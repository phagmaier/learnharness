/**
 * NoteStore — study notes on disk (fork plan 03). One owner directory per
 * session (data/notes/<chatId>/; phase 1 puts unit notes under a course):
 *
 *   notes.json       { version: 1, notes: NoteEntry[] }
 *   <noteId>.html    the final, self-contained page
 *
 * Sync fs like the chat store, so each read-modify-write of the index is
 * one uninterrupted step even while several notes are being written. A note
 * file is replaced by temp file and rename, so a failed rewrite never
 * touches the version already on disk.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { CURRENT_NOTES_VERSION, type NoteEntry, type NotesIndex } from "../core/contracts.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const INDEX = "notes.json";

export class NotesUnreadableError extends Error {}

function safeId(id: string, what: string): string {
	if (!SAFE_ID.test(id)) throw new Error(`Invalid ${what} id: ${id}`);
	return id;
}

export function newNoteId(): string {
	return `note_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export interface NoteStore {
	readonly dir: string;
	/** Every note, oldest first. Throws NotesUnreadableError for an index
	 *  this build cannot read (newer stamp, or damaged). */
	list(): NoteEntry[];
	get(noteId: string): NoteEntry | undefined;
	add(entry: NoteEntry): void;
	/** Replace one entry with `change(entry)`; undefined when absent. */
	update(noteId: string, change: (entry: NoteEntry) => NoteEntry): NoteEntry | undefined;
	/** Remove the entry and its file. */
	remove(noteId: string): boolean;
	readHtml(noteId: string): string | null;
	writeHtml(noteId: string, html: string): void;
	/** Remove the whole owner directory. */
	removeAll(): void;
}

export function noteStoreAt(dir: string): NoteStore {
	const indexFile = path.join(/* turbopackIgnore: true */ dir, INDEX);
	const htmlFile = (noteId: string) => path.join(/* turbopackIgnore: true */ dir, `${safeId(noteId, "note")}.html`);

	const load = (): NotesIndex => {
		let text: string;
		try {
			text = fs.readFileSync(/* turbopackIgnore: true */ indexFile, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: CURRENT_NOTES_VERSION, notes: [] };
			throw error;
		}
		let parsed: NotesIndex;
		try {
			parsed = JSON.parse(text) as NotesIndex;
		} catch {
			throw new NotesUnreadableError("This session's notes index is damaged and can't be read.");
		}
		const version = parsed.version ?? 1;
		if (typeof version !== "number" || version > CURRENT_NOTES_VERSION) {
			throw new NotesUnreadableError("This session's notes were saved by a newer version of the app.");
		}
		if (!Array.isArray(parsed.notes)) throw new NotesUnreadableError("This session's notes index is damaged and can't be read.");
		return parsed;
	};
	const save = (notes: NoteEntry[]) => {
		fs.mkdirSync(dir, { recursive: true });
		writeFileAtomicSync(indexFile, JSON.stringify({ version: CURRENT_NOTES_VERSION, notes }, null, "\t"), { allowInPlaceFallback: true });
	};

	return {
		dir,
		list: () => load().notes,
		get: (noteId) => load().notes.find((note) => note.id === noteId),
		add(entry) {
			safeId(entry.id, "note");
			const { notes } = load();
			save([...notes, entry]);
		},
		update(noteId, change) {
			const { notes } = load();
			const index = notes.findIndex((note) => note.id === noteId);
			if (index === -1) return undefined;
			const next = change(notes[index]!);
			notes[index] = next;
			save(notes);
			return next;
		},
		remove(noteId) {
			const file = htmlFile(noteId);
			const { notes } = load();
			const kept = notes.filter((note) => note.id !== noteId);
			if (kept.length === notes.length) return false;
			save(kept);
			fs.rmSync(file, { force: true });
			removeLeftoverTemps(file);
			return true;
		},
		readHtml(noteId) {
			try {
				return fs.readFileSync(/* turbopackIgnore: true */ htmlFile(noteId), "utf-8");
			} catch {
				return null;
			}
		},
		writeHtml(noteId, html) {
			const file = htmlFile(noteId);
			fs.mkdirSync(dir, { recursive: true });
			writeFileAtomicSync(file, html);
		},
		removeAll() {
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** The notes of one standalone session. */
export function sessionNoteStore(chatId: string): NoteStore {
	return noteStoreAt(path.join(/* turbopackIgnore: true */ PATHS.notes, safeId(chatId, "chat")));
}
