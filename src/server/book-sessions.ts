/**
 * A session's book (fork plan 05, item 4). A standalone Teach session and
 * a course setup carry their own `book`; a unit session (and a unit's
 * practice session) takes its course's. This module resolves it, composes
 * the turn's book parts and tool source, gives the chip its view, and
 * checks a book can be attached when a session starts.
 */
import { bookPromptParts, bookUnreadableParts } from "../core/book-prompt.ts";
import type { BookRange, BookRecord, ChatBookLink, ChatRecord, SessionBookView } from "../core/contracts.ts";
import type { AgentBuildOptions } from "../agent/teacher-agent.ts";
import { bookStore, BookUnreadableError } from "../store/books.ts";
import { bookToolSource } from "./book-reading.ts";
import { isCourseRefusal, readCourse } from "./courses.ts";
import type { BookRefusal } from "./books.ts";

export interface SessionBook {
	bookId: string;
	/** Absent for a standalone Teach session. */
	mode?: "follow" | "reference";
	/** A unit of a followed book: the unit's reading. */
	reading?: BookRange[];
}

/** The session's book, or undefined when it has none. A unit session that
 *  doesn't hold its unit (a crash's duplicate) has none, as it has no course
 *  section. */
export function sessionBook(record: ChatRecord): SessionBook | undefined {
	const link = record.course;
	if (link?.role === "unit" || link?.role === "practice") {
		const course = readCourse(link.courseId);
		if (isCourseRefusal(course) || !course.book) return undefined;
		const unit = course.units.find((candidate) => candidate.id === link.unitId);
		if (!unit || (link.role === "unit" && unit.chatId !== record.id)) return undefined;
		const reading = course.book.mode === "follow" && unit.reading?.length ? unit.reading : undefined;
		return { bookId: course.book.bookId, mode: course.book.mode, ...(reading ? { reading } : {}) };
	}
	if (record.book) return { bookId: record.book.bookId, ...(record.book.mode ? { mode: record.book.mode } : {}) };
	return undefined;
}

type ReadBook = { ok: true; book: BookRecord } | { ok: false; reason: string };

function readBookRecord(bookId: string): ReadBook {
	try {
		const book = bookStore.get(bookId);
		return book ? { ok: true, book } : { ok: false, reason: "It is no longer in the library." };
	} catch (error) {
		if (error instanceof BookUnreadableError) return { ok: false, reason: error.message };
		if (error instanceof Error && error.message.startsWith("Invalid book id")) return { ok: false, reason: "It is no longer in the library." };
		throw error;
	}
}

/** This turn's book for the agent: the section's parts, and the tools'
 *  source when the book can be read. Read fresh each turn, so summaries
 *  written meanwhile join the outline. */
export function sessionBookTurn(record: ChatRecord): NonNullable<AgentBuildOptions["book"]> | undefined {
	const link = sessionBook(record);
	if (!link) return undefined;
	const read = readBookRecord(link.bookId);
	if (!read.ok) return { parts: bookUnreadableParts(link.bookId, read.reason) };
	const { book } = read;
	if (book.import.status !== "ready") return { parts: bookUnreadableParts(book.title, "Its import isn't finished.") };
	try {
		const map = bookStore.readMap(book.id);
		if (!map) return { parts: bookUnreadableParts(book.title, "Its map can't be read.") };
		return { parts: bookPromptParts(book, map.nodes, link.reading), source: bookToolSource(book.id) };
	} catch (error) {
		if (error instanceof BookUnreadableError) return { parts: bookUnreadableParts(book.title, error.message) };
		throw error;
	}
}

/** The chip's view of the session's book; the title falls back to "Book"
 *  when the record can't be read (its page says why). */
export function sessionBookView(record: ChatRecord): SessionBookView | undefined {
	const link = sessionBook(record);
	if (!link) return undefined;
	const read = readBookRecord(link.bookId);
	return { bookId: link.bookId, title: read.ok ? read.book.title : "Book" };
}

/** A course's book chip, from its record. */
export function courseBookView(book: { bookId: string } | undefined): SessionBookView | undefined {
	if (!book) return undefined;
	const read = readBookRecord(book.bookId);
	return { bookId: book.bookId, title: read.ok ? read.book.title : "Book" };
}

export const BOOK_CHECK_CONTENTS_FIRST = "Check this book's contents first.";
export const BOOK_NOT_IMPORTED = "This book's import isn't finished.";
export const BOOK_GONE = "This book is no longer in the library.";

/**
 * The book a new session asks for, checked (decision 5 and item 3: only a
 * book whose import is ready, its contents accepted). `setup` sessions keep
 * the follow/reference mode, "follow" when none is given.
 */
export function bookLinkForNewSession(raw: unknown, setup: boolean): { ok: true; link: ChatBookLink } | BookRefusal {
	const body = raw && typeof raw === "object" ? raw as { bookId?: unknown; mode?: unknown } : {};
	if (typeof body.bookId !== "string" || !body.bookId) return { ok: false, status: 400, error: "Invalid book" };
	if (body.mode !== undefined && body.mode !== "follow" && body.mode !== "reference") return { ok: false, status: 400, error: "Invalid book mode" };
	const read = readBookRecord(body.bookId);
	if (!read.ok) return read.reason === "It is no longer in the library."
		? { ok: false, status: 404, error: BOOK_GONE }
		: { ok: false, status: 409, error: read.reason };
	if (read.book.import.status === "review") return { ok: false, status: 409, error: BOOK_CHECK_CONTENTS_FIRST };
	if (read.book.import.status !== "ready") return { ok: false, status: 409, error: BOOK_NOT_IMPORTED };
	return { ok: true, link: setup ? { bookId: read.book.id, mode: body.mode === "reference" ? "reference" : "follow" } : { bookId: read.book.id } };
}
