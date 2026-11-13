import type { ImageContent } from "@earendil-works/pi-ai";
import { answerForPresentation } from "../answer-presentation.ts";
import { collectCitations, CITATION_LABEL } from "../citations.ts";
import type { ChatRecord, ImageSnapshot, PlanBlockData, ShowImageDetails, SideChatThread } from "../contracts/chat.ts";
import { isSubagentFailure, isWebSourceUrl, type DemoResult, type PdfResult, type ResearchResult, type SubagentArtifactData, type VisualResult } from "../contracts/jobs.ts";
import { buildDemoSrcDoc, DEMO_MAX_HEIGHT, DEMO_MIN_HEIGHT } from "../demo-bridge.ts";
import { repairMathForDisplay } from "../math-delims.ts";
import type { LhMessage } from "../native-messages.ts";
import { readPluginQuestionAnswer, readPluginQuestionCancellation } from "../plugin-questions.ts";
import { normalizeOptions, seededRandom, shuffleOptions, type QuestionAnswerData } from "../question-core.ts";
import { sideEntryPoints } from "../side-chat.ts";
import { parseAskInput, parseQuestionInput, parseQuizInput } from "../tool-parts.ts";
import { projectView, type LhViewPart } from "../view.ts";
import { figureImageSrc, learnerImageSrc } from "./figures.ts";
import { escapeHtml } from "./html.ts";
import { markdownToHtml } from "./markdown.ts";
import { planMapSvg } from "./plan-map.ts";

/**
 * A teaching session as one document body (plan 03 item 2), built from the
 * same projection the chat renders (projectView) so blocks appear in
 * transcript order: learner messages, teacher prose, questions,
 * plan maps, figures and images, research and PDF briefs, interactive
 * demos, and side-question threads after the passage they were asked about.
 * Model thinking, usage, tool traffic, failed tool calls and markers are
 * left out. Learner-written text is shown verbatim (`lh-verbatim`, never
 * read as Markdown or math), as in the chat.
 */

export interface ConversationDocument {
	title: string;
	subtitle: string;
	body: string;
	/** The parent-side sizer for embedded demos; absent without demos. */
	appScript?: string;
}

const QUESTION_TOOLS = new Set(["quiz", "probe", "ask_user_question", "explain", "recall"]);

