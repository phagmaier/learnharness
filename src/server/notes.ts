/**
 * Study notes for Teach sessions (fork plan 03 item 3): the lifecycle
 * around the note writer. A new note is listed at once as
 * "writing" and written in the background; several notes can be written at
 * once, but one note is never rewritten while it is being written. Stop
 * aborts the writer; a stopped new note fails as stopped, and a stopped
 * rewrite keeps the version on disk. A note left "writing" by a closed app
 * reads as interrupted.
 *
 * Note requests use the noteWriter role (Strong slot), run with purpose
 * "user" because the learner asked for them (no background consent needed
 * on subscriptions), and share the worker-request pool.
 *
 * Where a session's notes live (fork plan 04 item 8): a unit session its
 * course records keeps them under the course
 * (data/courses/<courseId>/notes/<chatId>/); every other session, a
 * crash's duplicate unit session included, in data/notes/<chatId>/.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatCourseLink, ChatRecord, CourseRecord, JobUsage, NoteEntry } from "../core/contracts.ts";
import { unitSlug } from "../core/course.ts";
import { modelsNotConfigured, type ModelsNotConfigured } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { emit } from "../core/events.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { writeNote } from "../agent/subagents/note-writer.ts";
import { newNoteId, noteStoreAt, NotesUnreadableError, sessionNoteStore, type NoteStore } from "../store/notes.ts";
import { courseNotesDir, courseStore, CourseUnreadableError } from "../store/courses.ts";
import { documentSlug } from "./document-export.ts";
import { jobCost } from "./pricing.ts";
import { stores } from "./stores.ts";
import { zipFiles, type ZipEntry } from "./zip.ts";

export { NotesUnreadableError } from "../store/notes.ts";

export const INTERRUPTED_MESSAGE = "Interrupted when the app closed";
export const SETUP_NO_NOTES = "Course setup sessions have no notes.";
export const STOPPED_MESSAGE = "Stopped";

/** Test seams: engine construction and the writer itself. */
export const noteServiceSeams = {
	buildEngine: piEngineForSpec as (...args: Parameters<typeof piEngineForSpec>) => PiEngine,
	write: writeNote,
	now: () => new Date(),
};

interface RunningNote {
	chatId: string;
	noteId: string;
	sessionTitle: string;
	mode: "write" | "rewrite";
	controller: AbortController;
	startedAt: string;
	usage?: JobUsage;
	model?: string;
}

interface NotesGlobal { __lhRunningNotes?: Map<string, RunningNote> }
function running(): Map<string, RunningNote> {
	const global = globalThis as typeof globalThis & NotesGlobal;
	return global.__lhRunningNotes ??= new Map();
}
const key = (chatId: string, noteId: string) => `${chatId}:${noteId}`;

function changed(chatId: string): void {
	emit("notes-changed", { chatId });
}

// ─── where a session's notes live ───────────────────────────────────────────

/** The course whose record names this session as a unit's session, or
 *  null. Throws NotesUnreadableError when that course can't be read. */
function memberCourseId(record: Pick<ChatRecord, "id" | "course">): string | null {
	const link = record.course;
	if (link?.role !== "unit") return null;
	let course: CourseRecord | null;
	try {
		course = courseStore.get(link.courseId);
	} catch (error) {
		if (error instanceof CourseUnreadableError) throw new NotesUnreadableError(`This session's course can't be read: ${error.message}`);
		if (error instanceof Error && error.message.startsWith("Invalid course id")) return null;
		throw error;
	}
	return course?.units.some((unit) => unit.chatId === record.id) ? course.id : null;
}

/** A unit session's notes, inside its course. Notes written there before
 *  unit notes moved under the course (plan 04 items 4–7) move along once,
 *  while none of the session's writers runs. A failed move refuses access
 *  instead of letting an empty destination strand the original notes. */
function unitNoteStore(courseId: string, chatId: string): NoteStore {
	const dir = courseNotesDir(courseId, chatId);
	const standalone = sessionNoteStore(chatId).dir;
	if (!fs.existsSync(dir) && fs.existsSync(standalone) && ![...running().values()].some((entry) => entry.chatId === chatId)) {
		try {
			fs.mkdirSync(path.dirname(dir), { recursive: true });
			fs.renameSync(standalone, dir);
		} catch (error) {
			console.warn(`[notes] could not move ${chatId}'s notes into its course:`, error);
			throw new NotesUnreadableError("This session's notes couldn't be moved into its course. Try again.", { cause: error });
		}
	}
	return noteStoreAt(dir);
}

