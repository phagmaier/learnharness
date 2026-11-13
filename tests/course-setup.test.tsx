/**
 * Plan 04 item 2: the course setup session. The setup agent's prompt and
 * tools, propose_course validation through a scripted turn, course
 * creation (record, setup link, unit 1 started, refusals), the closed
 * session gate, extraction and chains-view exclusion, the start surfaces,
 * and the proposal card's renders. Fakes only (pi-ai's faux provider);
 * runs under an isolated LH_DATA_DIR set before any config-loading import.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-setup-"));
process.env.LH_DATA_DIR = TMP;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { courseStore } = await import("../src/store/courses.ts");
const { createSetupAgent, composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { createSetupTools } = await import("../src/agent/tools.ts");
const { SETUP_DOCTRINE } = await import("../src/agent/course-prompts.ts");
const { handleChatRequest, handleChatInput } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const courses = await import("../src/server/courses.ts");
const core = await import("../src/core/index.ts");
const { CourseProposalCard, CourseSetupContext } = await import("../components/artifacts/course-proposal-card.tsx");
const { CourseClosedBand } = await import("../components/course-session.tsx");
const { SessionRow } = await import("../components/sidebar.tsx");
const { startDraftSession } = await import("../components/new-session.tsx");
const { modePlaceholder } = await import("../components/start-session.ts");
type PiEngine = import("../src/agent/models.ts").PiEngine;
type LhMessage = import("../src/core/native-messages.ts").LhMessage;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SOURCE = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", "src", "agent", file), "utf-8").trim();

/** A valid proposal: 3 units, the third building on both earlier ones. */
const PROPOSAL = {
	title: "Linear algebra",
	goal: "Understand eigenvectors and diagonalization.",
	units: [
		{ key: "vectors", title: "Vectors and span", goal: "Work with span and bases.", prerequisites: [], startingPoint: "Knows arrows; span is new." },
		{ key: "maps", title: "Linear maps", goal: "Matrices as maps.", prerequisites: ["vectors"], startingPoint: "new" },
		{ key: "eigen", title: "Eigenvectors", goal: "Diagonalize a matrix.", prerequisites: ["vectors", "maps"], startingPoint: "new" },
	],
};

// ─── harness (the practice-flow idiom: faux engine + the handler seam) ──────

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

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, input }) });
}

/** The handler picks the agent; the factory records its choice and builds
 *  the real setup agent on the faux engine. */
function setupFactory(chatId: string, engine: PiEngine, kinds: string[]): Parameters<typeof handleChatRequest>[1] {
	return (opts) => {
		kinds.push(opts.agentKind ?? "?");
		return createSetupAgent({ chatId, chatStore, jobStore, spawn: () => {} }, { engine, messages: opts.messages });
	};
}

async function runTurn(chatId: string, input: unknown, factory: Parameters<typeof handleChatRequest>[1]): Promise<Response> {
	const ack = await handleChatRequest(post(chatId, input), factory);
	if (ack.status === 200) {
		const handle = runningTurn(chatId);
		if (handle) await new Response(handle.subscribe()).text();
	}
	return ack;
}

function setupChat(title = "Linear algebra"): string {
	const chat = chatStore.createChat(title, undefined, { role: "setup" });
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return chat.id;
}

