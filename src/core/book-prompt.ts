/**
 * The book in agents' prompts and tools (fork plan 05, item 4): pure texts.
 *
 * - `bookPromptParts`: the per-turn section's book-specific parts (title,
 *   citation style, location forms, map progress, outline, and a unit's
 *   reading), which the agent layer joins with its doctrine.
 * - `bookMapText`, `readSectionText`, `searchBookText`: what the three
 *   retrieval tools return.
 *
 * The wording is the human's (fork README, "Books checkpoint 1 and item 4
 * decisions"); examples in it come from the book itself. Browser-safe: no IO.
 */
import {
	BOOK_CHARS_PER_TOKEN,
	bookDetailText,
	bookOutlineText,
	displayNode,
	fitBookNodes,
	nodesInRanges,
	pageAtOffset,
	rangeText,
	resolveBookLocation,
	searchBookBlocks,
} from "./book.ts";
import type { BookBlock, BookMapWriterState, BookNode, BookRange, BookRecord } from "./contracts/book.ts";

/** Decision 2's budgets, and the tools' caps (plan item 4). */
export const BOOK_OUTLINE_TOKENS = 3_000;
export const BOOK_DETAIL_TOKENS = 4_000;
export const BOOK_MAP_TOOL_TOKENS = 4_000;
export const READ_SECTION_TOKENS = 8_000;
export const SEARCH_BOOK_HITS = 20;
/** The search query limit, as the reader's search route has it. */
export const SEARCH_BOOK_QUERY_CHARS = 500;
/** How many nodes "Narrow to one of" names at most. */
const NARROW_CHOICES = 30;

/** The parts of a session's book section, before the agent's doctrine. */
export type BookPromptParts =
	| {
		/** "## <title>…" through the outline. */
		book: string;
		/** A unit of a followed book: its reading's heading line and detail. */
		reading?: { heading: string; detail: string };
	}
	| { unreadable: string };

type PromptBook = Pick<BookRecord, "title" | "author" | "format" | "structure"> & { mapWriter: Pick<BookMapWriterState, "status"> };

const quoted = (text: string) => `"${text}"`;

/** The first node at the map's deepest level, preferring one with pages. */
function exampleNode(nodes: readonly BookNode[]): BookNode | undefined {
	const deepest = Math.max(0, ...nodes.map((node) => node.level));
	const leaves = nodes.filter((node) => node.level === deepest);
	return leaves.find((node) => node.pages) ?? leaves[0];
}

/** How citations look in this book (decision 3: app-made parts cite pages
 *  in PDFs and part numbers elsewhere, never invented §s). */
export function bookCitationLine(book: Pick<BookRecord, "format" | "structure">, nodes: readonly BookNode[]): string {
	const example = exampleNode(nodes);
	const page = example?.pages?.from ?? "1";
	if (book.structure === "app-made") {
		return book.format === "pdf"
			? `Cite places by page: ${quoted(`p. ${page}`)}. The app divided this book into parts; never cite them.`
			: `Cite places by the app's part numbers: ${quoted(example?.label ?? "Part 1")}. The book has no structure of its own.`;
	}
	const label = example?.label ?? "Chapter 1";
	return book.format === "pdf" && example?.pages
		? `Cite places as the book does, with the page: ${quoted(`${label} (p. ${page})`)}.`
		: `Cite places as the book does: ${quoted(label)}.`;
}

/** The location forms the tools take, with examples from this book. */
export function bookLocationsLine(nodes: readonly BookNode[]): string {
	const example = exampleNode(nodes);
	if (!example) return "The tools take a place as pages (\"pp. 1–3\").";
	const forms = [`an id or label from the outline (${quoted(example.id)}, ${quoted(example.label)})`];
	const next = nodes.slice(nodes.indexOf(example) + 1).find((node) => node.level === example.level && node.parentId === example.parentId);
	if (next) forms.push(`a range (${quoted(`${example.label}–${next.label}`)})`);
	if (example.pages) {
		const { from, to } = example.pages;
		forms.push(`pages (${quoted(from === to ? `p. ${from}` : `pp. ${from}–${to}`)})`);
	}
	const list = forms.length < 3 ? forms.join(" or ") : `${forms.slice(0, -1).join(", ")}, or ${forms.at(-1)}`;
	return `The tools take a place as ${list}.`;
}