/** The notes of one session, wherever they live. */
export function noteStoreFor(record: Pick<ChatRecord, "id" | "course">): NoteStore {
	const courseId = memberCourseId(record);
	return courseId ? unitNoteStore(courseId, record.id) : sessionNoteStore(record.id);
}

function storeOf(chatId: string): NoteStore {
	return noteStoreFor(stores.chatStore.getChat(chatId) ?? { id: chatId });
}

/** The note writer's engine: role override → Strong slot, purpose "user". */
export function noteWriterEngine(): PiEngine | undefined {
	const settings = stores.settingsStore.readSettings();
	const spec = resolveRoleSpec("noteWriter", settings);
	if (!spec) return undefined;
	return noteServiceSeams.buildEngine(spec, false, undefined, () => stores.settingsStore.readSettings()?.models?.strong?.cacheRetention);
}

/** Settle entries whose writer is not running in this process. */
function recover(chatId: string, store: NoteStore): NoteEntry[] {
	const notes = store.list();
	const live = running();
	let touched = false;
	for (const note of notes) {
		if (live.has(key(chatId, note.id))) continue;
		if (note.status === "writing") {
			store.update(note.id, (entry) => ({ ...entry, status: "failed", error: INTERRUPTED_MESSAGE, updatedAt: noteServiceSeams.now().toISOString() }));
			touched = true;
		} else if (note.regenerating && note.regenerating.error === undefined) {
			store.update(note.id, (entry) => ({ ...entry, regenerating: { ...entry.regenerating!, error: INTERRUPTED_MESSAGE } }));
			touched = true;
		}
	}
	return touched ? store.list() : notes;
}

export function listNotes(chatId: string): NoteEntry[] {
	return recover(chatId, storeOf(chatId));
}

const withCost = (notes: NoteEntry[]) => notes.map((note) => ({ ...note, costUsd: jobCost(note) }));

/** The notes page's list: each note with its latest generation's cost. */
export function listNotesWithCost(chatId: string): Array<NoteEntry & { costUsd: number | null }> {
	return withCost(listNotes(chatId));
}

export function getNote(chatId: string, noteId: string): NoteEntry | undefined {
	return listNotes(chatId).find((note) => note.id === noteId);
}

export function readNoteHtml(chatId: string, noteId: string): string | null {
	return storeOf(chatId).readHtml(noteId);
}

export type NoteRefusal = { ok: false; status: number; error: string; code?: ModelsNotConfigured["code"]; missing?: ModelsNotConfigured["missing"] };

function teachSession(chatId: string): ChatRecord | NoteRefusal {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return { ok: false, status: 404, error: "Unknown chat" };
	if (record.kind === "practice") return { ok: false, status: 400, error: "Practice sessions have no notes." };
	// Fork plan 04: a course setup session plans the course; it has no notes.
	if (record.course?.role === "setup") return { ok: false, status: 400, error: SETUP_NO_NOTES };
	return record;
}

function start(record: ChatRecord, store: NoteStore, note: NoteEntry, mode: RunningNote["mode"], engine: PiEngine, request: { instruction: string; interactive: boolean }): void {
	const entry: RunningNote = {
		chatId: record.id, noteId: note.id, sessionTitle: record.title, mode,
		controller: new AbortController(), startedAt: noteServiceSeams.now().toISOString(),
	};
	running().set(key(record.id, note.id), entry);
	emit("activity-changed", {});
	const signal = entry.controller.signal;
	void (async () => {
		try {
			const written = await noteServiceSeams.write({
				record, instruction: request.instruction, interactive: request.interactive, engine, signal,
				now: noteServiceSeams.now(),
				onUsage: (usage) => {
					entry.usage = usage;
					entry.model = usage.model;
					emit("activity-changed", {});
				},
			});
			if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
			// A note deleted mid-write leaves nothing behind.
			if (!store.get(note.id)) return;
			store.publish(note.id, written.html, ({ error: _error, stopped: _stopped, regenerating: _rewrite, ...rest }) => ({
				...rest,
				title: written.title,
				instruction: request.instruction,
				interactive: request.interactive,
				status: "ready",
				updatedAt: noteServiceSeams.now().toISOString(),
				...(written.model ? { model: written.model } : {}),
				...(written.usage ? { usage: written.usage } : {}),
			}));
		} catch (error) {
			const stopped = signal.aborted;
			const message = error instanceof Error ? error.message : String(error);
			try {
				store.update(note.id, (current) => {
					const now = noteServiceSeams.now().toISOString();
					if (mode === "rewrite") {
						// The version on disk stays; a stop needs no message.
						if (stopped) {
							const { regenerating: _rewrite, ...rest } = current;
							return rest;
						}
						return current.regenerating ? { ...current, regenerating: { ...current.regenerating, error: message } } : current;
					}
					return {
						...current, status: "failed", updatedAt: now,
						error: stopped ? STOPPED_MESSAGE : message,
						...(stopped ? { stopped: true as const } : {}),
						...(entry.model ? { model: entry.model } : {}),
						...(entry.usage ? { usage: entry.usage } : {}),
					};
				});
			} catch (storeError) {
				console.error(`[notes] could not record the outcome of note ${note.id}:`, storeError);
			}
		} finally {
			running().delete(key(record.id, note.id));
			emit("activity-changed", {});
			changed(record.id);
		}
	})();
}

