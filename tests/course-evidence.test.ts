/**
 * Plan 04 item 5: evidence capture. Hand-built transcripts in the record's
 * native shape, read into course evidence, with every expected event
 * worked out by hand: each answer kind (right/wrong checks with
 * confidence, don't know, skipped, predict, free recall and plugin answers
 * as ungraded, probes, setup answers), no event for ask answers, practice
 * outcomes, a repeated sync adding nothing, events surviving a deleted
 * practice session, and the sync at a real turn's settlement. Fakes only
 * (pi-ai's faux provider); an isolated LH_DATA_DIR is set before any
 * config-loading import.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type AssistantMessage,
	type FauxResponseFactory,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-evidence-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { courseStore } = await import("../src/store/courses.ts");
const { createPracticeAgent, createProberAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { POST: dismiss } = await import("../app/api/chats/[id]/dismiss/route.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const courses = await import("../src/server/courses.ts");
const { handoffTopics } = await import("../src/core/course.ts");
const { sessionAnswerEvidence, sessionPracticeEvidence } = await import("../src/core/course-evidence.ts");
const { concludedByDismissalPair, newProblemDismissedMarker, newUnitStartMessage } = await import("../src/core/native-messages.ts");
const { buildAnswer, dismissedAnswer, normalizeOptions, resolveCorrect } = await import("../src/core/question-core.ts");
type PiEngine = import("../src/agent/models.ts").PiEngine;
type LhMessage = import("../src/core/native-messages.ts").LhMessage;
type CourseRecord = import("../src/core/contracts/course.ts").CourseRecord;
type CourseEvidence = import("../src/core/contracts/course.ts").CourseEvidence;
type PluginQuestionSnapshot = import("../src/core/plugin-questions.ts").PluginQuestionSnapshot;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ─── record builders (the native shape the store holds) ─────────────────────

const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
function assistant(id: string, content: unknown[], extra: Record<string, unknown> = {}): LhMessage {
	return {
		id, role: "assistant", content, api: "openai-completions", provider: "test", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "toolUse", timestamp: 1, ...extra,
	} as never;
}
function result(callId: string, toolName: string, details: unknown, extra: Record<string, unknown> = {}): LhMessage {
	return { id: `r_${callId}`, role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text: "ok" }], details, isError: false, timestamp: Date.parse("2026-11-14T08:00:00.000Z"), ...extra } as never;
}
/** One asked-and-answered question: the call and its stored result. */
function asked(id: string, tool: string, args: unknown, details: unknown, extra: Record<string, unknown> = {}): LhMessage[] {
	return [assistant(`a_${id}`, [call(id, tool, args)]), result(id, tool, details, extra)];
}
const at = (minute: number) => `2026-11-14T09:${String(minute).padStart(2, "0")}:00.000Z`;
/** A stored multiple-choice answer, as the dock's buildAnswer writes it. */
const choice = (tool: string, minute: number, fields: Record<string, unknown>) => ({ kind: "quiz", tool, questionText: "Q?", dontKnow: false, answers: [{ label: "A", value: "a", index: 1 }], answeredAt: at(minute), ...fields });
const recalled = (tool: string, minute: number) => ({ kind: "explain", tool, questionText: "Explain.", dontKnow: false, answers: [], text: "Because…", answeredAt: at(minute) });
const plan = (id: string, nodes: Array<[string, string]>) => asked(id, "plan_init", { mermaid: "graph TD" }, { ok: true, tree: { nodes: nodes.map(([nodeId, title]) => ({ id: nodeId, title })), edges: [], version: 1 } });
const quizArgs = (type: string, nodeId: string) => ({ question: "Q?", options: [{ label: "A" }, { label: "B" }], explanation: "A is correct.", correctAnswer: "A", type, nodeId });

