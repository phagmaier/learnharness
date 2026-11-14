/**
 * Plan 04 item 3: the course overview and the sidebar's course groups.
 * Route tests (rename, "Edit units" under decision 5, the version guard,
 * the list, unit start), the learner-edit summary, and render tests for
 * the overview's units and the sidebar's grouping, filter, search,
 * collapse and menus. Isolated LH_DATA_DIR, set before any config import.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it, mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-overview-"));
process.env.LH_DATA_DIR = TMP;

const { courseStore } = await import("../src/store/courses.ts");
const { readCourse, startUnit } = await import("../src/server/courses.ts");
const { chatStore } = await import("../src/store/chats.ts");
const core = await import("../src/core/index.ts");
const courseRoute = await import("../app/api/courses/[id]/route.ts");
const listRoute = await import("../app/api/courses/route.ts");
const startRoute = await import("../app/api/courses/[id]/units/[unitId]/start/route.ts");
const { UnitCard, CourseTabs } = await import("../components/course-overview.tsx");
const { CourseGroup, SessionMenuItems, CourseMenuItems } = await import("../components/sidebar.tsx");
const { sessionListEntries, walkTargets } = await import("../components/session-list.ts");
type CourseRecord = import("../src/core/contracts/course.ts").CourseRecord;
type CourseUnit = import("../src/core/contracts/course.ts").CourseUnit;
type ChatListItem = import("../src/core/contracts/chat.ts").ChatListItem;
type CourseSummary = import("../src/core/contracts/course.ts").CourseSummary;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
function makeCourse(units?: CourseUnit[]): CourseRecord {
	const id = `course_test_${++counter}`;
	const record: CourseRecord = {
		id, title: "Linear algebra", goal: "Eigenvectors.", createdAt: "2026-11-13T09:00:00.000Z", updatedAt: "2026-11-13T09:00:00.000Z",
		setupChatId: "chat_setup",
		units: units ?? [
			{ id: "vectors", title: "Vectors", goal: "Span.", prerequisites: [], status: "completed", chatId: "chat_v", completion: "confirmed", completedAt: "2026-11-13T10:00:00.000Z" },
			{ id: "maps", title: "Maps", goal: "Matrices.", prerequisites: ["vectors"], status: "in-progress", chatId: "chat_m" },
			{ id: "eigen", title: "Eigen", goal: "Diagonalize.", startingPoint: "new", prerequisites: ["vectors", "maps"], status: "not-started" },
		],
		proposals: [], evidence: [],
	};
	courseStore.create(record);
	return record;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const put = (id: string, body: unknown) => courseRoute.PUT(new Request(`http://test/api/courses/${id}`, { method: "PUT", body: JSON.stringify(body) }), params(id));
const draft = (unit: CourseUnit) => ({ id: unit.id, title: unit.title, goal: unit.goal, startingPoint: unit.startingPoint, prerequisites: unit.prerequisites });

// ─── routes ─────────────────────────────────────────────────────────────────

describe("the course routes", () => {
	it("renames a course; a blank title is refused", async () => {
		const course = makeCourse();
		const ok = await put(course.id, { title: "  Linear algebra I " });
		assert.equal(ok.status, 200);
		assert.equal(courseStore.get(course.id)!.title, "Linear algebra I");
		const blank = await put(course.id, { title: " " });
		assert.equal(blank.status, 400);
		assert.equal((await blank.json()).error, "The course needs a title.");
	});

	it("edits units under decision 5: started units may be renamed and reordered, not removed", async () => {
		const course = makeCourse();
		const [vectors, maps, eigen] = course.units as [CourseUnit, CourseUnit, CourseUnit];
		const removed = await put(course.id, { units: [draft(vectors), { ...draft(eigen), prerequisites: ["vectors"] }] });
		assert.equal(removed.status, 400);
		assert.deepEqual((await removed.json()).problems, ["Unit 2 (Maps) has started, so it can't be removed."]);

		// Rename the in-progress unit, move a new unit in, drop the one that hasn't started.
		const edit = await put(course.id, { units: [
			draft(vectors),
			{ title: "Determinants", goal: "Volumes.", prerequisites: ["vectors"] },
			{ ...draft(maps), title: "Linear maps" },
		] });
		assert.equal(edit.status, 200);
		const stored = courseStore.get(course.id)!;
		assert.deepEqual(stored.units.map((u) => [u.id, u.title, u.status, u.chatId ?? null]), [
			["vectors", "Vectors", "completed", "chat_v"],
			["determinants", "Determinants", "not-started", null],
			["maps", "Linear maps", "in-progress", "chat_m"],
		]);
		assert.deepEqual(stored.evidence.map((e) => e.type === "revision" ? [e.source, e.decision, e.changes] : null), [[
			"learner", "accepted",
			["Added 2: Determinants", "Renamed 3: Maps → Linear maps", "Removed: Eigen"],
		]]);

		// Saving an unchanged list records nothing.
		await put(course.id, { units: stored.units.map(draft) });
		assert.equal(courseStore.get(course.id)!.evidence.length, 1);
	});

	it("refuses a course saved by a newer build and never rewrites it", async () => {
		const course = makeCourse();
		const file = path.join(TMP, "courses", course.id, "course.json");
		const newer = JSON.stringify({ ...course, version: 2 });
		fs.writeFileSync(file, newer);
		const read = await courseRoute.GET(new Request("http://test"), params(course.id));
		assert.equal(read.status, 409);
		assert.equal((await put(course.id, { title: "x" })).status, 409);
		assert.equal((await put(course.id, { units: [] })).status, 409);
		assert.equal(fs.readFileSync(file, "utf-8"), newer);
		const list = await (await listRoute.GET()).json() as { unreadable: string[] };
		assert.ok(list.unreadable.includes(course.id));
		assert.equal((await courseRoute.GET(new Request("http://test"), params("course_missing"))).status, 404);
	});

	it("lists courses for the sidebar and starts a unit once", async () => {
		const course = makeCourse();
		const list = await (await listRoute.GET()).json() as { courses: CourseSummary[] };
		const summary = list.courses.find((c) => c.id === course.id)!;
		assert.equal(summary.completedCount, 1);
		assert.deepEqual(summary.units.map((u) => [u.id, u.status, u.chatId ?? null]), [["vectors", "completed", "chat_v"], ["maps", "in-progress", "chat_m"], ["eigen", "not-started", null]]);
		const call = () => startRoute.POST(new Request("http://test", { method: "POST" }), { params: Promise.resolve({ id: course.id, unitId: "eigen" }) });
		const first = await call();
		assert.equal(first.status, 201);
		const { chatId } = await first.json() as { chatId: string };
		assert.equal(chatStore.getChat(chatId)!.title, "Linear algebra · 3. Eigen");
		const second = await call();
		assert.equal(second.status, 409);
		assert.equal((await second.json()).error, "This unit has already started.");
	});

	it("refuses a combined invalid edit without partially renaming the course", async () => {
		const course = makeCourse();
		const result = await put(course.id, { title: "Renamed", units: [] });
		assert.equal(result.status, 400);
		assert.equal(courseStore.get(course.id)!.title, course.title);
		const accepted = await put(course.id, { title: "Renamed", units: course.units.map(draft) });
		assert.equal(accepted.status, 200);
		assert.equal(courseStore.get(course.id)!.title, "Renamed");
	});

	it("refuses stale editor snapshots and unknown existing unit ids without discarding newer units", async () => {
		const course = makeCourse();
		await put(course.id, { units: [...course.units.map(draft), { title: "Applications", goal: "Use eigenvectors.", prerequisites: ["eigen"] }] });
		const stale = await put(course.id, { units: course.units.map(draft), expectedUpdatedAt: course.updatedAt });
		assert.equal(stale.status, 409);
		assert.equal(courseStore.get(course.id)!.units.at(-1)!.title, "Applications");
		const unknown = await put(course.id, { units: [...courseStore.get(course.id)!.units.map(draft), { id: "missing", title: "Typo", goal: "g", prerequisites: [] }] });
		assert.equal(unknown.status, 400);
		assert.equal(courseStore.get(course.id)!.units.length, 4);
	});

	it("repairs an empty unit chat left before its opening marker was saved", () => {
		const course = makeCourse();
		const chat = chatStore.createChat("Interrupted start", undefined, { role: "unit", courseId: course.id, unitId: "eigen" });
		const read = readCourse(course.id);
		assert.ok(!("ok" in read));
		assert.equal(read.units[2]!.chatId, chat.id);
		assert.equal(core.needsContinuation(chatStore.getChat(chat.id)!.messages), true);
		readCourse(course.id);
		assert.equal(chatStore.getChat(chat.id)!.messages.length, 1);
		assert.equal(courseStore.get(course.id)!.evidence.filter((e) => e.type === "unit-started").length, 1);
	});

	it("adopts a unit session after its course write fails, preserving its transcript and one start event", () => {
		const course = makeCourse();
		const rename = fs.renameSync;
		const failure = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
			if (String(to) === path.join(TMP, "courses", course.id, "course.json")) throw new Error("simulated interruption");
			return rename(from, to);
		});
		try { assert.throws(() => startUnit(course.id, "eigen"), /simulated interruption/); }
		finally { failure.mock.restore(); }
		const sessions = () => chatStore.listChats().filter((c) => c.course?.role === "unit" && c.course.courseId === course.id);
		assert.equal(sessions().length, 1);
		const chatId = sessions()[0]!.id;
		const messages = chatStore.getChat(chatId)!.messages;
		const recovered = readCourse(course.id);
		assert.ok(!("ok" in recovered));
		assert.equal(recovered.units[2]!.chatId, chatId);
		assert.equal(recovered.units[2]!.status, "in-progress");
		assert.deepEqual(recovered.evidence.filter((e) => e.type === "unit-started").map((e) => e.chatId), [chatId]);
		assert.deepEqual(chatStore.getChat(chatId)!.messages, messages);
		assert.equal(startUnit(course.id, "eigen").ok, false);
		assert.equal(sessions().length, 1);
	});
});

it("summarizes a learner's edit one line per change", () => {
	const unit = (id: string, title: string, extra: Partial<CourseUnit> = {}): CourseUnit => ({ id, title, goal: "g", prerequisites: [], status: "not-started", ...extra });
	const before = [unit("a", "A"), unit("b", "B", { startingPoint: "x" }), unit("c", "C")];
	assert.deepEqual(core.unitEditSummary(before, before), []);
	assert.deepEqual(core.unitEditSummary(before, [unit("b", "B", { goal: "new", startingPoint: "y", prerequisites: [] }), unit("a", "A2"), unit("d", "D")]), [
		"Changed the goal of 1: B", "Changed the starting point of 1: B", "Renamed 2: A → A2", "Added 3: D", "Removed: C", "Reordered the units",
	]);
	assert.equal(core.courseProgressLine(makeCourse().units), "1 of 3 units completed");
});

// ─── the overview ───────────────────────────────────────────────────────────

describe("the overview", () => {
	const course = makeCourse();
	const numberOf = new Map(course.units.map((u, i) => [u.id, i + 1]));
	const card = (index: number) => renderToStaticMarkup(<UnitCard unit={course.units[index]!} courseId={course.id} number={index + 1} numberOf={numberOf} onStart={() => {}} />);

	it("offers Start unit before a unit starts, and Open once it has", () => {
		const notStarted = card(2);
		assert.ok(notStarted.includes('data-status="not-started"') && notStarted.includes(">Not started<"));
		assert.match(notStarted, /<button[^>]*data-testid="unit-start"[^>]*>Start unit<\/button>/);
		assert.ok(!notStarted.includes("unit-open"));
		assert.ok(notStarted.includes("Builds on 1, 2") && notStarted.includes(">new<"), "prerequisites and the starting point");
		assert.ok(notStarted.includes('id="unit-eigen"'), "the sidebar's anchor");
		const inProgress = card(1);
		assert.ok(inProgress.includes(">In progress<") && inProgress.includes('href="/chat/chat_m"') && !inProgress.includes("unit-start"));
		assert.ok(!inProgress.includes("unit-practice"), "only a completed unit is practised");
		const completed = card(0);
		assert.ok(completed.includes(">Completed<") && completed.includes('href="/chat/chat_v"') && !completed.includes("Builds on"));
		// Item 8: Open, then "Practice this unit" (the practice draft with the unit attached).
		const practice = parseHTML(completed).document.querySelector('[data-testid="unit-practice"]');
		assert.equal(practice?.textContent, "Practice this unit");
		assert.equal(practice?.getAttribute("href"), `/chat/new?mode=practice&course=${course.id}&unit=${course.units[0]!.id}`);
		assert.ok(completed.indexOf("unit-open") < completed.indexOf("unit-practice"));
	});

	it("has Overview and Notes tabs", () => {
		const html = renderToStaticMarkup(<CourseTabs courseId="course_1" active="overview" />);
		assert.ok(html.includes('href="/course/course_1"'));
		assert.match(html, /aria-current="page"[^>]*>Overview</);
		const ready = renderToStaticMarkup(<CourseTabs courseId="course_1" active="notes" />);
		const notes = parseHTML(ready).document.querySelector('[data-testid="course-tab-notes"]');
		assert.equal(notes?.getAttribute("href"), "/course/course_1/notes");
		assert.equal(notes?.getAttribute("aria-current"), "page");
	});
});

// ─── the sidebar ────────────────────────────────────────────────────────────

function chat(id: string, updatedAt: string, extra: Partial<ChatListItem> = {}): ChatListItem {
	return { id, title: id, createdAt: updatedAt, updatedAt, kind: "teach", messageCount: 1, phase: "probe", pendingQuestion: false, pendingProblem: false, busy: false, compacting: false, ...extra };
}

const summary: CourseSummary = {
	id: "course_g", title: "Linear algebra", createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z", setupChatId: "setup",
	completedCount: 1,
	units: [
		{ id: "vectors", title: "Vectors and span", status: "completed", chatId: "u1" },
		{ id: "maps", title: "Linear maps", status: "in-progress", chatId: "u2" },
		{ id: "eigen", title: "Eigenvectors", status: "not-started" },
	],
};
const chats = [
	chat("standalone-old", "2026-11-11T00:00:00Z"),
	chat("setup", "2026-11-10T01:00:00Z", { title: "learn linear algebra", course: { role: "setup", courseId: "course_g" } }),
	chat("u1", "2026-11-12T00:00:00Z", { course: { role: "unit", courseId: "course_g", unitId: "vectors" } }),
	chat("u2", "2026-11-12T06:00:00Z", { course: { role: "unit", courseId: "course_g", unitId: "maps" }, pendingQuestion: true }),
	chat("standalone-new", "2026-11-13T00:00:00Z"),
	chat("practice-unit", "2026-11-12T12:00:00Z", { kind: "practice", course: { role: "practice", courseId: "course_g", unitId: "vectors" } }),
	chat("abandoned-setup", "2026-11-09T00:00:00Z", { course: { role: "setup" } }),
];
const entries = (filter: "teach" | "all" | "practice", query = "", collapsed = new Set<string>()) =>
	sessionListEntries({ chats, courses: [summary], filter, query, collapsed });
const keys = (list: ReturnType<typeof entries>) => list.map((e) => e.key);

describe("the sidebar's course groups", () => {
	it("groups the setup session and units, placed by the course's latest activity", () => {
		assert.deepEqual(keys(entries("all")), ["standalone-new", "practice-unit", "course_g", "standalone-old", "abandoned-setup"]);
		const group = entries("all")[2]!;
		assert.ok(group.kind === "course");
		assert.equal(group.activity, "2026-11-12T06:00:00Z");
		assert.deepEqual(group.rows.map((r) => [r.key, r.href]), [
			["course_g:setup", "/chat/setup"],
			["course_g:vectors", "/chat/u1"],
			["course_g:maps", "/chat/u2"],
			["course_g:eigen", "/course/course_g#unit-eigen"],
		]);
	});

	it("shows groups under Teaching and All, never under Practice", () => {
		assert.deepEqual(keys(entries("teach")), ["standalone-new", "course_g", "standalone-old", "abandoned-setup"]);
		assert.deepEqual(keys(entries("practice")), ["practice-unit"]);
	});

	it("search matches course and unit titles", () => {
		const byCourse = entries("all", "linear alg");
		assert.equal(byCourse.length, 1);
		assert.ok(byCourse[0]!.kind === "course" && byCourse[0]!.rows.length === 4, "a course match shows every row");
		const byUnit = entries("all", "eigenvec");
		assert.ok(byUnit[0]!.kind === "course");
		assert.deepEqual(byUnit[0]!.kind === "course" && byUnit[0]!.rows.map((r) => r.key), ["course_g:eigen"]);
		assert.deepEqual(keys(entries("all", "zzz")), []);
		// A collapsed group opens while searching.
		assert.ok(entries("all", "eigenvec", new Set(["course_g"]))[0]!.kind === "course" && !(entries("all", "eigenvec", new Set(["course_g"]))[0] as { collapsed: boolean }).collapsed);
	});

	it("a collapsed group keeps only its header in the list and the walk", () => {
		const collapsed = entries("teach", "", new Set(["course_g"]));
		assert.deepEqual(walkTargets(collapsed).map((t) => t.key), ["standalone-new", "course_g", "standalone-old", "abandoned-setup"]);
		assert.deepEqual(walkTargets(entries("teach")).map((t) => t.key), ["standalone-new", "course_g", "course_g:setup", "course_g:vectors", "course_g:maps", "course_g:eigen", "standalone-old", "abandoned-setup"]);
		const group = collapsed[1]!;
		assert.ok(group.kind === "course");
		const html = renderToStaticMarkup(<CourseGroup entry={group} pathname="/" onToggle={() => {}} onOpen={() => {}} />);
		assert.ok(html.includes('aria-expanded="false"') && !html.includes("course-member-row"));
	});

	it("renders the header with its count and the rows in order, units that haven't started muted", () => {
		const group = entries("teach")[1]!;
		assert.ok(group.kind === "course");
		const html = renderToStaticMarkup(<CourseGroup entry={group} pathname="/chat/u2" onToggle={() => {}} onOpen={() => {}} />);
		assert.ok(html.includes(">Linear algebra<") && html.includes(">1/3<"));
		const titles = [...html.matchAll(/font-prose[^>]*>([^<]+)</g)].map((m) => m[1]);
		assert.deepEqual(titles, ["Linear algebra", "Setup", "1 · Vectors and span", "2 · Linear maps", "3 · Eigenvectors"]);
		assert.ok(html.includes("Waiting for input"), "a unit row carries its session's usual meta");
		assert.ok(html.includes(">Not started<") && html.includes("text-muted-foreground/70"));
		assert.match(html, /bg-accent[^"]*"[^>]*data-row="unit"|data-row="unit"[^>]*bg-accent/, "the open unit's row is active");
	});

	it("rows inside a group offer the exports only; the header offers Rename course", () => {
		const grouped = renderToStaticMarkup(<SessionMenuItems chatId="u1" kind="teach" grouped onClose={() => {}} onRename={() => {}} onDelete={() => {}} />);
		assert.ok(grouped.includes("Export as Markdown…") && grouped.includes("Export as HTML…"));
		assert.ok(!grouped.includes("ctx-rename") && !grouped.includes("ctx-delete"), "no Rename or Delete inside a group");
		const standalone = renderToStaticMarkup(<SessionMenuItems chatId="s" kind="teach" grouped={false} onClose={() => {}} onRename={() => {}} onDelete={() => {}} />);
		assert.ok(standalone.includes("ctx-rename") && standalone.includes("ctx-delete"));
		assert.ok(renderToStaticMarkup(<CourseMenuItems onRename={() => {}} />).includes("Rename course"));
	});
});