function readRequest(input: { instruction?: unknown; interactive?: unknown }): { instruction: string; interactive: boolean } {
	return {
		instruction: typeof input.instruction === "string" ? input.instruction.trim() : "",
		interactive: input.interactive === true,
	};
}

export function createNote(chatId: string, input: { instruction?: unknown; interactive?: unknown }): { ok: true; note: NoteEntry } | NoteRefusal {
	const record = teachSession(chatId);
	if ("ok" in record) return record;
	const engine = noteWriterEngine();
	if (!engine) return { ok: false, status: 503, ...modelsNotConfigured(["strong"]) };
	const request = readRequest(input);
	const now = noteServiceSeams.now().toISOString();
	const note: NoteEntry = {
		id: newNoteId(), title: "", instruction: request.instruction, interactive: request.interactive,
		status: "writing", createdAt: now, updatedAt: now,
	};
	const store = noteStoreFor(record);
	store.add(note);
	start(record, store, note, "write", engine, request);
	changed(chatId);
	return { ok: true, note };
}

/** Rewrite a ready note (the current version stays until the new one
 *  succeeds), or try a failed note again in place. */
export function regenerateNote(chatId: string, noteId: string, input: { instruction?: unknown; interactive?: unknown }): { ok: true; note: NoteEntry } | NoteRefusal {
	const record = teachSession(chatId);
	if ("ok" in record) return record;
	const store = noteStoreFor(record);
	const note = recover(chatId, store).find((entry) => entry.id === noteId);
	if (!note) return { ok: false, status: 404, error: "Unknown note" };
	if (running().has(key(chatId, noteId))) return { ok: false, status: 409, error: "This note is being written. Stop it or wait for it to finish." };
	const engine = noteWriterEngine();
	if (!engine) return { ok: false, status: 503, ...modelsNotConfigured(["strong"]) };
	const request = readRequest(input);
	const now = noteServiceSeams.now().toISOString();
	const retry = note.status !== "ready";
	const updated = store.update(noteId, ({ error: _error, stopped: _stopped, regenerating: _rewrite, ...rest }) => retry
		? { ...rest, instruction: request.instruction, interactive: request.interactive, status: "writing", updatedAt: now }
		: { ...rest, regenerating: { instruction: request.instruction, interactive: request.interactive, startedAt: now } });
	if (!updated) return { ok: false, status: 404, error: "Unknown note" };
	start(record, store, updated, retry ? "write" : "rewrite", engine, request);
	changed(chatId);
	return { ok: true, note: updated };
}

export function stopNote(chatId: string, noteId: string): boolean {
	const entry = running().get(key(chatId, noteId));
	if (!entry) return false;
	entry.controller.abort();
	return true;
}

export function deleteNote(chatId: string, noteId: string): boolean {
	stopNote(chatId, noteId);
	const removed = storeOf(chatId).remove(noteId);
	if (removed) changed(chatId);
	return removed;
}

/** Delete every note of a session (session deletion): stop its writers,
 *  then remove its notes folder. `link` is the deleted record's course
 *  back-pointer: a unit session's notes may live under its course, so that
 *  folder goes too (it only ever holds this session's notes). A stopped
 *  writer finds no index and writes nothing back. */
export function deleteSessionNotes(chatId: string, link?: ChatCourseLink): void {
	for (const entry of running().values()) {
		if (entry.chatId === chatId) entry.controller.abort();
	}
	sessionNoteStore(chatId).removeAll();
	if (link?.role === "unit") {
		try { noteStoreAt(courseNotesDir(link.courseId, chatId)).removeAll(); }
		catch (error) { console.warn(`[notes] could not remove ${chatId}'s notes from course ${link.courseId}:`, error); }
	}
	changed(chatId);
}

