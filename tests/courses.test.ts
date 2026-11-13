/**
 * Plan 04 item 1: the course record's rules, texts and store. Expected
 * values are worked out by hand from the fixtures below. Runs under an
 * isolated LH_DATA_DIR (set before any config-loading import).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-courses-"));
process.env.LH_DATA_DIR = TMP;

const course = await import("../src/core/course.ts");
const { courseStore, CourseUnreadableError, courseNotesDir } = await import("../src/store/courses.ts");
const { subscribe } = await import("../src/core/events.ts");
type CourseUnit = import("../src/core/contracts/course.ts").CourseUnit;
type CourseRecord = import("../src/core/contracts/course.ts").CourseRecord;
type AnswerEvidence = import("../src/core/contracts/course.ts").AnswerEvidence;
type UnitHandoff = import("../src/core/contracts/course.ts").UnitHandoff;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function unit(id: string, title: string, prerequisites: string[] = [], status: CourseUnit["status"] = "not-started", extra: Partial<CourseUnit> = {}): CourseUnit {
	return { id, title, goal: `Goal of ${title}`, prerequisites, status, ...extra };
}

const ids = (units: readonly CourseUnit[]) => units.map((u) => u.id);
const prereqs = (units: readonly CourseUnit[]) => Object.fromEntries(units.map((u) => [u.id, u.prerequisites]));

// ─── validation and edits (decision 5) ──────────────────────────────────────

describe("unit-list validation", () => {
	it("accepts a prerequisite on an earlier unit", () => {
		assert.deepEqual(course.unitListProblems([unit("a", "A"), unit("b", "B", ["a"])]), []);
	});

	it("refuses a forward reference, a self-reference, an unknown unit, and blanks", () => {
		assert.deepEqual(course.unitListProblems([unit("a", "Vectors", ["b"]), unit("b", "Maps")]), [
			"Unit 1 (Vectors) builds on unit 2 (Maps), which comes after it. A unit can only build on earlier units.",
		]);
		assert.deepEqual(course.unitListProblems([unit("a", "Vectors", ["a"])]), ["Unit 1 (Vectors) can't build on itself."]);
		assert.deepEqual(course.unitListProblems([unit("a", "Vectors", ["zzz"])]), ['Unit 1 (Vectors) builds on an unknown unit: "zzz".']);
		assert.deepEqual(course.unitListProblems([{ ...unit("a", "  "), goal: "" }]), ["Unit 1 needs a title.", "Unit 1 (untitled) needs a goal."]);
		assert.deepEqual(course.unitListProblems([]), ["A course needs at least one unit."]);
	});
});

describe("learner edits", () => {
	const before = [
		unit("a", "Vectors", [], "completed", { chatId: "chat_a", completion: "confirmed", completedAt: "2026-11-20T12:00:00.000Z" }),
		unit("b", "Maps", ["a"], "in-progress", { chatId: "chat_b" }),
		unit("c", "Eigen", ["a"]),
	];

	it("renames and reorders a started unit, keeping its session and status", () => {
		const out = course.applyUnitEdit(before, [
			{ id: "a", title: "Vectors and span", goal: "Span", prerequisites: [] },
			{ id: "c", title: "Eigen", goal: "Goal of Eigen", prerequisites: ["a"] },
			{ id: "b", title: "Maps", goal: "Goal of Maps", prerequisites: ["a", "c"] },
		]);
		assert.ok(out.ok, JSON.stringify(out));
		assert.deepEqual(ids(out.units), ["a", "c", "b"]);
		assert.equal(out.units[0]!.title, "Vectors and span");
		assert.equal(out.units[0]!.status, "completed");
		assert.equal(out.units[0]!.completedAt, "2026-11-20T12:00:00.000Z");
		assert.equal(out.units[2]!.chatId, "chat_b");
		assert.deepEqual(out.units[2]!.prerequisites, ["a", "c"]);
	});

	it("refuses removing a started unit and allows removing one that hasn't started", () => {
		const removedStarted = course.applyUnitEdit(before, [
			{ id: "a", title: "Vectors", goal: "g", prerequisites: [] },
			{ id: "c", title: "Eigen", goal: "g", prerequisites: ["a"] },
		]);
		assert.deepEqual(removedStarted, { ok: false, problems: ["Unit 2 (Maps) has started, so it can't be removed."] });
		const removedNew = course.applyUnitEdit(before, [
			{ id: "a", title: "Vectors", goal: "g", prerequisites: [] },
			{ id: "b", title: "Maps", goal: "g", prerequisites: ["a"] },
		]);
		assert.ok(removedNew.ok);
		assert.deepEqual(ids(removedNew.units), ["a", "b"]);
	});

	it("adds a new unit with a fresh id that later new units can build on", () => {
		const out = course.applyUnitEdit(before, [
			...before.map((u) => ({ id: u.id, title: u.title, goal: u.goal, prerequisites: u.prerequisites })),
			{ title: "Determinants", goal: "Compute them", startingPoint: "  new  ", prerequisites: ["b"] },
			{ title: "Determinants", goal: "Again", prerequisites: ["new:3"] },
		]);
		assert.ok(out.ok, JSON.stringify(out));
		assert.deepEqual(ids(out.units), ["a", "b", "c", "determinants", "determinants-2"]);
		assert.equal(out.units[3]!.status, "not-started");
		assert.equal(out.units[3]!.startingPoint, "new");
		assert.deepEqual(out.units[4]!.prerequisites, ["determinants"]);
	});
});

describe("course changes", () => {
	// 1 vectors (completed) ← 2 maps (in progress) ← 3 eigen ← 4 jordan; 5 applications ← 1
	const list = [
		unit("vectors", "Vectors", [], "completed"),
		unit("maps", "Maps", ["vectors"], "in-progress"),
		unit("eigen", "Eigen", ["vectors", "maps"]),
		unit("jordan", "Jordan", ["eigen"]),
		unit("applications", "Applications", ["vectors"]),
	];

	it("inserts after a unit and at the start", () => {
		const out = course.applyCourseChanges(list, [
			{ type: "insert", after: "maps", title: "Determinants", goal: "g", prerequisites: ["maps"] },
			{ type: "insert", after: null, title: "Orientation", goal: "g", prerequisites: [] },
		]);
		assert.ok(out.ok, JSON.stringify(out));
		assert.deepEqual(ids(out.units), ["orientation", "vectors", "maps", "determinants", "eigen", "jordan", "applications"]);
		assert.equal(out.units[3]!.status, "not-started");
	});

	it("drops a unit that hasn't started; its dependants inherit its prerequisites", () => {
		const out = course.applyCourseChanges(list, [{ type: "drop", unit: "eigen" }]);
		assert.ok(out.ok, JSON.stringify(out));
		assert.deepEqual(ids(out.units), ["vectors", "maps", "jordan", "applications"]);
		assert.deepEqual(prereqs(out.units).jordan, ["vectors", "maps"]);
	});

	it("moves a unit, and refuses a move that puts a unit before its prerequisite", () => {
		const moved = course.applyCourseChanges(list, [{ type: "move", unit: "applications", after: "vectors" }]);
		assert.ok(moved.ok, JSON.stringify(moved));
		assert.deepEqual(ids(moved.units), ["vectors", "applications", "maps", "eigen", "jordan"]);
		const toStart = course.applyCourseChanges(list, [{ type: "move", unit: "maps", after: "eigen" }]);
		assert.deepEqual(toStart, { ok: false, problems: [
			"Unit 2 (Eigen) builds on unit 3 (Maps), which comes after it. A unit can only build on earlier units.",
		] });
	});

	it("merges units that haven't started into one, in place of the earliest", () => {
		const out = course.applyCourseChanges(list, [{ type: "merge", units: ["eigen", "jordan"], title: "Spectral theory", goal: "g" }]);
		assert.ok(out.ok, JSON.stringify(out));
		assert.deepEqual(ids(out.units), ["vectors", "maps", "spectral-theory", "applications"]);
		assert.deepEqual(prereqs(out.units)["spectral-theory"], ["vectors", "maps"]);
	});

	it("refuses dropping or merging a started unit", () => {
		assert.deepEqual(course.applyCourseChanges(list, [{ type: "drop", unit: "vectors" }]),
			{ ok: false, problems: ["Unit 1 (Vectors) has started, so it can't be dropped."] });
		assert.deepEqual(course.applyCourseChanges(list, [{ type: "merge", units: ["maps", "eigen"], title: "X", goal: "g" }]),
			{ ok: false, problems: ["Unit 2 (Maps) has started, so it can't be merged."] });
	});

	it("names unknown units and numbers multi-change problems", () => {
		assert.deepEqual(course.applyCourseChanges(list, [{ type: "move", unit: "applications", after: null }, { type: "drop", unit: "nope" }]),
			{ ok: false, problems: ['Change 2: There is no unit "nope" in the course.'] });
	});

	it("reads each change as one line", () => {
		assert.equal(course.courseChangeLine({ type: "insert", after: "eigen", title: "Determinants", goal: "g", prerequisites: [] }, list), "Insert after 3: Determinants");
		assert.equal(course.courseChangeLine({ type: "insert", after: null, title: "Orientation", goal: "g", prerequisites: [] }, list), "Insert at the start: Orientation");
		assert.equal(course.courseChangeLine({ type: "drop", unit: "applications" }, list), "Drop 5: Applications");
		assert.equal(course.courseChangeLine({ type: "move", unit: "applications", after: "maps" }, list), "Move 5 after 2");
		assert.equal(course.courseChangeLine({ type: "merge", units: ["eigen", "jordan"], title: "Spectral theory", goal: "g" }, list), "Merge 3 and 4 into: Spectral theory");
		assert.equal(course.courseChangeLine({ type: "merge", units: ["maps", "eigen", "jordan"], title: "All", goal: "g" }, list), "Merge 2, 3 and 4 into: All");
	});
});

it("collects transitive prerequisites on a diamond, in course order", () => {
	const diamond = [unit("a", "A"), unit("b", "B", ["a"]), unit("c", "C", ["a"]), unit("e", "E"), unit("d", "D", ["c", "b"])];
	assert.deepEqual(ids(course.transitivePrerequisites(diamond, "d")), ["a", "b", "c"]);
	assert.deepEqual(ids(course.transitivePrerequisites(diamond, "a")), []);
	assert.deepEqual(ids(course.unfinishedPrerequisites(diamond, "d")), ["b", "c"]);
});

// ─── the topic rule (decision 2) ────────────────────────────────────────────

function answer(nodeId: string, result: AnswerEvidence["result"], extra: Partial<AnswerEvidence> = {}): AnswerEvidence {
	return { type: "answer", id: `${nodeId}-${Math.random()}`, at: "2026-11-20T12:00:00.000Z", chatId: "chat_u", unitId: "u", phase: "teach", tool: "quiz", questionType: "check", nodeId, result, ...extra };
}

describe("handoff topics", () => {
	const nodes = ["n70", "n69", "fixed", "broke", "predict", "unvisited", "dk", "recall", "noconf"].map((id) => ({ id, title: id.toUpperCase() }));
	const reached = new Set(["n70", "n69", "fixed", "broke", "predict", "dk", "recall", "noconf"]);
	const answers = [
		answer("n70", "right", { confidence: 70 }),
		answer("n69", "right", { confidence: 69 }),
		answer("fixed", "wrong", { confidence: 80 }),
		answer("fixed", "right", { confidence: 90 }),
		answer("broke", "right", { confidence: 90 }),
		answer("broke", "wrong", { confidence: 60 }),
		answer("predict", "right", { questionType: "predict", confidence: 95 }),
		answer("dk", "dontKnow"),
		answer("recall", "ungraded", { tool: "explain", questionType: undefined }),
		answer("noconf", "right"),
		// A skipped check is no answer.
		answer("n70", "skipped"),
	];
	const topics = Object.fromEntries(course.handoffTopics(nodes, reached, answers).map((t) => [t.nodeId, [t.status, t.reason]]));

	it("rates by the latest graded check", () => {
		assert.deepEqual(topics.n70, ["solid", "last check right at 70% confidence"]);
		assert.deepEqual(topics.n69, ["shaky", "last check right at 69% confidence"]);
		assert.deepEqual(topics.fixed, ["solid", "last check right at 90% confidence"]);
		assert.deepEqual(topics.broke, ["shaky", "last check wrong"]);
		assert.deepEqual(topics.dk, ["shaky", "last check answered “don't know”"]);
		assert.deepEqual(topics.noconf, ["shaky", "last check right, with no confidence recorded"]);
	});

	it("leaves predictions and ungraded answers unchecked and unvisited nodes not reached", () => {
		assert.equal(topics.predict![0], "unchecked");
		assert.deepEqual(topics.recall, ["unchecked", "free-recall answers only"]);
		assert.equal(topics.unvisited![0], "not-reached");
	});
});

// ─── texts ──────────────────────────────────────────────────────────────────

/** The plan's proposed handoff, rebuilt from evidence. */
function linearMapsHandoff(): UnitHandoff {
	const nodes = [
		{ id: "matrix", title: "Matrix of a linear map" },
		{ id: "kernel", title: "Kernel and image" },
		{ id: "rank", title: "Rank–nullity" },
		{ id: "basis", title: "Change of basis" },
		{ id: "similar", title: "Similar matrices" },
	];
	const topics = course.handoffTopics(nodes, new Set(["matrix", "kernel", "rank", "basis"]), [
		answer("matrix", "right", { confidence: 90 }),
		answer("kernel", "wrong", { confidence: 70 }),
		answer("rank", "right", { confidence: 40 }),
		answer("basis", "ungraded", { tool: "explain", questionType: undefined }),
	]);
	return {
		writtenAt: "2026-11-20T12:00:00.000Z",
		completion: "early",
		topics,
		observations: {
			judged: [{ nodeId: "basis", status: "solid", reason: "explained the conjugation correctly twice" }],
			alsoShaky: ["mixes up column space and row space for non-square matrices"],
			misconceptionsRepaired: ["thought every linear map is invertible; fixed with the projection example"],
			carriedForward: ["wants more 3×3 practice"],
		},
		writer: { status: "ready" },
	};
}

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