function pluginQuestion(messageId: string, toolCallId: string, input: Record<string, unknown>, variant: "probe" | "teach" = "teach") {
	const snapshot: PluginQuestionSnapshot = {
		protocolVersion: 1, pluginId: "fixture", typeId: "sketch", label: "Sketch", variant, questionId: `q_${toolCallId}`, contractVersion: 1,
		occurrence: { messageId, contentIndex: 0, toolCallId, toolName: "sketch" },
		input: { question: "Sketch the span.", payload: {}, ...input } as PluginQuestionSnapshot["input"],
		questionSchema: { type: "object" }, answerSchema: { type: "string" }, showThinking: false, requiresAnswerRefinement: false,
	};
	const pose = { ...assistant(messageId, [call(toolCallId, "sketch", snapshot.input)]), lhQuestions: { "0": snapshot } } as LhMessage;
	return { snapshot, pose };
}

function pluginAnswer(question: ReturnType<typeof pluginQuestion>, minute: number): LhMessage {
	const { snapshot } = question;
	return {
		...result(snapshot.occurrence.toolCallId, snapshot.occurrence.toolName, {
			kind: "plugin-question", questionId: snapshot.questionId, pluginId: snapshot.pluginId,
			typeId: snapshot.typeId, contractVersion: snapshot.contractVersion, answer: "a plane", answeredAt: at(minute),
		}), id: `answer_${snapshot.occurrence.messageId}`, lhQuestionOccurrence: snapshot.occurrence,
	} as LhMessage;
}

// ─── a unit session's transcript ────────────────────────────────────────────

/** Unit 1 ("vectors") of a course: the probe, the plan (rewritten once,
 *  renaming "basis"), and teaching with every answer kind. */
function unitTranscript(): LhMessage[] {
	const sketch = pluginQuestion("a_plugin1", "plugin1", { type: "check", nodeId: "span" });
	const skipped = pluginQuestion("a_plugin2", "plugin2", { type: "check", nodeId: "basis" });
	return [
		newUnitStartMessage({ courseId: "c", unitId: "vectors", number: 1, title: "Vectors" }),
		...asked("p1", "probe", { question: "Q?" }, choice("probe", 10, { correct: false, confidence: 40 })),
		...asked("p2", "recall", { question: "Explain." }, recalled("recall", 11)),
		...asked("ask1", "ask_user_question", { question: "Which topic?" }, { kind: "ask", tool: "ask_user_question", questionText: "Which topic?", dontKnow: false, answers: [{ label: "Span", value: "span", index: 1 }], answeredAt: at(12) }),
		...asked("done1", "probe_done", {}, { ok: true }),
		...plan("plan1", [["span", "Span"], ["basis", "Basis"]]),
		...asked("q1", "quiz", quizArgs("predict", "span"), choice("quiz", 20, { questionType: "predict", correct: false, confidence: 60 })),
		...asked("q2", "quiz", quizArgs("check", "span"), choice("quiz", 21, { questionType: "check", correct: true, confidence: 85 })),
		...asked("q3", "quiz", quizArgs("check", "basis"), choice("quiz", 22, { questionType: "check", dontKnow: true, correct: false, answers: [] })),
		// A dismissal stores the minimal record: no tool, no question type.
		...asked("q4", "quiz", quizArgs("check", "basis"), { ...dismissedAnswer("quiz", "Q?"), answeredAt: at(23) }),
		// A refused call never happened.
		...asked("q5", "quiz", quizArgs("check", "span"), { ok: false }, { isError: true }),
		...plan("plan2", [["span", "Span"], ["basis", "Bases and dimension"]]),
		...asked("q6", "explain", { question: "Explain.", correctAnswer: "…", nodeId: "basis" }, recalled("explain", 30)),
		sketch.pose,
		{ ...result("plugin1", "sketch", { kind: "plugin-question", questionId: "q_plugin1", pluginId: "fixture", typeId: "sketch", contractVersion: 1, answer: "a plane", answeredAt: at(31) }), lhQuestionOccurrence: sketch.snapshot.occurrence } as LhMessage,
		skipped.pose,
		result("plugin2", "sketch", { kind: "plugin-question-cancelled", questionId: "q_plugin2", occurrence: skipped.snapshot.occurrence, reason: "dismissed" }, { timestamp: Date.parse(at(32)) }),
		// Asked, not yet answered.
		assistant("a_q7", [call("q7", "quiz", quizArgs("check", "basis"))]),
	];
}

const U = { chatId: "chat_unit", unitId: "vectors" };
const teach = { type: "answer", ...U, phase: "teach" } as const;

