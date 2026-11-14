/**
 * Plan 04 item 4: unit sessions and their agent context. Starting a unit
 * (the record, the graph folder placement and its reuse, the click as
 * foreground learner input, a refused second start), the per-turn course
 * section for the unit's prober and teacher (hand-written expected text;
 * absent elsewhere; fresh when a prerequisite is reopened), goal_reached,
 * the closed-unit gate, the prerequisite warning, and the unit chrome's
 * renders. Fakes only (pi-ai's faux provider); an isolated LH_DATA_DIR is
 * set before any config-loading import.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it, mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type AssistantMessage,
	type FauxResponseFactory,
	type FauxResponseStep,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-units-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { courseStore } = await import("../src/store/courses.ts");
const { sourceOrganizationStore } = await import("../src/store/source-organization.ts");
const { createProberAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { PROBER_UNIT_DOCTRINE, TEACHER_UNIT_DOCTRINE } = await import("../src/agent/course-prompts.ts");
const { handleChatRequest, handleChatInput } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { dynamicPromptEstimate } = await import("../src/server/compaction.ts");
const courses = await import("../src/server/courses.ts");
const core = await import("../src/core/index.ts");
const startRoute = await import("../app/api/courses/[id]/units/[unitId]/start/route.ts");
const { CourseClosedBand, GoalReachedLine, UnitBreadcrumb, UnitStartedLine, courseSessionClosed } = await import("../components/course-session.tsx");
const { UnitStartWarning } = await import("../components/course-overview.tsx");
type PiEngine = import("../src/agent/models.ts").PiEngine;
type LhMessage = import("../src/core/native-messages.ts").LhMessage;
type CourseRecord = import("../src/core/contracts/course.ts").CourseRecord;
type CourseUnit = import("../src/core/contracts/course.ts").CourseUnit;
type UnitHandoff = import("../src/core/contracts/course.ts").UnitHandoff;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ─── fixtures ───────────────────────────────────────────────────────────────

const VECTORS_HANDOFF: UnitHandoff = {
	writtenAt: "2026-11-20T12:00:00.000Z", completion: "confirmed",
	topics: [
		{ nodeId: "span", title: "Span", status: "solid", reason: "last check right at 90% confidence" },
		{ nodeId: "basis", title: "Basis", status: "shaky", reason: "last check wrong" },
	],
	observations: { judged: [], alsoShaky: [], misconceptionsRepaired: ["thought span meant the sum; fixed with the plane example"], carriedForward: [] },
	writer: { status: "ready" },
};
const MAPS_HANDOFF: UnitHandoff = {
	writtenAt: "2026-11-21T12:00:00.000Z", completion: "early",
	topics: [{ nodeId: "kernel", title: "Kernel", status: "not-reached", reason: "not reached" }],
	writer: { status: "writing" },
};
const DET_HANDOFF: UnitHandoff = {
	writtenAt: "2026-11-22T12:00:00.000Z", completion: "confirmed",
	topics: [{ nodeId: "area", title: "Signed area", status: "solid", reason: "last check right at 80% confidence" }],
	writer: { status: "ready" }, observations: { judged: [], alsoShaky: [], misconceptionsRepaired: [], carriedForward: ["wants 3×3 practice"] },
};

/** Five units: eigen (4) builds on maps (2), which builds on vectors (1);
 *  det (3) is unrelated to eigen; jordan (5) builds on eigen and det. */
function fiveUnits(eigenChat?: string): CourseUnit[] {
	return [
		{ id: "vectors", title: "Vectors and span", goal: "Work with span.", prerequisites: [], status: "completed", chatId: "chat_v", completion: "confirmed", completedAt: "2026-11-20T12:00:00.000Z", handoff: VECTORS_HANDOFF },
		{ id: "maps", title: "Linear maps", goal: "Matrices as maps.", prerequisites: ["vectors"], status: "completed", chatId: "chat_m", completion: "early", completedAt: "2026-11-21T12:00:00.000Z", handoff: MAPS_HANDOFF },
		{ id: "det", title: "Determinants", goal: "Compute determinants.", prerequisites: [], status: "completed", chatId: "chat_d", completion: "confirmed", completedAt: "2026-11-22T12:00:00.000Z", handoff: DET_HANDOFF },
		{ id: "eigen", title: "Eigenvectors", goal: "Diagonalize a matrix.", startingPoint: "Has seen eigenvalues once.", prerequisites: ["maps"], status: eigenChat ? "in-progress" : "not-started", ...(eigenChat ? { chatId: eigenChat } : {}) },
		{ id: "jordan", title: "Jordan form", goal: "Find the Jordan form.", prerequisites: ["eigen", "det"], status: "not-started" },
	];
}

