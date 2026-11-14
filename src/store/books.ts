/**
 * BookStore — the books library on disk (fork plan 05). One folder per book:
 *
 *   books/<bookId>/book.json        the record ({ version: 1, … })
 *   books/<bookId>/original.<ext>   the imported file, byte for byte
 *   books/<bookId>/text.json        the converted text (never rewritten)
 *   books/<bookId>/map.json         the structure and its summaries
 *   books/<bookId>/candidates.json  the structures the import found
 *
 * Sync fs like the course store, so each read-modify-write is one
 * uninterrupted step. Every file is replaced by temp file and rename. A
 * record that is damaged or stamped newer than this build is refused
 * (BookUnreadableError) and never rewritten; unknown fields survive a
 * rewrite because updates spread the parsed record.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	CURRENT_BOOK_DATA_VERSION,
	CURRENT_BOOK_VERSION,
	type BookCandidates,
	type BookFormat,
	type BookMap,
	type BookRecord,
	type BookText,
} from "../core/contracts.ts";
import { emit } from "../core/events.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const RECORD = "book.json";
const TEXT = "text.json";
const MAP = "map.json";
const CANDIDATES = "candidates.json";
const EXTENSIONS: Record<BookFormat, string> = { pdf: "pdf", epub: "epub", text: "txt", markdown: "md" };

export class BookUnreadableError extends Error {}

function safeId(id: string): string {
	if (!SAFE_ID.test(id)) throw new Error(`Invalid book id: ${id}`);
	return id;
}

export function newBookId(): string {
	return `book_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export function bookDir(bookId: string): string {
	return path.join(/* turbopackIgnore: true */ PATHS.books, safeId(bookId));
}

const file = (bookId: string, name: string) => path.join(/* turbopackIgnore: true */ bookDir(bookId), name);

export function originalFile(bookId: string, format: BookFormat): string {
	return file(bookId, `original.${EXTENSIONS[format]}`);
}

const damaged = () => new BookUnreadableError("This book's record is damaged and can't be read.");
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const FORMATS = ["pdf", "epub", "text", "markdown"];
const IMPORT_STATES = ["importing", "review", "ready", "failed"];
const MAP_STATES = ["waiting", "not-needed", "writing", "ready", "failed"];

/** The fields this build reads; unknown fields are left alone. An embedded
 *  id must never redirect a subsequent write. */
function readableRecord(value: Record<string, unknown>, bookId: string): boolean {
	if (value.id !== bookId) return false;
	if (![value.title, value.fileName, value.sha256, value.importedAt, value.updatedAt].every((field) => typeof field === "string")) return false;
	if (!FORMATS.includes(value.format as string) || typeof value.bytes !== "number") return false;
	if (value.author !== undefined && typeof value.author !== "string") return false;
	if (!object(value.import) || !IMPORT_STATES.includes(value.import.status as string)) return false;
	if (!object(value.mapWriter) || !MAP_STATES.includes(value.mapWriter.status as string)) return false;
	if (typeof value.mapWriter.done !== "number" || typeof value.mapWriter.total !== "number") return false;
	if (value.confidence !== undefined && (!object(value.confidence) || !Array.isArray(value.confidence.reasons))) return false;
	return value.structureWriter === undefined || (object(value.structureWriter) && typeof value.structureWriter.status === "string");
}

