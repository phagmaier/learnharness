/**
 * Plan 04 item 7: course revisions. The unit teacher's
 * propose_course_changes (a real turn: a refusal back to the model, then a
 * stored pending proposal), each change type applied on accept, the
 * decision-5 and order refusals, replacement of a pending proposal,
 * outdated detection after a conflicting learner edit, reject changing
 * nothing, the revision evidence, the decision route's refusals, the
 * store's change shapes, and the card's states. Every expected unit list
 * and line is worked by hand from the fixture. Fakes only (pi-ai's faux
 * provider); an isolated LH_DATA_DIR is set before any config import.
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-revisions-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { courseStore, courseDir } = await import("../src/store/courses.ts");
const { createProberAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const courses = await import("../src/server/courses.ts");
const core = await import("../src/core/index.ts");
const proposalRoute = await import("../app/api/courses/[id]/proposals/[proposalId]/route.ts");
const courseRoute = await import("../app/api/courses/[id]/route.ts");
const { CourseChangesCard, CourseProposalsContext, ProposeCourseChangesCard } = await import("../components/course-changes-card.tsx");
type PiEngine = import("../src/agent/models.ts").PiEngine;
type LhMessage = import("../src/core/native-messages.ts").LhMessage;
type CourseRecord = import("../src/core/contracts/course.ts").CourseRecord;
type CourseUnit = import("../src/core/contracts/course.ts").CourseUnit;
type CourseChange = import("../src/core/contracts/course.ts").CourseChange;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ─── fixtures ───────────────────────────────────────────────────────────────

/** Unit 1 is completed and unit 2 in progress (both started); 3–5 haven't
 *  started. Eigen (4) builds on maps (2) and det (3); jordan (5) on eigen. */
function units(): CourseUnit[] {
	return [
		{ id: "vectors", title: "Vectors and span", goal: "Work with span.", prerequisites: [], status: "completed", chatId: "chat_v", completion: "confirmed", completedAt: "2026-11-20T12:00:00.000Z" },
		{ id: "maps", title: "Linear maps", goal: "Matrices as maps.", prerequisites: ["vectors"], status: "in-progress", chatId: "chat_m" },
		{ id: "det", title: "Determinants", goal: "Compute determinants.", startingPoint: "Computes 2×2 determinants.", prerequisites: [], status: "not-started" },
		{ id: "eigen", title: "Eigenvectors", goal: "Diagonalize a matrix.", startingPoint: "Has seen eigenvalues once.", prerequisites: ["maps", "det"], status: "not-started" },
		{ id: "jordan", title: "Jordan form", goal: "Find the Jordan form.", prerequisites: ["eigen"], status: "not-started" },
	];
}

const UPDATED = "2026-11-13T09:00:00.000Z";
let counter = 0;
function makeCourse(list: CourseUnit[] = units(), extra: Partial<CourseRecord> = {}): CourseRecord {
	const record: CourseRecord = {
		id: `course_rev_${++counter}`, title: "Linear algebra", goal: "Understand eigenvectors.",
		createdAt: UPDATED, updatedAt: UPDATED, setupChatId: "chat_setup",
		units: list, proposals: [], evidence: [], ...extra,
	};
	courseStore.create(record);
	return record;
}

/** Store a proposal from unit 2's session (chat_m), as its teacher would. */
function propose(course: CourseRecord, changes: CourseChange[], toolCallId = `call_${++counter}`, reason = "The unit showed it.") {
	return courses.recordCourseProposal(course.id, "maps", "chat_m", toolCallId, { reason, changes });
}

function proposed(course: CourseRecord, changes: CourseChange[]): string {
	const outcome = propose(course, changes);
	assert.ok(outcome.ok, JSON.stringify(outcome));
	return outcome.proposalId;
}

async function decide(courseId: string, proposalId: string, decision: unknown): Promise<Response> {
	return proposalRoute.POST(
		new Request("http://test", { method: "POST", body: JSON.stringify({ decision }) }),
		{ params: Promise.resolve({ id: courseId, proposalId }) },
	);
}

const shape = (list: readonly CourseUnit[]) => list.map((unit) => [unit.id, unit.status, unit.prerequisites.join(",")]);

// ─── accepting each change type ─────────────────────────────────────────────