let counter = 0;
function makeCourse(units: CourseUnit[], extra: Partial<CourseRecord> = {}): CourseRecord {
	const record: CourseRecord = {
		id: `course_unit_${++counter}`, title: "Linear algebra", goal: "Understand eigenvectors.",
		createdAt: "2026-11-13T09:00:00.000Z", updatedAt: "2026-11-13T09:00:00.000Z", setupChatId: "chat_setup",
		units, proposals: [], evidence: [], ...extra,
	};
	courseStore.create(record);
	return record;
}

const PROPOSALS: CourseRecord["proposals"] = [
	{ id: "p1", chatId: "chat_e", unitId: "eigen", toolCallId: "call_p1", at: "2026-11-23T09:00:00.000Z", reason: "Determinants first.", changes: [{ type: "move", unit: "det", after: null }], status: "rejected", decidedAt: "2026-11-23T10:00:00.000Z" },
	{ id: "p2", chatId: "chat_m", unitId: "maps", toolCallId: "call_p2", at: "2026-11-21T09:00:00.000Z", reason: "Not this unit's.", changes: [{ type: "drop", unit: "jordan" }], status: "pending" },
];

/** The course section for unit 4 (eigen), worked by hand from the fixture
 *  and the plan's handoff format. Unit 3 is unrelated: one line, no handoff. */
const EIGEN_CONTEXT = `# Course context

Course: Linear algebra
Course goal: Understand eigenvectors.

This session is unit 4 of 5: Eigenvectors (id eigen).
Unit goal: Diagonalize a matrix.
Starting point (the setup probe's read): Has seen eigenvalues once.

Units (number. id: title, status, builds on):
1. vectors: Vectors and span (completed)
2. maps: Linear maps (completed; builds on 1)
3. det: Determinants (completed)
4. eigen: Eigenvectors (in progress, this unit; builds on 2)
5. jordan: Jordan form (not started; builds on 3, 4)

Handoffs from the units this one builds on, directly or indirectly:

Unit 1 · Vectors and span: completed 20 Nov 2026
Solid:
- Span: last check right at 90% confidence
Shaky:
- Basis: last check wrong
Teacher observations (model-written):
- Misconception repaired: thought span meant the sum; fixed with the plane example

Unit 2 · Linear maps: completed 21 Nov 2026 (early: before the teacher marked the goal reached)
Not reached (carried forward):
- Kernel

Your course-change proposals from this unit:
- Rejected: Determinants first.
  - Move 3 to the start`;

// ─── harness (the setup suite's idiom: faux engine + the handler seam) ──────

function scripted(steps: FauxResponseStep[]) {
	const contexts: TranscriptContext[] = [];
	const faux = createFauxCore({});
	faux.setResponses(steps.map((step) => async (context: TranscriptContext): Promise<AssistantMessage> => {
		contexts.push(context);
		return typeof step === "function" ? await (step as FauxResponseFactory)(context, undefined, undefined as never, undefined as never) : step;
	}));
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple } as PiEngine;
	return { engine, contexts };
}

type Factory = NonNullable<Parameters<typeof handleChatRequest>[1]>;
type BuildOptions = Parameters<Factory>[0];

/** The real prober or teacher, as the handler chose, on the faux engine,
 *  with the handler's options (the course section among them). */
function factory(chatId: string, engine: PiEngine, seen: BuildOptions[] = []): Factory {
	return (opts) => {
		seen.push(opts);
		return opts.agentKind === "teacher"
			? createTeacherAgent({ chatId, chatStore, jobStore, spawn: () => {} }, { ...opts, engine })
			: createProberAgent({ chatId, chatStore, jobStore, deliver: () => {}, spawn: () => {} }, { ...opts, engine });
	};
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, input }) });
}