/**
 * The book-specific parts of a turn's book section. `reading` is the unit's
 * reading when its course follows the book; absent or empty adds nothing.
 */
export function bookPromptParts(book: PromptBook, nodes: readonly BookNode[], reading?: readonly BookRange[]): BookPromptParts {
	const writing = book.mapWriter.status === "waiting" || book.mapWriter.status === "writing";
	const lines = [
		`## ${book.title}${book.author ? `, by ${book.author}` : ""}`,
		bookCitationLine(book, nodes),
		[bookLocationsLine(nodes), ...(writing ? ["Summaries are still being written; the outline shows those done."] : [])].join("\n"),
		`### Outline\n${bookOutlineText(nodes, BOOK_OUTLINE_TOKENS)}`,
	];
	const ranges = (reading ?? []).filter((range) => nodesInRanges(nodes, [range]).length > 0);
	return {
		book: lines.join("\n\n"),
		...(ranges.length > 0 ? {
			reading: {
				heading: `## This unit's reading: ${ranges.map((range) => rangeText(nodes, range)).join(", ")}`,
				detail: bookDetailText(nodes, ranges, BOOK_DETAIL_TOKENS),
			},
		} : {}),
	};
}

/** The section for a book that can't be read this turn. */
export function bookUnreadableParts(title: string, reason: string): BookPromptParts {
	const why = reason.trim().replace(/\.$/, "");
	const lowered = why.charAt(0).toLowerCase() + why.slice(1);
	return { unreadable: `# The learner's book\n\nThis session's book, ${quoted(title)}, can't be read right now (${lowered}). Teach without it; if the learner asks about it, say so.` };
}

// ─── the tools' texts ──────────────────────────────────────────────────────

/** A tool answer: the model's text, and whether it is a refusal to fix. */
export interface BookToolText {
	text: string;
	error?: true;
}

const refusal = (text: string): BookToolText => ({ text, error: true });

/** book_map: the map under a location (or the whole map), with summaries
 *  and key terms, capped; over the cap it names where to narrow. */
export function bookMapText(nodes: readonly BookNode[], blocks: readonly BookBlock[], at?: string): BookToolText {
	if (nodes.length === 0) return refusal("This book has no map yet.");
	let selected: readonly BookNode[] = nodes;
	let title = "the whole book";
	if (at !== undefined && at.trim()) {
		const location = resolveBookLocation(nodes, blocks, at);
		if (!location.ok) return refusal(location.error);
		if (location.kind !== "nodes") return refusal("book_map takes a section or a range from the outline, not pages or blocks. Read those with read_section.");
		selected = nodesInRanges(nodes, [location.range]);
		title = rangeText(nodes, location.range);
	}
	let fitted = fitBookNodes(selected, BOOK_MAP_TOOL_TOKENS, true);
	let map = fitted.text;
	// If only the selected root fits, asking for it again cannot narrow.
	// Keep its overview, then fit its children as roots so the next choices
	// name smaller subtrees or the remaining child range.
	if (fitted.collapsed.length === 1 && fitted.collapsed[0] === selected[0] && fitted.hidden.length === 0) {
		const selectedIds = new Set(selected.map((node) => node.id));
		if (selected.slice(1).every((node) => node.parentId && selectedIds.has(node.parentId))) {
			const remainingTokens = BOOK_MAP_TOOL_TOKENS - Math.ceil((map.length + 1) / BOOK_CHARS_PER_TOKEN);
			fitted = fitBookNodes(selected.slice(1), Math.max(0, remainingTokens), true);
			map += `\n${fitted.text}`;
		}
	}
	const text = `Map of ${title}:\n${map}`;
	if (fitted.complete) return { text };
	const choices = fitted.collapsed.map((node) => ({ from: node, to: node }));
	if (fitted.hidden.length > 0) choices.push({ from: fitted.hidden[0]!, to: fitted.hidden.at(-1)! });
	// A range for the remaining choices keeps every subtree reachable;
	// replacing them with an ellipsis would hide their locations again.
	if (choices.length > NARROW_CHOICES) {
		choices.splice(NARROW_CHOICES - 1, choices.length, { from: choices[NARROW_CHOICES - 1]!.from, to: choices.at(-1)!.to });
	}
	const named = choices.map(({ from, to }) => from === to ? `${from.id} (${displayNode(from)})` : `${from.id} to ${to.id}`);
	return { text: `${text}\n\nToo large to show in full. Narrow to one of: ${named.join(", ")}` };
}

