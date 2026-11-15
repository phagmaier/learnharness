import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { bookMapText, readSectionText, searchBookText, type BookToolText } from "../../core/book-prompt.ts";
import type { BookBlock, BookNode } from "../../core/contracts.ts";
import { BOOK_MAP_DESCRIPTION, READ_SECTION_DESCRIPTION, SEARCH_BOOK_DESCRIPTION } from "../book-prompts.ts";
import { healToolRecord } from "./heal.ts";

/**
 * The book retrieval tools (fork plan 05, item 4): book_map, read_section
 * and search_book, for the prober, teacher and setup agent of a session
 * with a book. Server-side and non-terminating. They read the library
 * through the server's source by book id and never take paths; a refusal
 * (an unknown location, an empty query) goes back to the model to fix.
 */

/** What the tools read: loaded on first use within a turn. */
export interface BookToolSource {
	load(): { nodes: readonly BookNode[]; blocks: readonly BookBlock[]; searchable: () => readonly string[] } | { error: string };
}

export const BOOK_TOOL_NAMES = ["book_map", "read_section", "search_book"] as const;

const bookMapInput = Type.Object({
	at: Type.Optional(Type.String({ description: "A section or range from the outline, by id or label (\"n12\", \"§187\", \"IV.A\", \"§178–§196\"). Leave out for the whole book." })),
});
const readSectionInput = Type.Object({
	at: Type.String({ minLength: 1, description: "Where to read: a section's id or label, a range (\"§178–§196\"), or pages (\"pp. 114–116\")." }),
});
const searchBookInput = Type.Object({
	query: Type.String({ minLength: 1, description: "A word or phrase, matched case- and accent-insensitively." }),
});

function result(tool: string, answer: BookToolText) {
	return {
		content: [{ type: "text" as const, text: answer.text }],
		...(answer.error ? { isError: true } : {}),
		details: answer.error ? { tool, error: answer.text } : { tool },
	};
}

export function bookTools(source: BookToolSource): Record<string, AgentTool<any>> {
	const withBook = (tool: string, read: (book: Exclude<ReturnType<BookToolSource["load"]>, { error: string }>) => BookToolText) => {
		const book = source.load();
		return result(tool, "error" in book ? { text: book.error, error: true } : read(book));
	};
	const bookMap: AgentTool<typeof bookMapInput> = {
		name: "book_map",
		label: "book_map",
		description: BOOK_MAP_DESCRIPTION,
		parameters: bookMapInput,
		execute: async (_id, input) => withBook("book_map", (book) => bookMapText(book.nodes, book.blocks, input.at)),
	};
	const readSection: AgentTool<typeof readSectionInput> = {
		name: "read_section",
		label: "read_section",
		description: READ_SECTION_DESCRIPTION,
		parameters: readSectionInput,
		execute: async (_id, input) => withBook("read_section", (book) => readSectionText(book.nodes, book.blocks, input.at)),
	};
	const searchBook: AgentTool<typeof searchBookInput> = {
		name: "search_book",
		label: "search_book",
		description: SEARCH_BOOK_DESCRIPTION,
		parameters: searchBookInput,
		execute: async (_id, input) => withBook("search_book", (book) => searchBookText(book.nodes, book.blocks, book.searchable(), input.query)),
	};
	return healToolRecord({ book_map: bookMap, read_section: readSection, search_book: searchBook });
}