describe("accepting a proposal", () => {
	it("inserts a unit after another, building on earlier units", async () => {
		const course = makeCourse();
		const id = proposed(course, [{ type: "insert", after: "maps", title: "Change of basis", goal: "Change coordinates.", prerequisites: ["maps"] }]);
		const response = await decide(course.id, id, "accept");
		assert.equal(response.status, 200);
		const after = courseStore.get(course.id)!;
		assert.deepEqual(shape(after.units), [
			["vectors", "completed", ""], ["maps", "in-progress", "vectors"], ["change-of-basis", "not-started", "maps"],
			["det", "not-started", ""], ["eigen", "not-started", "maps,det"], ["jordan", "not-started", "eigen"],
		]);
		assert.equal(after.units[2]!.goal, "Change coordinates.");
		assert.equal(after.units[2]!.startingPoint, undefined);
		assert.equal(after.proposals[0]!.status, "accepted");
		assert.ok(after.proposals[0]!.decidedAt);
		assert.notEqual(after.updatedAt, UPDATED, "the units changed, so an open editor's snapshot is stale");
		assert.deepEqual((await response.json() as { course: CourseRecord }).course.units.map((unit) => unit.id), after.units.map((unit) => unit.id));
	});

	it("drops a unit that hasn't started; its dependants inherit its prerequisites", async () => {
		const course = makeCourse();
		const id = proposed(course, [{ type: "drop", unit: "det" }]);
		assert.equal((await decide(course.id, id, "accept")).status, 200);
		assert.deepEqual(shape(courseStore.get(course.id)!.units), [
			["vectors", "completed", ""], ["maps", "in-progress", "vectors"], ["eigen", "not-started", "maps"], ["jordan", "not-started", "eigen"],
		]);
	});

	it("moves units, a started one included, to the start or after another", async () => {
		const course = makeCourse();
		// det to the start (det, vectors, maps, …), then the completed vectors
		// back to the start (vectors, det, maps, …). Lines number the units
		// as they stood before the proposal.
		const id = proposed(course, [{ type: "move", unit: "det", after: null }, { type: "move", unit: "vectors", after: null }]);
		assert.equal((await decide(course.id, id, "accept")).status, 200);
		assert.deepEqual(shape(courseStore.get(course.id)!.units), [
			["vectors", "completed", ""], ["det", "not-started", ""], ["maps", "in-progress", "vectors"], ["eigen", "not-started", "maps,det"], ["jordan", "not-started", "eigen"],
		]);
		assert.deepEqual(courseStore.get(course.id)!.evidence.map((event) => event.type === "revision" && event.changes), [["Move 3 to the start", "Move 1 to the start"]]);
		// A move that puts a unit before one it builds on is refused.
		assert.deepEqual(propose(courseStore.get(course.id)!, [{ type: "move", unit: "maps", after: null }]),
			{ ok: false, problems: ["Unit 1 (Linear maps) builds on unit 2 (Vectors and span), which comes after it. A unit can only build on earlier units."] });
	});

	it("merges units that haven't started into one at the earliest place, joining prerequisites and starting points", async () => {
		const course = makeCourse();
		const id = proposed(course, [{ type: "merge", units: ["eigen", "jordan"], title: "Spectral theory", goal: "Diagonalize and find Jordan forms." }]);
		assert.equal((await decide(course.id, id, "accept")).status, 200);
		const after = courseStore.get(course.id)!;
		assert.deepEqual(shape(after.units), [
			["vectors", "completed", ""], ["maps", "in-progress", "vectors"], ["det", "not-started", ""], ["spectral-theory", "not-started", "maps,det"],
		]);
		assert.equal(after.units[3]!.startingPoint, "Has seen eigenvalues once.");
		assert.equal(after.units[3]!.title, "Spectral theory");
	});

	it("records a revision event numbered against the units it was decided on, which the course context keeps", async () => {
		const course = makeCourse();
		const id = proposed(course, [{ type: "drop", unit: "det" }, { type: "merge", units: ["eigen", "jordan"], title: "Spectral theory", goal: "Both." }]);
		assert.equal((await decide(course.id, id, "accept")).status, 200);
		const after = courseStore.get(course.id)!;
		const revision = after.evidence.find((event) => event.type === "revision");
		assert.deepEqual(revision && { ...revision, at: "" }, {
			type: "revision", id: `revision:${id}`, at: "", source: "teacher", decision: "accepted", proposalId: id,
			changes: ["Drop 3: Determinants", "Merge 4 and 5 into: Spectral theory"],
		});
		// det, eigen and jordan are gone: the lines come from the decision.
		assert.ok(core.unitCourseContext(after, "maps").endsWith(
			"Your course-change proposals from this unit:\n- Accepted: The unit showed it.\n  - Drop 3: Determinants\n  - Merge 4 and 5 into: Spectral theory",
		));
		assert.deepEqual(core.proposalView(after, after.proposals[0]!).lines, ["Drop 3: Determinants", "Merge 4 and 5 into: Spectral theory"]);
	});
});