/** The archive entries of one session's notes with a version on disk,
 *  named after the notes (in `folder`, when given). */
function archiveEntries(chatId: string, store: NoteStore, folder = ""): ZipEntry[] {
	const used = new Set<string>();
	return recover(chatId, store).flatMap((note) => {
		if (note.status !== "ready") return [];
		const html = store.readHtml(note.id);
		if (html === null) return [];
		const base = note.title ? documentSlug(note.title) : note.id;
		let name = `${base}.html`;
		for (let n = 2; used.has(name); n++) name = `${base}-${n}.html`;
		used.add(name);
		return [{ name: `${folder}${name}`, data: Buffer.from(html, "utf8"), date: new Date(note.updatedAt) }];
	});
}

/** Every note with a version on disk, as one zip of HTML files. */
export function notesArchive(chatId: string): { filename: string; zip: Buffer; count: number } | NoteRefusal {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return { ok: false, status: 404, error: "Unknown chat" };
	const entries = archiveEntries(chatId, noteStoreFor(record));
	return { filename: `${documentSlug(record.title)}-notes.zip`, zip: zipFiles(entries), count: entries.length };
}

// ─── a course's notes (plan 04 item 8) ──────────────────────────────────────

/** One started unit's notes, for the course's Notes tab. */
export interface CourseNotesUnit {
	unitId: string;
	/** The unit's position in the course, from 1. */
	number: number;
	title: string;
	chatId: string;
	notes: Array<NoteEntry & { costUsd: number | null }>;
	/** This unit's notes index can't be read. */
	error?: string;
}

/** The units that have a session, in course order. */
function sessionUnits(course: CourseRecord): Array<{ unitId: string; number: number; title: string; chatId: string }> {
	return course.units.flatMap((unit, index) => unit.status !== "not-started" && unit.chatId
		? [{ unitId: unit.id, number: index + 1, title: unit.title, chatId: unit.chatId }]
		: []);
}

/** Every started unit's notes, in course order. A unit whose notes index
 *  can't be read carries the reason and no notes. */
export function courseNotes(course: CourseRecord): CourseNotesUnit[] {
	return sessionUnits(course).map((unit) => {
		try {
			return { ...unit, notes: withCost(recover(unit.chatId, unitNoteStore(course.id, unit.chatId))) };
		} catch (error) {
			if (error instanceof NotesUnreadableError) return { ...unit, notes: [], error: error.message };
			throw error;
		}
	});
}

/** Every unit's notes with a version on disk, as one zip with a folder
 *  per unit ("<n>-<unit-slug>/"). Throws NotesUnreadableError, naming the
 *  unit, when one unit's notes can't be read: a partial archive would
 *  silently leave notes out. */
export function courseNotesArchive(course: CourseRecord): { filename: string; zip: Buffer; count: number } {
	const entries = sessionUnits(course).flatMap((unit) => {
		try {
			return archiveEntries(unit.chatId, unitNoteStore(course.id, unit.chatId), `${unit.number}-${unitSlug(unit.title)}/`);
		} catch (error) {
			if (error instanceof NotesUnreadableError) throw new NotesUnreadableError(`Unit ${unit.number} (${unit.title}): ${error.message}`);
			throw error;
		}
	});
	return { filename: `${documentSlug(course.title)}-notes.zip`, zip: zipFiles(entries), count: entries.length };
}

/** Running note writers for the activity feed ("Note · <session title>"). */
export interface NoteWriterActivity {
	id: string;
	chatId: string;
	noteId: string;
	title: string;
	createdAt: string;
	activity: string;
	usage?: JobUsage;
}

export function noteWriterActivities(): NoteWriterActivity[] {
	return [...running().values()].map((entry) => ({
		id: key(entry.chatId, entry.noteId),
		chatId: entry.chatId,
		noteId: entry.noteId,
		title: `Note · ${entry.sessionTitle}`,
		createdAt: entry.startedAt,
		activity: entry.mode === "rewrite" ? "Rewriting" : "Writing",
		...(entry.usage ? { usage: entry.usage } : {}),
	}));
}

export function abortNoteWriterActivity(id: string): boolean {
	const separator = id.indexOf(":");
	if (separator < 1) return false;
	return stopNote(id.slice(0, separator), id.slice(separator + 1));
}

export function isNotesUnreadable(error: unknown): error is NotesUnreadableError {
	return error instanceof NotesUnreadableError;
}
