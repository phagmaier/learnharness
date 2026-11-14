/**
 * Plan 04 item 6: completing a unit, its handoff, and reopening.
 * Completion records confirmed vs early from the goal signal and refuses
 * while work runs; the computed topics follow decision 2 on a hand-built
 * unit session; the handoff writer's scripted submit is stored, a judgment
 * of a checked topic and an over-long line go back to the model, a failure
 * or Stop keeps the computed part, an interrupted writer reads as such
 * after a restart, and Try again writes it; reopening clears the signal and
 * stops a running writer; the dialog's offers run only when checked; the
 * next-unit offer skips started units; the handoff text matches the plan's
 * expected text; and the engine resolves through handoffWriter. Fakes only
 * (pi-ai's faux provider); an isolated LH_DATA_DIR is set before any
 * config-loading import.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	type FauxResponseStep,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-completion-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { courseStore } = await import("../src/store/courses.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const courses = await import("../src/server/courses.ts");
const handoffs = await import("../src/server/handoffs.ts");
const notes = await import("../src/server/notes.ts");
const { activityFeed } = await import("../src/server/observability.ts");
const core = await import("../src/core/index.ts");
const completeRoute = await import("../app/api/courses/[id]/units/[unitId]/complete/route.ts");
const reopenRoute = await import("../app/api/courses/[id]/units/[unitId]/reopen/route.ts");
const handoffRoute = await import("../app/api/courses/[id]/units/[unitId]/handoff/route.ts");
const exportRoute = await import("../app/api/chats/[id]/export.html/route.ts");
const abortRoute = await import("../app/api/activity/abort/route.ts");
const { CompleteUnitForm, UnitCompletedBody, UnitCompletionTrigger, runUnitCompletion, EMPTY_FORM } = await import("../components/unit-completion.tsx");
const { HandoffView, HandoffDisclosure } = await import("../components/course-handoff.tsx");
const { UnitCard } = await import("../components/course-overview.tsx");
type PiEngine = import("../src/agent/models.ts").PiEngine;
type LhMessage = import("../src/core/native-messages.ts").LhMessage;
type CourseRecord = import("../src/core/contracts/course.ts").CourseRecord;
type CourseUnit = import("../src/core/contracts/course.ts").CourseUnit;
type HandoffTopic = import("../src/core/contracts/course.ts").HandoffTopic;
type UnitHandoff = import("../src/core/contracts/course.ts").UnitHandoff;

const SETTINGS = { version: 1, models: { strong: { model: { provider: "test", id: "strong-model" } }, cheap: { model: { provider: "test", id: "cheap" } }, vision: { model: { provider: "test", id: "vision" } } } } as const;
const handoffSeams = { ...handoffs.handoffServiceSeams };
const noteSeams = { ...notes.noteServiceSeams };

before(() => settingsStore.writeSettings(structuredClone(SETTINGS) as never));
afterEach(() => {
	Object.assign(handoffs.handoffServiceSeams, handoffSeams);
	Object.assign(notes.noteServiceSeams, noteSeams);
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ─── a unit session (the record's native shape) ─────────────────────────────

const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
function assistant(id: string, content: unknown[]): LhMessage {
	return {
		id, role: "assistant", content, api: "openai-completions", provider: "test", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "toolUse", timestamp: 1,
	} as never;
}
function asked(id: string, tool: string, args: unknown, details: unknown): LhMessage[] {
	return [
		assistant(`a_${id}`, [call(id, tool, args)]),
		{ id: `r_${id}`, role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text: "ok" }], details, isError: false, timestamp: 2 } as never,
	];
}
const at = (minute: number) => `2026-11-20T09:${String(minute).padStart(2, "0")}:00.000Z`;
const choice = (minute: number, fields: Record<string, unknown>) => ({ kind: "quiz", tool: "quiz", questionText: "Q?", dontKnow: false, answers: [{ label: "A", value: "a", index: 1 }], answeredAt: at(minute), ...fields });
const recalled = (minute: number) => ({ kind: "explain", tool: "explain", questionText: "Explain.", dontKnow: false, answers: [], text: "Conjugate by the basis change.", answeredAt: at(minute) });
const quiz = (type: string, nodeId: string) => ({ question: "Q?", options: [{ label: "A" }, { label: "B" }], explanation: "A.", correctAnswer: "A", type, nodeId });

const NODES: Array<[string, string]> = [
	["matrix", "Matrix of a linear map"],
	["kernel", "Kernel and image"],
	["rank", "Rank–nullity"],
	["basis", "Change of basis"],
	["similar", "Similar matrices"],
];

/** Unit 2's teaching: a solid check, a check that ends wrong after a right
 *  one (and an ignored prediction), a low-confidence right check, free
 *  recall only, and a node never reached. */
function linearMapsTeaching(): LhMessage[] {
	return [
		...asked("done", "probe_done", {}, { ok: true }),
		...asked("plan", "plan_init", { mermaid: "graph TD" }, { ok: true, tree: { nodes: NODES.map(([id, title]) => ({ id, title })), edges: [], version: 1 } }),
		...asked("q1", "quiz", quiz("check", "matrix"), choice(10, { questionType: "check", correct: true, confidence: 90 })),
		...asked("q2", "quiz", quiz("predict", "kernel"), choice(11, { questionType: "predict", correct: false, confidence: 50 })),
		...asked("q3", "quiz", quiz("check", "kernel"), choice(12, { questionType: "check", correct: true, confidence: 80 })),
		...asked("q4", "quiz", quiz("check", "kernel"), choice(13, { questionType: "check", correct: false, confidence: 60 })),
		...asked("q5", "quiz", quiz("check", "rank"), choice(14, { questionType: "check", correct: true, confidence: 40 })),
		...asked("e1", "explain", { question: "Explain.", correctAnswer: "…", nodeId: "basis" }, recalled(15)),
		...asked("e2", "explain", { question: "Explain again.", correctAnswer: "…", nodeId: "basis" }, recalled(16)),
	];
}