// ─── refusals back to the teacher ───────────────────────────────────────────

describe("proposing", () => {
	it("refuses dropping or merging a started unit and a prerequisite on a later unit, storing nothing", () => {
		const course = makeCourse();
		assert.deepEqual(propose(course, [{ type: "drop", unit: "maps" }]), { ok: false, problems: ["Unit 2 (Linear maps) has started, so it can't be dropped."] });
		assert.deepEqual(propose(course, [{ type: "merge", units: ["vectors", "det"], title: "Basics", goal: "Both." }]), { ok: false, problems: ["Unit 1 (Vectors and span) has started, so it can't be merged."] });
		assert.deepEqual(propose(course, [{ type: "insert", after: null, title: "Linear systems", goal: "Solve systems.", prerequisites: ["eigen"] }]), {
			ok: false, problems: ["Unit 1 (Linear systems) builds on unit 5 (Eigenvectors), which comes after it. A unit can only build on earlier units."],
		});
		assert.deepEqual(propose(course, [{ type: "move", unit: "jordan", after: "nope" }]), { ok: false, problems: ['There is no unit "nope" in the course.'] });
		assert.deepEqual(courseStore.get(course.id)!.proposals, []);
	});

	it("refuses a session that isn't the unit's, and a completed unit", () => {
		const course = makeCourse();
		assert.deepEqual(courses.recordCourseProposal(course.id, "maps", "chat_other", "c1", { reason: "r", changes: [{ type: "drop", unit: "det" }] }),
			{ ok: false, refused: "The proposal couldn't be recorded: this session is no longer a unit of the course." });
		assert.deepEqual(courses.recordCourseProposal(course.id, "vectors", "chat_v", "c2", { reason: "r", changes: [{ type: "drop", unit: "det" }] }),
			{ ok: false, refused: "The proposal couldn't be recorded: this unit is already completed." });
	});

	it("a later proposal from the unit replaces its pending one; the same call recorded twice keeps its first", () => {
		const course = makeCourse();
		const first = proposed(course, [{ type: "drop", unit: "det" }]);
		const again = propose(course, [{ type: "drop", unit: "jordan" }], "call_second");
		assert.ok(again.ok);
		const repeat = propose(course, [{ type: "drop", unit: "eigen" }], "call_second");
		assert.deepEqual(repeat, { ok: true, proposalId: again.proposalId });
		const after = courseStore.get(course.id)!;
		assert.deepEqual(after.proposals.map((p) => [p.id, p.status, p.outdatedReason]), [
			[first, "outdated", "Replaced by a later proposal from this unit."],
			[again.proposalId, "pending", undefined],
		]);
		assert.deepEqual(after.proposals[1]!.changes, [{ type: "drop", unit: "jordan" }]);
		assert.equal(after.updatedAt, UPDATED, "proposing doesn't change the units");
		assert.equal(after.evidence.length, 0, "a replaced proposal isn't a learner decision");
	});

	it("names the fields each change type needs", () => {
		assert.deepEqual(core.courseChangesFromFields([
			{ type: "move", unit: "det" },
			{ type: "insert", after: null, title: " ", goal: "g" },
			{ type: "merge", units: ["eigen"], title: "t", goal: "g" },
			{ type: "drop" },
			{ type: "split" },
		]), { problems: [
			'Change 1 (move) needs "after": the id of the unit it goes after, or null for the start.',
			'Change 2 (insert) needs "title".',
			'Change 3 (merge) needs "units": the ids of two or more units.',
			'Change 4 (drop) needs "unit": the unit\'s id.',
			'Change 5 has an unknown type "split": use insert, drop, move, or merge.',
		] });
		assert.deepEqual(core.courseChangesFromFields([{ type: "insert", after: " maps ", title: " Basis ", goal: "g", prerequisites: ["maps", "maps"], unit: "ignored" }]),
			{ changes: [{ type: "insert", after: "maps", title: "Basis", goal: "g", prerequisites: ["maps"] }] });
	});
});