describe("handoff text", () => {
	it("matches the plan's proposed text", () => {
		const text = course.handoffText(2, { title: "Linear maps", completedAt: "2026-11-20T12:00:00.000Z" }, linearMapsHandoff());
		assert.equal(text, PLAN_HANDOFF_TEXT);
	});

	it("leaves out observations until the writer is ready, and says when there was no plan", () => {
		const writing = { ...linearMapsHandoff(), completion: "confirmed" as const, writer: { status: "writing" as const } };
		const text = course.handoffText(2, { title: "Linear maps", completedAt: "2026-11-20T12:00:00.000Z" }, writing);
		assert.ok(text.startsWith("Unit 2 · Linear maps: completed 20 Nov 2026\nSolid:"));
		assert.ok(!text.includes("Teacher observations"));
		const empty = { ...writing, topics: [] };
		assert.equal(course.handoffText(1, { title: "Orientation", completedAt: "2026-11-20T12:00:00.000Z" }, empty),
			"Unit 1 · Orientation: completed 20 Nov 2026\nNo plan topics were recorded.");
	});
});

function sampleCourse(): CourseRecord {
	const vectorsHandoff: UnitHandoff = {
		writtenAt: "2026-11-20T12:00:00.000Z",
		completion: "confirmed",
		topics: [
			{ nodeId: "span", title: "Span", status: "solid", reason: "last check right at 80% confidence" },
			{ nodeId: "basis", title: "Basis | dimension", status: "shaky", reason: "last check wrong" },
		],
		writer: { status: "failed", error: "Provider timed out" },
	};
	return {
		id: "course_test_1",
		title: "Linear algebra",
		goal: "Understand eigenvectors",
		createdAt: "2026-11-18T12:00:00.000Z",
		updatedAt: "2026-11-21T12:00:00.000Z",
		setupChatId: "chat_setup",
		units: [
			unit("vectors", "Vectors and span", [], "completed", { chatId: "chat_v", completion: "confirmed", completedAt: "2026-11-20T12:00:00.000Z", handoff: vectorsHandoff }),
			unit("maps", "Linear maps", ["vectors"], "in-progress", { chatId: "chat_m" }),
			unit("eigen", "Eigenvectors", ["vectors", "maps"]),
		],
		proposals: [
			{ id: "p1", chatId: "chat_m", unitId: "maps", toolCallId: "call_1", at: "2026-11-21T12:00:00.000Z", reason: "He needs determinants\nbefore eigenvalues.",
				changes: [{ type: "insert", after: "maps", title: "Determinants", goal: "g", prerequisites: ["maps"] }, { type: "move", unit: "eigen", after: null }], status: "pending" },
			{ id: "p0", chatId: "chat_v", unitId: "vectors", toolCallId: "call_0", at: "2026-11-20T12:00:00.000Z", reason: "Old", changes: [{ type: "drop", unit: "eigen" }], status: "rejected" },
		],
		evidence: [],
	};
}

