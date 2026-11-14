/**
 * The books library service (fork plan 05). Importing stores the original
 * file at once and converts it in the background; the contents are always
 * found without a model (src/core/book.ts):
 *
 * - confident contents are accepted at once (`contentsAccepted: "auto"`);
 * - unsure ones leave the import in "review" until the learner accepts the
 *   shown structure or switches to another candidate;
 * - a broken file is refused with the reason, before or during conversion.
 *
 * Accepting contents starts the map writer (item 2, src/server/
 * book-maps.ts) unless the book is short; switching them discards a
 * running writer and starts again on the new map. An import left
 * "importing" by a closed app reads as interrupted, and Try again
 * reconverts the stored original; a writer left "writing" reads as
 * interrupted too, and its Try again continues with what's left.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import {
	chooseCandidate,
	SHORT_BOOK_WORDS,
	structureCandidates,
	structureDigest,
	wordCount,
} from "../core/book.ts";
import type { BookBlock, BookCandidate, BookMap, BookRecord, BookSummary } from "../core/contracts.ts";
import { emit } from "../core/events.ts";
import { modelsNotConfigured } from "../core/settings.ts";
import { prepareStructurePass, type PreparedStructurePass } from "../agent/subagents/book-mapper.ts";
import type { PiEngine } from "../agent/models.ts";
import { bookStore, BookUnreadableError, newBookId } from "../store/books.ts";
import { BOOK_REFUSALS, BookImportRefusal, bookFormat, convertBook, MAX_BOOK_BYTES, probeBook } from "./book-import.ts";
import {
	bookMapperEngine,
	bookMapperModel,
	discardBookWriters,
	interruptedWriters,
	isBookWriterRunning,
	startBookContentsWriter,
	startBookMapWriter,
} from "./book-maps.ts";

export { BookUnreadableError } from "../store/books.ts";
export { MAX_BOOK_BYTES } from "./book-import.ts";

export type BookRefusal = { ok: false; status: number; error: string; existing?: { id: string; title: string } };

const refusal = (status: number, error: string, extra: Partial<BookRefusal> = {}): BookRefusal => ({ ok: false, status, error, ...extra });
export const isBookRefusal = (value: unknown): value is BookRefusal => typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;

export const BOOK_INTERRUPTED = "The import was interrupted.";
export const BOOK_IMPORT_FAILED = "The import failed. Try again.";

/** Seams: accepted contents start the map writer; tests observe it. */
export const bookServiceSeams = {
	contentsAccepted: (bookId: string): void => {
		// The contents are accepted either way; a writer that can't start
		// shows as failed on the book, or is retried with Try again.
		try { startBookMapWriter(bookId); }
		catch (error) { console.error(`[books] could not start the map writer of ${bookId}:`, error); }
	},
};

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

interface RunningImport { done: number; total: number; lastEmit: number }
interface BooksGlobal { __lhRunningBookImports?: Map<string, RunningImport> }
function running(): Map<string, RunningImport> {
	const global = globalThis as typeof globalThis & BooksGlobal;
	return global.__lhRunningBookImports ??= new Map();
}

export function isImportRunning(bookId: string): boolean {
	return running().has(bookId);
}

/** Read a record, mapping storage refusals to responses. */
function readRecord(bookId: string): BookRecord | BookRefusal {
	try {
		const record = bookStore.get(bookId);
		return record ? settleInterrupted(record) : refusal(404, "Unknown book");
	} catch (error) {
		if (error instanceof BookUnreadableError) return refusal(409, error.message);
		if (error instanceof Error && error.message.startsWith("Invalid book id")) return refusal(404, "Unknown book");
		throw error;
	}
}

/** An import or a writer left running by a closed app: none runs for it
 *  here, so it reads as interrupted. */
