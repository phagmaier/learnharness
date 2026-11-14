/**
 * Plan 04 item 9: course deletion. Through the real DELETE route: the
 * course folder (record, progress.md, notes), its setup and unit sessions
 * with their jobs and notes go, while another course, a standalone
 * session's notes and a linked "Practice this unit" session stay; the
 * graph mode applies to every session and the course's graph folder goes
 * only once nothing is left in it; a running turn or job refuses with the
 * session named and deletes nothing; a failure part-way keeps the course
 * and a rerun finishes; the handoff writer stops and leaves nothing behind.
 * The dialog's line, checkbox and "Download notes" are rendered. Fakes only
 * (pi-ai's faux provider writes notes); an isolated LH_DATA_DIR is set
 * before any config-loading import.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it, mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-deletion-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

const { chatStore } = await import("../src/store/chats.ts");
const { courseStore, courseDir } = await import("../src/store/courses.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { sourceOrganizationStore } = await import("../src/store/source-organization.ts");
const { getGraph } = await import("../src/core/graph.ts");
const notes = await import("../src/server/notes.ts");
const chats = await import("../src/server/chats.ts");
const { abortExtraction, createExtractionPipeline, extractionStatuses } = await import("../src/agent/subagents/extraction.ts");
const courses = await import("../src/server/courses.ts");
const handoffs = await import("../src/server/handoffs.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const courseRoute = await import("../app/api/courses/[id]/route.ts");
const { DeleteCourseBody, courseDeletionLine, COURSE_TRACES_COPY } = await import("../components/delete-course-dialog.tsx");
const { CourseMenuItems } = await import("../components/sidebar.tsx");
type PiEngine = import("../src/agent/models.ts").PiEngine;
type CourseRecord = import("../src/core/contracts/course.ts").CourseRecord;

const SETTINGS = { version: 1, models: { strong: { model: { provider: "test", id: "strong-model" } }, cheap: { model: { provider: "test", id: "cheap" } }, vision: { model: { provider: "test", id: "vision" } } } } as const;
const noteSeams = { ...notes.noteServiceSeams };
const handoffSeams = { ...handoffs.handoffServiceSeams };

before(() => settingsStore.writeSettings(structuredClone(SETTINGS) as never));
afterEach(() => {
	Object.assign(notes.noteServiceSeams, noteSeams);
	Object.assign(handoffs.handoffServiceSeams, handoffSeams);
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ─── helpers ────────────────────────────────────────────────────────────────

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const del = (id: string, mode = "preserve-graph") => courseRoute.DELETE(new Request(`http://x/api/courses/${id}?mode=${mode}`, { method: "DELETE" }), ctx(id));
const exists = (file: string) => fs.existsSync(file);
const chatFile = (chatId: string) => path.join(TMP, "chats", `${chatId}.json`);

let submits = 0;
async function writeNote(chatId: string, title: string): Promise<void> {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_note", { title, body: `<p>${title}</p>` }, { id: `s${++submits}` })], { stopReason: "toolUse" })]);
	const engine = { model: faux.getModel(), level: "off", streamFn: (model, context, options) => faux.streamSimple(model, context, options) } as PiEngine;
	notes.noteServiceSeams.buildEngine = () => engine;
	const created = notes.createNote(chatId, {});
	assert.ok(created.ok, JSON.stringify(created));
	for (let i = 0; i < 400 && notes.noteWriterActivities().some((row) => row.noteId === created.note.id); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(notes.getNote(chatId, created.note.id)?.status, "ready");
}

let counter = 0;
/** A course created by its setup session, with units 1 and 2 started
 *  through the real start (so their graph sources sit in the course's
 *  folder) and unit 3 not started. */
