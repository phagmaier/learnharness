/**
 * NoteStore — study notes on disk (fork plan 03). One owner directory per
 * session (data/notes/<chatId>/; phase 1 puts unit notes under a course):
 *
 *   notes.json                   { version: 2, notes: NoteEntry[] }
 *   <noteId>.<htmlRevision>.html  the final, self-contained page
 *   <noteId>.html                 legacy v1 page (read until rewritten)
 *
 * Sync fs like the chat store, so each read-modify-write of the index is
 * one uninterrupted step even while several notes are being written. A note
 * revision is written before the index atomically selects it. A failed
 * publication never touches the current revision or its metadata.
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
	/** Publish HTML and metadata together; the index rename is the commit. */
	publish(noteId: string, html: string, change: (entry: NoteEntry) => NoteEntry): NoteEntry | undefined;
	writeHtml(noteId: string, html: string): void;
	/** Remove the whole owner directory. */
	removeAll(): void;
}

export function noteStoreAt(dir: string): NoteStore {
	const indexFile = path.join(/* turbopackIgnore: true */ dir, INDEX);
	const htmlFile = (noteId: string, revision?: string) => path.join(/* turbopackIgnore: true */ dir,
		`${safeId(noteId, "note")}${revision ? `.${safeId(revision, "revision")}` : ""}.html`);

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
		writeFileAtomicSync(indexFile, JSON.stringify({ version: CURRENT_NOTES_VERSION, notes }, null, "\t"));
	};
	// Cleanup cannot turn a committed publication into a reported failure.
	const discard = (file: string) => {
		try { fs.rmSync(file, { force: true }); }
		catch (error) { console.warn(`[notes] could not remove unused HTML ${file}:`, error); }
		removeLeftoverTemps(file);
	};
	const publish: NoteStore["publish"] = (noteId, html, change) => {
		const { notes } = load();
		const index = notes.findIndex((note) => note.id === noteId);
		if (index === -1) return undefined;
		const previous = notes[index]!;
		const previousFile = htmlFile(noteId, previous.htmlRevision);
		const revision = crypto.randomUUID();
		const file = htmlFile(noteId, revision);
		const next = { ...change(previous), htmlRevision: revision };
		fs.mkdirSync(dir, { recursive: true });
		try {
			writeFileAtomicSync(file, html);
			notes[index] = next;
			save(notes);
		} catch (error) {
			discard(file);
			throw error;
		}
		discard(previousFile);
		return next;
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
			safeId(noteId, "note");
			const { notes } = load();
			const kept = notes.filter((note) => note.id !== noteId);
			if (kept.length === notes.length) return false;
			save(kept);
			for (const name of fs.readdirSync(dir)) {
				if (name.startsWith(`${noteId}.`) && /\.html(?:\.tmp-.*)?$/.test(name)) discard(path.join(dir, name));
			}
			return true;
		},
		readHtml(noteId) {
			try {
				const note = load().notes.find((entry) => entry.id === noteId);
				return note ? fs.readFileSync(/* turbopackIgnore: true */ htmlFile(noteId, note.htmlRevision), "utf-8") : null;
			} catch {
				return null;
			}
		},
		publish,
		writeHtml: (noteId, html) => { safeId(noteId, "note"); publish(noteId, html, (entry) => entry); },
		removeAll() {
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** The notes of one standalone session. */
export function sessionNoteStore(chatId: string): NoteStore {
	return noteStoreAt(path.join(/* turbopackIgnore: true */ PATHS.notes, safeId(chatId, "chat")));
}