const SAMPLE_PROGRESS = `# Linear algebra

Goal: Understand eigenvectors
Updated 21 Nov 2026. Written by LearnHarness Fork; edits to this file are not read back.

## Units

| # | Unit | Status | Builds on |
|---|------|--------|-----------|
| 1 | Vectors and span | Completed 20 Nov 2026 | — |
| 2 | Linear maps | In progress | 1 |
| 3 | Eigenvectors | Not started | 1, 2 |

## Pending course changes

- He needs determinants before eigenvalues.
  - Insert after 2: Determinants
  - Move 3 to the start

## Handoffs

### 1. Vectors and span
Unit 1 · Vectors and span: completed 20 Nov 2026
Solid:
- Span: last check right at 80% confidence
Shaky:
- Basis | dimension: last check wrong
`;

it("renders progress.md as the hand-written expected file", () => {
	assert.equal(course.progressMarkdown(sampleCourse()), SAMPLE_PROGRESS);
});

it("escapes pipes in unit titles inside the table", () => {
	const record = sampleCourse();
	record.units[1]!.title = "Maps | matrices";
	assert.ok(course.progressMarkdown(record).includes("| 2 | Maps \\| matrices | In progress | 1 |"));
});

// ─── the store ──────────────────────────────────────────────────────────────

