/**
 * Study notes for standalone Teach sessions (fork plan 03 item 3): the
 * lifecycle around the note writer. A new note is listed at once as
 * "writing" and written in the background; several notes can be written at
 * once, but one note is never rewritten while it is being written. Stop
 * aborts the writer; a stopped new note fails as stopped, and a stopped
 * rewrite keeps the version on disk. A note left "writing" by a closed app
 * reads as interrupted.
 *
 * Note requests use the noteWriter role (Strong slot), run with purpose
 * "user" because the learner asked for them (no background consent needed
 * on subscriptions), and share the worker-request pool.
 */
import type { ChatRecord, JobUsage, NoteEntry } from "../core/contracts.ts";
import { modelsNotConfigured, type ModelsNotConfigured } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { emit } from "../core/events.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { writeNote } from "../agent/subagents/note-writer.ts";
import { newNoteId, NotesUnreadableError, sessionNoteStore, type NoteStore } from "../store/notes.ts";
import { documentSlug } from "./document-export.ts";
import { jobCost } from "./pricing.ts";
import { stores } from "./stores.ts";
import { zipFiles } from "./zip.ts";

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
	return recover(chatId, sessionNoteStore(chatId));
}

/** The notes page's list: each note with its latest generation's cost. */
export function listNotesWithCost(chatId: string): Array<NoteEntry & { costUsd: number | null }> {
	return listNotes(chatId).map((note) => ({ ...note, costUsd: jobCost(note) }));
}

export function getNote(chatId: string, noteId: string): NoteEntry | undefined {
	return listNotes(chatId).find((note) => note.id === noteId);
}

export function readNoteHtml(chatId: string, noteId: string): string | null {
	return sessionNoteStore(chatId).readHtml(noteId);
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

function start(record: ChatRecord, note: NoteEntry, mode: RunningNote["mode"], engine: PiEngine, request: { instruction: string; interactive: boolean }): void {
	const store = sessionNoteStore(record.id);
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
	sessionNoteStore(chatId).add(note);
	start(record, note, "write", engine, request);
	changed(chatId);
	return { ok: true, note };
}

/** Rewrite a ready note (the current version stays until the new one
 *  succeeds), or try a failed note again in place. */
export function regenerateNote(chatId: string, noteId: string, input: { instruction?: unknown; interactive?: unknown }): { ok: true; note: NoteEntry } | NoteRefusal {
	const record = teachSession(chatId);
	if ("ok" in record) return record;
	const note = getNote(chatId, noteId);
	if (!note) return { ok: false, status: 404, error: "Unknown note" };
	if (running().has(key(chatId, noteId))) return { ok: false, status: 409, error: "This note is being written. Stop it or wait for it to finish." };
	const engine = noteWriterEngine();
	if (!engine) return { ok: false, status: 503, ...modelsNotConfigured(["strong"]) };
	const request = readRequest(input);
	const now = noteServiceSeams.now().toISOString();
	const store = sessionNoteStore(chatId);
	const retry = note.status !== "ready";
	const updated = store.update(noteId, ({ error: _error, stopped: _stopped, regenerating: _rewrite, ...rest }) => retry
		? { ...rest, instruction: request.instruction, interactive: request.interactive, status: "writing", updatedAt: now }
		: { ...rest, regenerating: { instruction: request.instruction, interactive: request.interactive, startedAt: now } });
	if (!updated) return { ok: false, status: 404, error: "Unknown note" };
	start(record, updated, retry ? "write" : "rewrite", engine, request);
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
	const removed = sessionNoteStore(chatId).remove(noteId);
	if (removed) changed(chatId);
	return removed;
}

/** Delete every note of a session (session deletion): stop its writers,
 *  then remove the folder. A stopped writer finds no index and writes
 *  nothing back. */
export function deleteSessionNotes(chatId: string): void {
	for (const entry of running().values()) {
		if (entry.chatId === chatId) entry.controller.abort();
	}
	sessionNoteStore(chatId).removeAll();
	changed(chatId);
}

/** Every note with a version on disk, as one zip of HTML files. */
export function notesArchive(chatId: string): { filename: string; zip: Buffer; count: number } | NoteRefusal {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return { ok: false, status: 404, error: "Unknown chat" };
	const store = sessionNoteStore(chatId);
	const used = new Set<string>();
	const entries = listNotes(chatId).flatMap((note) => {
		if (note.status !== "ready") return [];
		const html = store.readHtml(note.id);
		if (html === null) return [];
		const base = note.title ? documentSlug(note.title) : note.id;
		let name = `${base}.html`;
		for (let n = 2; used.has(name); n++) name = `${base}-${n}.html`;
		used.add(name);
		return [{ name, data: Buffer.from(html, "utf8"), date: new Date(note.updatedAt) }];
	});
	return { filename: `${documentSlug(record.title)}-notes.zip`, zip: zipFiles(entries), count: entries.length };
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