async function runTurn(chatId: string, input: unknown, build: Factory): Promise<Response> {
	const ack = await handleChatRequest(post(chatId, input), build);
	if (ack.status === 200) {
		const handle = runningTurn(chatId);
		if (handle) await new Response(handle.subscribe()).text();
	}
	return ack;
}

const systemOf = (context: TranscriptContext) => JSON.stringify(context.messages.filter((m) => (m.role as string) === "system"));

/** Change disk truth at the first async boundary after the course is read,
 * without depending on how many synchronous reads preflight makes. */
function changeDuringPreflight(courseId: string, change: (course: CourseRecord) => CourseRecord) {
	const get = courseStore.get;
	let scheduled = false;
	return mock.method(courseStore, "get", (id: string) => {
		const result = get(id);
		if (id === courseId && !scheduled) {
			scheduled = true;
			queueMicrotask(() => courseStore.update(id, change));
		}
		return result;
	});
}

/** A course whose unit 4 (eigen) has started; the session is configured. */
function startedEigen(extra: Partial<CourseRecord> = {}): { course: CourseRecord; chatId: string } {
	const course = makeCourse(fiveUnits(), extra);
	const started = courses.startUnit(course.id, "eigen");
	assert.ok(started.ok);
	chatStore.saveSettings(started.chatId, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return { course, chatId: started.chatId };
}

/** Mark the probe concluded so the handler builds the teacher. */
function concludeProbe(chatId: string): void {
	const messages = chatStore.getChat(chatId)!.messages;
	chatStore.saveMessages(chatId, [
		...messages,
		{ ...fauxAssistantMessage([fauxToolCall("probe_done", {}, { id: "probe-1" })], { stopReason: "toolUse" }), id: "probe-response" } as LhMessage,
		{ id: "probe-result", role: "toolResult", toolCallId: "probe-1", toolName: "probe_done", content: [], details: { ok: true }, isError: false, timestamp: 1 } as LhMessage,
		{ id: "learner-next", role: "user", content: "Let's go on.", timestamp: 2 } as LhMessage,
	]);
}

// ─── starting a unit ────────────────────────────────────────────────────────

describe("starting a unit", () => {
	it("creates the session, records it, and places its source in the course's graph folder, reused by later starts", async () => {
		const course = makeCourse(fiveUnits());
		const response = await startRoute.POST(new Request("http://test", { method: "POST" }), { params: Promise.resolve({ id: course.id, unitId: "eigen" }) });
		assert.equal(response.status, 201);
		const { chatId } = await response.json() as { chatId: string };

		const chat = chatStore.getChat(chatId)!;
		assert.equal(chat.title, "Linear algebra · 4. Eigenvectors");
		assert.deepEqual(chat.course, { role: "unit", courseId: course.id, unitId: "eigen" });
		assert.equal(chat.messages.length, 1);
		const marker = chat.messages[0] as Extract<LhMessage, { role: "custom" }>;
		assert.equal(marker.customType, "unit-start");
		assert.deepEqual(core.toLlmMessages(chat.messages).map((m) => m.content), [[{ type: "text", text: "[Unit start] The learner opened unit 4, Eigenvectors. Begin the unit's probe." }]]);

		const record = courseStore.get(course.id)!;
		assert.equal(record.units[3]!.status, "in-progress");
		assert.equal(record.units[3]!.chatId, chatId);
		assert.deepEqual(record.evidence.map((e) => [e.type, e.id]), [["unit-started", `unit-started:${chatId}`]]);

		const organization = sourceOrganizationStore.read();
		const folder = organization.folders.find((f) => f.id === record.sourceFolderId)!;
		assert.ok(folder, "the course records its graph folder");
		assert.equal(folder.name, "Linear algebra");
		assert.equal(folder.parentId, null);
		assert.equal(organization.placements[chatId]!.folderId, folder.id);

		// The next start reuses the folder: no second folder for this course.
		const jordan = courses.startUnit(course.id, "jordan");
		assert.ok(jordan.ok);
		const after = sourceOrganizationStore.read();
		assert.equal(after.folders.filter((f) => f.name === "Linear algebra").length, 1);
		assert.equal(after.placements[jordan.chatId]!.folderId, folder.id);
		assert.equal(courseStore.get(course.id)!.sourceFolderId, folder.id);
	});

	it("recreates the folder when the learner removed it, and leaves a source the learner placed alone", () => {
		const course = makeCourse(fiveUnits(), { sourceFolderId: "folder_gone" });
		const first = courses.startUnit(course.id, "eigen");
		assert.ok(first.ok);
		const folderId = courseStore.get(course.id)!.sourceFolderId!;
		assert.notEqual(folderId, "folder_gone");
		assert.ok(sourceOrganizationStore.read().folders.some((f) => f.id === folderId));

		// A chat the learner already placed (here: at the root) stays put on adoption.
		const chat = chatStore.createChat("Placed by the learner", undefined, { role: "unit", courseId: course.id, unitId: "jordan" });
		const state = sourceOrganizationStore.read();
		sourceOrganizationStore.write({ ...state, placements: { ...state.placements, [chat.id]: { folderId: null } } });
		const read = courses.readCourse(course.id);
		assert.ok(!courses.isCourseRefusal(read));
		assert.equal(read.units[4]!.chatId, chat.id, "the interrupted start is adopted");
		assert.equal(sourceOrganizationStore.read().placements[chat.id]!.folderId, null);
	});

	it("places an adopted session left by a crash before the course write", () => {
		const course = makeCourse(fiveUnits());
		const chat = chatStore.createChat("Interrupted", undefined, { role: "unit", courseId: course.id, unitId: "eigen" });
		const read = courses.readCourse(course.id);
		assert.ok(!courses.isCourseRefusal(read));
		assert.equal(read.units[3]!.chatId, chat.id);
		assert.equal(sourceOrganizationStore.read().placements[chat.id]!.folderId, read.sourceFolderId);
	});

	it("recovers the first graph folder after interrupted publication, even if the learner moved the session", () => {
		for (const moved of [false, true]) {
			const course = makeCourse(fiveUnits());
			// The fixture's unit 2 handoff reads "writing" with no writer in this
			// process; the first read settles it as interrupted (a course write).
			// Settle it before the crash, so the crash hits the start's own write.
			assert.ok(!courses.isCourseRefusal(courses.readCourse(course.id)));
			const rename = fs.renameSync;
			const failure = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
				if (String(to) === path.join(TMP, "courses", course.id, "course.json")) throw new Error("interrupted course publication");
				return rename(from, to);
			});
			try { assert.throws(() => courses.startUnit(course.id, "eigen"), /interrupted course publication/); }
			finally { failure.mock.restore(); }
			const chatId = chatStore.listChats().find((chat) => chat.course?.role === "unit" && chat.course.courseId === course.id)!.id;
			const organization = sourceOrganizationStore.read();
			const folderId = organization.placements[chatId]!.folderId;
			assert.ok(folderId);
			if (moved) sourceOrganizationStore.write({ ...organization, placements: { ...organization.placements, [chatId]: { folderId: null } } });
			const recovered = courses.readCourse(course.id);
			assert.ok(!courses.isCourseRefusal(recovered));
			assert.equal(recovered.sourceFolderId, folderId, "recover the course's folder independently of the session's current placement");
			assert.equal(sourceOrganizationStore.read().placements[chatId]!.folderId, moved ? null : folderId);
			const next = courses.startUnit(course.id, "jordan");
			assert.ok(next.ok);
			const after = sourceOrganizationStore.read();
			assert.equal(after.placements[next.chatId]!.folderId, folderId);
			assert.equal(after.folders.length, organization.folders.length, "the next start reuses the recovered folder");
		}
	});

	it("refuses to start a unit that has already started", async () => {
		const { course } = startedEigen();
		const again = await startRoute.POST(new Request("http://test", { method: "POST" }), { params: Promise.resolve({ id: course.id, unitId: "eigen" }) });
		assert.equal(again.status, 409);
		assert.equal((await again.json()).error, "This unit has already started.");
	});

	it("the opening turn is a foreground request: the click is learner input", async () => {
		const { chatId } = startedEigen();
		assert.equal(core.reconstructRequestCause(chatStore.getChat(chatId)!.messages), "foreground");
		const { engine, contexts } = scripted([() => fauxAssistantMessage([fauxText("What do you know about eigenvalues?")])]);
		const seen: BuildOptions[] = [];
		const res = await runTurn(chatId, { type: "continue" }, factory(chatId, engine, seen));
		assert.equal(res.status, 200);
		assert.equal(contexts.length, 1);
		assert.equal(seen[0]!.agentKind, "prober");
		assert.equal(seen[0]!.callPurpose?.background, false, "the prepared request is foreground");
	});
});