/** The labels of the nodes that start at a block, outermost first, unless
 *  the block's text already starts with them (as the reader's margin does). */
function startLabels(nodes: readonly BookNode[], block: BookBlock): string[] {
	const text = block.text.trimStart();
	// "§187" is also written "187."; "I" must not match "In".
	const startsWith = (label: string) => [label, label.replace(/^§\s*/, "")].some((form) =>
		form !== "" && text.startsWith(form) && !/[\p{L}\p{N}]/u.test(text.charAt(form.length)));
	return nodes
		.filter((node) => node.firstBlock === block.id && node.label && !startsWith(node.label))
		.map((node) => node.label);
}

function pageOf(entry: { page?: number; pageLabel?: string }): string | undefined {
	return entry.pageLabel ?? (entry.page !== undefined ? String(entry.page) : undefined);
}

/** One block as read_section shows it: page markers where pages start,
 *  section labels where sections start, headings marked. */
function blockText(nodes: readonly BookNode[], block: BookBlock, pageBefore: string | undefined, from: number, to: number): { text: string; page: string | undefined } {
	const lines: string[] = [];
	let page = pageBefore;
	const starts = pageAtOffset(block, from);
	if (starts !== undefined && starts !== page) { lines.push(`[p. ${starts}]`); page = starts; }
	const labels = from === 0 ? startLabels(nodes, block) : [];
	if (labels.length > 0) lines.push(`[${labels.join(" › ")}]`);
	const pieces: string[] = [];
	let start = from;
	for (const brk of block.breaks ?? []) {
		if (brk.at <= from || brk.at >= to) continue;
		pieces.push(block.text.slice(start, brk.at).trimEnd(), `[p. ${pageOf(brk)}]`);
		start = brk.at;
		page = pageOf(brk);
	}
	pieces.push(block.text.slice(start, to));
	const body = pieces.filter(Boolean).join(" ");
	lines.push(block.kind === "heading" && from === 0 ? `${"#".repeat(block.level ?? 1)} ${body}` : body);
	return { text: lines.join("\n"), page };
}

/** read_section: bounded exact text with labels and page markers. Prefer
 *  whole blocks; an oversized block continues at a UTF-16 offset without
 *  splitting a Unicode character. The envelope counts toward the cap too. */