/** Worked by hand from linearMapsTeaching and decision 2. */
const TOPICS: HandoffTopic[] = [
	{ nodeId: "matrix", title: "Matrix of a linear map", status: "solid", reason: "last check right at 90% confidence" },
	{ nodeId: "kernel", title: "Kernel and image", status: "shaky", reason: "last check wrong" },
	{ nodeId: "rank", title: "Rank–nullity", status: "shaky", reason: "last check right at 40% confidence" },
	{ nodeId: "basis", title: "Change of basis", status: "unchecked", reason: "free-recall answers only" },
	{ nodeId: "similar", title: "Similar matrices", status: "not-reached", reason: "not reached" },
];

/** The plan's proposed handoff text, verbatim (its date is the run's). */
const PLAN_HANDOFF_TEXT = `Unit 2 · Linear maps: completed 20 Nov 2026 (early: before the teacher marked the goal reached)
Solid:
- Matrix of a linear map: last check right at 90% confidence
Shaky:
- Kernel and image: last check wrong
- Rank–nullity: last check right at 40% confidence
Not checked by a graded question:
- Change of basis
Not reached (carried forward):
- Similar matrices
Teacher observations (model-written):
- Change of basis looks solid: explained the conjugation correctly twice (judged from free-recall answers)
- Also shaky: mixes up column space and row space for non-square matrices
- Misconception repaired: thought every linear map is invertible; fixed with the projection example
- Carry forward: wants more 3×3 practice`;

const OBSERVATIONS = {
	judged: [{ nodeId: "basis", status: "solid", reason: "explained the conjugation correctly twice" }],
	alsoShaky: ["mixes up column space and row space for non-square matrices"],
	misconceptionsRepaired: ["thought every linear map is invertible; fixed with the projection example"],
	carriedForward: ["wants more 3×3 practice"],
};

const VECTORS: CourseUnit = {
	id: "vectors", title: "Vectors and span", goal: "Work with span.", prerequisites: [], status: "completed", chatId: "chat_vectors_done",
	completion: "confirmed", completedAt: "2026-11-19T12:00:00.000Z",
	handoff: { writtenAt: "2026-11-19T12:00:00.000Z", completion: "confirmed", topics: [{ nodeId: "span", title: "Span", status: "solid", reason: "last check right at 90% confidence" }], writer: { status: "ready" }, observations: { judged: [], alsoShaky: [], misconceptionsRepaired: [], carriedForward: [] } },
};

let counter = 0;
/** A four-unit course whose unit 2 (Linear maps) has started and taught. */
function taughtUnit(): { courseId: string; chatId: string } {
	const course: CourseRecord = {
		id: `course_done_${++counter}`, title: "Linear algebra", goal: "Understand eigenvectors.",
		createdAt: "2026-11-13T09:00:00.000Z", updatedAt: "2026-11-13T09:00:00.000Z", setupChatId: "chat_setup_none",
		units: [
			VECTORS,
			{ id: "linear-maps", title: "Linear maps", goal: "Represent linear maps as matrices.", prerequisites: ["vectors"], status: "not-started" },
			{ id: "eigen", title: "Eigenvectors", goal: "Diagonalize a matrix.", prerequisites: ["linear-maps"], status: "not-started" },
			{ id: "det", title: "Determinants", goal: "Compute determinants.", prerequisites: [], status: "not-started" },
		],
		proposals: [], evidence: [],
	};
	courseStore.create(course);
	const started = courses.startUnit(course.id, "linear-maps");
	assert.ok(started.ok);
	const chat = chatStore.getChat(started.chatId)!;
	chatStore.saveMessages(chat.id, [...chat.messages, ...linearMapsTeaching()]);
	chatStore.saveTree(chat.id, { nodes: NODES.map(([id, title]) => ({ id, title })), edges: [], version: 1 });
	return { courseId: course.id, chatId: started.chatId };
}

const unitOf = (courseId: string, unitId = "linear-maps") => courseStore.get(courseId)!.units.find((unit) => unit.id === unitId)!;

// ─── the writer's engine (faux) ─────────────────────────────────────────────

function scripted(steps: FauxResponseStep[]) {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	const requests: TranscriptContext[] = [];
	const engine: PiEngine = {
		model: faux.getModel(), level: "off",
		streamFn: (model, context, options) => {
			requests.push(structuredClone(context));
			return faux.streamSimple(model, context, options);
		},
	} as PiEngine;
	return { engine, requests };
}

let calls = 0;
const submit = (args: object) => fauxAssistantMessage([fauxToolCall("submit_handoff", args as never, { id: `h${++calls}` })], { stopReason: "toolUse" });
/** A model call that waits until the writer is stopped. */
const untilStopped: FauxResponseStep = async (_context, options) => {
	await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }));
	throw Object.assign(new Error("aborted"), { name: "AbortError" });
};

function useEngine(engine: PiEngine) {
	handoffs.handoffServiceSeams.buildEngine = () => engine;
}