/** Worked by hand from unitTranscript. */
const UNIT_EVENTS: CourseEvidence[] = [
	{ type: "answer", ...U, id: "chat_unit:p1", at: at(10), phase: "probe", tool: "probe", result: "wrong", confidence: 40 },
	{ type: "answer", ...U, id: "chat_unit:p2", at: at(11), phase: "probe", tool: "recall", result: "ungraded" },
	{ ...teach, id: "chat_unit:q1", at: at(20), tool: "quiz", questionType: "predict", nodeId: "span", nodeTitle: "Span", result: "wrong", confidence: 60 },
	{ ...teach, id: "chat_unit:q2", at: at(21), tool: "quiz", questionType: "check", nodeId: "span", nodeTitle: "Span", result: "right", confidence: 85 },
	{ ...teach, id: "chat_unit:q3", at: at(22), tool: "quiz", questionType: "check", nodeId: "basis", nodeTitle: "Basis", result: "dontKnow" },
	{ ...teach, id: "chat_unit:q4", at: at(23), tool: "quiz", questionType: "check", nodeId: "basis", nodeTitle: "Basis", result: "skipped" },
	{ ...teach, id: "chat_unit:q6", at: at(30), tool: "explain", nodeId: "basis", nodeTitle: "Bases and dimension", result: "ungraded" },
	{ ...teach, id: "chat_unit:plugin1", at: at(31), tool: "sketch", questionType: "check", nodeId: "span", nodeTitle: "Span", result: "ungraded" },
	{ ...teach, id: "chat_unit:plugin2", at: at(32), tool: "sketch", questionType: "check", nodeId: "basis", nodeTitle: "Bases and dimension", result: "skipped" },
];