function seededCourse(): { courseId: string; setupId: string; unit1: string; unit2: string } {
	const courseId = `course_del_${++counter}`;
	const setup = chatStore.createChat("Setup", undefined, { role: "setup", courseId });
	const course: CourseRecord = {
		id: courseId, title: "Linear algebra", goal: "Eigenvectors.", createdAt: "2026-11-20T09:00:00.000Z", updatedAt: "2026-11-20T09:00:00.000Z", setupChatId: setup.id,
		units: [
			{ id: "vectors", title: "Vectors and span", goal: "Span.", prerequisites: [], status: "not-started" },
			{ id: "maps", title: "Linear maps", goal: "Matrices.", prerequisites: ["vectors"], status: "not-started" },
			{ id: "eigen", title: "Eigenvectors", goal: "Diagonalize.", prerequisites: ["maps"], status: "not-started" },
		],
		proposals: [], evidence: [],
	};
	courseStore.create(course);
	const one = courses.startUnit(courseId, "vectors");
	const two = courses.startUnit(courseId, "maps");
	assert.ok(one.ok && two.ok);
	return { courseId, setupId: setup.id, unit1: one.chatId, unit2: two.chatId };
}

const node = (id: string, chatIds: string[]) => ({
	id, name: id, statement: `${id} statement`, aliases: [] as string[], createdAt: "2026-11-20T10:00:00.000Z",
	provenance: chatIds.map((chatId) => ({ chatId, messageId: "m1" })),
});
const folderOf = (courseId: string) => courseStore.get(courseId)!.sourceFolderId!;
const folderExists = (id: string) => sourceOrganizationStore.read().folders.some((folder) => folder.id === id);

// ─── the service and route ──────────────────────────────────────────────────