// ─── outdated, rejected, and the route's refusals ───────────────────────────

describe("deciding", () => {
	it("an accept that no longer applies after a learner edit becomes outdated, and nothing changes", async () => {
		const course = makeCourse();
		const id = proposed(course, [{ type: "drop", unit: "jordan" }]);
		// The learner removes jordan first (not started; nothing builds on it).
		const edited = await courseRoute.PUT(new Request("http://test", { method: "PUT", body: JSON.stringify({
			units: units().slice(0, 4).map(({ id: unitId, title, goal, startingPoint, prerequisites }) => ({ id: unitId, title, goal, startingPoint, prerequisites })),
		}) }), { params: Promise.resolve({ id: course.id }) });
		assert.equal(edited.status, 200);
		const before = courseStore.get(course.id)!;
		const response = await decide(course.id, id, "accept");
		assert.equal(response.status, 200);
		const after = courseStore.get(course.id)!;
		assert.deepEqual(after.units, before.units);
		assert.equal(after.updatedAt, before.updatedAt);
		assert.equal(after.proposals[0]!.status, "outdated");
		assert.equal(after.proposals[0]!.outdatedReason, 'There is no unit "jordan" in the course.');
		assert.deepEqual(after.evidence.filter((event) => event.type === "revision").map((event) => event.type === "revision" && event.source), ["learner"], "only the learner's edit is a revision");
		assert.equal((await decide(course.id, id, "reject")).status, 409, "an outdated proposal is settled");
	});

	it("also finds a proposal outdated once a unit it drops has started", async () => {
		const course = makeCourse();
		const id = proposed(course, [{ type: "drop", unit: "det" }]);
		courseStore.update(course.id, (current) => ({ ...current, units: current.units.map((unit) => unit.id === "det" ? { ...unit, status: "in-progress" as const, chatId: "chat_d" } : unit) }));
		assert.equal((await decide(course.id, id, "accept")).status, 200);
		assert.equal(courseStore.get(course.id)!.proposals[0]!.outdatedReason, "Unit 3 (Determinants) has started, so it can't be dropped.");
	});

	it("reject changes nothing but records the decision", async () => {
		const course = makeCourse();
		const id = proposed(course, [{ type: "insert", after: "det", title: "Volumes", goal: "Read determinants as volume.", prerequisites: ["det"] }]);
		assert.ok(fs.readFileSync(path.join(courseDir(course.id), "progress.md"), "utf-8").includes("## Pending course changes\n\n- The unit showed it.\n  - Insert after 3: Volumes\n"));
		const response = await decide(course.id, id, "reject");
		assert.equal(response.status, 200);
		const after = courseStore.get(course.id)!;
		assert.deepEqual(after.units, units());
		assert.equal(after.updatedAt, UPDATED);
		assert.equal(after.proposals[0]!.status, "rejected");
		const revision = after.evidence[0];
		assert.deepEqual(revision && { ...revision, at: "" }, {
			type: "revision", id: `revision:${id}`, at: "", source: "teacher", decision: "rejected", proposalId: id, changes: ["Insert after 3: Volumes"],
		});
		assert.ok(!fs.readFileSync(path.join(courseDir(course.id), "progress.md"), "utf-8").includes("Pending course changes"), "progress.md drops it");
	});

	it("refuses a second decision, an unknown proposal, and an unknown decision", async () => {
		const course = makeCourse();
		const id = proposed(course, [{ type: "drop", unit: "det" }]);
		const bad = await decide(course.id, id, "maybe");
		assert.equal(bad.status, 400);
		assert.equal((await bad.json() as { error: string }).error, 'The decision must be "accept" or "reject".');
		assert.equal((await decide(course.id, "proposal_nope", "accept")).status, 404);
		assert.equal((await decide(course.id, id, "accept")).status, 200);
		const twice = await decide(course.id, id, "reject");
		assert.equal(twice.status, 409);
		assert.equal((await twice.json() as { error: string }).error, "This proposal has already been decided.");
		assert.equal(courseStore.get(course.id)!.evidence.filter((event) => event.type === "revision").length, 1);
	});
});