export function readSectionText(nodes: readonly BookNode[], blocks: readonly BookBlock[], at: string): BookToolText {
	if (blocks.length === 0) return refusal("This book has no text.");
	const location = resolveBookLocation(nodes, blocks, at);
	if (!location.ok) return refusal(location.error);
	const budget = READ_SECTION_TOKENS * BOOK_CHARS_PER_TOKEN;
	const rawTitle = location.kind === "nodes" ? rangeText(nodes, location.range) : location.label;
	const title = rawTitle.length > 512 ? `${rawTitle.slice(0, 511)}…` : rawTitle;
	const firstOffset = location.kind === "blocks" ? location.firstOffset ?? 0 : 0;
	const firstPage = pageAtOffset(blocks[location.firstBlock]!, firstOffset);
	const parts: string[] = [];
	let size = 0;
	let page: string | undefined;
	let nextBlock = location.firstBlock;
	let nextOffset = firstOffset;
	const envelope = (lastPage: string | undefined, block: number, offset: number) => {
		const pages = firstPage === undefined || location.kind === "pages" ? "" : firstPage === lastPage || lastPage === undefined ? `, p. ${firstPage}` : `, pp. ${firstPage}–${lastPage}`;
		const where = `${block === location.lastBlock ? `block ${block}` : `blocks ${block}–${location.lastBlock}`}${offset > 0 ? ` from offset ${offset}` : ""}`;
		return {
			header: `${title}${pages}\n\n`,
			tail: block <= location.lastBlock ? `\n\nContinues: call read_section with at ${quoted(where)}` : "",
		};
	};
	for (let index = location.firstBlock; index <= location.lastBlock; index++) {
		const block = blocks[index]!;
		const from = index === location.firstBlock ? firstOffset : 0;
		const safeEnd = (end: number) => end < block.text.length && /[\uD800-\uDBFF]/.test(block.text.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(block.text.charAt(end)) ? end - 1 : end;
		const render = (end: number) => {
			const to = safeEnd(end);
			const rendered = blockText(nodes, block, page, from, to);
			const next = to < block.text.length ? index : index + 1;
			const offset = to < block.text.length ? to : 0;
			const { header, tail } = envelope(rendered.page, next, offset);
			return { ...rendered, to, next, offset, length: header.length + size + (parts.length > 0 ? 2 : 0) + rendered.text.length + tail.length };
		};
		let rendered = render(Math.min(block.text.length, from + budget));
		if (rendered.length > budget) {
			// Keep ordinary blocks intact after one has fitted. Only the first
			// block needs slicing, so every successful call still makes progress.
			if (parts.length > 0) break;
			let low = from + 1;
			let high = Math.min(block.text.length, from + budget);
			let fitted: typeof rendered | undefined;
			while (low <= high) {
				const middle = Math.floor((low + high) / 2);
				const candidate = render(middle);
				if (candidate.length <= budget) {
					if (candidate.to > from) fitted = candidate;
					low = middle + 1;
				} else high = middle - 1;
			}
			if (!fitted) return refusal("This location's labels are too large to read within the limit.");
			rendered = fitted;
		}
		size += (parts.length > 0 ? 2 : 0) + rendered.text.length;
		parts.push(rendered.text);
		page = rendered.page;
		nextBlock = rendered.next;
		nextOffset = rendered.offset;
		if (nextOffset > 0) break;
	}
	const { header, tail } = envelope(page, nextBlock, nextOffset);
	return { text: `${header}${parts.join("\n\n")}${tail}` };
}

/** search_book: up to 20 matches in book order, each with its location,
 *  page and the stored text around it. */
export function searchBookText(nodes: readonly BookNode[], blocks: readonly BookBlock[], searchable: readonly string[], query: string): BookToolText {
	const wanted = query.trim();
	if (!wanted) return refusal("Give a word or phrase to search for.");
	if (wanted.length > SEARCH_BOOK_QUERY_CHARS) return refusal(`Search for at most ${SEARCH_BOOK_QUERY_CHARS} characters.`);
	const result = searchBookBlocks(blocks, searchable, nodes, wanted, SEARCH_BOOK_HITS);
	if (result.total === 0) return { text: `No matches for ${quoted(wanted)}.` };
	const header = result.total > result.hits.length
		? `${result.total.toLocaleString("en-US")} matches; showing the first ${result.hits.length}. Add words to narrow it.`
		: `${result.total} ${result.total === 1 ? "match" : "matches"}:`;
	const lines = result.hits.map((hit) => {
		const where = hit.nodeId ? `${hit.label} (${hit.nodeId})` : `block ${hit.block}`;
		const page = hit.page !== undefined ? `, p. ${hit.page}` : "";
		const snippet = `${hit.before}${hit.match}${hit.after}`.replace(/\s+/g, " ").trim();
		return `- ${where}${page}: ${quoted(snippet)}`;
	});
	return { text: `${header}\n${lines.join("\n")}` };
}