describe("course deletion", () => {
	it("deletes the course folder, its setup and unit sessions with their jobs and notes, and nothing else", async () => {
		const { courseId, setupId, unit1, unit2 } = seededCourse();
		const other = seededCourse();
		const standalone = chatStore.createChat("Standalone");
		const practice = chatStore.createChat("Practice unit 1: Vectors and span", "practice", { role: "practice", courseId, unitId: "vectors" });
		await writeNote(unit1, "Span notes");
		await writeNote(standalone.id, "Standalone notes");
		await writeNote(other.unit1, "Other course notes");
		const unitNotes = path.join(courseDir(courseId), "notes", unit1);
		assert.ok(exists(path.join(unitNotes, "notes.json")), "the unit's note lives under its course");
		assert.ok(exists(path.join(courseDir(courseId), "progress.md")));
		const job = jobStore.createJob({ kind: "research", chatId: unit2, toolCallId: "tc_done" });
		jobStore.updateJob(job.id, { status: "done" });

		const res = await del(courseId);
		assert.equal(res.status, 200);
		const body = await res.json() as { ok: boolean; mode: string; chatIds: string[]; graphRevision: number };
		assert.deepEqual([body.ok, body.mode, body.chatIds], [true, "preserve-graph", [setupId, unit1, unit2]], "setup first, then the units in order");

		assert.equal(exists(courseDir(courseId)), false, "record, progress.md and notes are gone");
		for (const chatId of [setupId, unit1, unit2]) assert.equal(chatStore.getChat(chatId), null);
		assert.equal(jobStore.getJob(job.id), null);
		assert.equal(exists(path.join(TMP, "notes", unit1)), false);
		assert.equal((await courseRoute.GET(new Request("http://x"), ctx(courseId))).status, 404);
		assert.equal((await del(courseId)).status, 404, "a second delete is an honest 404");

		// Untouched: another course, a standalone session's notes, and the
		// linked practice session, whose link is now ignored.
		assert.ok(courseStore.get(other.courseId));
		assert.deepEqual(notes.listNotes(other.unit1).map((note) => note.title), ["Other course notes"]);
		assert.deepEqual(notes.listNotes(standalone.id).map((note) => note.title), ["Standalone notes"]);
		assert.deepEqual(chatStore.getChat(practice.id)?.course, { role: "practice", courseId, unitId: "vectors" });
		courses.syncSessionEvidence(chatStore.getChat(practice.id)!);
		assert.equal(exists(courseDir(courseId)), false, "syncing the practice session doesn't bring the course back");
	});

	it("applies the graph mode to every session and removes the graph folder once it's empty", async () => {
		const keep = seededCourse();
		const purge = seededCourse();
		const elsewhere = chatStore.createChat("Elsewhere");
		for (const [prefix, course] of [["keep", keep], ["purge", purge]] as const) {
			graphStore.appendNode(node(`n_${prefix}_one`, [course.unit1]));
			graphStore.appendNode(node(`n_${prefix}_two`, [course.unit2]));
			graphStore.appendNode(node(`n_${prefix}_shared`, [course.unit2, elsewhere.id]));
		}
		const keepFolder = folderOf(keep.courseId);
		const purgeFolder = folderOf(purge.courseId);

		assert.equal((await del(keep.courseId, "preserve-graph")).status, 200);
		const kept = getGraph(graphStore).nodes.filter((n) => n.id.startsWith("n_keep_"));
		assert.deepEqual(kept.map((n) => [n.id, n.provenance.length]).sort(), [["n_keep_one", 1], ["n_keep_shared", 2], ["n_keep_two", 1]]);
		assert.ok(folderExists(keepFolder), "the graph keeps the sessions' traces, so their folder stays");

		assert.equal((await del(purge.courseId, "delete-nodes")).status, 200);
		const purged = getGraph(graphStore).nodes.filter((n) => n.id.startsWith("n_purge_"));
		assert.deepEqual(purged.map((n) => [n.id, n.provenance.map((point) => point.chatId)]), [["n_purge_shared", [elsewhere.id]]], "only the topic another session covers survives");
		assert.equal(folderExists(purgeFolder), false, "nothing is left in the course's folder");
		assert.ok(!Object.values(sourceOrganizationStore.read().placements).some((placement) => placement.folderId === purgeFolder));
	});

	it("keeps the graph folder when the learner put another source in it", async () => {
		const course = seededCourse();
		const folderId = folderOf(course.courseId);
		const mine = chatStore.createChat("Filed by the learner");
		const state = sourceOrganizationStore.read();
		sourceOrganizationStore.write({ ...state, placements: { ...state.placements, [mine.id]: { folderId } } });
		assert.equal((await del(course.courseId, "delete-nodes")).status, 200);
		assert.ok(folderExists(folderId));
		assert.equal(sourceOrganizationStore.read().placements[mine.id]?.folderId, folderId);
	});

	for (const state of ["deleted", "unreadable"] as const) it(`removes graph traces and legacy notes even when a member session is already ${state}`, async () => {
		const { courseId, setupId, unit1, unit2 } = seededCourse();
		const folderId = folderOf(courseId);
		const elsewhere = chatStore.createChat("Another source of the shared topic");
		const prefix = `n_${state}_member`;
		graphStore.appendNode(node(`${prefix}_only`, [unit1]));
		graphStore.appendNode(node(`${prefix}_shared`, [unit1, elsewhere.id]));
		await writeNote(unit1, "Legacy member notes");
		const stagedNotes = path.join(TMP, `staged-${unit1}`);
		fs.renameSync(path.join(courseDir(courseId), "notes", unit1), stagedNotes);
		if (state === "deleted") {
			assert.ok((await chats.deleteChatSession(unit1, "preserve-graph")).ok);
		} else {
			fs.writeFileSync(chatFile(unit1), "damaged session record");
		}
		assert.equal(chatStore.getChat(unit1), null);
		const legacyNotes = path.join(TMP, "notes", unit1);
		fs.mkdirSync(path.dirname(legacyNotes), { recursive: true });
		fs.renameSync(stagedNotes, legacyNotes);
		// Do not read notes here: that would migrate the legacy fixture.

		const res = await del(courseId, "delete-nodes");
		assert.equal(res.status, 200);
		const body = await res.json() as { chatIds: string[] };
		const remaining = getGraph(graphStore).nodes.filter((n) => n.id.startsWith(prefix));
		assert.deepEqual(remaining.map((n) => [n.id, n.provenance.map((point) => point.chatId)]), [[`${prefix}_shared`, [elsewhere.id]]]);
		assert.deepEqual(body.chatIds, [setupId, unit1, unit2], "all member ids let the client leave an already-deleted session too");
		assert.equal(folderExists(folderId), false);
		assert.equal(exists(courseDir(courseId)), false);
		assert.equal(exists(legacyNotes), false, "missing and unreadable members still own legacy notes");
		if (state === "unreadable") assert.ok(exists(chatFile(unit1)), "unreadable sessions still count as gone rather than being overwritten");
	});

	it("refuses while a session runs a turn or a background job, naming it, and deletes nothing", async () => {
		const { courseId, setupId, unit1, unit2 } = seededCourse();
		const everything = () => [chatStore.getChat(setupId), chatStore.getChat(unit1), chatStore.getChat(unit2), courseStore.get(courseId)].every(Boolean);

		assert.ok(beginTurn(unit2));
		try {
			const turn = await del(courseId);
			assert.equal(turn.status, 409);
			assert.deepEqual(await turn.json(), { error: "A turn is running in unit 2 (Linear maps) — try again when it finishes", code: "turn_in_flight", chatId: unit2 });
			assert.ok(everything());
		} finally {
			endTurn(unit2);
		}

		const job = jobStore.createJob({ kind: "research", chatId: setupId, toolCallId: "tc_running" });
		const jobs = await del(courseId);
		assert.equal(jobs.status, 409);
		assert.deepEqual(await jobs.json(), { error: "Background jobs are still running in the setup session — try again when they finish", code: "jobs_running", chatId: setupId });
		assert.ok(everything());

		jobStore.updateJob(job.id, { status: "done" });
		assert.equal((await del(courseId)).status, 200);
		assert.equal(courseStore.get(courseId), null);
	});

	it("keeps the course after a failure part-way, and Delete again finishes", async () => {
		const { courseId, setupId, unit1, unit2 } = seededCourse();
		await writeNote(unit2, "Maps notes");
		const unlink = fs.unlinkSync;
		const failure = mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
			if (String(file) === chatFile(unit2)) throw Object.assign(new Error("EACCES: injected"), { code: "EACCES" });
			return unlink(file);
		});
		syncBuiltinESMExports();
		try {
			const res = await del(courseId);
			assert.equal(res.status, 500);
			assert.deepEqual(await res.json(), { error: "Some of this course's sessions couldn't be deleted. Try again." });
		} finally {
			failure.mock.restore();
			syncBuiltinESMExports();
		}
		assert.equal(chatStore.getChat(setupId), null);
		assert.equal(chatStore.getChat(unit1), null);
		assert.ok(chatStore.getChat(unit2), "the session that couldn't be removed is still there");
		assert.ok(courseStore.get(courseId), "the course still names it, so Delete can be pressed again");

		const rerun = await del(courseId);
		assert.equal(rerun.status, 200);
		assert.deepEqual((await rerun.json() as { chatIds: string[] }).chatIds, [setupId, unit1, unit2], "the response still names members deleted by the first attempt");
		assert.equal(chatStore.getChat(unit2), null);
		assert.equal(exists(courseDir(courseId)), false);
	});

	for (const location of ["course", "legacy"] as const) it(`retries ${location} note cleanup after the member's chat record was unlinked`, async (t) => {
		if (process.platform === "win32" || process.getuid?.() === 0) {
			t.skip("requires filesystem permissions enforced for a non-root user");
			return;
		}
		const { courseId, unit2 } = seededCourse();
		await writeNote(unit2, "Notes that could not be removed");
		const courseNotes = path.join(courseDir(courseId), "notes", unit2);
		const unitNotes = location === "legacy" ? path.join(TMP, "notes", unit2) : courseNotes;
		if (location === "legacy") {
			fs.mkdirSync(path.dirname(unitNotes), { recursive: true });
			fs.renameSync(courseNotes, unitNotes);
		}
		// No note reads after moving: they would migrate the legacy fixture.
		let response: Response | undefined;
		try {
			fs.chmodSync(unitNotes, 0o000);
			response = await del(courseId);
		} finally {
			fs.chmodSync(unitNotes, 0o700);
		}
		assert.ok(courseStore.get(courseId), "failed cleanup must leave the course readable for retry");
		assert.equal(response?.status, 500);
		assert.ok(exists(path.join(unitNotes, "notes.json")));
		assert.equal(chatStore.getChat(unit2), null, "the failure happened after session deletion");

		assert.equal((await del(courseId)).status, 200);
		assert.equal(exists(courseDir(courseId)), false, "retry removes the remaining notes and course folder");
		assert.equal(exists(unitNotes), false, "retry removes the notes, including any legacy folder");
	});

	it("restores the exact course record when final directory removal fails, then retries", async (t) => {
		if (process.platform === "win32" || process.getuid?.() === 0) {
			t.skip("requires filesystem permissions enforced for a non-root user");
			return;
		}
		const { courseId, setupId, unit1, unit2 } = seededCourse();
		const file = path.join(courseDir(courseId), "course.json");
		const record = JSON.parse(fs.readFileSync(file, "utf8"));
		record.futureMetadata = { retained: ["unknown", "fields"] };
		const original = `  ${JSON.stringify(record, null, "  ")}\n`;
		fs.writeFileSync(file, original);
		const parent = path.dirname(courseDir(courseId));
		const mode = fs.statSync(parent).mode & 0o777;
		let response: Response | undefined;
		try {
			fs.chmodSync(parent, 0o500);
			response = await del(courseId);
		} finally {
			fs.chmodSync(parent, mode);
		}
		assert.equal(response?.status, 500);
		assert.deepEqual(await response!.json(), { error: "Some of this course's sessions couldn't be deleted. Try again." });
		assert.equal(fs.readFileSync(file, "utf8"), original, "restore original bytes, including unknown fields and formatting");
		const remaining = courseStore.get(courseId)!;
		assert.ok(remaining, "failed final rmdir leaves a readable membership record");
		assert.deepEqual([remaining.setupChatId, ...remaining.units.flatMap((unit) => unit.chatId ? [unit.chatId] : [])], [setupId, unit1, unit2]);
		for (const id of [setupId, unit1, unit2]) assert.equal(chatStore.getChat(id), null);
		const retry = await del(courseId);
		assert.equal(retry.status, 200);
		assert.deepEqual((await retry.json() as { chatIds: string[] }).chatIds, [setupId, unit1, unit2]);
		assert.equal(exists(courseDir(courseId)), false);
	});

	it("stops the course's handoff writer, which then leaves nothing behind", async () => {
		const { courseId } = seededCourse();
		let started!: () => void;
		const running = new Promise<void>((resolve) => { started = resolve; });
		handoffs.handoffServiceSeams.write = (input) => new Promise((_resolve, reject) => {
			started();
			input.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
		});
		const course = courseStore.update(courseId, (current) => ({
			...current,
			units: current.units.map((unit) => unit.id === "vectors"
				? { ...unit, status: "completed" as const, completion: "confirmed" as const, completedAt: "2026-11-20T10:00:00.000Z", handoff: { writtenAt: "2026-11-20T10:00:00.000Z", completion: "confirmed" as const, topics: [], writer: { status: "writing" as const } } }
				: unit),
		}))!;
		handoffs.startHandoffWriter(course, "vectors", {} as PiEngine);
		await running;
		assert.ok(handoffs.isHandoffWriterRunning(courseId, "vectors"));

		beginTurn(course.units[1]!.chatId!);
		try {
			assert.equal((await del(courseId)).status, 409);
			assert.ok(handoffs.isHandoffWriterRunning(courseId, "vectors"), "a refused deletion leaves the writer running");
		} finally {
			endTurn(course.units[1]!.chatId!);
		}

		assert.equal((await del(courseId)).status, 200);
		for (let i = 0; i < 400 && handoffs.isHandoffWriterRunning(courseId, "vectors"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(handoffs.isHandoffWriterRunning(courseId, "vectors"), false);
		assert.equal(exists(courseDir(courseId)), false, "the stopped writer's outcome has no record to land in");
	});

	it("requires a mode", async () => {
		const { courseId } = seededCourse();
		const res = await courseRoute.DELETE(new Request(`http://x/api/courses/${courseId}`, { method: "DELETE" }), ctx(courseId));
		assert.equal(res.status, 400);
		assert.ok(courseStore.get(courseId));
	});
});