function settleInterrupted(record: BookRecord): BookRecord {
	const importStale = record.import.status === "importing" && !isImportRunning(record.id);
	if (!importStale && !interruptedWriters(record)) return record;
	return bookStore.update(record.id, (current) => ({
		...current,
		...(current.import.status === "importing" && !isImportRunning(current.id) ? { import: { status: "failed", error: BOOK_INTERRUPTED } } : {}),
		...interruptedWriters(current),
	})) ?? record;
}

/** The map writer's starting state once the contents are accepted. */
function mapWriterAfterAcceptance(words: number): BookRecord["mapWriter"] {
	return words < SHORT_BOOK_WORDS ? { status: "not-needed", done: 0, total: 0 } : { status: "waiting", done: 0, total: 0 };
}

function convert(record: BookRecord): void {
	const entry: RunningImport = { done: 0, total: record.pageCount ?? 0, lastEmit: 0 };
	running().set(record.id, entry);
	const provisionalTitle = record.title;
	void (async () => {
		try {
			const bytes = bookStore.readOriginal(record);
			const converted = await convertBook(record.format, bytes, {
				onProgress: (done, total) => {
					entry.done = done;
					entry.total = total;
					const now = Date.now();
					if (now - entry.lastEmit > 500) {
						entry.lastEmit = now;
						emit("books-changed", { bookId: record.id });
					}
				},
			});
			// Yields between the whole-book steps keep the server responsive
			// (the plan's performance check).
			await yieldToEventLoop();
			const candidates = structureCandidates({ format: record.format, blocks: converted.blocks, ...(converted.outline ? { outline: converted.outline } : {}) });
			const chosen = chooseCandidate(candidates);
			if (!chosen) throw new BookImportRefusal(BOOK_REFUSALS.empty);
			const words = converted.blocks.reduce((sum, block) => sum + wordCount(block.text), 0);
			await yieldToEventLoop();
			bookStore.writeText(record.id, { blocks: converted.blocks });
			await yieldToEventLoop();
			bookStore.writeCandidates(record.id, { candidates });
			bookStore.writeMap(record.id, { nodes: chosen.nodes });
			const confident = chosen.confidence.level === "confident";
			bookStore.update(record.id, (current) => ({
				...current,
				...(converted.title && current.title === provisionalTitle ? { title: converted.title } : {}),
				...(converted.author && current.author === undefined ? { author: converted.author } : {}),
				...(converted.pageCount !== undefined ? { pageCount: converted.pageCount } : {}),
				words,
				structure: chosen.method,
				confidence: chosen.confidence,
				...(confident ? { contentsAccepted: "auto" as const } : {}),
				import: { status: confident ? "ready" : "review", ...(converted.notice ? { notice: converted.notice } : {}) },
				mapWriter: confident ? mapWriterAfterAcceptance(words) : { status: "waiting", done: 0, total: 0 },
			}));
			if (confident) bookServiceSeams.contentsAccepted(record.id);
		} catch (error) {
			const message = error instanceof BookImportRefusal ? error.message : BOOK_IMPORT_FAILED;
			if (!(error instanceof BookImportRefusal)) console.error(`[books] import of ${record.id} failed:`, error);
			try {
				bookStore.update(record.id, (current) => ({ ...current, import: { status: "failed", error: message } }));
			} catch (storeError) {
				console.error(`[books] could not record the import failure of ${record.id}:`, storeError);
			}
		} finally {
			running().delete(record.id);
		}
	})();
}

/**
 * Import one file: refusals that need no conversion (type, size, a
 * duplicate, an unreadable or protected file, too many pages) answer at
 * once and create nothing. Otherwise the record is created, the original
 * stored, and conversion runs in the background.
 */
