import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ChatRecord } from "../../core/contracts/chat.ts";
import { accumulateJobUsage, piUsageToStep, type JobUsage } from "../../core/contracts/jobs.ts";
import { documentDate } from "../../core/document/conversation.ts";
import { insertFigures, noteBodyProblems } from "../../core/document/note-body.ts";
import { noteSource, type NoteSource } from "../../core/document/note-source.ts";
import { renderDocumentFile } from "../document/render.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

/**
 * The note writer (fork plan 03 item 3): one submit_note call turns a
 * session into a study note. The app checks the body, places the session's
 * figures, renders math and Mermaid, and wraps it in the document template;
 * each problem goes back to the model to fix. Rendering problems that remain
 * after the last fix attempt are kept in the file as source boxes.
 *
 * The prompt lives here, like the other background workers' prompts
 * (src/agent/prompts/README.md); it is not a Settings → Prompts segment.
 */

/** Fix attempts after the first submission (agent-selected). */
export const NOTE_FIX_ATTEMPTS = 3;

const SELF_CONTAINED = "Everything must be self-contained: no `<style>`, `<script>`, `<iframe>` or `<link>` elements, no event-handler attributes, and no external images, fonts, or stylesheets. Links to web pages are fine.";

const INTERACTIVE = "The learner asked for an interactive note. Where it helps them explore an idea (a slider that changes a parameter, a step-through of an algorithm), add small widgets with `<script>` and `<style>` elements. Scripts run in a sandbox with no network access, so they must be self-contained: no external scripts, images, fonts, or stylesheets. Keep the rest of the note static.";

const PROMPT = `You write study notes for a learner from one of their tutoring sessions. The learner reads the notes later to review what they learned; nobody else reads them.

**What to write.** A condensed lesson, in the order the session taught it:
- the key definitions, stated precisely;
- the reasoning steps, so each result follows from what came before it;
- the worked examples from the session, with their steps;
- the misconceptions the learner showed, and how each was resolved.

Use only what the session taught. Where the session corrected an earlier statement, write only the corrected version. Leave out small talk and the session's logistics (plans, quizzes as events); keep the knowledge.

**The learner's instruction**, if there is one, follows the session. It can set a focus ("I struggle with X"), narrow the topic ("only Y"), or ask for emphasis ("lots of visuals"). Follow it within this style.

**Format.** Call \`submit_note\` once, with a short, specific \`title\` (at most eight words) and the note's HTML \`body\`. The app places the body in a fixed page template with its own stylesheet, so write only content:
- headings \`h2\` and \`h3\`, paragraphs, lists, tables, \`blockquote\`, \`code\`, and \`pre\`;
- callout boxes: \`<div class="definition">\`, \`<div class="example">\`, \`<div class="misconception">\`, \`<div class="key-idea">\`;
- math as TeX: \`\\( … \\)\` inline and \`\\[ … \\]\` for display. Inside formulas, write \`\\lt\`, \`\\gt\` and \`\\&\` instead of \`<\`, \`>\` and \`&\`. Never use \`$\` for math;
- diagrams: Mermaid source in \`<pre class="mermaid">…</pre>\`, or inline \`<svg>\`;
- figures from the session, by the ids listed after it: \`<figure data-figure="F2"><figcaption>…</figcaption></figure>\`. The app inserts the image;
- inline \`style\` attributes for layout, such as grids and columns.

{{SELF_CONTAINED}}

If the app finds a problem (a formula that doesn't render, a diagram with a syntax error, an unknown figure), \`submit_note\` returns it. Fix it and submit again.`;

export function noteSystemPrompt(interactive: boolean): string {
	return PROMPT.replace("{{SELF_CONTAINED}}", interactive ? INTERACTIVE : SELF_CONTAINED);
}

export function noteUserMessage(sessionTitle: string, source: NoteSource, instruction: string): string {
	const figures = source.figures.length === 0
		? "Figures you can include: none"
		: `Figures you can include:\n${source.figures.map((figure) => `- ${figure.id} (${figure.kind}): ${figure.description}`).join("\n")}`;
	const plan = source.planTitles.length === 0 ? "Plan topics: none" : `Plan topics: ${source.planTitles.join("; ")}`;
	const trimmed = instruction.trim();
	return [
		`Session title: ${sessionTitle}`,
		`<session>\n${source.text}\n</session>`,
		plan,
		figures,
		trimmed ? `Learner's instruction: ${trimmed}` : "No instruction: write the default note.",
	].join("\n\n");
}

/** "Notes from <session> · <date>", plus the instruction when there is one. */
export function noteSubtitle(sessionTitle: string, instruction: string, date: Date): string {
	const trimmed = instruction.replace(/\s+/g, " ").trim();
	return `Notes from ${sessionTitle} · ${documentDate(date)}${trimmed ? ` · “${trimmed}”` : ""}`;
}

