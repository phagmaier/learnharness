/**
 * The library's wording and shapes (fork plan 05, item 3), pure so render
 * and unit tests reach them without the page's state: a book's state line,
 * its size, where its contents came from, the "Not right" methods, the map
 * writer's usage, the contents rows (numbered paragraphs folded into runs),
 * and a block's text split at its page breaks and highlight.
 */
import type {
	BookBlock,
	BookCandidate,
	BookFormat,
	BookMapWriterState,
	BookNode,
	BookStructureMethod,
	BookSummary,
	JobUsage,
} from "@/src/core";
import { formatTokens, formatUsd, prettyModel } from "@/components/usage-format";

/** The library's view of a book, as GET /api/books returns it. */
export type LibraryBook = BookSummary & {
	progress?: { done: number; total: number };
	/** A failed import that Try again can fix (not a refusal of the file). */
	retryable?: boolean;
};

/** The book page's view, as GET /api/books/:id returns it. */
export type BookPageBook = LibraryBook & {
	fileName: string;
	bytes: number;
	updatedAt: string;
	structureWriter?: { status: "writing" | "ready" | "failed"; error?: string; stopped?: true; model?: string };
	mapCostUsd: number | null;
};

export interface BookUserView {
	kind: "course" | "session";
	id: string;
	title: string;
	/** Absent for a record that can't be read: there's no page to open. */
	href?: string;
}

export const BOOK_FORMAT_LABEL: Record<BookFormat, string> = { pdf: "PDF", epub: "EPUB", text: "Text", markdown: "Markdown" };

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

/** "610 pages" for a PDF, else "96 sections" once the contents are found. */
export function bookSizeLine(book: Pick<LibraryBook, "format" | "pageCount" | "sections">): string | null {
	if (book.format === "pdf" && book.pageCount !== undefined) return plural(book.pageCount, "page");
	if (book.sections !== undefined) return plural(book.sections, "section");
	return null;
}

/** "G. Tester · PDF · 610 pages" */
export function bookFactsLine(book: Pick<LibraryBook, "author" | "format" | "pageCount" | "sections">): string {
	return [book.author, BOOK_FORMAT_LABEL[book.format], bookSizeLine(book)].filter(Boolean).join(" · ");
}

export type BookStateTone = "busy" | "attention" | "done" | "failed";

export interface BookStateLine {
	text: string;
	tone: BookStateTone;
	/** What its Try again retries. */
	retry?: "import" | "map";
}

function mapState(writer: BookMapWriterState): BookStateLine {
	switch (writer.status) {
		case "writing": return { text: writer.total > 0 ? `Mapping ${count(writer.done)} of ${count(writer.total)} sections` : "Mapping…", tone: "busy" };
		case "ready": return { text: "Map ready", tone: "done" };
		case "not-needed": return { text: "Short book: no map needed", tone: "done" };
		case "waiting": return { text: "Map not started", tone: "failed", retry: "map" };
		case "failed":
			return writer.stopped
				? { text: `Map stopped at ${count(writer.done)} of ${count(writer.total)} sections`, tone: "failed", retry: "map" }
				: { text: `Map failed: ${writer.error ?? "unknown error"}`, tone: "failed", retry: "map" };
	}
}

/** The row's state: the import first, then the map writer. */
export function bookStateLine(book: Pick<LibraryBook, "import" | "mapWriter" | "progress" | "retryable">): BookStateLine {
	switch (book.import.status) {
		case "importing": {
			const progress = book.progress;
			return { text: progress && progress.total > 0 ? `Importing… page ${count(progress.done)} of ${count(progress.total)}` : "Importing…", tone: "busy" };
		}
		case "failed": return { text: book.import.error ?? "The import failed. Try again.", tone: "failed", ...(book.retryable === false ? {} : { retry: "import" as const }) };
		case "review": return { text: "Check the contents", tone: "attention" };
		case "ready": return mapState(book.mapWriter);
	}
}

/** What a method is called on "Not right" and "Contents from …". */
export function methodName(format: BookFormat, method: BookStructureMethod): string {
	switch (method) {
		case "outline": return format === "pdf" ? "The PDF's bookmarks" : "The EPUB's table of contents";
		case "numbered": return "Numbered paragraphs";
		case "headings": return "Headings";
		case "app-made": return "Parts of about 2,000 words";
		case "model": return "Found by the model";
	}
}

/** "Contents from the PDF's bookmarks" (or the method used). */
export function contentsSourceLine(format: BookFormat, method: BookStructureMethod): string {
	switch (method) {
		case "outline": return format === "pdf" ? "Contents from the PDF's bookmarks" : "Contents from the EPUB's table of contents";
		case "numbered": return "Contents from numbered paragraphs";
		case "headings": return "Contents from the text's headings";
		case "app-made": return "Divided by the app";
		case "model": return "Contents found by the model";
	}
}

/** "Numbered paragraphs: §1–§808 under 12 headings", "Headings: 31",
 *  "Parts of about 2,000 words: 96". */