export async function importBook(fileName: string, bytes: Uint8Array): Promise<{ ok: true; book: BookRecord } | BookRefusal> {
	if (bytes.length > MAX_BOOK_BYTES) return refusal(413, BOOK_REFUSALS.tooBig);
	if (bytes.length === 0) return refusal(400, BOOK_REFUSALS.empty);
	let format: BookRecord["format"];
	let probe: { pageCount?: number };
	try {
		format = bookFormat(fileName, bytes);
		probe = await probeBook(format, bytes);
	} catch (error) {
		if (error instanceof BookImportRefusal) return refusal(400, error.message);
		throw error;
	}
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const existing = bookStore.list().books.find((book) => book.sha256 === sha256);
	if (existing) return refusal(409, `This book is already in your library: ${existing.title}.`, { existing: { id: existing.id, title: existing.title } });
	const now = new Date().toISOString();
	const stem = path.basename(fileName, path.extname(fileName)).trim() || "Untitled book";
	const record = bookStore.create({
		id: newBookId(),
		title: stem,
		format,
		fileName: path.basename(fileName),
		sha256,
		bytes: bytes.length,
		importedAt: now,
		updatedAt: now,
		...(probe.pageCount !== undefined ? { pageCount: probe.pageCount } : {}),
		import: { status: "importing" },
		mapWriter: { status: "waiting", done: 0, total: 0 },
	}, bytes);
	convert(record);
	return { ok: true, book: record };
}

/** Reconvert a failed import from its stored original. */
export function retryBookImport(bookId: string): { ok: true; book: BookRecord } | BookRefusal {
	const record = readRecord(bookId);
	if (isBookRefusal(record)) return record;
	if (record.import.status !== "failed") return refusal(409, "This book's import hasn't failed.");
	const next = bookStore.update(bookId, (current) => ({ ...current, import: { status: "importing" } }));
	if (!next) return refusal(404, "Unknown book");
	convert(next);
	return { ok: true, book: next };
}

function sectionCount(bookId: string): number | undefined {
	try { return bookStore.readMap(bookId)?.nodes.length; }
	catch { return undefined; }
}

export interface BookImportProgress { done: number; total: number }

function summaryOf(record: BookRecord): BookSummary & { progress?: BookImportProgress } {
	const progress = running().get(record.id);
	const sections = record.import.status === "ready" || record.import.status === "review" ? sectionCount(record.id) : undefined;
	return {
		id: record.id,
		title: record.title,
		...(record.author ? { author: record.author } : {}),
		format: record.format,
		importedAt: record.importedAt,
		...(record.pageCount !== undefined ? { pageCount: record.pageCount } : {}),
		...(record.words !== undefined ? { words: record.words } : {}),
		...(sections !== undefined ? { sections } : {}),
		...(record.structure ? { structure: record.structure } : {}),
		...(record.confidence ? { confidence: record.confidence } : {}),
		...(record.contentsAccepted ? { contentsAccepted: record.contentsAccepted } : {}),
		import: record.import,
		mapWriter: record.mapWriter,
		...(progress ? { progress: { done: progress.done, total: progress.total } } : {}),
	};
}

/** The library: every readable book, newest first. */
export function listBooks(): { books: ReturnType<typeof summaryOf>[]; unreadable: string[] } {
	const { books, unreadable } = bookStore.list();
	return { books: books.map((book) => summaryOf(settleInterrupted(book))), unreadable };
}

/** One book with its current map (absent until the import finishes). */
export function readBook(bookId: string): { book: ReturnType<typeof summaryOf> & Pick<BookRecord, "fileName" | "bytes" | "updatedAt" | "structureWriter">; map: BookMap | null } | BookRefusal {
	const record = readRecord(bookId);
	if (isBookRefusal(record)) return record;
	let map: BookMap | null = null;
	try { map = bookStore.readMap(bookId); }
	catch (error) { if (error instanceof BookUnreadableError) return refusal(409, error.message); throw error; }
	return {
		book: { ...summaryOf(record), fileName: record.fileName, bytes: record.bytes, updatedAt: record.updatedAt, ...(record.structureWriter ? { structureWriter: record.structureWriter } : {}) },
		map,
	};
}