export class NoteWriterError extends Error {}

/** A session the Strong model can't read in one request (no splitting). */
export function contextProblem(engine: PiEngine, systemPrompt: string, prompt: string): string | null {
	const window = engine.model.contextWindow;
	if (!window || window <= 0) return null;
	const needed = Math.ceil((systemPrompt.length + prompt.length) / 4);
	const reserve = Math.min(engine.model.maxTokens || 16_000, 32_000);
	if (needed + reserve <= window) return null;
	const k = (n: number) => `${Math.round(n / 1000)}k`;
	return `This session is too long for ${engine.model.name || engine.model.id} (about ${k(needed)} tokens; its context window is ${k(window)}). Choose a Strong model with a larger context window and try again.`;
}

export interface WriteNoteInput {
	record: ChatRecord;
	instruction: string;
	interactive: boolean;
	engine: PiEngine | undefined;
	signal?: AbortSignal;
	/** Live usage after each model call (the activity row's cost). */
	onUsage?: (usage: JobUsage) => void;
	now?: Date;
}

export interface WrittenNote {
	title: string;
	html: string;
	model?: string;
	usage?: JobUsage;
}

export async function writeNote(input: WriteNoteInput): Promise<WrittenNote> {
	if (!input.engine) throw new NoteWriterError("No model configured — set up your models first");
	const source = noteSource(input.record);
	const systemPrompt = noteSystemPrompt(input.interactive);
	const prompt = noteUserMessage(input.record.title, source, input.instruction);
	const tooLong = contextProblem(input.engine, systemPrompt, prompt);
	if (tooLong) throw new NoteWriterError(tooLong);

	const figures = new Map(source.figures.map((figure) => [figure.id, figure]));
	const figureIds = new Set(figures.keys());
	const subtitle = noteSubtitle(input.record.title, input.instruction, input.now ?? new Date());
	let usage: JobUsage | undefined;
	let model: string | undefined;
	let submissions = 0;
	let accepted: { title: string; html: string } | undefined;

	const validate = async (value: { title: string; body: string }): Promise<string | null> => {
		submissions++;
		const problems: string[] = [];
		if (!value.title) problems.push("The title is empty. Give the note a short, specific title.");
		else if (value.title.split(/\s+/).length > 8) problems.push("The title is too long. Use at most eight words.");
		problems.push(...noteBodyProblems(value.body, { interactive: input.interactive, figureIds }));
		if (problems.length > 0) return `Fix these problems and call submit_note again:\n${problems.map((p) => `- ${p}`).join("\n")}`;

		const file = await renderDocumentFile({
			title: value.title,
			subtitle,
			body: insertFigures(value.body, figures),
			scripted: input.interactive,
		});
		const renderProblems = [
			...file.mathFailures.map((failure) => `The formula ${failure.source} doesn't render: ${failure.message}`),
			...file.diagramFailures.map((failure) => `A Mermaid diagram doesn't render: ${failure.message}\nIts source:\n${failure.source}`),
		];
		// After the last fix attempt, the note is kept; each item that still
		// fails shows its source in a "couldn't be rendered" box.
		if (renderProblems.length > 0 && submissions <= NOTE_FIX_ATTEMPTS) {
			return `Fix these problems and call submit_note again:\n${renderProblems.map((p) => `- ${p}`).join("\n")}`;
		}
		accepted = { title: value.title, html: file.html };
		return null;
	};

	await runSubmitAgent<{ title: string; body: string }>({
		role: "noteWriter",
		toolName: "submit_note",
		toolDescription: "Submit the finished note: a short, specific title and the note's HTML body (content only; the app supplies the page).",
		parameters: Type.Object({
			title: Type.String({ description: "A short, specific title, at most eight words." }),
			body: Type.String({ description: "The note's HTML body: content only, no <html>, <head> or <body>." }),
		}),
		fill: (raw: { title: string; body: string }) => ({ title: String(raw.title ?? "").replace(/\s+/g, " ").trim(), body: String(raw.body ?? "") }),
		systemPrompt,
		prompt,
		engine: input.engine,
		signal: input.signal,
		onStep: (stepUsage: Usage, stepModel: string) => {
			model = stepModel;
			usage = accumulateJobUsage(usage, stepModel, piUsageToStep(stepUsage));
			input.onUsage?.(usage);
		},
		neverSubmitted: "The note writer stopped without producing a note it could save.",
		validate,
		maxTurns: 1 + NOTE_FIX_ATTEMPTS,
		chatId: input.record.id,
	});
	if (!accepted) throw new NoteWriterError("The note writer stopped without producing a note it could save.");
	return { title: accepted.title, html: accepted.html, ...(model ? { model } : {}), ...(usage ? { usage } : {}) };
}