describe("answer evidence from a transcript", () => {
	it("records each answer kind in order, with the plan's title at the time, and no ask answers", () => {
		assert.deepEqual(sessionAnswerEvidence(unitTranscript(), U), UNIT_EVENTS);
	});

	it("keeps don't-know free recall ungraded, including a teach check", () => {
		const answer = buildAnswer({
			id: "free", kind: "explain", questionType: "check", question: "Explain a basis.",
			mode: "text", options: [], committedAnswer: "An independent spanning set.", createdAt: at(0),
		}, { dontKnow: true }, "explain");
		const events = sessionAnswerEvidence([
			...plan("plan", [["basis", "Basis"]]),
			...asked("recall", "recall", { question: "Explain a basis.", correctAnswer: "An independent spanning set." }, { ...answer, tool: "recall", questionType: undefined }),
			...asked("explain", "explain", { question: "Explain a basis.", correctAnswer: "An independent spanning set.", type: "check", nodeId: "basis" }, answer),
		], U);
		assert.deepEqual(events, [
			{ type: "answer", ...U, id: "chat_unit:recall", at: answer.answeredAt, phase: "probe", tool: "recall", result: "ungraded" },
			{ ...teach, id: "chat_unit:explain", at: answer.answeredAt, tool: "explain", questionType: "check", nodeId: "basis", nodeTitle: "Basis", result: "ungraded" },
		]);
		assert.equal(handoffTopics([{ id: "basis", title: "Basis" }], new Set(["basis"]), events)[0]!.status, "unchecked");
	});

	it("uses successful plans preceding native and plugin questions in their batch, without later renames", () => {
		const plugin = pluginQuestion("plugin_batch", "sketch", { type: "check", nodeId: "basis" });
		plugin.snapshot.occurrence.contentIndex = 1;
		const events = sessionAnswerEvidence([
			...plan("initial", [["basis", "Basis"]]),
			assistant("native_batch", [call("rewrite1", "plan_init", {}), call("quiz", "quiz", quizArgs("check", "basis"))]),
			result("rewrite1", "plan_init", { ok: true, tree: { nodes: [{ id: "basis", title: "Bases and dimension" }] } }),
			result("quiz", "quiz", choice("quiz", 20, { questionType: "check", correct: true, confidence: 80 })),
			assistant("plugin_batch", [call("rewrite2", "plan_init", {}), call("sketch", "sketch", plugin.snapshot.input)], { lhQuestions: { "1": plugin.snapshot } }),
			result("rewrite2", "plan_init", { ok: true, tree: { nodes: [{ id: "basis", title: "Coordinates" }] } }),
			// A later plan can arrive before the plugin answer; it must not
			// rename the question that was already posed.
			...plan("later", [["basis", "Coordinate systems"]]),
			pluginAnswer(plugin, 21),
		], U);
		assert.deepEqual(events, [
			{ ...teach, id: "chat_unit:quiz", at: at(20), tool: "quiz", questionType: "check", nodeId: "basis", nodeTitle: "Bases and dimension", result: "right", confidence: 80 },
			{ ...teach, id: "chat_unit:sketch", at: at(21), tool: "sketch", questionType: "check", nodeId: "basis", nodeTitle: "Coordinates", result: "ungraded" },
		]);
	});

	it("tags every setup answer as setup, without a unit", () => {
		const probe = pluginQuestion("a_plugin", "plugin", {}, "probe");
		const messages = [
			{ id: "u1", role: "user", content: "Teach me linear algebra.", timestamp: 1 } as LhMessage,
			...asked("s1", "probe", { question: "Q?" }, choice("probe", 1, { correct: true, confidence: 90 })),
			...asked("s2", "recall", { question: "Explain." }, recalled("recall", 2)),
			...asked("s3", "ask_user_question", { question: "Goal?" }, { kind: "ask", questionText: "Goal?", dontKnow: false, answers: [], text: "Eigenvectors", answeredAt: at(3) }),
			probe.pose,
			{ ...result("plugin", "sketch", { kind: "plugin-question", questionId: "q_plugin", pluginId: "fixture", typeId: "sketch", contractVersion: 1, answer: "x", answeredAt: at(4) }), lhQuestionOccurrence: probe.snapshot.occurrence } as LhMessage,
		];
		assert.deepEqual(sessionAnswerEvidence(messages, { chatId: "chat_setup", setup: true }), [
			{ type: "answer", chatId: "chat_setup", id: "chat_setup:s1", at: at(1), phase: "setup", tool: "probe", result: "right", confidence: 90 },
			{ type: "answer", chatId: "chat_setup", id: "chat_setup:s2", at: at(2), phase: "setup", tool: "recall", result: "ungraded" },
			{ type: "answer", chatId: "chat_setup", id: "chat_setup:plugin", at: at(4), phase: "setup", tool: "sketch", result: "ungraded" },
		]);
	});
});

// ─── a "Practice this unit" session's transcript ────────────────────────────

const problemArgs = (target?: string[]) => ({ statement: "Show the span is a plane.", mode: "recall", modelSolution: "…", ...(target ? { target } : {}) });
const concludeArgs = (outcome: string, rung: string | null, missClass: string | null) => ({ outcome, verdict: "…", rung, missClass, retest: false });

function practiceTranscript(withDismissalConclude: boolean): LhMessage[] {
	const [dismissCall, dismissAck] = concludedByDismissalPair("pr2");
	return [
		...asked("pr1", "problem", problemArgs(["n_span01", "n_basis02"]), null),
		...asked("c1", "conclude", concludeArgs("solvedWithHints", "R2", "execution"), null, { timestamp: Date.parse(at(40)) }),
		...asked("pr2", "problem", problemArgs(), null),
		{ ...newProblemDismissedMarker("pr2"), timestamp: Date.parse(at(41)) },
		...(withDismissalConclude ? [dismissCall, { ...dismissAck, timestamp: Date.parse(at(42)) }] : []),
		...asked("pr3", "problem", problemArgs(["n_span01"]), null),
		...asked("c3", "conclude", concludeArgs("solved", null, null), null, { timestamp: Date.parse(at(43)) }),
		// A refused conclude ends nothing.
		...asked("pr4", "problem", problemArgs(), null),
		...asked("c4", "conclude", concludeArgs("surrendered", "R5", "structural"), null, { isError: true }),
	];
}