/** Rename: the title (required non-empty when given) and the author ("" clears). */
export function renameBook(bookId: string, input: { title?: unknown; author?: unknown }): BookRecord | BookRefusal {
	const record = readRecord(bookId);
	if (isBookRefusal(record)) return record;
	if (input.title === undefined && input.author === undefined) return refusal(400, "Give a title or an author.");
	if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim())) return refusal(400, "The title can't be empty.");
	if (input.author !== undefined && typeof input.author !== "string") return refusal(400, "Invalid author");
	const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim().slice(0, 300) : undefined;
	const author = typeof input.author === "string" ? input.author.replace(/\s+/g, " ").trim().slice(0, 300) : undefined;
	return bookStore.update(bookId, (current) => {
		const next = { ...current, ...(title ? { title } : {}) };
		if (author !== undefined) {
			if (author) next.author = author;
			else delete next.author;
		}
		return next;
	}) ?? refusal(404, "Unknown book");
}

/** The structures the import found, for "Check the contents". */
export function bookContents(bookId: string): { current: BookRecord["structure"]; candidates: BookCandidate[] } | BookRefusal {
	const record = readRecord(bookId);
	if (isBookRefusal(record)) return record;
	if (record.import.status !== "ready" && record.import.status !== "review") return refusal(409, "This book's import hasn't finished.");
	try {
		return { current: record.structure, candidates: bookStore.readCandidates(bookId)?.candidates ?? [] };
	} catch (error) {
		if (error instanceof BookUnreadableError) return refusal(409, error.message);
		throw error;
	}
}

/** Summaries are not contents: accepting an unchanged model candidate
 *  must retain the summaries already written for it. */
function sameContents(a: BookMap["nodes"], b: BookMap["nodes"]): boolean {
	return a.length === b.length && a.every((node, i) => {
		const other = b[i]!;
		return node.id === other.id && node.parentId === other.parentId
			&& node.label === other.label && node.title === other.title
			&& node.kind === other.kind && node.level === other.level
			&& node.firstBlock === other.firstBlock && node.lastBlock === other.lastBlock
			&& node.pages?.from === other.pages?.from && node.pages?.to === other.pages?.to;
	});
}

/**
 * The learner's "Looks right" (no method: accept the shown contents) or
 * "Use these" (a method: switch to that candidate and accept it). Starts
 * the map writer unless the book is short.
 */
export function acceptBookContents(bookId: string, method?: unknown): BookRecord | BookRefusal {
	const record = readRecord(bookId);
	if (isBookRefusal(record)) return record;
	if (record.import.status !== "ready" && record.import.status !== "review") return refusal(409, "This book's import hasn't finished.");
	if (method !== undefined && typeof method !== "string") return refusal(400, "Invalid method");
	// Acceptance must honor the same map version/damage guard as a read,
	// including when switching would otherwise replace an unreadable map.
	let map: BookMap | null;
	try { map = bookStore.readMap(bookId); }
	catch (error) { if (error instanceof BookUnreadableError) return refusal(409, error.message); throw error; }
	let chosen: BookCandidate | undefined;
	if (method !== undefined && (method !== record.structure || method === "model")) {
		let candidate: BookCandidate | undefined;
		try { candidate = bookStore.readCandidates(bookId)?.candidates.find((entry) => entry.method === method); }
		catch (error) { if (error instanceof BookUnreadableError) return refusal(409, error.message); throw error; }
		if (!candidate) return refusal(400, "This book has no such contents.");
		if (method !== record.structure || !map || !sameContents(map.nodes, candidate.nodes)) {
			chosen = candidate;
			// A new pass can replace the model candidate without changing
			// its method. Its old writer belongs to the old map either way.
			discardBookWriters(bookId, ["map"]);
			bookStore.writeMap(bookId, { nodes: chosen.nodes });
		}
	}
	const words = record.words ?? 0;
	const next = bookStore.update(bookId, (current) => ({
		...current,
		...(chosen ? { structure: chosen.method, confidence: chosen.confidence } : {}),
		contentsAccepted: "learner",
		import: { ...current.import, status: "ready" },
		// A switch restarts the summaries; accepting what's shown keeps them.
		mapWriter: chosen || current.mapWriter.status === "waiting" ? mapWriterAfterAcceptance(words) : current.mapWriter,
	}));
	if (!next) return refusal(404, "Unknown book");
	if (chosen || record.mapWriter.status === "waiting") bookServiceSeams.contentsAccepted(bookId);
	return next;
}