async function settledHandoff(courseId: string, unitId = "linear-maps"): Promise<UnitHandoff> {
	for (let i = 0; i < 400; i++) {
		if (!handoffs.isHandoffWriterRunning(courseId, unitId)) return unitOf(courseId, unitId).handoff!;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("handoff writer never settled");
}

function userText(context: TranscriptContext): string {
	return context.messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("")).join("\n");
}
function toolResultTexts(context: TranscriptContext): string {
	return context.messages.flatMap((m) => m.role === "toolResult" ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])) : []).join("\n");
}

const params = (id: string, unitId = "linear-maps") => ({ params: Promise.resolve({ id, unitId }) });
const post = (body?: unknown) => new Request("http://test", { method: "POST", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });

// ─── completing ─────────────────────────────────────────────────────────────

describe("completing a unit", () => {
	it("records an early finish before the goal signal and a confirmed one after it, with the computed topics, the event, and progress.md", async () => {
		useEngine(scripted([submit(OBSERVATIONS), submit(OBSERVATIONS)]).engine);
		const { courseId, chatId } = taughtUnit();

		const response = await completeRoute.POST(post(), params(courseId));
		assert.equal(response.status, 200);
		const early = unitOf(courseId);
		assert.equal(early.status, "completed");
		assert.equal(early.completion, "early");
		assert.equal(early.handoff!.completion, "early");
		assert.equal(early.handoff!.writtenAt, early.completedAt);
		assert.deepEqual(early.handoff!.topics, TOPICS, "decision 2 on the hand-built session");
		const completed = courseStore.get(courseId)!.evidence.filter((e) => e.type === "unit-completed");
		assert.deepEqual(completed.map((e) => [e.id, (e as { completion: string }).completion]), [[`unit-completed:${chatId}:1`, "early"]]);
		const progress = fs.readFileSync(path.join(TMP, "courses", courseId, "progress.md"), "utf8");
		assert.match(progress, new RegExp(`\\| 2 \\| Linear maps \\| Completed ${core.courseDate(early.completedAt!)} \\| 1 \\|`));
		assert.match(progress, /### 2\. Linear maps\nUnit 2 · Linear maps: completed .* \(early: before the teacher marked the goal reached\)/);
		await settledHandoff(courseId);

		// Reopened, then the teacher signals: the next completion is confirmed.
		assert.ok(!courses.isCourseRefusal(courses.reopenUnit(courseId, "linear-maps")));
		assert.equal(courses.recordGoalReached(courseId, "linear-maps", chatId, "goal-1", "Can represent maps as matrices."), null);
		const again = courses.completeUnit(courseId, "linear-maps");
		assert.ok(again.ok);
		const confirmed = unitOf(courseId);
		assert.equal(confirmed.completion, "confirmed");
		assert.equal(confirmed.handoff!.completion, "confirmed");
		assert.deepEqual(courseStore.get(courseId)!.evidence.filter((e) => e.type === "unit-completed").map((e) => [e.id, (e as { completion: string }).completion]),
			[[`unit-completed:${chatId}:1`, "early"], [`unit-completed:${chatId}:2`, "confirmed"]]);
		await settledHandoff(courseId);
	});

	it("keeps completion and computed topics when the handoff engine can't be constructed, and can retry after the model is restored", async () => {
		const { courseId, chatId } = taughtUnit();
		// Disconnecting a custom endpoint keeps saved model selections.
		settingsStore.writeSettings({ ...structuredClone(SETTINGS), agent: { models: { handoffWriter: { model: { provider: "custom", id: "unavailable-model" } } } } } as never);
		try {
			const response = await completeRoute.POST(post(), params(courseId));
			assert.equal(response.status, 200);
			const body = await response.json();
			const completed = body.course.units.find((unit: CourseUnit) => unit.id === "linear-maps");
			assert.equal(completed.status, "completed");
			assert.deepEqual(completed.handoff.topics, TOPICS);
			assert.deepEqual(completed.handoff.writer, { status: "failed", error: "custom catalog has no model unavailable-model" });
			assert.deepEqual(unitOf(courseId).handoff, completed.handoff, "the failure is persisted with the computed part");
			assert.equal(handoffs.isHandoffWriterRunning(courseId, "linear-maps"), false);
			assert.deepEqual(courseStore.get(courseId)!.evidence.filter((event) => event.type === "unit-completed").map((event) => event.id), [`unit-completed:${chatId}:1`]);
			assert.match(fs.readFileSync(path.join(TMP, "courses", courseId, "progress.md"), "utf8"), /Matrix of a linear map: last check right at 90% confidence/);

			settingsStore.writeSettings(structuredClone(SETTINGS) as never);
			useEngine(scripted([submit(OBSERVATIONS)]).engine);
			assert.equal((await handoffRoute.POST(post(), params(courseId))).status, 200);
			assert.equal((await settledHandoff(courseId)).writer.status, "ready");
			assert.equal(courseStore.get(courseId)!.evidence.filter((event) => event.type === "unit-completed").length, 1);
		} finally {
			settingsStore.writeSettings(structuredClone(SETTINGS) as never);
		}
	});

	it("refuses while a turn or a background job runs in the unit, but not while a note is being written", async () => {
		const { courseId, chatId } = taughtUnit();
		const message = { ok: false, status: 409, error: "Wait for the running work to finish, then complete the unit." };

		assert.ok(beginTurn(chatId));
		try { assert.deepEqual(courses.completeUnit(courseId, "linear-maps"), message); }
		finally { endTurn(chatId); }

		const job = jobStore.createJob({ kind: "research", chatId, toolCallId: "tc_research" });
		assert.deepEqual(courses.completeUnit(courseId, "linear-maps"), message);
		jobStore.updateJob(job.id, { status: "done" });
		assert.equal(unitOf(courseId).status, "in-progress", "a refusal changes nothing");

		// A note writer still writing doesn't block.
		let releaseNote!: () => void;
		const noteGate = new Promise<void>((resolve) => { releaseNote = resolve; });
		const note = scripted([async () => { await noteGate; throw new Error("note writer released"); }]);
		notes.noteServiceSeams.buildEngine = () => note.engine;
		const created = notes.createNote(chatId, {});
		assert.ok(created.ok);
		useEngine(scripted([submit(OBSERVATIONS)]).engine);
		try {
			const outcome = courses.completeUnit(courseId, "linear-maps");
			assert.ok(outcome.ok, "completes while the note is written");
		} finally {
			releaseNote();
		}
		await settledHandoff(courseId);

		const done = await completeRoute.POST(post(), params(courseId));
		assert.equal(done.status, 409);
		assert.equal((await done.json()).error, "This unit is already completed.");
		const notStarted = await completeRoute.POST(post(), params(courseId, "eigen"));
		assert.equal(notStarted.status, 409);
		assert.equal((await notStarted.json()).error, "This unit hasn't started yet.");
	});

	it("starts the note writer from the completion only when the note is offered", async () => {
		for (const offered of [false, true]) {
			notes.noteServiceSeams.buildEngine = () => scripted([fauxAssistantMessage([fauxToolCall("submit_note", { title: "Linear maps", body: "<p>Maps.</p>" }, { id: `n${++calls}` })], { stopReason: "toolUse" })]).engine;
			useEngine(scripted([submit(OBSERVATIONS)]).engine);
			const { courseId, chatId } = taughtUnit();
			const response = await completeRoute.POST(post(offered ? { note: { instruction: "only kernels", interactive: true } } : {}), params(courseId));
			assert.equal(response.status, 200);
			const listed = notes.listNotes(chatId);
			assert.equal(listed.length, offered ? 1 : 0);
			if (offered) assert.deepEqual([listed[0]!.instruction, listed[0]!.interactive], ["only kernels", true]);
			await settledHandoff(courseId);
		}
	});

	it("returns the completed unit and a note error when the optional note engine can't be built, while still downloading the export", async () => {
		const { courseId, chatId } = taughtUnit();
		useEngine(scripted([submit(OBSERVATIONS)]).engine);
		settingsStore.writeSettings({ ...structuredClone(SETTINGS), agent: { models: { noteWriter: { model: { provider: "custom", id: "unavailable-model" } } } } } as never);
		try {
			const responses: number[] = [];
			const fetch = (async (url: string, init?: RequestInit) => {
				const request = new Request(new URL(url, "http://test"), init);
				const response = url.endsWith("/complete")
					? await completeRoute.POST(request, params(courseId))
					: await exportRoute.GET(request, { params: Promise.resolve({ id: chatId }) });
				responses.push(response.status);
				return response;
			}) as typeof globalThis.fetch;
			const downloads: Blob[] = [];
			const outcome = await runUnitCompletion({ courseId, unitId: "linear-maps", chatId }, { ...EMPTY_FORM, note: true, exportConversation: true }, {
				fetch, download: (blob) => downloads.push(blob),
			});
			assert.ok(outcome.ok);
			assert.equal(outcome.noteError, "custom catalog has no model unavailable-model");
			assert.equal(outcome.exportError, undefined);
			assert.equal(outcome.course.units.find((unit) => unit.id === "linear-maps")!.status, "completed");
			assert.equal(unitOf(courseId).status, "completed");
			assert.equal(courseStore.get(courseId)!.evidence.filter((event) => event.type === "unit-completed").length, 1);
			assert.deepEqual(responses, [200, 200]);
			assert.equal(downloads.length, 1);
			assert.match(await downloads[0]!.text(), /<!doctype html>/i);
			assert.equal(notes.listNotes(chatId).length, 0);
		} finally {
			settingsStore.writeSettings(structuredClone(SETTINGS) as never);
			await settledHandoff(courseId);
		}
	});
});

// ─── the handoff writer ─────────────────────────────────────────────────────

describe("the handoff writer", () => {
	it("refuses a judgment of a checked topic back to the model, then stores the plan's handoff text", async () => {
		const { engine, requests } = scripted([
			submit({ ...OBSERVATIONS, judged: [{ nodeId: "kernel", status: "solid", reason: "seemed fine" }] }),
			submit(OBSERVATIONS),
		]);
		useEngine(engine);
		const { courseId } = taughtUnit();
		assert.ok(courses.completeUnit(courseId, "linear-maps").ok);
		assert.equal(unitOf(courseId).handoff!.writer.status, "writing");
		const handoff = await settledHandoff(courseId);

		assert.equal(handoff.writer.status, "ready");
		assert.deepEqual(handoff.observations, OBSERVATIONS);
		assert.deepEqual(handoff.topics, TOPICS, "the computed part is untouched");
		assert.equal(handoff.writer.usage?.steps, 2);
		assert.equal(handoff.writer.model, handoff.writer.usage?.model);
		const unit = unitOf(courseId);
		assert.equal(core.handoffText(2, unit, handoff), PLAN_HANDOFF_TEXT.replace("20 Nov 2026", core.courseDate(unit.completedAt!)));

		// What the writer read: the course and unit, the completion, the topic
		// table with each topic's answers, and the session.
		assert.equal(requests.length, 2);
		const input = userText(requests[0]!);
		assert.match(input, /Course: Linear algebra\nCourse goal: Understand eigenvectors\./);
		assert.match(input, /Unit 2: Linear maps\nUnit goal: Represent linear maps as matrices\.\nCompleted: early, before the teacher marked the goal reached/);
		assert.match(input, /- Kernel and image \(id kernel\): shaky \(last check wrong\)\n {2}Answers, oldest first: predict wrong at 50% confidence; check right at 80% confidence; check wrong at 60% confidence/);
		assert.match(input, /- Change of basis \(id basis\): no graded check \(free-recall answers only\)\n {2}Answers, oldest first: question, free recall, ungraded; question, free recall, ungraded\n/);
		assert.match(input, /- Similar matrices \(id similar\): not reached\n/);
		assert.match(input, /Topics you may judge in `judged` \(no graded check\): basis/);
		assert.match(input, /<session>[\s\S]*Conjugate by the basis change\.[\s\S]*<\/session>/);
		assert.match(toolResultTexts(requests[1]!), /"Kernel and image" \(kernel\) was rated shaky by the app, so it can't be judged\. Judge only topics with no graded check: basis\./);
		assert.match(JSON.stringify(requests[0]!.messages.filter((m) => (m.role as string) === "system")), /You write the handoff for one completed unit of a learner's course\./);
	});

	it("refuses an item over 200 characters back to the model and accepts one of exactly 200", async () => {
		const long = "x".repeat(201);
		const { engine, requests } = scripted([submit({ ...OBSERVATIONS, carriedForward: [long] }), submit({ ...OBSERVATIONS, carriedForward: ["y".repeat(200)] })]);
		useEngine(engine);
		const { courseId } = taughtUnit();
		assert.ok(courses.completeUnit(courseId, "linear-maps").ok);
		const handoff = await settledHandoff(courseId);
		assert.equal(handoff.writer.status, "ready");
		assert.deepEqual(handoff.observations!.carriedForward, ["y".repeat(200)]);
		assert.match(toolResultTexts(requests[1]!), /An item in `carriedForward` is longer than 200 characters/);
	});

	it("keeps the computed part when the writer fails or gives up, and shows no observations", async () => {
		// Gives up: four refused submissions exhaust the three fixes.
		const bad = { ...OBSERVATIONS, judged: [{ nodeId: "matrix", status: "solid", reason: "x" }] };
		useEngine(scripted([submit(bad), submit(bad), submit(bad), submit(bad)]).engine);
		const first = taughtUnit();
		assert.ok(courses.completeUnit(first.courseId, "linear-maps").ok);
		const gaveUp = await settledHandoff(first.courseId);
		assert.equal(gaveUp.writer.status, "failed");
		assert.equal(gaveUp.writer.error, "The handoff writer stopped without producing observations it could save.");
		assert.deepEqual(gaveUp.topics, TOPICS);
		assert.equal(gaveUp.observations, undefined);
		assert.doesNotMatch(core.handoffText(2, unitOf(first.courseId), gaveUp), /Teacher observations/);

		// Fails: the writer throws.
		handoffs.handoffServiceSeams.write = async () => { throw new Error("The provider is down."); };
		const second = taughtUnit();
		assert.ok(courses.completeUnit(second.courseId, "linear-maps").ok);
		const failed = await settledHandoff(second.courseId);
		assert.deepEqual([failed.writer.status, failed.writer.error], ["failed", "The provider is down."]);
		assert.deepEqual(failed.topics, TOPICS);
	});

	it("stops from Background agents, keeps the computed part, and Try again writes it", async () => {
		// A refused first submission gives the row live usage, then the writer waits.
		useEngine(scripted([submit({ ...OBSERVATIONS, judged: [{ nodeId: "matrix", status: "shaky", reason: "x" }] }), untilStopped]).engine);
		const { courseId, chatId } = taughtUnit();
		assert.ok(courses.completeUnit(courseId, "linear-maps").ok);
		let row: ReturnType<typeof activityFeed>["handoffWriters"][number] | undefined;
		for (let i = 0; i < 200 && !row?.usage; i++) {
			row = activityFeed().handoffWriters.find((r) => r.courseId === courseId);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(row?.title, "Handoff · Linear maps");
		assert.equal(row?.chatId, chatId);
		assert.equal(row?.activity, "Writing");
		assert.equal(row?.usage?.steps, 1, "live usage after the first model call");
		assert.ok("costUsd" in row!);

		const stopped = await abortRoute.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ kind: "handoff-writer", id: row!.id }) }));
		assert.equal(stopped.status, 200);
		const afterStop = await settledHandoff(courseId);
		assert.deepEqual([afterStop.writer.status, afterStop.writer.error, afterStop.writer.stopped], ["failed", "Stopped", true]);
		assert.deepEqual(afterStop.topics, TOPICS);
		assert.equal(activityFeed().handoffWriters.some((r) => r.courseId === courseId), false);
		const nothing = await abortRoute.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ kind: "handoff-writer", id: row!.id }) }));
		assert.equal(nothing.status, 409);

		useEngine(scripted([submit(OBSERVATIONS)]).engine);
		const retried = await handoffRoute.POST(post(), params(courseId));
		assert.equal(retried.status, 200);
		const written = await settledHandoff(courseId);
		assert.equal(written.writer.status, "ready");
		assert.equal(written.writer.error, undefined);
		assert.equal(written.writer.stopped, undefined);
		assert.equal(written.writtenAt, afterStop.writtenAt, "the same handoff, written again");
		assert.deepEqual(written.observations, OBSERVATIONS);
		const twice = await handoffRoute.POST(post(), params(courseId));
		assert.equal(twice.status, 409);
		assert.equal((await twice.json()).error, "The teacher observations are already written.");
	});

	it("reads a writer left writing by a closed app as interrupted, without touching updatedAt, and Try again recovers it", async () => {
		const course: CourseRecord = {
			id: `course_done_${++counter}`, title: "Linear algebra", goal: "g", createdAt: "2026-11-13T09:00:00.000Z", updatedAt: "2026-11-13T09:00:00.000Z",
			setupChatId: "chat_setup_none", units: [{ ...VECTORS, handoff: { ...VECTORS.handoff!, observations: undefined, writer: { status: "writing" } } }], proposals: [], evidence: [],
		};
		courseStore.create(course);
		const before = courseStore.get(course.id)!.updatedAt;
		const read = courses.readCourse(course.id);
		assert.ok(!courses.isCourseRefusal(read));
		assert.deepEqual(read.units[0]!.handoff!.writer, { status: "failed", error: "Interrupted when the app closed" });
		assert.equal(courseStore.get(course.id)!.updatedAt, before);

		const chat = chatStore.createChat("Vectors", undefined, { role: "unit", courseId: course.id, unitId: "vectors" });
		courseStore.update(course.id, (current) => ({ ...current, units: [{ ...current.units[0]!, chatId: chat.id }] }));
		useEngine(scripted([submit({ ...OBSERVATIONS, judged: [] })]).engine);
		const retried = courses.retryHandoffWriter(course.id, "vectors");
		assert.ok(!courses.isCourseRefusal(retried));
		assert.equal((await settledHandoff(course.id, "vectors")).writer.status, "ready");
	});

	it("resolves its engine through handoffWriter from the Strong slot, with purpose user, in the worker pool", async () => {
		const built: unknown[][] = [];
		let activeDuringRequest = -1;
		const pool = () => (globalThis as Record<symbol, { active: number } | undefined>)[Symbol.for("lh.worker-request-admission.pool.v1")];
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		faux.setResponses([submit(OBSERVATIONS)]);
		handoffs.handoffServiceSeams.buildEngine = (...args) => {
			built.push(args);
			return { model: faux.getModel(), level: "off", streamFn: (model, context, options) => { activeDuringRequest = pool()?.active ?? -1; return faux.streamSimple(model, context, options); } } as PiEngine;
		};
		const { courseId } = taughtUnit();
		assert.ok(courses.completeUnit(courseId, "linear-maps").ok);
		assert.equal((await settledHandoff(courseId)).writer.status, "ready");
		assert.equal(built.length, 1);
		const [spec, background] = built[0]!;
		assert.deepEqual({ provider: (spec as { provider: string }).provider, id: (spec as { id: string }).id }, { provider: "test", id: "strong-model" });
		assert.equal(background, false, "the learner completed the unit: purpose user, not background");
		assert.ok(activeDuringRequest >= 1, "the request held a worker-pool permit");

		// An override for the role wins over the Strong slot.
		settingsStore.writeSettings({ ...structuredClone(SETTINGS), agent: { models: { handoffWriter: { model: { provider: "test", id: "override-model" } } } } } as never);
		try {
			handoffs.handoffWriterEngine();
			assert.equal((built.at(-1)![0] as { id: string }).id, "override-model");
		} finally {
			settingsStore.writeSettings(structuredClone(SETTINGS) as never);
		}
	});

	it("without a Strong model, completes with the writer failed at once, and Try again says why", async () => {
		const { courseId } = taughtUnit();
		settingsStore.writeSettings({ version: 1 } as never);
		try {
			assert.ok(courses.completeUnit(courseId, "linear-maps").ok);
			const unit = unitOf(courseId);
			assert.equal(unit.status, "completed");
			assert.deepEqual(unit.handoff!.writer, { status: "failed", error: "No model configured — set up your models first" });
			assert.deepEqual(unit.handoff!.topics, TOPICS);
			const retried = await handoffRoute.POST(post(), params(courseId));
			assert.equal(retried.status, 503);
		} finally {
			settingsStore.writeSettings(structuredClone(SETTINGS) as never);
		}
	});
});