const P = { practiceChatId: "chat_prac", unitId: "vectors" };
const PRACTICE_EVENTS: CourseEvidence[] = [
	{ type: "practice", ...P, id: "chat_prac:pr1", at: at(40), problemCallId: "pr1", outcome: "solvedWithHints", rung: 2, missClass: "execution", targets: ["n_span01", "n_basis02"] },
	{ type: "practice", ...P, id: "chat_prac:pr2", at: at(41), problemCallId: "pr2", outcome: "dismissed" },
	{ type: "practice", ...P, id: "chat_prac:pr3", at: at(43), problemCallId: "pr3", outcome: "solved", targets: ["n_span01"] },
];

describe("practice evidence from a transcript", () => {
	it("records each concluded problem with its outcome, rung, miss class and targets", () => {
		assert.deepEqual(sessionPracticeEvidence(practiceTranscript(true), { chatId: "chat_prac", unitId: "vectors" }), PRACTICE_EVENTS);
	});

	it("counts a dismissal from its marker, and its later conclude as the same event", () => {
		assert.deepEqual(sessionPracticeEvidence(practiceTranscript(false), { chatId: "chat_prac", unitId: "vectors" }), PRACTICE_EVENTS);
	});
});

// ─── the course service ─────────────────────────────────────────────────────

let counter = 0;
/** A course whose setup session, unit 1 session, and a linked practice
 *  session hold the transcripts above. Unit 2 hasn't started. */
function seededCourse(): { course: CourseRecord; setupId: string; unitId: string; practiceId: string } {
	const courseId = `course_ev_${++counter}`;
	const setup = chatStore.createChat("Setup", undefined, { role: "setup", courseId });
	chatStore.saveMessages(setup.id, asked("s1", "probe", { question: "Q?" }, choice("probe", 1, { correct: true, confidence: 90 })));
	const unit = chatStore.createChat("Unit 1", undefined, { role: "unit", courseId, unitId: "vectors" });
	chatStore.saveMessages(unit.id, unitTranscript());
	const practice = chatStore.createChat("Practice", "practice", { role: "practice", courseId, unitId: "vectors" });
	chatStore.saveMessages(practice.id, practiceTranscript(true));
	const course: CourseRecord = {
		id: courseId, title: "Linear algebra", goal: "Eigenvectors.", createdAt: at(0), updatedAt: at(0), setupChatId: setup.id,
		units: [
			{ id: "vectors", title: "Vectors", goal: "Span.", prerequisites: [], status: "in-progress", chatId: unit.id },
			{ id: "maps", title: "Linear maps", goal: "Maps.", prerequisites: ["vectors"], status: "not-started" },
		],
		proposals: [],
		evidence: [{ type: "unit-started", id: `unit-started:${unit.id}`, at: at(5), unitId: "vectors", chatId: unit.id }],
	};
	courseStore.create(course);
	return { course, setupId: setup.id, unitId: unit.id, practiceId: practice.id };
}

const rechat = (events: CourseEvidence[], from: string, to: string) =>
	events.map((event) => JSON.parse(JSON.stringify(event).replaceAll(from, to)) as CourseEvidence);