/** "Try again" for the map writer: continues with the sections left. */
export function retryBookMapWriter(bookId: string): BookRecord | BookRefusal {
	const record = readRecord(bookId);
	if (isBookRefusal(record)) return record;
	if (record.import.status !== "ready" || !record.contentsAccepted) return refusal(409, "Accept the book's contents first.");
	if (isBookWriterRunning(bookId, "map")) return refusal(409, "The map is already being written.");
	if (record.mapWriter.status === "ready") return refusal(409, "The map is already written.");
	if (record.mapWriter.status === "not-needed") return refusal(409, "This book is short: it needs no map.");
	let engine;
	try { engine = bookMapperEngine(); }
	catch (error) { return refusal(503, error instanceof Error ? error.message : String(error)); }
	if (!engine) return refusal(503, modelsNotConfigured(["cheap"]).error);
	try {
		return startBookMapWriter(bookId, engine) ?? refusal(404, "Unknown book");
	} catch (error) {
		if (error instanceof BookUnreadableError) return refusal(409, error.message);
		throw error;
	}
}

const NO_HEADING_LINES = "This book has no lines that look like headings.";

/** The contents pass's digest, when the book can have one. */
interface ContentsPassInput extends PreparedStructurePass {
	record: BookRecord;
	blocks: BookBlock[];
	engine: PiEngine | undefined;
}

function contentsPassInput(bookId: string): ContentsPassInput | BookRefusal {
	const record = readRecord(bookId);
	if (isBookRefusal(record)) return record;
	if (record.import.status !== "ready" && record.import.status !== "review") return refusal(409, "This book's import hasn't finished.");
	let text;
	try { text = bookStore.readText(bookId); }
	catch (error) { if (error instanceof BookUnreadableError) return refusal(409, error.message); throw error; }
	if (!text) return refusal(409, "This book's text can't be read.");
	let engine;
	try {
		engine = bookMapperEngine();
		const prepared = prepareStructurePass({
			bookTitle: record.title,
			...(record.author ? { author: record.author } : {}),
			blocks: text.blocks.length,
			digest: structureDigest(text.blocks),
			engine,
		});
		if (prepared.digest.lines.length === 0) return refusal(409, NO_HEADING_LINES);
		return { record, blocks: text.blocks, engine, ...prepared };
	} catch (error) {
		return refusal(503, error instanceof Error ? error.message : String(error));
	}
}

/** What the contents pass would cost: "about <n>k tokens on <model>". */
export function bookContentsPassEstimate(bookId: string): { tokens: number; lines: number; model: { provider: string; id: string } | null } | BookRefusal {
	const input = contentsPassInput(bookId);
	if (isBookRefusal(input)) return input;
	return { tokens: input.tokens, lines: input.digest.lines.length, model: bookMapperModel() };
}

/** The learner's "Find the contents with the model": its result becomes
 *  the `model` candidate, reviewed like any other. */
export function runBookContentsPass(bookId: string): BookRecord | BookRefusal {
	const input = contentsPassInput(bookId);
	if (isBookRefusal(input)) return input;
	if (isBookWriterRunning(bookId, "contents")) return refusal(409, "The contents are already being found.");
	if (!input.engine) return refusal(503, modelsNotConfigured(["cheap"]).error);
	try {
		return startBookContentsWriter(input.record, input.engine, input) ?? refusal(404, "Unknown book");
	} catch (error) {
		if (error instanceof BookUnreadableError) return refusal(409, error.message);
		throw error;
	}
}