describe("session deletion during extraction", () => {
	it("cancels an extraction started during deletion and keeps the session until retry", async () => {
		const chat = chatStore.createChat("Session deletion race");
		chatStore.saveMessages(chat.id, [{ ...fauxAssistantMessage("A vector space is closed under addition and scaling."), id: "race-prose" }]);
		const faux = createFauxCore({});
		faux.setResponses([(_context, options) => new Promise((_resolve, reject) => {
			const die = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
			if (options?.signal?.aborted) die();
			else options?.signal?.addEventListener("abort", die, { once: true });
		})]);
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple } as PiEngine;
		const pipeline = createExtractionPipeline({ chatStore, graphStore, extractor: engine, auditor: engine });

		// Deletion has checked an empty extraction registry, then yields.
		// The real pipeline registers its run before deletion resumes.
		const deleting = chats.deleteChatSession(chat.id, "preserve-graph");
		const extraction = pipeline.runExtraction(chat.id);
		try {
			const outcome = await deleting;
			assert.equal(outcome.ok, false, "deletion cannot succeed while its extraction still runs");
			if (!outcome.ok) {
				assert.equal(outcome.status, 503);
				assert.equal(outcome.code, "extraction_winding_down");
			}
			assert.ok(chatStore.getChat(chat.id), "the retryable refusal keeps the session");
			assert.ok(extractionStatuses().filter((run) => run.chatId === chat.id).every((run) => run.controller.signal.aborted));
		} finally {
			abortExtraction(chat.id);
			await extraction;
		}
		assert.ok((await chats.deleteChatSession(chat.id, "preserve-graph")).ok);
		assert.equal(chatStore.getChat(chat.id), null);
		assert.ok(!extractionStatuses().some((run) => run.chatId === chat.id));
	});
});