describe("syncing a course's evidence", () => {
	for (const first of ["older", "newer"] as const) {
		it(`keeps both reused-id plugin occurrences when the ${first} answer arrives first`, () => {
			const { course, unitId } = seededCourse();
			const older = pluginQuestion("older", "reused", { type: "check", nodeId: "span" });
			const newer = pluginQuestion("newer", "reused", { type: "check", nodeId: "basis" });
			older.snapshot.questionId = "q_older";
			newer.snapshot.questionId = "q_newer";
			const [one, two] = first === "older" ? [older, newer] : [newer, older];
			const firstAnswer = pluginAnswer(one, 35);
			const secondAnswer = pluginAnswer(two, 36);
			const messages = [...plan("plan", [["span", "Span"], ["basis", "Basis"]]), older.pose, newer.pose, firstAnswer];
			chatStore.saveMessages(unitId, messages);
			courses.syncSessionEvidence(chatStore.getChat(unitId)!);
			const base = { type: "answer", chatId: unitId, unitId: "vectors", phase: "teach", tool: "sketch", questionType: "check", result: "ungraded" } as const;
			const expectedFirst = { ...base, id: `${unitId}:reused`, at: at(35), nodeId: first === "older" ? "span" : "basis", nodeTitle: first === "older" ? "Span" : "Basis" };
			assert.deepEqual(courseStore.get(course.id)!.evidence.filter((event) => event.type === "answer"), [expectedFirst]);

			// A repeated answer and a copied occurrence must not consume the
			// remaining question or create an extra event.
			chatStore.saveMessages(unitId, [...messages,
				{ ...firstAnswer, id: "repeated" },
				{ ...secondAnswer, id: "copied", lhQuestionOccurrence: one.snapshot.occurrence },
				secondAnswer,
			]);
			courses.syncSessionEvidence(chatStore.getChat(unitId)!);
			const expected = [expectedFirst, { ...base, id: `${unitId}:reused:2`, at: at(36), nodeId: first === "older" ? "basis" : "span", nodeTitle: first === "older" ? "Basis" : "Span" }];
			assert.deepEqual(courseStore.get(course.id)!.evidence.filter((event) => event.type === "answer"), expected);
			courses.syncSessionEvidence(chatStore.getChat(unitId)!);
			assert.deepEqual(courseStore.get(course.id)!.evidence.filter((event) => event.type === "answer"), expected);
		});
	}

	it("appends the setup, unit and practice sessions' events once, without touching updatedAt", () => {
		const { course, setupId, unitId, practiceId } = seededCourse();
		// Neither another course's practice nor a crash's duplicate unit
		// session contributes.
		const stray = chatStore.createChat("Other practice", "practice", { role: "practice", courseId: "course_other", unitId: "vectors" });
		chatStore.saveMessages(stray.id, practiceTranscript(true));
		const duplicate = chatStore.createChat("Duplicate", undefined, { role: "unit", courseId: course.id, unitId: "vectors" });
		chatStore.saveMessages(duplicate.id, unitTranscript());

		const synced = courses.syncCourseEvidence(course.id);
		assert.ok(!courses.isCourseRefusal(synced));
		const stored = courseStore.get(course.id)!;
		assert.deepEqual(stored.evidence, [
			course.evidence[0],
			{ type: "answer", chatId: setupId, id: `${setupId}:s1`, at: at(1), phase: "setup", tool: "probe", result: "right", confidence: 90 },
			...rechat(UNIT_EVENTS, "chat_unit", unitId),
			...rechat(PRACTICE_EVENTS, "chat_prac", practiceId),
		]);
		assert.equal(stored.updatedAt, course.updatedAt, "evidence bookkeeping doesn't make an open editor stale");

		const bytes = fs.readFileSync(path.join(TMP, "courses", course.id, "course.json"), "utf-8");
		courses.syncCourseEvidence(course.id);
		assert.equal(fs.readFileSync(path.join(TMP, "courses", course.id, "course.json"), "utf-8"), bytes, "repeating the sync writes nothing");
	});

	it("keeps a deleted practice session's events, and picks up new answers one session at a time", () => {
		const { course, unitId, practiceId } = seededCourse();
		courses.syncCourseEvidence(course.id);
		const before = courseStore.get(course.id)!.evidence;
		assert.ok(chatStore.deleteChat(practiceId));
		courses.syncCourseEvidence(course.id);
		assert.deepEqual(courseStore.get(course.id)!.evidence, before);

		const record = chatStore.getChat(unitId)!;
		chatStore.saveMessages(unitId, [...record.messages, result("q7", "quiz", choice("quiz", 50, { questionType: "check", correct: true, confidence: 70 }))]);
		courses.syncSessionEvidence(chatStore.getChat(unitId)!);
		assert.deepEqual(courseStore.get(course.id)!.evidence.at(-1), { ...teach, chatId: unitId, id: `${unitId}:q7`, at: at(50), tool: "quiz", questionType: "check", nodeId: "basis", nodeTitle: "Bases and dimension", result: "right", confidence: 70 });
		assert.equal(courseStore.get(course.id)!.evidence.length, before.length + 1);
	});

	it("brings in the setup probe's answers when the course is created", () => {
		const setup = chatStore.createChat("Setup", undefined, { role: "setup" });
		chatStore.saveMessages(setup.id, [
			...asked("s1", "probe", { question: "Q?" }, choice("probe", 1, { correct: false, confidence: 30 })),
			...asked("prop", "propose_course", { title: "LA", goal: "g", units: [] }, { ok: true }),
		]);
		const out = courses.createCourseFromSetup({
			setupChatId: setup.id, toolCallId: "prop", title: "Linear algebra", goal: "Eigenvectors.",
			units: [{ key: "vectors", title: "Vectors", goal: "Span.", startingPoint: "", prerequisites: [] }],
		});
		assert.ok(out.ok, JSON.stringify(out));
		const answers = courseStore.get(out.courseId)!.evidence.filter((event) => event.type === "answer");
		assert.deepEqual(answers, [{ type: "answer", chatId: setup.id, id: `${setup.id}:s1`, at: at(1), phase: "setup", tool: "probe", result: "wrong", confidence: 30 }]);
	});
});