/** "13 November 2026": the date line notes and exports carry. */
export function documentDate(date: Date): string {
	return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** The listener that sizes demo frames from the bridge's reports. */
export const DEMO_FRAME_SIZER = `window.addEventListener("message",function(e){var d=e.data;if(!d||d.type!=="demo-resize"||typeof d.height!=="number"||!isFinite(d.height)||d.height<=0)return;var f=document.querySelectorAll("iframe.lh-demo-frame");for(var i=0;i<f.length;i++){if(f[i].contentWindow===e.source){f[i].style.height=Math.min(Math.max(Math.round(d.height),${DEMO_MIN_HEIGHT}),${DEMO_MAX_HEIGHT})+"px"}}});`;

function inlineMarkdown(markdown: string): string {
	const html = markdownToHtml(markdown).trim();
	const single = /^<p>([\s\S]*)<\/p>$/.exec(html);
	return single && !single[1]!.includes("<p>") ? single[1]! : html;
}

function verbatim(text: string): string {
	return `<span class="lh-verbatim">${escapeHtml(text)}</span>`;
}

function images(list: ReadonlyArray<Pick<ImageContent, "data" | "mimeType">> | undefined): string {
	if (!list?.length) return "";
	return `<div class="lh-images">${list.map((image) =>
		`<img src="data:${escapeHtml(image.mimeType)};base64,${escapeHtml(image.data)}" alt="Learner image">`).join("")}</div>`;
}

/** Learner text with Tutor quotes shown as quotes, never as raw links. */
function learnerText(text: string): string {
	let out = "";
	let cursor = 0;
	for (const occurrence of collectCitations(text)) {
		out += verbatim(text.slice(cursor, occurrence.start));
		const comment = occurrence.citation.comment
			? `<p class="lh-quote-comment">Comment: ${verbatim(occurrence.citation.comment)}</p>`
			: "";
		out += `<blockquote class="lh-quote"><span class="lh-label">${CITATION_LABEL}</span>${verbatim(occurrence.citation.text)}${comment}</blockquote>`;
		cursor = occurrence.end;
	}
	return out + verbatim(text.slice(cursor));
}

function learnerBlock(text: string, attached?: ReadonlyArray<Pick<ImageContent, "data" | "mimeType">>): string {
	return `<div class="lh-learner"><span class="lh-label">You</span><div class="lh-learner-text">${learnerText(text)}</div>${images(attached)}</div>`;
}

function questionLabel(answer: Pick<QuestionAnswerData, "tool" | "kind" | "questionType">): string {
	if (answer.tool === "probe") return "Probe question";
	if (answer.tool === "recall") return "Recall question";
	if (answer.kind === "quiz") return answer.questionType === "predict" ? "Prediction question" : "Check question";
	if (answer.kind === "explain") return "Explain question";
	return "Question";
}

/** Export only fields visible before submission; never serialize private keys. */
function pendingQuestionBlock(tool: string, part: LhViewPart): string {
	if (part.state !== "input-available") return "";
	const input = parseQuestionInput(tool, part.input);
	if (!input) return "";
	const kind = tool === "ask_user_question" ? "ask" : tool === "explain" || tool === "recall" ? "explain" : "quiz";
	const label = questionLabel({ tool, kind, questionType: "type" in input ? input.type : undefined });
	const options = "options" in input ? normalizeOptions(input.options) : [];
	const ordered = kind === "quiz" ? shuffleOptions(options, seededRandom(part.toolCallId ?? "")) : options;
	const rows = ordered.map(option => `<li class="lh-option">${inlineMarkdown(repairMathForDisplay(option.label))}`
		+ (option.description ? `<span class="lh-option-description">${inlineMarkdown(repairMathForDisplay(option.description))}</span>` : "") + "</li>").join("");
	const details = "details" in input && input.details ? `<div class="lh-question-details">${markdownToHtml(repairMathForDisplay(input.details))}</div>` : "";
	return `<div class="lh-question"><div class="lh-question-head"><span class="lh-label">${label}</span></div>`
		+ `<div class="lh-question-prompt">${markdownToHtml(repairMathForDisplay(input.question))}</div>${details}`
		+ (rows ? `<ol class="lh-options">${rows}</ol>` : "") + `<p class="lh-question-meta">Not answered</p></div>`;
}

function resultBadge(answer: QuestionAnswerData): string {
	if (answer.dismissed) return `<span class="lh-result lh-result-skipped">Skipped</span>`;
	if (answer.kind !== "quiz") return "";
	if (answer.dontKnow) return `<span class="lh-result lh-result-dontknow">Don't know</span>`;
	return answer.correct
		? `<span class="lh-result lh-result-right">Right</span>`
		: `<span class="lh-result lh-result-wrong">Wrong</span>`;
}

function questionBlock(saved: QuestionAnswerData, input: unknown): string {
	const answer = answerForPresentation(saved, input);
	const head = `<div class="lh-question-head"><span class="lh-label">${questionLabel(answer)}</span>${resultBadge(answer)}</div>`;
	const prompt = `<div class="lh-question-prompt">${markdownToHtml(repairMathForDisplay(answer.questionText))}</div>`;
	if (answer.dismissed) return `<div class="lh-question">${head}${prompt}</div>`;

	const isQuiz = answer.kind === "quiz";
	const askInput = answer.kind === "ask" ? parseAskInput(input) : undefined;
	const details = askInput?.details ?? (isQuiz ? parseQuizInput(input)?.details : undefined);
	const descriptions = new Map((askInput?.options ?? []).map((option, i) => [i + 1, option.description]));
	const selected = new Set(answer.answers.map((a) => a.index));
	const correct = new Set(isQuiz ? answer.correctIndices ?? [] : []);

	const parts: string[] = [head, prompt];
	if (details) parts.push(`<div class="lh-question-details">${markdownToHtml(repairMathForDisplay(details))}</div>`);
	const options = (answer.options ?? []).map((option) => {
		const chosen = selected.has(option.index);
		const key = correct.has(option.index);
		const classes = ["lh-option", key ? "lh-option-correct" : "", chosen ? "lh-option-chosen" : "", chosen && isQuiz && !key ? "lh-option-wrong" : ""];
		const note = chosen ? "your answer" : key ? "correct answer" : "";
		const description = descriptions.get(option.index);
		return `<li class="${classes.filter(Boolean).join(" ")}">${inlineMarkdown(repairMathForDisplay(option.label))}`
			+ (note ? `<span class="lh-option-note">${note}</span>` : "")
			+ (description ? `<span class="lh-option-description">${inlineMarkdown(repairMathForDisplay(description))}</span>` : "")
			+ "</li>";
	});
	if (answer.other) options.push(`<li class="lh-option lh-option-chosen">“${verbatim(answer.other)}”<span class="lh-option-note">your answer</span></li>`);
	if (options.length > 0) parts.push(`<ol class="lh-options">${options.join("")}</ol>`);
	if (answer.text) parts.push(`<p class="lh-question-answer">Your answer: “${verbatim(answer.text)}”</p>`);
	parts.push(images(answer.images?.answer));
	if (isQuiz && answer.confidence != null) parts.push(`<p class="lh-question-meta">Confidence: ${answer.confidence}%</p>`);
	if (answer.readingThinking || answer.images?.readingThinking?.length) {
		parts.push(`<p class="lh-question-meta">Your thinking while reading: ${verbatim(answer.readingThinking ?? "")}</p>`, images(answer.images?.readingThinking));
	}
	const thinking = answer.thinking ?? answer.note;
	if (thinking || answer.images?.thinking?.length) {
		parts.push(`<p class="lh-question-meta">Your thinking: ${verbatim(thinking ?? "")}</p>`, images(answer.images?.thinking));
	}
	if (isQuiz && answer.explanation) {
		parts.push(`<details class="lh-why"><summary>Why</summary>${markdownToHtml(repairMathForDisplay(answer.explanation))}</details>`);
	}
	if (answer.kind === "explain" && answer.committed) {
		parts.push(`<div class="lh-answer-key"><span class="lh-label">The answer</span>${markdownToHtml(repairMathForDisplay(answer.committed))}</div>`);
	}
	return `<div class="lh-question">${parts.join("")}</div>`;
}

/** Plugin questions keep their recorded answer text, as the Markdown export does. */
function pluginQuestionBlock(part: LhViewPart): string {
	const annotation = part.pluginQuestion;
	if (!annotation || annotation.status !== "posed" || part.state === "output-error") return "";
	const head = `<div class="lh-question-head"><span class="lh-label">Question</span></div>`;
	const prompt = `<div class="lh-question-prompt">${markdownToHtml(repairMathForDisplay(annotation.snapshot.input.question))}</div>`;
	if (part.state === "input-available") return `<div class="lh-question">${head}${prompt}<p class="lh-question-meta">Not answered</p></div>`;
	if (part.state !== "output-available") return "";
	if (readPluginQuestionCancellation(part.output)) {
		return `<div class="lh-question">${head}${prompt}<p class="lh-question-meta">The question was cancelled without a learner answer.</p></div>`;
	}
	const answer = readPluginQuestionAnswer(part.output);
	if (!answer) return "";
	const text = typeof answer.answer === "string" ? answer.answer : JSON.stringify(answer.answer);
	const thinking = answer.thinking !== undefined || answer.images?.thinking?.length
		? `<p class="lh-question-meta">Your thinking: ${verbatim(answer.thinking ?? "")}</p>${images(answer.images?.thinking)}` : "";
	const reading = answer.readingThinking !== undefined || answer.images?.readingThinking?.length
		? `<p class="lh-question-meta">Your thinking while reading: ${verbatim(answer.readingThinking ?? "")}</p>${images(answer.images?.readingThinking)}` : "";
	return `<div class="lh-question">${head}${prompt}<p class="lh-question-answer">Your answer: “${verbatim(text)}”</p>${images(answer.images?.answer)}${reading}${thinking}</div>`;
}

function snapshotOf(record: ChatRecord, id: string | undefined): ImageSnapshot | undefined {
	return id ? record.imageSnapshots?.[id] : undefined;
}

function pageList(pages: readonly number[]): string {
	const sorted = [...new Set(pages)].sort((a, b) => a - b);
	const ranges: string[] = [];
	for (let i = 0; i < sorted.length; i++) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
		ranges.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
		i = j;
	}
	return ranges.join(", ");
}

