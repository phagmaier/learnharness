/**
 * Plan 03 item 2: the HTML conversation export's body builder, the shared
 * plan map, and the sidebar entry. One fixture session (built here, in the
 * record's native shape) covers every block type; the expected block order
 * is worked out by hand from the fixture below and checked by parsing the
 * produced HTML with linkedom.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanBlock } from "../components/plan-block.tsx";
import { ExportHtmlItem } from "../components/sidebar.tsx";
import { serializeCitation } from "../src/core/citations.ts";
import type { ChatRecord, PlanBlockData, SideChatThread } from "../src/core/contracts/chat.ts";
import { buildAbortSteer, buildSubagentSteer } from "../src/core/contracts/jobs.ts";
import { conversationDocument } from "../src/core/document/conversation.ts";
import { planMapSvg } from "../src/core/document/plan-map.ts";
import { LEARNER_IMAGE_HREF } from "../src/core/learner-image-svg.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
import { renderDocumentFile } from "../src/agent/document/render.ts";
import { headlessOverride } from "../src/agent/subagents/headless.ts";

// ─── fixture ────────────────────────────────────────────────────────────────

function assistant(id: string, content: unknown[]): LhMessage {
	return {
		id, role: "assistant", content, api: "openai-completions", provider: "test", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "toolUse", timestamp: 1,
	} as never;
}
function result(callId: string, toolName: string, details: unknown, isError = false, text = "ok"): LhMessage {
	return { id: `r_${callId}`, role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text }], details, isError, timestamp: 1 } as never;
}
const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });

const PLAN: PlanBlockData = {
	kind: "full",
	at: "2026-11-13T10:00:00.000Z",
	current: "a",
	nodes: [
		{ id: "a", title: "Vectors and maps", status: "visited" },
		{ id: "b", title: "Eigenvectors stay on their own line", status: "current" },
		{ id: "c", title: "Diagonalization", status: "upcoming" },
	],
	edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
} as PlanBlockData;

const QUIZ_INPUT = {
	question: "Which vector is an eigenvector of \\(A = \\mathrm{diag}(2, 3)\\)?",
	type: "check",
	details: "Compute \\(Av\\) for each.",
	options: [
		{ label: "\\((1, 0)\\)", value: "e1" },
		{ label: "\\((1, 1)\\)", value: "ones" },
	],
	correctAnswer: "e1",
	explanation: "Only \\(e_1\\) maps onto a multiple of itself.",
};
const QUIZ_ANSWER: QuestionAnswerData = {
	kind: "quiz", tool: "quiz", questionType: "check",
	questionText: QUIZ_INPUT.question,
	options: [{ index: 1, label: "\\((1, 0)\\)" }, { index: 2, label: "\\((1, 1)\\)" }],
	dontKnow: false,
	answers: [{ index: 2, value: "ones", label: "\\((1, 1)\\)" }],
	correct: false, correctIndices: [1], confidence: 70,
	thinking: "Both entries grow, so it should stay.",
	answeredAt: "2026-11-13T10:05:00.000Z",
} as QuestionAnswerData;

const ASK_INPUT = { question: "What next?", options: [{ label: "Diagonalization", value: "diag", description: "Change of basis" }, { label: "Review", value: "review" }] };
const ASK_ANSWER: QuestionAnswerData = {
	kind: "ask", tool: "ask_user_question", questionText: "What next?",
	options: [{ index: 1, label: "Diagonalization" }, { index: 2, label: "Review" }],
	dontKnow: false, answers: [], other: "Both, \\(slowly\\)",
	answeredAt: "2026-11-13T10:20:00.000Z",
} as QuestionAnswerData;

const LEARNER_PNG = { mimeType: "image/png" as const, data: "iVBORw0KGgoAAAANSUhEUg==", width: 4, height: 3 };
const ANNOTATION = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><image href="${LEARNER_IMAGE_HREF}" width="40" height="30"/><circle cx="10" cy="15" r="6"/></svg>`;

const quote = serializeCitation({
	version: 1, chatId: "chat_x", messageId: "a1", text: "stays on its own line", start: 0, end: 21, prefix: "", suffix: "",
});

const THREAD: SideChatThread = {
	id: "t1",
	anchor: { messageId: "a1", partId: "a1-t0", blockIndex: 0, blockText: "An eigenvector stays on its own line under $A$." },
	open: false,
	createdAt: "2026-11-13T10:06:00.000Z",
	messages: [
		{ id: "s1", role: "user", text: "Why only one line?", quotes: ["An eigenvector stays on its own line under $A$."], at: "2026-11-13T10:06:00.000Z" },
		{ id: "s2", role: "assistant", text: "Because $Av = \\lambda v$ only rescales.", at: "2026-11-13T10:06:05.000Z" },
	],
};

const messages: LhMessage[] = [
	{ id: "u1", role: "user", content: `Explain eigenvectors. I wrote \\(x\\) and it costs $5.\n${quote}`, timestamp: 1 } as never,
	assistant("a1", [
		{ type: "thinking", thinking: "SECRET REASONING" },
		{ type: "text", text: "An **eigenvector** stays on its own line under $A$: $Av = \\lambda v$.\n\n```mermaid\ngraph LR\n  v-->Av\n```\n\n<b>raw tag</b> stays text." },
		call("c_plan", "plan_init", { nodes: [] }),
		call("c_quiz", "quiz", QUIZ_INPUT),
		call("c_vis", "visual", { brief: "annotate", image: "/tmp/photo.png" }),
		call("c_demo", "demo", { title: "Eigen explorer", brief: "x" }),
		call("c_res", "research", { question: "Who named eigenvectors?" }),
		call("c_pdf", "pdf", { path: "/books/linear.pdf", question: "Find the definition" }),
	]),
	result("c_plan", "plan_init", { ok: true, tree: { nodes: [], edges: [] } }),
	{ id: "pb1", role: "custom", customType: "plan-block", content: "", display: true, details: { planCallId: "c_plan", block: PLAN }, timestamp: 1 } as never,
	result("c_vis", "visual", { jobId: "j_vis" }, false, "TOOL TRAFFIC dispatched"),
	result("c_demo", "demo", { jobId: "j_demo" }, false, "TOOL TRAFFIC dispatched"),
	result("c_res", "research", { jobId: "j_res" }, false, "TOOL TRAFFIC dispatched"),
	result("c_pdf", "pdf", { jobId: "j_pdf" }, false, "TOOL TRAFFIC dispatched"),
	result("c_quiz", "quiz", QUIZ_ANSWER),
	assistant("a2", [{ type: "text", text: "" }, call("c_read", "read", { path: "/nope" })]),
	result("c_read", "read", undefined, true, "FAILED CALL ERROR TEXT"),
	buildSubagentSteer({ id: "j_vis", kind: "visual", toolCallId: "c_vis" }, { svg: ANNOTATION, image: { path: "/tmp/photo.png", snapshotId: "snap1" } }) as never,
	buildSubagentSteer({ id: "j_demo", kind: "demo", toolCallId: "c_demo" }, { title: "Eigen explorer", html: "<!doctype html><html><body><p>demo</p></body></html>", tested: true }) as never,
	buildSubagentSteer({ id: "j_res", kind: "research", toolCallId: "c_res" }, {
		brief: "**Hilbert** used *Eigenfunktion* in 1904.",
		sources: [{ title: "History", url: "https://example.org/eigen" }, { title: "Local file", url: "file:///etc/passwd" }],
	}) as never,
	buildSubagentSteer({ id: "j_pdf", kind: "pdf", toolCallId: "c_pdf" }, {
		path: "/books/linear.pdf", question: "Find the definition", brief: "Defined on p. 4.", pagesRead: [3, 4, 5, 9], pagesConsulted: [3, 4, 5, 9, 12],
	}) as never,
	buildSubagentSteer({ id: "j_demo2", kind: "demo", toolCallId: "c_demo" }, { title: "Broken", html: "", tested: true, notes: "The demo could not be verified." } as never) as never,
	buildAbortSteer({ id: "j_abort", kind: "research", toolCallId: "c_res" } as never) as never,
	{ id: "u2", role: "user", content: "Thanks!", timestamp: 1 } as never,
	assistant("a3", [{ type: "text", text: "One more choice." }, call("c_ask", "ask_user_question", ASK_INPUT), call("c_show", "show_image", { path: "/tmp/photo.png", caption: "Your photo" })]),
	result("c_show", "show_image", { path: "/tmp/photo.png", caption: "Your photo", mimeType: "image/png", snapshotId: "snap1", width: 4, height: 3 }),
	result("c_ask", "ask_user_question", ASK_ANSWER),
];

const RECORD: ChatRecord = {
	id: "chat_x",
	title: "Eigenvectors <basics>",
	createdAt: "2026-11-13T09:59:00.000Z",
	updatedAt: "2026-11-13T10:30:00.000Z",
	messages,
	imageSnapshots: { snap1: LEARNER_PNG },
	sideChats: [THREAD],
};

function blocks(html: string) {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	return document.body;
}
function kindOf(element: Element): string {
	const cls = element.getAttribute("class");
	return cls ? cls.split(/\s+/)[0]! : element.localName;
}

afterEach(() => {
	headlessOverride.current = undefined;
});

// ─── the body ───────────────────────────────────────────────────────────────

describe("conversation export body", () => {
	const doc = conversationDocument(RECORD);
	const root = blocks(doc.body);

	it("renders every block in transcript order", () => {
		assert.deepEqual(Array.from(root.children).map(kindOf), [
			"lh-learner", // u1
			"p", "mermaid", "p", // a1 prose: text with math, the Mermaid fence, the raw-HTML paragraph
			"lh-plan", // plan block, spliced after plan_init
			"lh-question", // the quiz (a1)
			"lh-side", // the side thread on a1's segment, before the next step
			"lh-figure", // visual steer
			"lh-demo", // demo steer
			"lh-brief", // research steer
			"lh-brief", // pdf steer
			"lh-artifact-failed", // the failed demo
			"lh-learner", // u2
			"p", // a3 prose
			"lh-question", // ask
			"lh-figure", // show_image
		]);
		assert.equal(doc.title, "Eigenvectors <basics>");
		assert.equal(doc.subtitle, "Conversation · 13 November 2026");
	});

	it("leaves out model thinking, tool traffic, failed calls and markers", () => {
		for (const hidden of ["SECRET REASONING", "TOOL TRAFFIC", "FAILED CALL ERROR TEXT", "aborted", "plan_init"]) {
			assert.ok(!doc.body.includes(hidden), hidden);
		}
	});

	it("shows learner text verbatim, with Tutor quotes as quotes", () => {
		const learner = root.querySelector(".lh-learner")!;
		const text = learner.textContent ?? "";
		assert.ok(text.includes("I wrote \\(x\\) and it costs $5."));
		assert.ok(!text.includes("lh-citation://"));
		assert.equal(learner.querySelector(".lh-quote .lh-verbatim")?.textContent, "stays on its own line");
		assert.equal(learner.querySelector(".lh-quote .lh-label")?.textContent, "Tutor quote");
	});

	it("reads teacher prose as Markdown with math, and shows raw HTML as text", () => {
		const prose = root.children[1]!;
		assert.ok(prose.querySelector("strong"));
		assert.deepEqual(Array.from(prose.querySelectorAll('annotation[encoding="application/x-tex"]')).map((n) => n.textContent), ["A", "Av = \\lambda v"]);
		assert.equal(root.children[2]!.textContent?.trim(), "graph LR\n  v-->Av");
		const raw = root.children[3]!;
		assert.equal(raw.querySelector("b"), null);
		assert.ok(raw.textContent?.includes("<b>raw tag</b> stays text."));
	});

	it("shows a graded question with the learner's choice, the key, the result and the reasoning", () => {
		const quiz = root.querySelectorAll(".lh-question")[0]!;
		assert.equal(quiz.querySelector(".lh-label")?.textContent, "Check question");
		assert.equal(quiz.querySelector(".lh-result")?.textContent, "Wrong");
		const options = Array.from(quiz.querySelectorAll(".lh-option"));
		assert.deepEqual(options.map((o) => o.getAttribute("class")), ["lh-option lh-option-correct", "lh-option lh-option-chosen lh-option-wrong"]);
		assert.deepEqual(options.map((o) => o.querySelector(".lh-option-note")?.textContent), ["correct answer", "your answer"]);
		assert.ok(quiz.querySelector(".lh-question-details")?.textContent?.includes("Compute"));
		assert.ok((quiz.textContent ?? "").includes("Confidence: 70%"));
		assert.ok((quiz.textContent ?? "").includes("Your thinking: Both entries grow, so it should stay."));
		assert.equal(quiz.querySelector(".lh-why summary")?.textContent, "Why");
	});

	it("shows an ungraded question without a result, with the typed answer verbatim", () => {
		const ask = root.querySelectorAll(".lh-question")[1]!;
		assert.equal(ask.querySelector(".lh-label")?.textContent, "Question");
		assert.equal(ask.querySelector(".lh-result"), null);
		const chosen = ask.querySelector(".lh-option-chosen")!;
		assert.ok(chosen.textContent?.includes("Both, \\(slowly\\)"));
		assert.ok(chosen.querySelector(".lh-verbatim"));
		assert.equal(ask.querySelector(".lh-option-description")?.textContent, "Change of basis");
	});

	it("embeds demos in a scripts-only sandbox, sized by the bridge", () => {
		const frame = root.querySelector(".lh-demo iframe")!;
		assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
		assert.ok(frame.getAttribute("srcdoc")?.includes("demo-resize"));
		assert.ok(frame.getAttribute("srcdoc")?.includes("<p>demo</p>"));
		assert.ok(doc.appScript?.includes("demo-resize"));
		assert.ok(root.querySelector(".lh-demo figcaption")?.textContent?.includes("Eigen explorer"));
	});

	it("quotes the passage a side question was asked about in its summary", () => {
		const side = root.querySelector(".lh-side")!;
		assert.equal(side.querySelector("summary")?.textContent, "Side question on “An eigenvector stays on its own line under $A$.”");
		assert.equal(side.querySelector(".lh-learner .lh-verbatim")?.textContent, "Why only one line?");
		assert.ok(side.querySelector(".lh-side-answer annotation"));
	});

	it("collapses research and PDF briefs, linking only web sources", () => {
		const [research, pdf] = Array.from(root.querySelectorAll(".lh-brief"));
		assert.equal(research!.querySelector("summary")?.textContent, "Research brief · Who named eigenvectors?");
		assert.deepEqual(Array.from(research!.querySelectorAll(".lh-brief-sources a")).map((a) => a.getAttribute("href")), ["https://example.org/eigen"]);
		assert.equal(pdf!.querySelector("summary")?.textContent, "PDF brief · linear.pdf (pages 3–5, 9)");
		assert.equal(root.querySelector(".lh-artifact-failed p")?.textContent, "The demo could not be verified.");
	});

	it("shows figures as images, with the learner image an annotation draws on", () => {
		const [figure, shown] = Array.from(root.querySelectorAll(".lh-figure img"));
		const svg = Buffer.from(figure!.getAttribute("src")!.replace("data:image/svg+xml;base64,", ""), "base64").toString("utf8");
		assert.ok(svg.includes(`href="data:image/png;base64,${LEARNER_PNG.data}"`));
		assert.equal(shown!.getAttribute("src"), `data:image/png;base64,${LEARNER_PNG.data}`);
		assert.equal(root.querySelectorAll(".lh-figure figcaption")[0]?.textContent, "Your photo");
	});

	it("keeps learner text literal through the document renderer, while teacher math renders", async () => {
		headlessOverride.current = {
			available: () => true, unavailableReason: () => null,
			runDemo: async () => { throw new Error("unexpected"); },
			renderSvg: async () => { throw new Error("unexpected"); },
			renderPdfPages: async () => { throw new Error("unexpected"); },
			renderMermaid: async (sources) => ({ status: "rendered", diagrams: sources.map(() => ({ ok: true as const, svg: "<svg data-diagram></svg>" })) }),
		};
		const file = await renderDocumentFile({ title: doc.title, subtitle: doc.subtitle, body: doc.body, appScript: doc.appScript }, {
			assets: { katexCss: "", textFontCss: "", codeFontCss: "" },
		});
		const { document } = parseHTML(file.html);
		assert.ok(document.querySelector(".lh-learner")?.textContent?.includes("I wrote \\(x\\)"));
		assert.equal(document.querySelector(".lh-learner .katex"), null);
		const typed = document.querySelectorAll(".lh-question")[1]!.querySelector(".lh-option-chosen")!;
		assert.ok(typed.textContent?.includes("\\(slowly\\)"));
		assert.equal(typed.querySelector(".katex"), null);
		assert.equal(document.querySelectorAll(".lh-diagram svg[data-diagram]").length, 1);
		assert.ok(file.html.includes("<script>window.addEventListener(\"message\""));
		assert.ok(!file.html.includes("Content-Security-Policy"), "a page with demo frames is not inert");
	});
});

// ─── the plan map ───────────────────────────────────────────────────────────

describe("export plan map", () => {
	const geometry = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
		const svg = document.querySelector("svg")!;
		return {
			viewBox: svg.getAttribute("viewBox"),
			maxWidth: /max-width:\s*([\d.]+)px/.exec(svg.getAttribute("style") ?? "")?.[1],
			nodes: Array.from(svg.querySelectorAll("g")).map((g) => {
				const rect = g.querySelector("rect")!;
				return [g.getAttribute("transform"), rect.getAttribute("width"), rect.getAttribute("height"),
					Array.from(g.querySelectorAll("text")).map((t) => [t.getAttribute("x"), t.getAttribute("y"), t.textContent])];
			}),
			edges: Array.from(svg.querySelectorAll("path")).filter((p) => p.getAttribute("marker-end")).map((p) => p.getAttribute("d")),
		};
	};

	it("draws the same nodes and edges as the chat's plan block for the same snapshot", () => {
		const chat = geometry(renderToStaticMarkup(<PlanBlock data={PLAN} onOpen={() => {}} />).replace(/markerEnd/g, "marker-end"));
		const exported = geometry(planMapSvg(PLAN, "lh-plan-arrow-1"));
		assert.equal(chat.nodes.length, 3);
		assert.equal(chat.edges.length, 2);
		assert.deepEqual(exported, chat);
	});

	it("uses the given arrow id and light ink", () => {
		const svg = planMapSvg(PLAN, "lh-plan-arrow-7");
		assert.ok(svg.includes('<marker id="lh-plan-arrow-7"'));
		assert.equal((svg.match(/marker-end="url\(#lh-plan-arrow-7\)"/g) ?? []).length, 2);
		assert.ok(!svg.includes("class="));
	});
});

// ─── the sidebar entry ──────────────────────────────────────────────────────

describe("sidebar Export as HTML", () => {
	it("is offered for Teach sessions and absent for Practice", () => {
		const teach = renderToStaticMarkup(<ExportHtmlItem chatId="c1" kind="teach" onPicked={() => {}} />);
		assert.ok(teach.includes('data-testid="ctx-export-html"'));
		assert.ok(teach.includes("Export as HTML…"));
		assert.ok(renderToStaticMarkup(<ExportHtmlItem chatId="c1" onPicked={() => {}} />).includes("ctx-export-html"));
		assert.equal(renderToStaticMarkup(<ExportHtmlItem chatId="c1" kind="practice" onPicked={() => {}} />), "");
	});
});