// ─── the store's change shapes ──────────────────────────────────────────────

describe("stored proposals", () => {
	const write = (record: CourseRecord) => fs.writeFileSync(path.join(courseDir(record.id), "course.json"), JSON.stringify({ ...record, version: 1 }));

	it("a malformed change makes the record unreadable; a change type a newer build wrote is kept and outdated on accept", async () => {
		const course = makeCourse();
		const base = { id: "p_x", chatId: "chat_m", unitId: "maps", toolCallId: "c", at: UPDATED, reason: "r", status: "pending" as const };
		write({ ...course, proposals: [{ ...base, changes: [{ type: "insert", after: "maps", title: "t" } as unknown as CourseChange] }] });
		assert.throws(() => courseStore.get(course.id), /damaged/);

		write({ ...course, proposals: [{ ...base, changes: [{ type: "split", unit: "eigen" } as unknown as CourseChange] }] });
		const read = courseStore.get(course.id)!;
		assert.deepEqual(core.proposalView(read, read.proposals[0]!).lines, ["Unknown change: split"]);
		assert.equal((await decide(course.id, "p_x", "accept")).status, 200);
		const after = courseStore.get(course.id)!;
		assert.equal(after.proposals[0]!.status, "outdated");
		assert.equal(after.proposals[0]!.outdatedReason, `This version of the app doesn't know the change "split".`);
		assert.deepEqual((after.proposals[0]!.changes[0] as unknown), { type: "split", unit: "eigen" }, "kept as written");
	});
});

// ─── a real teacher turn ────────────────────────────────────────────────────

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

function factory(chatId: string, engine: PiEngine): Factory {
	return (opts) => opts.agentKind === "teacher"
		? createTeacherAgent({ chatId, chatStore, jobStore, spawn: () => {} }, { ...opts, engine })
		: createProberAgent({ chatId, chatStore, jobStore, deliver: () => {}, spawn: () => {} }, { ...opts, engine });
}

async function runTurn(chatId: string, input: unknown, build: Factory): Promise<Response> {
	const request = new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, input }) });
	const ack = await handleChatRequest(request, build);
	if (ack.status === 200) {
		const handle = runningTurn(chatId);
		if (handle) await new Response(handle.subscribe()).text();
	}
	return ack;
}

const systemOf = (context: TranscriptContext) => JSON.stringify(context.messages.filter((m) => (m.role as string) === "system"));

/** A teaching session: the probe concluded, so the handler builds the teacher. */
function concludeProbe(chatId: string): void {
	chatStore.saveMessages(chatId, [
		...chatStore.getChat(chatId)!.messages,
		{ ...fauxAssistantMessage([fauxToolCall("probe_done", {}, { id: "probe-1" })], { stopReason: "toolUse" }), id: "probe-response" } as LhMessage,
		{ id: "probe-result", role: "toolResult", toolCallId: "probe-1", toolName: "probe_done", content: [], details: { ok: true }, isError: false, timestamp: 1 } as LhMessage,
		{ id: "learner-next", role: "user", content: "Let's go on.", timestamp: 2 } as LhMessage,
	]);
}