function failedArtifact(label: string, text: string): string {
	return `<div class="lh-artifact-failed"><span class="lh-label">${label}</span><p>${escapeHtml(text)}</p></div>`;
}

interface BuildState {
	record: ChatRecord;
	calls: Map<string, Record<string, unknown> | undefined>;
	plans: number;
	demos: number;
}

function artifactBlock(state: BuildState, artifact: SubagentArtifactData, toolCallId: string | undefined): string {
	const args = toolCallId ? state.calls.get(toolCallId) : undefined;
	switch (artifact.kind) {
		case "visual": {
			const result = artifact.result as VisualResult;
			if (isSubagentFailure("visual", result)) return failedArtifact("Figure", result.notes ?? "The figure could not be made.");
			const image = snapshotOf(state.record, result.image?.snapshotId);
			return `<figure class="lh-figure"><img src="${figureImageSrc(result.svg, image)}" alt="Figure"></figure>`;
		}
		case "demo": {
			const result = artifact.result as DemoResult;
			if (isSubagentFailure("demo", result)) return failedArtifact("Interactive demo", result.notes ?? "The demo could not be built.");
			state.demos++;
			return `<figure class="lh-demo"><figcaption><span class="lh-label">Interactive demo</span>${escapeHtml(result.title)}</figcaption>`
				+ `<iframe class="lh-demo-frame" sandbox="allow-scripts" title="${escapeHtml(result.title)}" srcdoc="${escapeHtml(buildDemoSrcDoc(result.html))}"></iframe></figure>`;
		}
		case "research": {
			const result = artifact.result as ResearchResult;
			if (isSubagentFailure("research", result)) return failedArtifact("Research brief", result.brief);
			const question = typeof args?.question === "string" && args.question.trim() ? ` · ${escapeHtml(args.question.trim())}` : "";
			const sources = result.sources.filter((source) => isWebSourceUrl(source.url));
			const links = sources.length > 0
				? `<p class="lh-brief-sources">Sources: ${sources.map((source) => `<a href="${escapeHtml(source.url)}">${escapeHtml(source.title || source.url)}</a>`).join(" · ")}</p>`
				: "";
			return `<details class="lh-brief"><summary>Research brief${question}</summary>${markdownToHtml(result.brief)}${links}</details>`;
		}
		case "pdf": {
			const result = artifact.result as PdfResult;
			if (isSubagentFailure("pdf", result)) return failedArtifact("PDF brief", result.brief);
			const name = result.path.split(/[\\/]/).pop() || result.path;
			const pages = result.pagesRead?.length ? result.pagesRead : result.pagesConsulted ?? [];
			const read = pages.length > 0 ? ` (${pages.length === 1 ? "page" : "pages"} ${pageList(pages)})` : "";
			return `<details class="lh-brief"><summary>PDF brief · ${escapeHtml(name)}${read}</summary>${markdownToHtml(result.brief)}</details>`;
		}
		default:
			return "";
	}
}

