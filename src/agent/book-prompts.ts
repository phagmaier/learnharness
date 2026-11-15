/**
 * The book prompts (fork plan 05, item 4), fixed in code like the course
 * prompts: not Settings → Prompts segments, no overrides. The doctrine, the
 * additions and the tool descriptions are the plan's approved text; the rest
 * of the section (core/book-prompt.ts) is the human's approved wording.
 *
 * - BOOK_DOCTRINE: opens a session's book section, for the prober, the
 *   teacher and the setup agent. Its second paragraph, on quoting with
 *   `quote_passage`, arrives with that tool in item 5.
 * - PROBER_BOOK_ADDITION: the prober of any session with a book.
 * - TEACHER_UNIT_READING_ADDITION: a unit teacher whose course follows its
 *   book, before the unit's reading.
 */
import type { BookPromptParts } from "../core/book-prompt.ts";

export const BOOK_DOCTRINE = `# The learner's book

This session studies a book from the learner's library. The outline below shows its structure; open any part with \`book_map\`, read exact text with \`read_section\`, and find passages with \`search_book\`. Never rely on memory of the book: read before you state what it says.`;

export const PROBER_BOOK_ADDITION = "For a session with a book, probe what the book demands of a reader at this point: its terms, and the background it assumes.";

export const TEACHER_UNIT_READING_ADDITION = "This unit reads the range below. Plan from its text: read it before plan_init, and let the plan follow its argument.";

export const BOOK_MAP_DESCRIPTION = "Show the book's map under a location: titles, one-line summaries and key terms.";
export const READ_SECTION_DESCRIPTION = "Read the exact text of a location in the book (a section, a numbered paragraph, or pages).";
export const SEARCH_BOOK_DESCRIPTION = "Search the book's text for a word or phrase; returns locations with snippets.";

/** The agents that read the session's book in item 4. */
export type BookReadingAgent = "prober" | "teacher" | "setup";

/** A turn's book section for the agent, or null when it gets none (the
 *  practitioner, until item 7). */
export function bookPromptSection(kind: BookReadingAgent | "practice", parts: BookPromptParts): string | null {
	if (kind === "practice") return null;
	if ("unreadable" in parts) return parts.unreadable;
	return [
		BOOK_DOCTRINE,
		...(kind === "prober" ? [PROBER_BOOK_ADDITION] : []),
		parts.book,
		...(parts.reading ? [
			parts.reading.heading,
			...(kind === "teacher" ? [TEACHER_UNIT_READING_ADDITION] : []),
			parts.reading.detail,
		] : []),
	].join("\n\n");
}