// ─── at a real turn's settlement ────────────────────────────────────────────

function scripted(steps: FauxResponseStep[]) {
	const faux = createFauxCore({});
	faux.setResponses(steps.map((step) => async (context): Promise<AssistantMessage> =>
		typeof step === "function" ? await (step as FauxResponseFactory)(context, undefined, undefined as never, undefined as never) : step));
	return { model: faux.getModel(), streamFn: faux.streamSimple } as PiEngine;
}

type Factory = NonNullable<Parameters<typeof handleChatRequest>[1]>;
function factory(chatId: string, engine: PiEngine): Factory {
	return (opts) => {
		if (opts.agentKind === "practice") return createPracticeAgent({ chatId, chatStore }, { ...opts, engine });
		return opts.agentKind === "teacher"
			? createTeacherAgent({ chatId, chatStore, jobStore, spawn: () => {} }, { ...opts, engine })
			: createProberAgent({ chatId, chatStore, jobStore, deliver: () => {}, spawn: () => {} }, { ...opts, engine });
	};
}

async function runTurn(chatId: string, input: unknown, build: Factory): Promise<number> {
	const request = new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, input }) });
	const ack = await handleChatRequest(request, build);
	const handle = ack.status === 200 ? runningTurn(chatId) : undefined;
	if (handle) await new Response(handle.subscribe()).text();
	return ack.status;
}

function startedTeachingUnit(): { courseId: string; chatId: string } {
	const courseId = `course_ev_${++counter}`;
	courseStore.create({
		id: courseId, title: "Linear algebra", goal: "Eigenvectors.", createdAt: at(0), updatedAt: at(0), setupChatId: "chat_setup",
		units: [{ id: "vectors", title: "Vectors", goal: "Span.", prerequisites: [], status: "not-started" }], proposals: [], evidence: [],
	});
	const started = courses.startUnit(courseId, "vectors");
	assert.ok(started.ok);
	const chatId = started.chatId;
	chatStore.saveSettings(chatId, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveMessages(chatId, [...chatStore.getChat(chatId)!.messages, ...asked("done1", "probe_done", {}, { ok: true }), { id: "go", role: "user", content: "Go on.", timestamp: 2 } as LhMessage]);
	return { courseId, chatId };
}

async function parkThroughRoute(chatId: string, input: unknown): Promise<void> {
	const response = await dismiss(new Request(`http://test/api/chats/${chatId}/dismiss`, {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }),
	}), { params: Promise.resolve({ id: chatId }) });
	assert.equal(response.status, 202);
}