describe("course store", () => {
	const file = (id: string, name: string) => path.join(TMP, "courses", id, name);

	it("round-trips a record, stamps the version, writes progress.md and announces it", () => {
		const seen: unknown[] = [];
		const stop = subscribe((event) => { if (event.type === "courses-changed") seen.push(event); });
		const record = sampleCourse();
		const created = courseStore.create(record);
		stop();
		assert.equal(created.version, 1);
		assert.deepEqual(courseStore.get(record.id), { ...record, version: 1 });
		assert.equal(fs.readFileSync(file(record.id, "progress.md"), "utf-8"), SAMPLE_PROGRESS);
		assert.deepEqual(seen, [{ type: "courses-changed", courseId: record.id }]);
		assert.deepEqual(courseStore.list().courses.map((c) => c.id), [record.id]);
		assert.throws(() => courseStore.create(record), /already exists/);
	});

	it("updates by read-modify-write and keeps evidence types it doesn't know", () => {
		const id = "course_test_unknown";
		courseStore.create({ ...sampleCourse(), id });
		const raw = JSON.parse(fs.readFileSync(file(id, "course.json"), "utf-8"));
		raw.evidence.push({ type: "gate-passed", id: "future-1", at: "2026-12-01T00:00:00.000Z", score: 9 });
		raw.futureField = { kept: true };
		fs.writeFileSync(file(id, "course.json"), JSON.stringify(raw));
		const updated = courseStore.update(id, (c) => ({ ...c, title: "Renamed" }));
		assert.equal(updated?.title, "Renamed");
		const stored = JSON.parse(fs.readFileSync(file(id, "course.json"), "utf-8"));
		assert.deepEqual(stored.evidence.at(-1), { type: "gate-passed", id: "future-1", at: "2026-12-01T00:00:00.000Z", score: 9 });
		assert.deepEqual(stored.futureField, { kept: true });
		assert.ok(fs.readFileSync(file(id, "progress.md"), "utf-8").startsWith("# Renamed\n"));
		assert.equal(courseStore.update("course_missing", (c) => c), null);
	});

	it("refuses a newer or damaged record and never rewrites it", () => {
		const newer = "course_test_newer";
		fs.mkdirSync(path.join(TMP, "courses", newer), { recursive: true });
		const newerBytes = JSON.stringify({ ...sampleCourse(), id: newer, version: 2 });
		fs.writeFileSync(file(newer, "course.json"), newerBytes);
		assert.throws(() => courseStore.get(newer), (e: unknown) => e instanceof CourseUnreadableError && /newer version/.test((e as Error).message));
		assert.throws(() => courseStore.update(newer, (c) => ({ ...c, title: "x" })), CourseUnreadableError);
		assert.equal(fs.readFileSync(file(newer, "course.json"), "utf-8"), newerBytes);

		const broken = "course_test_broken";
		fs.mkdirSync(path.join(TMP, "courses", broken), { recursive: true });
		fs.writeFileSync(file(broken, "course.json"), "{ not json");
		assert.throws(() => courseStore.get(broken), /damaged/);
		fs.writeFileSync(file(broken, "course.json"), JSON.stringify({ id: broken, units: "nope" }));
		assert.throws(() => courseStore.get(broken), /damaged/);

		const listed = courseStore.list();
		assert.ok(listed.unreadable.includes(newer) && listed.unreadable.includes(broken));
		assert.ok(!listed.courses.some((c) => c.id === newer || c.id === broken));
	});

	it("rejects unsafe ids and removes a whole course folder", () => {
		assert.throws(() => courseStore.get("../chats"), /Invalid course id/);
		assert.throws(() => courseNotesDir("course_x", "../../chats"), /Invalid chat id/);
		assert.equal(courseNotesDir("course_x", "chat_1"), path.join(TMP, "courses", "course_x", "notes", "chat_1"));
		const id = "course_test_remove";
		courseStore.create({ ...sampleCourse(), id });
		fs.mkdirSync(courseNotesDir(id, "chat_v"), { recursive: true });
		assert.equal(courseStore.remove(id), true);
		assert.equal(fs.existsSync(path.join(TMP, "courses", id)), false);
		assert.equal(courseStore.remove(id), false);
		assert.equal(courseStore.get(id), null);
	});
});