export function methodChoiceLine(format: BookFormat, candidate: Pick<BookCandidate, "method" | "description" | "nodes">): string {
	const name = methodName(format, candidate.method);
	switch (candidate.method) {
		case "headings": return `${name}: ${count(candidate.nodes.filter((node) => node.kind !== "paragraph").length)}`;
		case "app-made": return `${name}: ${count(candidate.nodes.length)}`;
		default: return `${name}: ${candidate.description}`;
	}
}

/** "cheap-model · 698k tokens · $0.2100": what the map cost so far. */
export function mapUsageLine(writer: Pick<BookMapWriterState, "usage">, costUsd: number | null): string | null {
	const usage: JobUsage | undefined = writer.usage;
	if (!usage) return null;
	const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
	return [prettyModel(usage.model, true), tokens > 0 ? `${formatTokens(tokens)} tokens` : null, costUsd !== null ? formatUsd(costUsd) : null].filter(Boolean).join(" · ");
}

/** "p. 114" or "pp. 114–116". */
export function pagesText(pages: BookNode["pages"]): string | null {
	if (!pages) return null;
	return pages.from === pages.to ? `p. ${pages.from}` : `pp. ${pages.from}–${pages.to}`;
}

/** How a node reads in a list: its title, else its label. */
export function nodeTitle(node: Pick<BookNode, "label" | "title">): string {
	return node.title || node.label;
}

/** A node's label when its title doesn't already start with it. */
export function nodeLabel(node: Pick<BookNode, "label" | "title">): string | null {
	if (!node.title || node.title === node.label || node.title.startsWith(node.label)) return null;
	return node.label;
}

export type ContentsRow =
	| { kind: "node"; node: BookNode; depth: number }
	/** Consecutive numbered paragraphs under one parent, folded. */
	| { kind: "run"; key: string; nodes: BookNode[]; depth: number };

/** The contents as rows: every section, with consecutive numbered
 *  paragraphs folded into one run ("§1–§30"). */
export function contentsRows(nodes: readonly BookNode[]): ContentsRow[] {
	const rows: ContentsRow[] = [];
	for (const node of nodes) {
		const depth = node.level - 1;
		const last = rows.at(-1);
		if (node.kind === "paragraph") {
			if (last?.kind === "run" && last.nodes[0]!.parentId === node.parentId) last.nodes.push(node);
			else rows.push({ kind: "run", key: `run-${node.id}`, nodes: [node], depth });
			continue;
		}
		rows.push({ kind: "node", node, depth });
	}
	return rows;
}

/** "§1–§30" */
export function runLabel(nodes: readonly BookNode[]): string {
	return nodes.length === 1 ? nodes[0]!.label : `${nodes[0]!.label}–${nodes.at(-1)!.label}`;
}

/** Each block's margin label: the deepest section starting there. */
export function marginLabels(nodes: readonly BookNode[]): Map<number, BookNode> {
	const labels = new Map<number, BookNode>();
	for (const node of nodes) labels.set(node.firstBlock, node);
	return labels;
}

export type BlockSegment =
	| { kind: "text"; text: string; mark?: true }
	/** A page starting inside the block, shown in the margin at its line. */
	| { kind: "page"; page: string };

/**
 * A block's text split at its page breaks and around one highlighted span
 * (UTF-16 offsets into the stored text), in reading order.
 */
export function blockSegments(block: Pick<BookBlock, "text" | "breaks">, highlight?: { start: number; end: number }): BlockSegment[] {
	const cuts = new Set<number>([0, block.text.length]);
	const pages = new Map<number, string>();
	for (const brk of block.breaks ?? []) {
		if (brk.at <= 0 || brk.at >= block.text.length) continue;
		cuts.add(brk.at);
		pages.set(brk.at, brk.pageLabel ?? String(brk.page));
	}
	const span = highlight && highlight.end > highlight.start
		? { start: Math.max(0, highlight.start), end: Math.min(block.text.length, highlight.end) }
		: undefined;
	if (span) { cuts.add(span.start); cuts.add(span.end); }
	const sorted = [...cuts].sort((a, b) => a - b);
	const segments: BlockSegment[] = [];
	for (let i = 0; i < sorted.length - 1; i++) {
		const from = sorted[i]!;
		const to = sorted[i + 1]!;
		const page = pages.get(from);
		if (page !== undefined) segments.push({ kind: "page", page });
		if (to <= from) continue;
		const marked = span !== undefined && from >= span.start && to <= span.end;
		segments.push({ kind: "text", text: block.text.slice(from, to), ...(marked ? { mark: true as const } : {}) });
	}
	return segments;
}

/** The page a block ends on (its last break, else its start). */
export function blockEndPage(block: Pick<BookBlock, "page" | "pageLabel" | "breaks">): string | undefined {
	const last = block.breaks?.at(-1);
	if (last) return last.pageLabel ?? String(last.page);
	return block.pageLabel ?? (block.page !== undefined ? String(block.page) : undefined);
}

/** The page a block starts on. */
export function blockStartPage(block: Pick<BookBlock, "page" | "pageLabel">): string | undefined {
	return block.pageLabel ?? (block.page !== undefined ? String(block.page) : undefined);
}