// ─── reopening ──────────────────────────────────────────────────────────────

describe("reopening a unit", () => {
	it("clears the signal, keeps the old handoff for later units, records the event, and stops a running writer", async () => {
		useEngine(scripted([untilStopped]).engine);
		const { courseId, chatId } = taughtUnit();
		assert.equal(courses.recordGoalReached(courseId, "linear-maps", chatId, "goal-1", "Done."), null);
		assert.ok(courses.completeUnit(courseId, "linear-maps").ok);
		const handoff = unitOf(courseId).handoff!;
		assert.ok(handoffs.isHandoffWriterRunning(courseId, "linear-maps"));

		const response = await reopenRoute.POST(post(), params(courseId));
		assert.equal(response.status, 200);
		const unit = unitOf(courseId);
		assert.equal(unit.status, "in-progress");
		assert.equal(unit.goalReachedAt, undefined);
		assert.equal(unit.completion, undefined);
		assert.equal(unit.completedAt, undefined);
		assert.equal(unit.handoff!.writtenAt, handoff.writtenAt, "the old handoff stays");
		const settled = await settledHandoff(courseId);
		assert.deepEqual([settled.writer.status, settled.writer.stopped], ["failed", true], "the running writer was stopped");
		assert.ok(courseStore.get(courseId)!.evidence.some((e) => e.type === "unit-reopened" && e.id === `unit-reopened:${chatId}:1`));

		// Unit 3 builds on it: its course section keeps the last handoff.
		const context = core.unitCourseContext(courseStore.get(courseId)!, "eigen");
		assert.match(context, /Unit 2 · Linear maps was reopened and is in progress\. Its last handoff:\nUnit 2 · Linear maps: completed /);
		// The session takes input again.
		assert.equal(courses.courseInputRefusal(chatStore.getChat(chatId)!, "message"), null);

		const again = await reopenRoute.POST(post(), params(courseId));
		assert.equal(again.status, 409);
		assert.equal((await again.json()).error, "This unit isn't completed.");
	});
});