function readJson(target: string): unknown | null {
	let text: string;
	try {
		text = fs.readFileSync(/* turbopackIgnore: true */ target, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		return JSON.parse(text);
	} catch {
		throw damaged();
	}
}

/** The record, null when the book doesn't exist. Throws BookUnreadableError
 *  for a damaged or newer record. */
function get(bookId: string): BookRecord | null {
	const parsed = readJson(file(bookId, RECORD));
	if (parsed === null) return null;
	if (!object(parsed)) throw damaged();
	const version = parsed.version === undefined ? 1 : parsed.version;
	if (typeof version === "number" && version > CURRENT_BOOK_VERSION) throw new BookUnreadableError("This book was saved by a newer version of the app.");
	if (version !== CURRENT_BOOK_VERSION || !readableRecord(parsed, bookId)) throw damaged();
	return parsed as unknown as BookRecord;
}

function write(record: BookRecord): BookRecord {
	const stamped = { ...record, version: CURRENT_BOOK_VERSION };
	fs.mkdirSync(bookDir(record.id), { recursive: true });
	writeFileAtomicSync(file(record.id, RECORD), JSON.stringify(stamped, null, "\t"));
	emit("books-changed", { bookId: record.id });
	return stamped;
}

/** Create the folder with the original file first, then the record. */
function create(record: BookRecord, original: Uint8Array): BookRecord {
	safeId(record.id);
	if (fs.existsSync(file(record.id, RECORD))) throw new Error(`Book already exists: ${record.id}`);
	fs.mkdirSync(bookDir(record.id), { recursive: true });
	writeFileAtomicSync(originalFile(record.id, record.format), original);
	return write(record);
}

/** Every readable book, newest first, plus folders whose record can't be read. */
function list(): { books: BookRecord[]; unreadable: string[] } {
	let names: string[];
	try {
		names = fs.readdirSync(/* turbopackIgnore: true */ PATHS.books);
	} catch {
		return { books: [], unreadable: [] };
	}
	const books: BookRecord[] = [];
	const unreadable: string[] = [];
	for (const name of names) {
		if (!SAFE_ID.test(name)) continue;
		try {
			const record = get(name);
			if (record) books.push(record);
		} catch (error) {
			if (!(error instanceof BookUnreadableError)) console.error(`[books] could not read ${name}:`, error);
			unreadable.push(name);
		}
	}
	books.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
	return { books, unreadable };
}

/** Read-modify-write; updatedAt is stamped here. Null when the book doesn't exist. */
function update(bookId: string, change: (record: BookRecord) => BookRecord): BookRecord | null {
	const record = get(bookId);
	if (!record) return null;
	const next = change(record);
	return write({ ...next, id: record.id, updatedAt: new Date().toISOString() });
}

function readOriginal(record: Pick<BookRecord, "id" | "format">): Uint8Array {
	return fs.readFileSync(/* turbopackIgnore: true */ originalFile(record.id, record.format));
}

/** A data file (text, map, candidates): null when absent, refused when
 *  damaged or newer. */
function readData<T extends { version: number }>(bookId: string, name: string, check: (value: Record<string, unknown>) => boolean): T | null {
	const parsed = readJson(file(bookId, name));
	if (parsed === null) return null;
	if (!object(parsed) || typeof parsed.version !== "number") throw damaged();
	if (parsed.version > CURRENT_BOOK_DATA_VERSION) throw new BookUnreadableError("This book was saved by a newer version of the app.");
	if (!check(parsed)) throw damaged();
	return parsed as unknown as T;
}

const readText = (bookId: string) => readData<BookText>(bookId, TEXT, (value) => Array.isArray(value.blocks)
	&& value.blocks.every((block) => object(block) && typeof block.id === "number" && typeof block.text === "string" && (block.kind === "heading" || block.kind === "paragraph")));
const nodesReadable = (nodes: unknown) => Array.isArray(nodes) && nodes.every((node) => object(node)
	&& ["id", "label", "title", "kind"].every((key) => typeof node[key] === "string")
	&& ["level", "firstBlock", "lastBlock"].every((key) => typeof node[key] === "number"));
const readMap = (bookId: string) => readData<BookMap>(bookId, MAP, (value) => nodesReadable(value.nodes));
const readCandidates = (bookId: string) => readData<BookCandidates>(bookId, CANDIDATES, (value) => Array.isArray(value.candidates)
	&& value.candidates.every((candidate) => object(candidate) && typeof candidate.method === "string" && nodesReadable(candidate.nodes)));

function writeData(bookId: string, name: string, value: object): void {
	fs.mkdirSync(bookDir(bookId), { recursive: true });
	writeFileAtomicSync(file(bookId, name), JSON.stringify({ ...value, version: CURRENT_BOOK_DATA_VERSION }));
}

const writeText = (bookId: string, text: Omit<BookText, "version">) => writeData(bookId, TEXT, text);
const writeCandidates = (bookId: string, candidates: Omit<BookCandidates, "version">) => writeData(bookId, CANDIDATES, candidates);
/** The map changes the record's view (sections, summaries): emit too. */
function writeMap(bookId: string, map: Omit<BookMap, "version">): void {
	writeData(bookId, MAP, map);
	emit("books-changed", { bookId });
}

/** Remove a book's whole folder, the record last, so an interrupted removal
 *  still lists the book and Delete can run again. */
function remove(bookId: string): boolean {
	const dir = bookDir(bookId);
	if (!fs.existsSync(dir)) return false;
	for (const name of fs.readdirSync(dir)) {
		if (name !== RECORD) fs.rmSync(path.join(/* turbopackIgnore: true */ dir, name), { recursive: true, force: true });
	}
	fs.rmSync(dir, { recursive: true, force: true });
	emit("books-changed", { bookId });
	return true;
}

export const bookStore = { create, get, list, update, remove, readOriginal, readText, writeText, readMap, writeMap, readCandidates, writeCandidates };
export type BookStore = typeof bookStore;
