/**
 * Reading a library book (fork plan 05, item 3): windows of its stored text
 * for the reader, and search. The text is never rewritten after import, so
 * a book's search form is computed once and kept for the few books read
 * most recently; deleting a book forgets it.
 */
import {
	bookTextWindow,
	searchableBlocks,
	searchBookBlocks,
	type BookSearchResult,
	type BookWindowRequest,
} from "../core/book.ts";
import type { BookBlock, BookNode } from "../core/contracts.ts";
import type { BookToolSource } from "../agent/tools/book.ts";
import { bookStore, BookUnreadableError } from "../store/books.ts";

type Refusal = { ok: false; status: number; error: string };
const refusal = (status: number, error: string): Refusal => ({ ok: false, status, error });

export const BOOK_NOT_READABLE_YET = "This book's text isn't ready yet.";
/** The search limit per request; `total` still counts every match. */
export const BOOK_SEARCH_LIMIT = 100;

interface ReadableBook { blocks: BookBlock[]; nodes: BookNode[] }

/** The text and map of a finished import, or why there are none. */
function readable(bookId: string): ReadableBook | Refusal {
	try {
		const record = bookStore.get(bookId);
		if (!record) return refusal(404, "Unknown book");
		if (record.import.status !== "ready" && record.import.status !== "review") return refusal(409, BOOK_NOT_READABLE_YET);
		const text = bookStore.readText(bookId);
		if (!text) return refusal(409, BOOK_NOT_READABLE_YET);
		return { blocks: text.blocks, nodes: bookStore.readMap(bookId)?.nodes ?? [] };
	} catch (error) {
		if (error instanceof BookUnreadableError) return refusal(409, error.message);
		if (error instanceof Error && error.message.startsWith("Invalid book id")) return refusal(404, "Unknown book");
		throw error;
	}
}

export interface BookTextWindow {
	/** Inclusive block indexes; `to < from` when the window is empty. */
	from: number;
	to: number;
	/** Blocks in the whole book. */
	total: number;
	blocks: BookBlock[];
}

/**
 * A window of the text: `around` a node or `at` a block (starting a few
 * blocks above it, and always holding it), `from` a block forward, or
 * `before` a block backward.
 */
export function bookTextWindowOf(bookId: string, request: { around?: string; at?: number; from?: number; before?: number }): BookTextWindow | Refusal {
	const book = readable(bookId);
	if ("ok" in book) return book;
	let window: BookWindowRequest;
	if (request.around !== undefined) {
		const node = book.nodes.find((candidate) => candidate.id === request.around);
		if (!node) return refusal(404, `No section has the id "${request.around}".`);
		window = { around: node.firstBlock };
	} else if (request.at !== undefined) window = { around: request.at };
	else if (request.from !== undefined) window = { from: request.from };
	else if (request.before !== undefined) window = { before: request.before };
	else window = { from: 0 };
	const { from, to } = bookTextWindow(book.blocks, window);
	return { from, to, total: book.blocks.length, blocks: book.blocks.slice(from, to + 1) };
}

interface SearchCacheGlobal { __lhBookSearchCache?: Map<string, { searchable: string[] }> }
const CACHED_BOOKS = 3;

function searchCache() {
	const global = globalThis as typeof globalThis & SearchCacheGlobal;
	return global.__lhBookSearchCache ??= new Map();
}

/** A book's search form, computed once (most recently used last). An
 *  import that reconverts the text forgets the old one first. */
function searchable(bookId: string, blocks: BookBlock[]): string[] {
	const cache = searchCache();
	const hit = cache.get(bookId);
	if (hit && hit.searchable.length === blocks.length) {
		cache.delete(bookId);
		cache.set(bookId, hit);
		return hit.searchable;
	}
	const entry = { searchable: searchableBlocks(blocks) };
	cache.set(bookId, entry);
	while (cache.size > CACHED_BOOKS) cache.delete(cache.keys().next().value!);
	return entry.searchable;
}

export function forgetSearchableBook(bookId: string): void {
	searchCache().delete(bookId);
}

/** Search a book's text (case- and accent-insensitive, as one phrase). */
export function searchBook(bookId: string, query: string, limit = BOOK_SEARCH_LIMIT): BookSearchResult | Refusal {
	const book = readable(bookId);
	if ("ok" in book) return book;
	return searchBookBlocks(book.blocks, searchable(bookId, book.blocks), book.nodes, query, limit);
}

/** The book tools' source for one turn (item 4): the text and map read on
 *  the first call and kept for the turn; search uses the cached form. */
export function bookToolSource(bookId: string): BookToolSource {
	let loaded: ReturnType<BookToolSource["load"]> | undefined;
	return {
		load: () => loaded ??= (() => {
			const book = readable(bookId);
			if ("ok" in book) return { error: book.error };
			return { nodes: book.nodes, blocks: book.blocks, searchable: () => searchable(bookId, book.blocks) };
		})(),
	};
}