describe("the settlement sync", () => {
	it("records a unit's check answer with its title when plan and quiz share a batch", async () => {
		const { courseId, chatId } = startedTeachingUnit();

		const quiz = { question: "Is span{(1,0),(2,0)} a line?", options: [{ label: "Yes" }, { label: "No" }], correctAnswer: "Yes", explanation: "Both lie on the x-axis.", type: "check", nodeId: "span" };
		const engine = scripted([
			() => fauxAssistantMessage([
				fauxToolCall("plan_init", { mermaid: "graph TD\n  span[Span] --> basis[Basis]" }, { id: "plan1" }),
				fauxToolCall("quiz", quiz, { id: "quiz1" }),
			], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Right: both vectors lie on one line.")]),
		]);
		assert.equal(await runTurn(chatId, { type: "continue" }, factory(chatId, engine)), 200);
		const updatedAt = courseStore.get(courseId)!.updatedAt;

		// The dock grades the answer and posts the full record.
		const options = normalizeOptions(quiz.options);
		const question = { id: "quiz1", kind: "quiz" as const, questionType: "check" as const, question: quiz.question, mode: "single-select" as const, options, correctIndices: resolveCorrect(quiz.correctAnswer, options).indices, explanation: quiz.explanation, createdAt: at(0) };
		const answer = buildAnswer(question, { values: [options[0]!.value], confidence: 80 }, "quiz");
		assert.equal(answer.correct, true);
		assert.equal(await runTurn(chatId, { type: "answer", toolCallId: "quiz1", answer }, factory(chatId, engine)), 200);

		const stored = courseStore.get(courseId)!;
		assert.deepEqual(stored.evidence.filter((event) => event.type === "answer"), [
			{ type: "answer", unitId: "vectors", chatId, id: `${chatId}:quiz1`, at: answer.answeredAt, phase: "teach", tool: "quiz", questionType: "check", nodeId: "span", nodeTitle: "Span", result: "right", confidence: 80 },
		]);
		assert.equal(stored.updatedAt, updatedAt);
	});

	it("records a parked question dismissal before the turn reports settlement", async () => {
		const { courseId, chatId } = startedTeachingUnit();
		const answer = dismissedAnswer("quiz", "Q?");
		const engine = scripted([async () => {
			await parkThroughRoute(chatId, { type: "dismiss", toolCallId: "quiz1", answer });
			return fauxAssistantMessage([
				fauxToolCall("plan_init", { mermaid: "graph TD\n span[Span] --> basis[Basis]" }, { id: "plan1" }),
				fauxToolCall("quiz", quizArgs("check", "span"), { id: "quiz1" }),
			], { stopReason: "toolUse" });
		}]);
		assert.equal(await runTurn(chatId, { type: "continue" }, factory(chatId, engine)), 200);
		const saved = chatStore.getChat(chatId)!;
		assert.ok(saved.messages.some((message) => message.role === "toolResult" && message.toolCallId === "quiz1" && (message.details as { dismissed?: boolean })?.dismissed));
		assert.deepEqual(courseStore.get(courseId)!.evidence.filter((event) => event.type === "answer"), [
			{ type: "answer", chatId, unitId: "vectors", id: `${chatId}:quiz1`, at: answer.answeredAt, phase: "teach", tool: "quiz", questionType: "check", nodeId: "span", nodeTitle: "Span", result: "skipped" },
		]);
	});

	it("keeps a parked practice dismissal's evidence when its session is deleted after settlement", async () => {
		const { courseId } = startedTeachingUnit();
		const practice = chatStore.createChat("Practice", "practice", { role: "practice", courseId, unitId: "vectors" });
		const chatId = practice.id;
		chatStore.saveSettings(chatId, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		const engine = scripted([async () => {
			await parkThroughRoute(chatId, { type: "dismiss-problem", problemCallId: "problem1" });
			return fauxAssistantMessage([fauxToolCall("problem", problemArgs(), { id: "problem1" })], { stopReason: "toolUse" });
		}]);
		assert.equal(await runTurn(chatId, { type: "text", text: "One problem, please." }, factory(chatId, engine)), 200);
		const marker = chatStore.getChat(chatId)!.messages.find((message) => message.role === "custom" && message.customType === "problem-dismissed");
		assert.ok(marker);
		const expected = [{ type: "practice", id: `${chatId}:problem1`, at: new Date(marker.timestamp).toISOString(), practiceChatId: chatId, unitId: "vectors", problemCallId: "problem1", outcome: "dismissed" }];
		assert.deepEqual(courseStore.get(courseId)!.evidence.filter((event) => event.type === "practice"), expected);
		assert.ok(chatStore.deleteChat(chatId));
		courses.syncCourseEvidence(courseId);
		assert.deepEqual(courseStore.get(courseId)!.evidence.filter((event) => event.type === "practice"), expected);
	});
});