// ─── the dialog and the menu ────────────────────────────────────────────────

describe("the Delete course dialog", () => {
	const body = (unitSessions: number, noteCount: number) => renderToStaticMarkup(
		<DeleteCourseBody course={{ id: "course_x", title: "Linear algebra" }} unitSessions={unitSessions} noteCount={noteCount}
			traces={false} busy={false} failure={null} onTraces={() => {}} onClose={() => {}} onRun={() => {}} />,
	);

	it("names what goes with the course, counting its unit sessions and notes", () => {
		assert.equal(courseDeletionLine(2, 3), "This deletes the course, its setup session, its 2 unit sessions, and their 3 notes.");
		assert.equal(courseDeletionLine(1, 1), "This deletes the course, its setup session, its 1 unit session, and their 1 note.");
		assert.equal(courseDeletionLine(2, 0), "This deletes the course, its setup session, and its 2 unit sessions.");
		assert.equal(courseDeletionLine(0, 0), "This deletes the course and its setup session.");
		const html = body(2, 3);
		assert.match(html, /<h2[^>]*text-destructive[^>]*>Delete course\?<\/h2>/);
		assert.match(html, /data-testid="course-name-code"[^>]*>Linear algebra</);
		assert.match(html, /data-testid="delete-course-line"[^>]*>This deletes the course, its setup session, its 2 unit sessions, and their 3 notes\.</);
	});

	it("offers the unchecked graph-traces checkbox for these sessions", () => {
		const html = body(2, 0);
		assert.ok(html.includes(`>${COURSE_TRACES_COPY.title}<`) && COURSE_TRACES_COPY.title === "Also remove their graph traces");
		assert.ok(html.includes("These sessions’ topics, links, and events leave the graph too."));
		assert.ok(!/checked=""/.test(html), "unchecked by default");
	});

	it("offers the course archive as Download notes only when there are notes", () => {
		assert.match(body(2, 3), /<a href="\/api\/courses\/course_x\/notes\/archive\.zip" download=""[^>]*data-testid="delete-download-notes"[^>]*>Download notes<\/a>/);
		assert.ok(!body(2, 0).includes("Download notes"));
		for (const html of [body(2, 3), body(2, 0)]) assert.ok(html.includes(">Cancel<") && html.includes(">Delete<"));
	});

	it("is offered last in the course header's menu", () => {
		const html = renderToStaticMarkup(<CourseMenuItems onRename={() => {}} onDelete={() => {}} />);
		assert.deepEqual([...html.matchAll(/data-testid="(ctx-course-[a-z]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]), [["ctx-course-rename", "Rename course"], ["ctx-course-delete", "Delete course…"]]);
	});
});