function sideThreadBlock(thread: SideChatThread): string {
	const messages = thread.messages.filter((message) => message.text.trim());
	if (messages.length === 0) return "";
	const first = messages.find((message) => message.role === "user");
	const passage = (first?.quotes?.[0] ?? thread.anchor.blockText).replace(/\s+/g, " ").trim();
	const quoted = passage.length > 140 ? `${passage.slice(0, 139).trimEnd()}…` : passage;
	const body = messages.map((message) => message.role === "user"
		? learnerBlock(message.text)
		: `<div class="lh-side-answer">${markdownToHtml(message.text)}</div>`).join("");
	return `<details class="lh-side"><summary>Side question on <span class="lh-side-quote">“${escapeHtml(quoted)}”</span></summary>${body}</details>`;
}

function toolCallArguments(messages: readonly LhMessage[]): Map<string, Record<string, unknown> | undefined> {
	const calls = new Map<string, Record<string, unknown> | undefined>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "toolCall") calls.set(block.id, (block.arguments ?? undefined) as Record<string, unknown> | undefined);
		}
	}
	return calls;
}

export function conversationDocument(record: ChatRecord): ConversationDocument {
	const view = projectView(record.messages);
	const entries = sideEntryPoints(record.messages, view);
	const threads = new Map<string, SideChatThread[]>();
	for (const thread of record.sideChats ?? []) {
		threads.set(thread.anchor.messageId, [...(threads.get(thread.anchor.messageId) ?? []), thread]);
	}
	const sideEntry = (segment: string | undefined) => (segment ? (threads.get(segment) ?? []).map(sideThreadBlock).join("") : "");
	const state: BuildState = { record, calls: toolCallArguments(record.messages), plans: 0, demos: 0 };
	const blocks: string[] = [];

	for (const message of view) {
		if (message.role === "user") {
			const meta = (message.metadata as { subagentResult?: { toolCallId?: string } } | undefined)?.subagentResult;
			const artifact = message.parts.find((part) => part.type === "data-subagent-artifact");
			if (artifact) {
				blocks.push(artifactBlock(state, artifact.data as SubagentArtifactData, meta?.toolCallId));
				continue;
			}
			// Markers (aborts, handoffs, compaction, graph context) render nothing.
			if (meta || message.parts.some((part) => part.type.startsWith("data-"))) continue;
			const text = message.parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
			const attached = message.parts.filter((part) => part.type === "image") as unknown as ImageContent[];
			if (text.trim() || attached.length > 0) blocks.push(learnerBlock(text, attached));
			continue;
		}

		const segments = entries.get(message.id);
		message.parts.forEach((part, index) => {
			if (part.type === "step-start") blocks.push(sideEntry(segments?.get(index)));
			if (part.pluginQuestion) {
				blocks.push(pluginQuestionBlock(part));
				return;
			}
			if (part.state === "output-error") return;
			if (part.type === "text") {
				if (part.text?.trim()) blocks.push(markdownToHtml(part.text));
				return;
			}
			if (part.type === "data-plan-block") {
				blocks.push(`<figure class="lh-plan">${planMapSvg(part.data as PlanBlockData, `lh-plan-arrow-${++state.plans}`)}<figcaption>Plan</figcaption></figure>`);
				return;
			}
			const tool = part.type.startsWith("tool-") ? part.type.slice(5) : "";
			if (QUESTION_TOOLS.has(tool) && part.state === "output-available" && part.output) {
				blocks.push(questionBlock(part.output as QuestionAnswerData, part.input));
				return;
			}
			if (QUESTION_TOOLS.has(tool)) {
				blocks.push(pendingQuestionBlock(tool, part));
				return;
			}
			if (tool === "show_image" && part.state === "output-available") {
				const shown = part.output as ShowImageDetails | undefined;
				const image = snapshotOf(record, shown?.snapshotId);
				if (!shown || !image) return;
				const caption = shown.caption?.trim();
				blocks.push(`<figure class="lh-figure"><img src="${learnerImageSrc(image)}" alt="${escapeHtml(caption || "Image")}">${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>`);
			}
		});
		blocks.push(sideEntry(segments?.get(message.parts.length)));
	}

	return {
		title: record.title,
		subtitle: `Conversation · ${documentDate(new Date(record.createdAt))}`,
		body: blocks.filter(Boolean).join("\n"),
		...(state.demos > 0 ? { appScript: DEMO_FRAME_SIZER } : {}),
	};
}