// ─── the dialog and the next unit ───────────────────────────────────────────

describe("the completion dialog", () => {
	const target = { courseId: "course_x", unitId: "linear-maps", chatId: "chat_u" };
	const course = { id: "course_x", units: [] } as unknown as CourseRecord;

	function fakeFetch() {
		const seen: Array<{ url: string; body?: string }> = [];
		const fetch = (async (url: string, init?: RequestInit) => {
			seen.push({ url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
			if (url.endsWith("/complete")) return Response.json({ course });
			return new Response("<html></html>", { headers: { "content-disposition": 'attachment; filename="linear-algebra-2-linear-maps.html"' } });
		}) as typeof globalThis.fetch;
		return { fetch, seen };
	}

	it("sends the note offer and downloads the export only when checked", async () => {
		for (const form of [EMPTY_FORM, { ...EMPTY_FORM, note: true, instruction: "only kernels", interactive: true }, { ...EMPTY_FORM, exportConversation: true }]) {
			const { fetch, seen } = fakeFetch();
			const downloads: string[] = [];
			const outcome = await runUnitCompletion(target, form, { fetch, download: (_blob, name) => downloads.push(name) });
			assert.ok(outcome.ok);
			assert.equal(seen[0]!.url, "/api/courses/course_x/units/linear-maps/complete");
			assert.deepEqual(JSON.parse(seen[0]!.body!), form.note ? { note: { instruction: "only kernels", interactive: true } } : {});
			assert.deepEqual(seen.slice(1).map((s) => s.url), form.exportConversation ? ["/api/chats/chat_u/export.html"] : []);
			assert.deepEqual(downloads, form.exportConversation ? ["linear-algebra-2-linear-maps.html"] : []);
		}
	});

	it("keeps the dialog's form on a refusal and runs no offer", async () => {
		const seen: string[] = [];
		const fetch = (async (url: string) => { seen.push(url); return Response.json({ error: "Wait for the running work to finish, then complete the unit." }, { status: 409 }); }) as typeof globalThis.fetch;
		const outcome = await runUnitCompletion(target, { ...EMPTY_FORM, exportConversation: true }, { fetch, download: () => assert.fail("no download") });
		assert.deepEqual(outcome, { ok: false, error: "Wait for the running work to finish, then complete the unit." });
		assert.equal(seen.length, 1);
	});

	it("renders both forms: the early sentence only before the goal signal, and the note box once offered", () => {
		const noop = () => {};
		const early = renderToStaticMarkup(<CompleteUnitForm view={{ number: 2, unitTitle: "Linear maps" }} form={EMPTY_FORM} busy={false} onChange={noop} onCancel={noop} onConfirm={noop} />);
		assert.match(early, /Complete this unit\?/);
		assert.match(early, /2\. Linear maps/);
		assert.match(early, /The teacher hasn&#x27;t marked the goal as reached\. This is recorded as an early finish\./);
		assert.match(early, />Generate a note</);
		assert.match(early, />Export full conversation</);
		assert.match(early, />Cancel</);
		assert.match(early, />Complete unit</);
		assert.doesNotMatch(early, /data-testid="complete-note-box"/);
		assert.doesNotMatch(early, /checked=""/, "both offers are off by default");

		const confirmed = renderToStaticMarkup(<CompleteUnitForm view={{ number: 2, unitTitle: "Linear maps", goalReachedAt: "2026-11-20T10:00:00.000Z" }} form={{ ...EMPTY_FORM, note: true }} busy={false} onChange={noop} onCancel={noop} onConfirm={noop} />);
		assert.doesNotMatch(confirmed, /early finish/);
		assert.match(confirmed, /data-testid="complete-note-box"/);
		assert.match(confirmed, /data-testid="note-instruction"/);
		assert.match(confirmed, /Interactive \(widgets with scripts\)/);

		const refused = renderToStaticMarkup(<CompleteUnitForm view={{ number: 2, unitTitle: "Linear maps" }} form={EMPTY_FORM} busy={false} error="Wait for the running work to finish, then complete the unit." onChange={noop} onCancel={noop} onConfirm={noop} />);
		assert.match(refused, /role="alert"[^>]*>Wait for the running work to finish, then complete the unit\./);
	});

	it("offers the first unit that hasn't started, skipping started ones, and only Back to course when none is left", () => {
		const units = (statuses: CourseUnit["status"][]): CourseUnit[] => statuses.map((status, i) => ({ id: `u${i + 1}`, title: `Unit ${i + 1} title`, goal: "g", prerequisites: [], status }));
		assert.equal(core.nextUnitOffer(units(["completed", "completed", "not-started", "not-started"]))!.number, 3);
		const skipped = core.nextUnitOffer(units(["completed", "completed", "in-progress", "not-started"]))!;
		assert.deepEqual([skipped.number, skipped.unit.id], [4, "u4"]);
		assert.equal(core.nextUnitOffer(units(["completed", "in-progress"])), null);

		const html = renderToStaticMarkup(<UnitCompletedBody courseId="course_x" next={{ number: 3, title: "Eigenvectors" }} starting={false} onOpenNext={() => {}} />);
		assert.match(html, /Unit completed\./);
		assert.match(html, />Open next unit: 3\. Eigenvectors</);
		assert.match(html, /href="\/course\/course_x"[^>]*>Back to course</);
		const last = renderToStaticMarkup(<UnitCompletedBody courseId="course_x" next={null} noteError="No model configured — set up your models first" starting={false} onOpenNext={() => {}} />);
		assert.doesNotMatch(last, /Open next unit/);
		assert.match(last, /The note couldn&#x27;t be started: No model configured/);
	});

	it("the top bar shows the quiet Unit menu before the signal, Complete unit after, and nothing once completed", () => {
		const noop = () => {};
		const before = renderToStaticMarkup(<UnitCompletionTrigger view={{ status: "in-progress" }} menuOpen={false} onToggleMenu={noop} onOpen={noop} />);
		assert.match(before, /data-testid="unit-menu-trigger"[^>]*>Unit/);
		assert.doesNotMatch(before, /Complete unit/);
		const after = renderToStaticMarkup(<UnitCompletionTrigger view={{ status: "in-progress", goalReachedAt: "2026-11-20T10:00:00.000Z" }} menuOpen={false} onToggleMenu={noop} onOpen={noop} />);
		assert.match(after, /data-testid="unit-complete"[\s\S]*Complete unit/);
		assert.equal(renderToStaticMarkup(<UnitCompletionTrigger view={{ status: "completed", goalReachedAt: "2026-11-20T10:00:00.000Z" }} menuOpen={false} onToggleMenu={noop} onOpen={noop} />), "");
	});
});

// ─── the overview ───────────────────────────────────────────────────────────

describe("the overview's handoff", () => {
	const unit = { completedAt: "2026-11-20T12:00:00.000Z" };
	const handoff: UnitHandoff = { writtenAt: unit.completedAt, completion: "early", topics: TOPICS, observations: OBSERVATIONS as UnitHandoff["observations"], writer: { status: "ready" } };

	it("renders a ready handoff's lists in the agents' words", () => {
		const html = renderToStaticMarkup(<HandoffView unit={unit} handoff={handoff} />);
		assert.match(html, /Completed 20 Nov 2026 \(early: before the teacher marked the goal reached\)/);
		for (const line of PLAN_HANDOFF_TEXT.split("\n").slice(1)) {
			if (line.startsWith("- ")) assert.ok(html.includes(`>${line.slice(2).replace(/&/g, "&amp;")}</li>`), line);
			else assert.ok(html.includes(line.replace(/:$/, "")), line);
		}
		assert.doesNotMatch(html, /data-testid="handoff-writer-status"/);
	});

	it("shows a writing writer, and a failed one with Try again; the computed lists stay", () => {
		const writing = renderToStaticMarkup(<HandoffView unit={unit} handoff={{ ...handoff, observations: undefined, writer: { status: "writing" } }} />);
		assert.match(writing, /Writing the teacher observations…/);
		assert.doesNotMatch(writing, /Teacher observations \(model-written\)/);
		assert.match(writing, /Kernel and image: last check wrong/);
		const failed = renderToStaticMarkup(<HandoffView unit={unit} handoff={{ ...handoff, observations: undefined, writer: { status: "failed", error: "Stopped", stopped: true } }} onRetry={() => {}} />);
		assert.match(failed, /Teacher observations couldn&#x27;t be written: Stopped/);
		assert.match(failed, /data-testid="handoff-retry"[^>]*>Try again</);
		const empty = renderToStaticMarkup(<HandoffView unit={unit} handoff={{ ...handoff, topics: [], observations: undefined }} />);
		assert.match(empty, /No plan topics were recorded\./);
	});

	it("a completed unit's card offers Open and Reopen unit, with its Handoff disclosure closed by default", () => {
		const completed: CourseUnit = { id: "linear-maps", title: "Linear maps", goal: "g", prerequisites: [], status: "completed", chatId: "chat_u", completedAt: unit.completedAt, handoff };
		const html = renderToStaticMarkup(<UnitCard unit={completed} courseId="course_c" number={2} numberOf={new Map()} onReopen={() => {}} extra={<HandoffDisclosure unit={completed} handoff={handoff} />} />);
		assert.match(html, /data-testid="unit-open"[^>]*>Open</);
		assert.match(html, /data-testid="unit-reopen"[^>]*>Reopen unit</);
		assert.match(html, /data-testid="handoff-toggle" aria-expanded="false"/);
		assert.doesNotMatch(html, /data-testid="unit-handoff"/);
		const opened = renderToStaticMarkup(<HandoffDisclosure unit={completed} handoff={handoff} defaultOpen />);
		assert.match(opened, /data-testid="unit-handoff"/);
		const inProgress = renderToStaticMarkup(<UnitCard unit={{ ...completed, status: "in-progress" }} courseId="course_c" number={2} numberOf={new Map()} onReopen={() => {}} />);
		assert.doesNotMatch(inProgress, /Reopen unit/);
	});
});