// ─── the course section ─────────────────────────────────────────────────────

describe("the unit's course section", () => {
	it("refreshes a course changed during preflight and binds the prompt size to the saved response", async () => {
		const { course, chatId } = startedEigen();
		const { engine, contexts } = scripted([() => ({ ...fauxAssistantMessage([fauxText("Begin the revised goal.")]),
			usage: { input: 10_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 10_100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		})]);
		const change = changeDuringPreflight(course.id, (current) => ({ ...current, title: "Revised course", units: current.units.map((unit) => unit.id === "eigen" ? { ...unit, goal: "Use eigenspaces to diagonalize matrices." } : unit) }));
		try { assert.equal((await runTurn(chatId, { type: "text", text: "Ready." }, factory(chatId, engine))).status, 200); }
		finally { change.mock.restore(); }
		const system = systemOf(contexts[0]!);
		assert.ok(system.includes("Course: Revised course"));
		assert.ok(system.includes("Unit goal: Use eigenspaces to diagonalize matrices."));
		const response = chatStore.getChat(chatId)!.messages.filter((message) => message.role === "assistant").at(-1)!;
		const baseline = dynamicPromptEstimate(chatId, 0).previous;
		assert.ok(baseline);
		assert.equal(baseline.messageId, response.id, "the next turn can adjust this response's measured prompt");
		assert.ok(baseline.tokens > 0);
	});

	it("lists every unit on one line and only the transitive prerequisites' handoffs, in full", () => {
		const course = makeCourse(fiveUnits("chat_e"), { proposals: PROPOSALS });
		assert.equal(core.unitCourseContext(course, "eigen"), EIGEN_CONTEXT);
	});

	it("names a prerequisite without a handoff and a reopened one with its last handoff", () => {
		const units = fiveUnits("chat_e");
		units[1] = { ...units[1]!, status: "in-progress", completion: undefined, completedAt: undefined };
		const course = makeCourse(units);
		const jordan = core.unitCourseContext(course, "jordan");
		assert.ok(jordan.includes("\n2. maps: Linear maps (in progress; builds on 1)\n"));
		assert.ok(jordan.includes(`\nUnit 2 · Linear maps was reopened and is in progress. Its last handoff:\nUnit 2 · Linear maps: completed 21 Nov 2026 (early: before the teacher marked the goal reached)\nNot reached (carried forward):\n- Kernel\n`));
		assert.ok(jordan.endsWith("\n\nUnit 4 · Eigenvectors: in progress, no handoff yet."), "the last prerequisite, in course order");
		// Unit 3 is jordan's prerequisite: its handoff is included this time.
		assert.ok(jordan.includes("Unit 3 · Determinants: completed 22 Nov 2026\nSolid:\n- Signed area: last check right at 80% confidence\nTeacher observations (model-written):\n- Carry forward: wants 3×3 practice"));
		assert.ok(!jordan.includes("Your course-change proposals"), "no proposals, no section");
		assert.ok(jordan.includes("Starting point (the setup probe's read): none recorded"));
	});

	it("rides the unit prober's system prompt, then the teacher's with goal_reached, and composes fresh each turn", async () => {
		const { course, chatId } = startedEigen();
		const { engine, contexts } = scripted([
			() => fauxAssistantMessage([fauxText("Tell me about kernels.")]),
			() => fauxAssistantMessage([fauxText("Planning.")]),
			() => fauxAssistantMessage([fauxText("Again.")]),
		]);
		assert.equal((await runTurn(chatId, { type: "continue" }, factory(chatId, engine))).status, 200);
		const prober = systemOf(contexts[0]!);
		assert.ok(prober.includes(JSON.stringify(PROBER_UNIT_DOCTRINE).slice(1, -1)), "the prober's unit doctrine");
		assert.ok(!prober.includes("# Teaching one unit of a course"));
		assert.ok(prober.includes(JSON.stringify(core.unitCourseContext(courseStore.get(course.id)!, "eigen")).slice(1, -1)));
		assert.ok(!prober.includes('"goal_reached"'), "the prober has no goal_reached");

		concludeProbe(chatId);
		assert.equal((await runTurn(chatId, { type: "text", text: "Ready." }, factory(chatId, engine))).status, 200);
		const teacher = systemOf(contexts[1]!);
		assert.ok(teacher.includes(JSON.stringify(TEACHER_UNIT_DOCTRINE).slice(1, -1)), "the teacher's unit doctrine");
		assert.ok(!teacher.includes("# This session is one unit of a course"));
		assert.ok(teacher.includes("Unit 2 · Linear maps: completed 21 Nov 2026"));
		assert.ok(teacher.includes('"goal_reached"'), "the unit teacher has goal_reached");

		// Reopening a prerequisite changes the next turn's section.
		courseStore.update(course.id, (current) => ({ ...current, units: current.units.map((unit) => unit.id === "maps" ? { ...unit, status: "in-progress" as const } : unit) }));
		assert.equal((await runTurn(chatId, { type: "text", text: "And?" }, factory(chatId, engine))).status, 200);
		const reopened = systemOf(contexts[2]!);
		assert.ok(reopened.includes("2. maps: Linear maps (in progress; builds on 1)"));
		assert.ok(reopened.includes("Unit 2 · Linear maps was reopened and is in progress. Its last handoff:"));
		assert.ok(!teacher.includes("was reopened"));
	});

	it("is absent outside a unit session", async () => {
		const chat = chatStore.createChat("Standalone");
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		const { engine, contexts } = scripted([() => fauxAssistantMessage([fauxText("Hi.")]), () => fauxAssistantMessage([fauxText("Plan.")])]);
		const seen: BuildOptions[] = [];
		assert.equal((await runTurn(chat.id, { type: "text", text: "teach me" }, factory(chat.id, engine, seen))).status, 200);
		concludeProbe(chat.id);
		assert.equal((await runTurn(chat.id, { type: "text", text: "go" }, factory(chat.id, engine, seen))).status, 200);
		assert.deepEqual(seen.map((opts) => [opts.agentKind, opts.course]), [["prober", undefined], ["teacher", undefined]]);
		for (const context of contexts) {
			const system = systemOf(context);
			assert.ok(!system.includes("# Course context") && !system.includes("one unit of a course") && !system.includes('"goal_reached"'));
		}
	});

	it("a session that doesn't hold its unit (a crash's duplicate) gets no course section", () => {
		const { course, chatId } = startedEigen();
		const duplicate = chatStore.createChat("Duplicate", undefined, { role: "unit", courseId: course.id, unitId: "eigen" });
		assert.ok(courses.unitTurnCourse(chatStore.getChat(chatId)!));
		assert.equal(courses.unitTurnCourse(chatStore.getChat(duplicate.id)!), undefined);
		assert.equal(courses.sessionCourseView(chatStore.getChat(duplicate.id)!), undefined);
	});
});

// ─── goal_reached ───────────────────────────────────────────────────────────

describe("goal_reached", () => {
	it("records the signal and an event per call, and the turn continues", async () => {
		const { course, chatId } = startedEigen();
		concludeProbe(chatId);
		const { engine, contexts } = scripted([
			() => fauxAssistantMessage([fauxToolCall("goal_reached", { summary: "Diagonalizes 2×2 matrices." }, { id: "goal-1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("You can complete the unit whenever you're ready.")]),
			() => fauxAssistantMessage([fauxToolCall("goal_reached", { summary: "Also 3×3." }, { id: "goal-2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Still reached.")]),
		]);
		assert.equal((await runTurn(chatId, { type: "text", text: "I think I get it." }, factory(chatId, engine))).status, 200);
		assert.equal(contexts.length, 2, "non-terminating: the model speaks after the signal");
		const first = courseStore.get(course.id)!;
		const reachedAt = first.units[3]!.goalReachedAt;
		assert.ok(reachedAt);
		const events = () => courseStore.get(course.id)!.evidence.filter((e) => e.type === "goal-reached");
		assert.deepEqual(events().map((e) => [e.id, e.unitId, e.chatId, e.summary]), [[`goal-reached:${chatId}:goal-1`, "eigen", chatId, "Diagonalizes 2×2 matrices."]]);
		const result = chatStore.getChat(chatId)!.messages.find((m) => m.role === "toolResult" && m.toolCallId === "goal-1") as Extract<LhMessage, { role: "toolResult" }>;
		assert.equal(result.isError, false);
		assert.deepEqual(result.details, { ok: true });

		assert.equal((await runTurn(chatId, { type: "text", text: "One more?" }, factory(chatId, engine))).status, 200);
		assert.equal(events().length, 2, "repeatable: each call is an event");
		assert.equal(courseStore.get(course.id)!.units[3]!.goalReachedAt, reachedAt, "the first signal's time is kept");
		assert.equal(courses.sessionCourseView(chatStore.getChat(chatId)!)?.role, "unit");
	});

	it("refuses back to the model when the unit is completed meanwhile", () => {
		const { course, chatId } = startedEigen();
		courseStore.update(course.id, (current) => ({ ...current, units: current.units.map((unit) => unit.id === "eigen" ? { ...unit, status: "completed" as const } : unit) }));
		assert.equal(courses.recordGoalReached(course.id, "eigen", chatId, "late", "x"), "The goal couldn't be recorded: this unit is already completed.");
		assert.equal(courses.recordGoalReached(course.id, "eigen", "chat_other", "late", "x"), "The goal couldn't be recorded: this session is no longer a unit of the course.");
	});
});

// ─── closed units ───────────────────────────────────────────────────────────

describe("a completed unit", () => {
	it("rechecks completion after asynchronous preflight without saving input or starting a turn", async () => {
		for (const automatic of [false, true]) {
			const { course, chatId } = startedEigen();
			const before = chatStore.getChat(chatId)!.messages;
			const { engine, contexts } = scripted([() => fauxAssistantMessage([fauxText("never")])]);
			const duringPreflight = changeDuringPreflight(course.id, (current) => ({ ...current, units: current.units.map((unit) => unit.id === "eigen" ? { ...unit, status: "completed" as const } : unit) }));
			let response: Response;
			try {
				response = await handleChatInput(chatId, automatic
					? { type: "steers", steers: [core.buildProbeHandoffSteer(chatId) as unknown as LhMessage] }
					: { type: "text", text: "one more thing" }, factory(chatId, engine));
				const turn = runningTurn(chatId);
				if (turn) await new Response(turn.subscribe()).text();
			} finally { duringPreflight.mock.restore(); }
			assert.equal(response.status, automatic ? 410 : 409);
			assert.deepEqual(await response.json(), { error: "This unit is completed. Reopen it to continue." });
			assert.equal(contexts.length, 0);
			assert.deepEqual(chatStore.getChat(chatId)!.messages, before);
			assert.equal(runningTurn(chatId), undefined);
		}
	});

	it("refuses main input (409) and leaves a job delivery pending (410), with no model call", async () => {
		const { course, chatId } = startedEigen();
		courseStore.update(course.id, (current) => ({ ...current, units: current.units.map((unit) => unit.id === "eigen" ? { ...unit, status: "completed" as const } : unit) }));
		const { engine, contexts } = scripted([() => fauxAssistantMessage([fauxText("never")])]);
		const text = await runTurn(chatId, { type: "text", text: "one more thing" }, factory(chatId, engine));
		assert.equal(text.status, 409);
		assert.deepEqual(await text.json(), { error: "This unit is completed. Reopen it to continue." });
		const steer = core.buildProbeHandoffSteer(chatId) as unknown as LhMessage;
		assert.equal((await handleChatInput(chatId, { type: "steers", steers: [steer] }, factory(chatId, engine))).status, 410);
		assert.equal(contexts.length, 0);
		const view = courses.sessionCourseView(chatStore.getChat(chatId)!)!;
		assert.ok(view.role === "unit" && view.status === "completed" && courseSessionClosed(view));
	});

	it("an unreadable course refuses the unit's input", async () => {
		const { course, chatId } = startedEigen();
		fs.writeFileSync(path.join(TMP, "courses", course.id, "course.json"), "{ not json");
		const { engine, contexts } = scripted([() => fauxAssistantMessage([fauxText("never")])]);
		const text = await runTurn(chatId, { type: "text", text: "hello" }, factory(chatId, engine));
		assert.equal(text.status, 409);
		assert.deepEqual(await text.json(), { error: "This session's course can't be read: This course's record is damaged and can't be read." });
		assert.equal(contexts.length, 0);
	});
});

// ─── the prerequisite warning ───────────────────────────────────────────────

describe("the prerequisite warning", () => {
	const unit = (id: string, title: string, status: CourseUnit["status"], prerequisites: string[] = []): CourseUnit => ({ id, title, goal: "g", prerequisites, status });
	const units = [
		unit("a", "Vectors", "completed"),
		unit("b", "Linear maps", "in-progress", ["a"]),
		unit("c", "Determinants", "not-started"),
		unit("d", "Eigenvectors", "not-started", ["b"]),
		unit("e", "Jordan form", "not-started", ["a", "b", "c"]),
	];

	it("names one unfinished prerequisite and lists several by number", () => {
		assert.equal(core.prerequisiteWarning(units, "d"), "Unit 4 builds on unit 2 (Linear maps), which isn't completed yet. Start anyway?");
		assert.equal(core.prerequisiteWarning(units, "e"), "Unit 5 builds on units 2 and 3, which aren't completed yet. Start anyway?");
		assert.equal(core.prerequisiteWarning(units, "b"), null, "its only prerequisite is completed");
		assert.equal(core.prerequisiteWarning(units, "c"), null);
	});

	it("renders the warning with Cancel and Start anyway", () => {
		const html = renderToStaticMarkup(<UnitStartWarning text="Unit 4 builds on unit 2 (Linear maps), which isn't completed yet. Start anyway?" onCancel={() => {}} onConfirm={() => {}} />);
		assert.ok(html.includes("Unit 4 builds on unit 2 (Linear maps), which isn&#x27;t completed yet. Start anyway?"));
		assert.match(html, /data-testid="unit-start-cancel"[^>]*>Cancel<\/button>/);
		assert.match(html, /data-testid="unit-start-confirm"[^>]*>Start anyway<\/button>/);
	});
});

// ─── the unit's chrome ──────────────────────────────────────────────────────

describe("the unit session's chrome", () => {
	const view = { role: "unit" as const, courseId: "course_x", courseTitle: "Linear algebra", unitId: "maps", number: 2, unitTitle: "Linear maps", status: "in-progress" as const };

	it("the top bar reads course › n. unit and links to the overview", () => {
		const html = renderToStaticMarkup(<UnitBreadcrumb view={view} />);
		assert.match(html, /^<a[^>]*href="\/course\/course_x"/);
		assert.equal(html.replace(/<[^>]+>/g, ""), "Linear algebra›2. Linear maps");
	});

	it("the transcript marks the start and a recorded goal, quietly", () => {
		assert.equal(renderToStaticMarkup(<UnitStartedLine data={{ courseId: "c", unitId: "maps", number: 2, title: "Linear maps" }} />).replace(/<[^>]+>/g, ""), "Unit 2 started");
		const reached = renderToStaticMarkup(<GoalReachedLine part={{ type: "tool-goal_reached", state: "output-available", toolCallId: "g", input: { summary: "Reads matrices as maps." }, output: { ok: true } }} />);
		assert.equal(reached.replace(/<[^>]+>/g, ""), "Goal reachedReads matrices as maps.");
		assert.equal(renderToStaticMarkup(<GoalReachedLine part={{ type: "tool-goal_reached", state: "output-error", toolCallId: "g", input: { summary: "x" }, output: { ok: false } }} />), "");
	});

	it("a completed unit's composer becomes the closed band; an open one stays", () => {
		const band = renderToStaticMarkup(<CourseClosedBand view={{ ...view, status: "completed" }} />);
		assert.ok(band.includes("This unit is completed. Reopen it to continue."));
		assert.ok(band.includes('href="/course/course_x"') && band.includes("Open course"));
		assert.equal(renderToStaticMarkup(<CourseClosedBand view={view} />), "");
		assert.equal(courseSessionClosed(view), false);
	});
});