/** A setup chat whose turn proposed PROPOSAL (call "prop-2"). */
async function proposedSetup(): Promise<string> {
	const chatId = setupChat();
	const { engine } = scripted([
		() => fauxAssistantMessage([fauxToolCall("propose_course", PROPOSAL, { id: "prop-2" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage([fauxText("Three units.")]),
	]);
	const res = await runTurn(chatId, { type: "text", text: "teach me linear algebra" }, setupFactory(chatId, engine, []));
	assert.equal(res.status, 200);
	return chatId;
}

const editedUnits = () => PROPOSAL.units.map(({ key, title, goal, startingPoint, prerequisites }) => ({ key, title, goal, startingPoint, prerequisites }));

// ─── the setup agent ────────────────────────────────────────────────────────

describe("the setup agent", () => {
	it("composes the base, the setup doctrine, and the shared fragments, never the prober doctrine", () => {
		const prompt = composeInstructions("setup");
		const base = prompt.indexOf(SOURCE("system-prompt.md"));
		const doctrine = prompt.indexOf(SETUP_DOCTRINE);
		const formatting = prompt.indexOf(SOURCE("prompts/shared/40-formatting.md"));
		assert.ok(base === 0 && doctrine > base && formatting > doctrine, "base → setup doctrine → shared fragments");
		assert.ok(!prompt.includes(SOURCE("prompts/prober/10-probe-doctrine.md")), "no prober doctrine");
		assert.ok(SETUP_DOCTRINE.startsWith("# Course setup\n\nThe learner wants to learn a large subject as a course"));
	});

	it("has the prober's probing tools and propose_course, but no probe_done or plan tools", () => {
		const names = Object.keys(createSetupTools({ chatId: "c", chatStore, jobStore, spawn: () => {} })).sort();
		assert.deepEqual(names, ["ask_user_question", "find", "grep", "ls", "pdf", "probe", "propose_course", "read", "research"].sort());
		const recall = Object.keys(createSetupTools({ chatId: "c", chatStore, jobStore, spawn: () => {} }, { quizMechanics: "free" } as never));
		assert.ok(recall.includes("propose_course"));
	});

	it("is chosen for a setup session; propose_course problems go back to the model, which then proposes a valid list", async () => {
		const chatId = setupChat();
		const forward = { ...PROPOSAL, units: [{ ...PROPOSAL.units[0]!, prerequisites: ["maps"] }, PROPOSAL.units[1]!] };
		const { engine, contexts } = scripted([
			() => fauxAssistantMessage([fauxToolCall("propose_course", forward, { id: "prop-1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("propose_course", PROPOSAL, { id: "prop-2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Here is the plan: three units.")]),
		]);
		const kinds: string[] = [];
		const res = await runTurn(chatId, { type: "text", text: "teach me linear algebra" }, setupFactory(chatId, engine, kinds));
		assert.equal(res.status, 200);
		assert.deepEqual(kinds, ["setup"]);
		// The prompt and tool declarations ride the transcript's system message.
		const system = JSON.stringify(contexts[0]!.messages.filter((m) => (m.role as string) === "system"));
		assert.ok(system.includes("# Course setup"), "the setup doctrine is in the system prompt");
		assert.ok(system.includes('"propose_course"'));
		assert.ok(!system.includes('"probe_done"'));
		// The second request carries the refusal of the first proposal.
		const refusal = JSON.stringify(contexts[1]!.messages.at(-1));
		assert.ok(refusal.includes("Unit 1 (Vectors and span) builds on unit 2 (Linear maps), which comes after it."), refusal);
		const messages = chatStore.getChat(chatId)!.messages;
		const results = messages.filter((m): m is LhMessage & { role: "toolResult"; isError: boolean; toolCallId: string } => m.role === "toolResult");
		assert.deepEqual(results.map((r) => [r.toolCallId, r.isError]), [["prop-1", true], ["prop-2", false]]);
		assert.equal(core.latestProposalCallId(messages), "prop-2");
	});
});

// ─── creating the course ────────────────────────────────────────────────────

describe("creating a course", () => {
	it("writes the record, links the setup session, and starts unit 1", async () => {
		const setupId = await proposedSetup();
		const units = editedUnits();
		units[1] = { ...units[1]!, title: "Linear maps and matrices" };
		units.push({ key: "new-1", title: "Determinants", goal: "Compute them.", startingPoint: "", prerequisites: ["maps"] });
		const out = courses.createCourseFromSetup({ setupChatId: setupId, toolCallId: "prop-2", title: "Linear algebra", goal: "Eigenvectors.", units });
		assert.ok(out.ok, JSON.stringify(out));
		const record = courseStore.get(out.courseId)!;
		assert.equal(record.setupChatId, setupId);
		assert.deepEqual(record.units.map((u) => [u.id, u.title, u.prerequisites, u.status]), [
			["vectors-and-span", "Vectors and span", [], "in-progress"],
			["linear-maps-and-matrices", "Linear maps and matrices", ["vectors-and-span"], "not-started"],
			["eigenvectors", "Eigenvectors", ["vectors-and-span", "linear-maps-and-matrices"], "not-started"],
			["determinants", "Determinants", ["linear-maps-and-matrices"], "not-started"],
		]);
		assert.equal(record.units[0]!.startingPoint, "Knows arrows; span is new.");
		assert.equal(record.units[3]!.startingPoint, undefined);
		assert.deepEqual(chatStore.getChat(setupId)!.course, { role: "setup", courseId: out.courseId });

		// Unit 1's session: titled, linked, opened by its unit-start marker.
		const unitChat = chatStore.getChat(out.chatId!)!;
		assert.equal(record.units[0]!.chatId, unitChat.id);
		assert.equal(unitChat.title, "Linear algebra · 1. Vectors and span");
		assert.deepEqual(unitChat.course, { role: "unit", courseId: out.courseId, unitId: "vectors-and-span" });
		assert.equal(unitChat.messages.length, 1);
		const marker = unitChat.messages[0] as LhMessage & { customType: string; content: string };
		assert.equal(marker.customType, "unit-start");
		assert.equal(marker.content, "[Unit start] The learner opened unit 1, Vectors and span. Begin the unit's probe.");
		assert.equal(core.needsContinuation(unitChat.messages), true, "the chat page continues at once");
		assert.equal(core.reconstructRequestCause(unitChat.messages), "foreground", "the click is learner input");
		assert.deepEqual(record.evidence.map((e) => [e.type, (e as { unitId?: string }).unitId]), [["unit-started", "vectors-and-span"]]);
		assert.ok(fs.existsSync(path.join(TMP, "courses", out.courseId, "progress.md")));
	});

	it("refuses an invalid edited list, a replaced proposal, a running turn, and a second creation", async () => {
		const setupId = await proposedSetup();
		const forward = editedUnits();
		forward[0] = { ...forward[0]!, prerequisites: ["eigen"] };
		const invalid = courses.createCourseFromSetup({ setupChatId: setupId, toolCallId: "prop-2", title: "Linear algebra", goal: "g", units: forward });
		assert.deepEqual(invalid, { ok: false, status: 400, error: "Unit 1 (Vectors and span) builds on unit 3 (Eigenvectors), which comes after it. A unit can only build on earlier units.", problems: [
			"Unit 1 (Vectors and span) builds on unit 3 (Eigenvectors), which comes after it. A unit can only build on earlier units.",
		] });
		const blank = courses.createCourseFromSetup({ setupChatId: setupId, toolCallId: "prop-2", title: " ", goal: "g", units: editedUnits() });
		assert.equal(!blank.ok && blank.problems?.[0], "The course needs a title.");
		const replaced = courses.createCourseFromSetup({ setupChatId: setupId, toolCallId: "prop-old", title: "t", goal: "g", units: editedUnits() });
		assert.equal(!replaced.ok && replaced.status, 409);

		assert.ok(beginTurn(setupId));
		try {
			const running = courses.createCourseFromSetup({ setupChatId: setupId, toolCallId: "prop-2", title: "t", goal: "g", units: editedUnits() });
			assert.deepEqual(running, { ok: false, status: 409, error: "A turn is running in this session — try again when it finishes" });
		} finally {
			endTurn(setupId);
		}
		assert.equal(courseStore.list().courses.filter((c) => c.setupChatId === setupId).length, 0, "nothing was created");

		const first = courses.createCourseFromSetup({ setupChatId: setupId, toolCallId: "prop-2", title: "t", goal: "g", units: editedUnits() });
		assert.ok(first.ok);
		const second = courses.createCourseFromSetup({ setupChatId: setupId, toolCallId: "prop-2", title: "t", goal: "g", units: editedUnits() });
		assert.deepEqual(second, { ok: false, status: 409, error: "This course has already been created." });
	});

	it("the route answers 201 with the course and unit 1, and 400 with problems", async () => {
		const route = await import("../app/api/courses/route.ts");
		const setupId = await proposedSetup();
		const call = (body: unknown) => route.POST(new Request("http://test/api/courses", { method: "POST", body: JSON.stringify(body) }));
		const bad = await call({ setupChatId: setupId, toolCallId: "prop-2", title: "t", goal: "g", units: [] });
		assert.equal(bad.status, 400);
		assert.deepEqual((await bad.json()).problems, ["A course needs at least one unit."]);
		const ok = await call({ setupChatId: setupId, toolCallId: "prop-2", title: "t", goal: "g", units: editedUnits() });
		assert.equal(ok.status, 201);
		const body = await ok.json() as { courseId: string; chatId: string };
		assert.equal(courseStore.get(body.courseId)!.units[0]!.chatId, body.chatId);
	});

	it("validates proposal keys before converting them into stored unit ids", async () => {
		const setupId = await proposedSetup();
		const duplicate = editedUnits();
		duplicate[1] = { ...duplicate[1]!, key: duplicate[0]!.key, prerequisites: [] };
		const unknown = editedUnits();
		unknown[1] = { ...unknown[1]!, prerequisites: ["vectors-and-span"] };
		for (const units of [duplicate, unknown]) {
			const result = courses.createCourseFromSetup({ setupChatId: setupId, toolCallId: "prop-2", title: "t", goal: "g", units });
			assert.equal(!result.ok && result.status, 400);
		}
		assert.equal(courseStore.list().courses.filter((c) => c.setupChatId === setupId).length, 0);
	});

	it("adopts a course whose setup link a crash left unwritten", async () => {
		const setupId = await proposedSetup();
		const out = courses.createCourseFromSetup({ setupChatId: setupId, toolCallId: "prop-2", title: "t", goal: "g", units: editedUnits() });
		assert.ok(out.ok);
		chatStore.setCourseLink(setupId, { role: "setup" });
		assert.equal(courses.setupCourseId(chatStore.getChat(setupId)!), out.courseId);
		assert.deepEqual(chatStore.getChat(setupId)!.course, { role: "setup", courseId: out.courseId });
	});
});

describe("after creation", () => {
	it("the server refuses new main input to the setup session; a job delivery is left pending", async () => {
		const setupId = await proposedSetup();
		const out = courses.createCourseFromSetup({ setupChatId: setupId, toolCallId: "prop-2", title: "t", goal: "g", units: editedUnits() });
		assert.ok(out.ok);
		const { engine, contexts } = scripted([() => fauxAssistantMessage([fauxText("never")])]);
		const text = await runTurn(setupId, { type: "text", text: "one more thing" }, setupFactory(setupId, engine, []));
		assert.equal(text.status, 409);
		assert.deepEqual(await text.json(), { error: "This course has been created. Continue in its units." });
		// The wake pipeline enters through handleChatInput (server-originated input).
		const steer = core.buildProbeHandoffSteer(setupId) as unknown as LhMessage;
		const wake = await handleChatInput(setupId, { type: "steers", steers: [steer] }, setupFactory(setupId, engine, []));
		assert.equal(wake.status, 410);
		assert.equal(contexts.length, 0, "no model call");
		assert.equal(courses.sessionCourseView(chatStore.getChat(setupId)!)?.role, "setup");
	});

	it("setup sessions are never extracted and are hidden from the chains view and practice picker", () => {
		assert.equal(core.sessionExtracts({ course: { role: "setup" } }), false);
		assert.equal(core.sessionExtracts({ kind: "practice" }), false);
		assert.equal(core.sessionExtracts({ course: { role: "unit" } }), true);
		assert.equal(core.sessionExtracts({}), true);
		const directory = {
			organization: { version: 1 as const, folders: [], placements: {} },
			sources: [
				{ id: "a", kind: "chat" as const, chatKind: "teach" as const, courseRole: "setup" as const, label: "Setup", createdAt: null },
				{ id: "b", kind: "chat" as const, chatKind: "teach" as const, courseRole: "unit" as const, label: "Unit", createdAt: null },
				{ id: "c", kind: "chat" as const, chatKind: "teach" as const, label: "Teach", createdAt: null },
			],
		};
		assert.deepEqual(core.chainSourceDirectory(directory).sources.map((s) => s.id), ["b", "c"]);
	});

	it("the setup session has no notes", async () => {
		const { createNote } = await import("../src/server/notes.ts");
		const setupId = setupChat();
		assert.deepEqual(createNote(setupId, {}), { ok: false, status: 400, error: "Course setup sessions have no notes." });
	});
});

// ─── starting a course ──────────────────────────────────────────────────────

describe("the start surfaces", () => {
	it("a course draft creates a setup session", async () => {
		const calls: unknown[] = [];
		const storage = new Map<string, string>();
		Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } } });
		const f = (async (_url: string, init?: RequestInit) => { calls.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ id: "chat_new" })); }) as typeof fetch;
		assert.equal(await startDraftSession("linear algebra", f, "course"), "/chat/chat_new");
		assert.deepEqual(calls, [{ title: "linear algebra", course: { role: "setup" } }]);
		assert.equal(modePlaceholder("course"), "What do you want to learn in this course?");
		Reflect.deleteProperty(globalThis, "sessionStorage");
	});

	it("POST /api/chats creates a setup session with its back-pointer", async () => {
		const route = await import("../app/api/chats/route.ts");
		const res = await route.POST(new Request("http://test/api/chats", { method: "POST", body: JSON.stringify({ title: "Linear algebra", course: { role: "setup" } }) }));
		const { id } = await res.json() as { id: string };
		assert.deepEqual(chatStore.getChat(id)!.course, { role: "setup" });
		const practice = await route.POST(new Request("http://test/api/chats", { method: "POST", body: JSON.stringify({ title: "x", kind: "practice", course: { role: "setup" } }) }));
		assert.equal(chatStore.getChat((await practice.json() as { id: string }).id)!.course, undefined, "a practice session is never a setup");
	});

	it("an uncreated setup session's row carries the course icon and the meta", () => {
		const row = (course: { role: "setup"; courseId?: string }) => renderToStaticMarkup(<SessionRow chat={{
			id: "c", title: "Linear algebra", createdAt: "2026-11-13T00:00:00Z", updatedAt: new Date().toISOString(), kind: "teach",
			messageCount: 3, phase: "probe", pendingQuestion: false, pendingProblem: false, busy: false, compacting: false, course,
		}} active={false} onOpen={() => {}} />);
		const html = row({ role: "setup" });
		assert.ok(html.includes("Course setup · just now"), html);
		assert.ok(html.includes('aria-label="Course setup"'));
		assert.ok(!row({ role: "setup", courseId: "course_1" }).includes("Course setup ·"));
	});
});

// ─── the editor model and the card ──────────────────────────────────────────

describe("the unit editor model", () => {
	const rows = () => core.parseCourseProposal(PROPOSAL)!.units;

	it("won't move a unit past one it builds on, and keeps prerequisites in course order", () => {
		assert.equal(core.canMoveDraftUnit(rows(), 1, -1), false, "maps builds on vectors");
		assert.equal(core.canMoveDraftUnit(rows(), 0, 1), false);
		assert.equal(core.canMoveDraftUnit(rows(), 0, -1), false, "already first");
		const free = rows().map((row) => ({ ...row, prerequisites: [] }));
		assert.deepEqual(core.moveDraftUnit(free, 2, -1).map((r) => r.key), ["vectors", "eigen", "maps"]);
		const toggled = core.togglePrerequisite(core.togglePrerequisite(free, 2, "maps"), 2, "vectors");
		assert.deepEqual(toggled[2]!.prerequisites, ["vectors", "maps"]);
		assert.deepEqual(core.togglePrerequisite(toggled, 2, "vectors")[2]!.prerequisites, ["maps"]);
	});

	it("removing a unit drops it from later prerequisites; a started unit stays", () => {
		const out = core.removeDraftUnit(rows(), 1);
		assert.deepEqual(out.map((r) => [r.key, r.prerequisites]), [["vectors", []], ["eigen", ["vectors"]]]);
		const locked = rows().map((row, i) => (i === 0 ? { ...row, locked: true } : row));
		assert.equal(core.removeDraftUnit(locked, 0).length, 3);
		assert.deepEqual(core.draftProblems({ title: "t", goal: "g", units: out }), []);
		assert.deepEqual(core.draftProblems({ title: "", goal: "g", units: [{ ...out[0]!, goal: "" }] }), ["The course needs a title.", "Unit 1 (Vectors and span) needs a goal."]);
	});
});

describe("the proposal card", () => {
	const part = (toolCallId: string) => ({ type: "tool-propose_course", state: "output-available", toolCallId, input: PROPOSAL, output: { ok: true } });
	const render = (toolCallId: string, setup: { latestCallId: string | null; courseId: string | null; busy?: boolean } | null) => renderToStaticMarkup(
		<CourseSetupContext.Provider value={setup && { chatId: "chat_s", busy: false, navigate: () => {}, ...setup }}>
			<CourseProposalCard part={part(toolCallId)} />
		</CourseSetupContext.Provider>,
	);

	it("the latest proposal is editable: title, goal, units with their fields, builds-on checkboxes, moves, removal, add, create", () => {
		const html = render("prop-2", { latestCallId: "prop-2", courseId: null });
		assert.ok(html.includes('data-state="editable"'));
		for (const label of ["Course title", "Course goal", "Unit 1 title", "Unit 2 goal", "Unit 3 starting point"]) assert.ok(html.includes(`aria-label="${label}"`), label);
		assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3, "unit 2 has one earlier unit, unit 3 two");
		assert.equal((html.match(/checked=""/g) ?? []).length, 3);
		assert.ok(html.includes("Builds on"));
		assert.equal((html.match(/aria-label="Move unit up"/g) ?? []).length, 3);
		assert.equal((html.match(/aria-label="Remove unit"/g) ?? []).length, 3);
		assert.ok(html.includes("Add unit"));
		assert.match(html, /<button[^>]*>Create course<\/button>/);
		assert.ok(!/<button[^>]*disabled=""[^>]*>Create course/.test(html), "enabled for a valid list");
		assert.match(render("prop-2", { latestCallId: "prop-2", courseId: null, busy: true }), /<button[^>]*disabled=""[^>]*>Create course/);
	});

	it("an older proposal renders read-only, collapsed, and marked Replaced", () => {
		const html = render("prop-1", { latestCallId: "prop-2", courseId: null });
		assert.ok(html.includes('data-state="replaced"'));
		assert.ok(html.includes(">Replaced<"));
		assert.ok(html.includes("<details"));
		assert.ok(!html.includes("<input") && !html.includes("<textarea"));
		assert.ok(html.includes("Builds on 1, 2"));
	});

	it("after creation the proposal is read-only and the band replaces the composer", () => {
		const html = render("prop-2", { latestCallId: "prop-2", courseId: "course_1" });
		assert.ok(html.includes(">Course created<") && !html.includes("<input"));
		assert.ok(html.includes('data-state="created"') && html.includes("<details"), "collapsed once the course exists");
		const band = renderToStaticMarkup(<CourseClosedBand view={{ role: "setup", courseId: "course_1" }} />);
		assert.ok(band.includes("This course has been created."));
		assert.ok(band.includes('href="/course/course_1"') && band.includes("Open course"));
		assert.equal(renderToStaticMarkup(<CourseClosedBand view={{ role: "setup", courseId: null }} />), "");
	});

	it("a refused call renders nothing", () => {
		const html = renderToStaticMarkup(<CourseProposalCard part={{ ...part("x"), state: "output-error", output: undefined }} />);
		assert.equal(html, "");
	});
});