describe("propose_course_changes in a unit session", () => {
	for (const boundary of ["the same turn", "the next turn"] as const) {
		it(`records a replacement when the provider reuses an id in ${boundary}`, async () => {
			const course = makeCourse(units().map((unit) => unit.id === "maps" ? { ...unit, status: "not-started" as const, chatId: undefined } : unit));
			const started = courses.startUnit(course.id, "maps");
			assert.ok(started.ok);
			const chatId = started.chatId;
			chatStore.saveSettings(chatId, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
			concludeProbe(chatId);
			const { engine } = scripted([
				// A collision with another tool must also preserve the proposal's
				// canonical id, even before there is an earlier proposal.
				() => fauxAssistantMessage([fauxToolCall("goal_reached", { summary: "Maps are understood." }, { id: "call_0" })], { stopReason: "toolUse" }),
				() => fauxAssistantMessage([fauxToolCall("propose_course_changes", { reason: "Drop determinants.", changes: [{ type: "drop", unit: "det" }] }, { id: "call_0" })], { stopReason: "toolUse" }),
				...(boundary === "the next turn" ? [() => fauxAssistantMessage([fauxText("First proposal ready.")])] : []),
				() => fauxAssistantMessage([fauxToolCall("propose_course_changes", { reason: "Drop Jordan instead.", changes: [{ type: "drop", unit: "jordan" }] }, { id: "call_0" })], { stopReason: "toolUse" }),
				() => fauxAssistantMessage([fauxText("Replacement ready.")]),
			]);
			assert.equal((await runTurn(chatId, { type: "text", text: "Revise the course." }, factory(chatId, engine))).status, 200);
			if (boundary === "the next turn") {
				assert.equal((await runTurn(chatId, { type: "text", text: "Change that proposal." }, factory(chatId, engine))).status, 200);
			}

			const proposals = courseStore.get(course.id)!.proposals;
			assert.equal(proposals.length, 2, "distinct calls must record distinct proposals");
			assert.deepEqual(proposals.map((proposal) => [proposal.status, proposal.reason, proposal.changes]), [
				["outdated", "Drop determinants.", [{ type: "drop", unit: "det" }]],
				["pending", "Drop Jordan instead.", [{ type: "drop", unit: "jordan" }]],
			]);
			assert.equal(proposals[0]!.outdatedReason, "Replaced by a later proposal from this unit.");
			const results = chatStore.getChat(chatId)!.messages.filter((message): message is Extract<LhMessage, { role: "toolResult" }> => message.role === "toolResult" && message.toolName === "propose_course_changes");
			assert.equal(results.length, 2);
			assert.notEqual(results[0]!.toolCallId, results[1]!.toolCallId);
			assert.deepEqual(proposals.map((proposal) => proposal.toolCallId), results.map((result) => result.toolCallId), "proposals keep the same canonical ids as the transcript");
			assert.deepEqual(results.map((result) => result.details), proposals.map((proposal) => ({ ok: true, proposalId: proposal.id })));

			// Recording the actual same occurrence again stays idempotent.
			assert.deepEqual(courses.recordCourseProposal(course.id, "maps", chatId, proposals[1]!.toolCallId, { reason: "Drop Jordan instead.", changes: [{ type: "drop", unit: "jordan" }] }),
				{ ok: true, proposalId: proposals[1]!.id });
			assert.deepEqual(courseStore.get(course.id)!.proposals, proposals);
			assert.equal((await decide(course.id, proposals[1]!.id, "accept")).status, 200);
			assert.deepEqual(courseStore.get(course.id)!.units.map((unit) => unit.id), ["vectors", "maps", "det", "eigen"], "accepting the replacement keeps determinants and drops Jordan");
		});
	}

	it("refuses a broken rule back to the model, stores a valid proposal as pending, and the turn continues", async () => {
		const list = units().map((unit) => unit.id === "maps" ? { ...unit, status: "not-started" as const, chatId: undefined } : unit);
		const course = makeCourse(list);
		const started = courses.startUnit(course.id, "maps");
		assert.ok(started.ok);
		const chatId = started.chatId;
		chatStore.saveSettings(chatId, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		concludeProbe(chatId);
		const { engine, contexts } = scripted([
			() => fauxAssistantMessage([fauxToolCall("propose_course_changes", { reason: "Vectors is held.", changes: [{ type: "drop", unit: "vectors" }] }, { id: "pc-1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("propose_course_changes", { reason: "He needs  determinants\nfirst.", changes: [{ type: "move", unit: "det", after: null }] }, { id: "pc-2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("I've proposed moving determinants first.")]),
		]);
		const updatedAt = courseStore.get(course.id)!.updatedAt;
		assert.equal((await runTurn(chatId, { type: "text", text: "Done?" }, factory(chatId, engine))).status, 200);
		assert.equal(contexts.length, 3, "non-terminating: the model fixes the refusal, then speaks");
		assert.ok(systemOf(contexts[0]!).includes('"propose_course_changes"'), "the unit teacher has the tool");

		const results = chatStore.getChat(chatId)!.messages.filter((m): m is Extract<LhMessage, { role: "toolResult" }> => m.role === "toolResult" && m.toolName === "propose_course_changes");
		assert.equal(results[0]!.isError, true);
		assert.deepEqual(results[0]!.content, [{ type: "text", text: 'Invalid tool input for tool "propose_course_changes":\n- Unit 1 (Vectors and span) has started, so it can\'t be dropped.' }]);
		const record = courseStore.get(course.id)!;
		assert.equal(record.proposals.length, 1);
		const proposal = record.proposals[0]!;
		assert.equal(results[1]!.isError, false);
		assert.deepEqual(results[1]!.details, { ok: true, proposalId: proposal.id });
		assert.deepEqual(results[1]!.content, [{ type: "text", text: "The learner sees the proposal and decides." }]);
		assert.deepEqual({ ...proposal, id: "", at: "" }, {
			id: "", at: "", chatId, unitId: "maps", toolCallId: "pc-2", reason: "He needs determinants first.",
			changes: [{ type: "move", unit: "det", after: null }], status: "pending",
		});
		assert.equal(record.updatedAt, updatedAt);
		const view = courses.sessionCourseView(chatStore.getChat(chatId)!);
		assert.deepEqual(view?.role === "unit" && view.proposals, [{ id: proposal.id, status: "pending", reason: "He needs determinants first.", lines: ["Move 3 to the start"] }]);
	});
});

// ─── the card ───────────────────────────────────────────────────────────────

describe("the course-changes card", () => {
	const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
	const pending = { status: "pending" as const, reason: "Determinants first.", lines: ["Move 3 to the start", "Drop 5: Jordan form"] };

	it("shows the reason and lines, with Accept and Reject while pending", () => {
		const html = renderToStaticMarkup(<CourseChangesCard proposal={pending} onDecide={async () => null} />);
		assert.equal(text(html), "Proposed course changes Determinants first. Move 3 to the start Drop 5: Jordan form Reject Accept");
		assert.ok(html.includes('data-testid="course-changes-accept"') && html.includes('data-testid="course-changes-reject"'));
		assert.ok(!text(renderToStaticMarkup(<CourseChangesCard proposal={pending} />)).includes("Accept"), "a read-only copy has no buttons");
	});

	it("shows how a decided proposal ended, without buttons", () => {
		for (const [status, label] of [["accepted", "Accepted"], ["rejected", "Rejected"]] as const) {
			assert.equal(text(renderToStaticMarkup(<CourseChangesCard proposal={{ ...pending, status }} onDecide={async () => null} />)),
				`Proposed course changes ${label} Determinants first. Move 3 to the start Drop 5: Jordan form`);
		}
		assert.equal(text(renderToStaticMarkup(<CourseChangesCard proposal={{ ...pending, status: "outdated", outdatedReason: "Replaced by a later proposal from this unit." }} onDecide={async () => null} />)),
			"Proposed course changes Outdated Determinants first. Move 3 to the start Drop 5: Jordan form Replaced by a later proposal from this unit.");
	});

	it("in the chat: the stored proposal from the course; nothing for a refused or running call; the input when the course is gone", () => {
		const part = (state: string, output?: unknown) => ({ type: "tool-propose_course_changes", state, toolCallId: "pc-2", input: { reason: "Det first.", changes: [{ type: "drop", unit: "det" }] }, output });
		const stored = { id: "p1", status: "accepted" as const, reason: "Det first.", lines: ["Drop 3: Determinants"] };
		const live = renderToStaticMarkup(
			<CourseProposalsContext.Provider value={{ proposals: [stored], decide: async () => null }}>
				<ProposeCourseChangesCard part={part("output-available", { ok: true, proposalId: "p1" })} />
			</CourseProposalsContext.Provider>,
		);
		assert.equal(text(live), "Proposed course changes Accepted Det first. Drop 3: Determinants");
		assert.equal(renderToStaticMarkup(<ProposeCourseChangesCard part={part("input-available")} />), "");
		assert.equal(renderToStaticMarkup(<ProposeCourseChangesCard part={part("output-error", { tool: "propose_course_changes", problems: ["x"] })} />), "");
		assert.equal(text(renderToStaticMarkup(<ProposeCourseChangesCard part={part("output-available", { ok: true, proposalId: "p1" })} />)),
			'Proposed course changes Det first. Drop "det": det');
	});
});
