/**
 * Books (fork plan 05): a library of imported books, each with its stored
 * copy, its converted text, and a map of its structure. One folder per book
 * lives at data/books/<bookId>/:
 *
 *   book.json        the record (version 1)
 *   original.<ext>   the imported file, byte for byte
 *   text.json        the converted text as ordered blocks (never rewritten)
 *   map.json         the structure tree and, once written, its summaries
 *   candidates.json  every structure the import found, for "Not right"
 *
 * The contents (the map's structure) are always found without a model. The
 * import judges its own confidence: confident contents are accepted at once,
 * unsure ones wait for the learner's review. Summaries come later from the
 * map writer (item 2).
 */
import type { JobUsage } from "./jobs.ts";

/** The book record format this build writes and understands. */
export const CURRENT_BOOK_VERSION = 1;
/** The text.json, map.json and candidates.json format. */
export const CURRENT_BOOK_DATA_VERSION = 1;

export type BookFormat = "pdf" | "epub" | "text" | "markdown";

/** How the contents were found: the file's own contents (PDF bookmarks or
 *  the EPUB's table of contents), numbered paragraphs, detected headings,
 *  parts made by the app, or the optional model pass (item 2). */
export type BookStructureMethod = "outline" | "numbered" | "headings" | "app-made" | "model";

export interface BookConfidence {
	level: "confident" | "unsure";
	/** Why, in the learner's words; shown on "Check the contents". */
	reasons: string[];
}

export interface BookImportState {
	status: "importing" | "review" | "ready" | "failed";
	error?: string;
	/** Shown beside a finished import, e.g. pages skipped for lacking text. */
	notice?: string;
}

/** A learner-started model writer's state (the map writer, the structure pass). */
export interface BookWriterState {
	status: "writing" | "ready" | "failed";
	error?: string;
	stopped?: true;
	model?: string;
	usage?: JobUsage;
}

export interface BookMapWriterState {
	/** waiting: contents not yet accepted, or the writer not yet started.
	 *  not-needed: a short book, whose text the agent can simply read. */
	status: "waiting" | "not-needed" | "writing" | "ready" | "failed";
	/** Leaf and parent summaries written, out of total. */
	done: number;
	total: number;
	error?: string;
	stopped?: true;
	model?: string;
	usage?: JobUsage;
}

export interface BookRecord {
	/** Absent reads as 1; a newer stamp is refused. */
	version?: number;
	id: string;
	title: string;
	author?: string;
	format: BookFormat;
	/** The imported file's name, as the learner chose it. */
	fileName: string;
	/** Hex SHA-256 of the original bytes: the same file imports once. */
	sha256: string;
	bytes: number;
	importedAt: string;
	updatedAt: string;
	/** PDFs: the page count. */
	pageCount?: number;
	/** Words in the converted text (set when the import finishes). */
	words?: number;
	/** The method behind the current contents (set when the import finishes). */
	structure?: BookStructureMethod;
	confidence?: BookConfidence;
	/** Who accepted the contents; absent while they await review. */
	contentsAccepted?: "auto" | "learner";
	import: BookImportState;
	/** The optional model pass over candidate headings (item 2). */
	structureWriter?: BookWriterState;
	mapWriter: BookMapWriterState;
}

/** Where a block's text crosses onto a later page. */
export interface BookPageBreak {
	/** UTF-16 offset in the block's text where the page starts. */
	at: number;
	page: number;
	pageLabel?: string;
}

export interface BookBlock {
	/** Its index in text.json; stable, since the text is never rewritten. */
	id: number;
	kind: "heading" | "paragraph";
	/** Heading level, 1 (largest) to 3. */
	level?: 1 | 2 | 3;
	text: string;
	/** The page the block starts on (PDFs, and EPUBs with print page marks). */
	page?: number;
	/** The printed page label when it differs from the page number. */
	pageLabel?: string;
	breaks?: BookPageBreak[];
}

export interface BookText {
	version: number;
	blocks: BookBlock[];
}

export type BookNodeKind = "part" | "chapter" | "section" | "paragraph" | "app-part";

export interface BookNode {
	/** "n<index>" in book order; unique within one map. */
	id: string;
	parentId?: string;
	/** What citations show: "§187", "IV.A", "Chapter 2", "Part 14". */
	label: string;
	/** The section's title; "" for an app-made part until the map writer names it. */
	title: string;
	kind: BookNodeKind;
	/** Depth from 1 (top level). */
	level: number;
	/** The node's text: blocks firstBlock…lastBlock, inclusive. */
	firstBlock: number;
	lastBlock: number;
	/** First and last page labels (or numbers) the node covers. */
	pages?: { from: string; to: string };
	summary?: string;
	terms?: string[];
}

export interface BookMap {
	version: number;
	nodes: BookNode[];
}

/** One structure an import method found, kept so "Not right" can switch. */
export interface BookCandidate {
	method: BookStructureMethod;
	confidence: BookConfidence;
	/** "8 parts, 46 sections, §1–§808". */
	description: string;
	nodes: BookNode[];
}

export interface BookCandidates {
	version: number;
	candidates: BookCandidate[];
}

/** A contiguous stretch of the map, inclusive, by node id. */
export interface BookRange {
	from: string;
	to: string;
}

/** A chat's book (fork plan 05): standalone Teach sessions and course setups. */
export interface ChatBookLink {
	bookId: string;
}

/** A course's book: followed (units have readings) or reference only. */
export interface CourseBookLink {
	bookId: string;
	mode: "follow" | "reference";
}

/** A position in the text: a block and a UTF-16 offset in its text. */
export interface BookPosition {
	block: number;
	offset: number;
}

/** What a quote_passage result carries (item 5): self-contained, so exports,
 *  notes and compaction never need the library. */
export interface BookQuoteDetails {
	bookId: string;
	bookTitle: string;
	nodeId: string;
	label: string;
	pages?: { from: string; to: string };
	start: BookPosition;
	end: BookPosition;
	/** The stored text of the quoted span, verbatim. */
	text: string;
}

/** The library's view of a book. */
export interface BookSummary {
	id: string;
	title: string;
	author?: string;
	format: BookFormat;
	importedAt: string;
	pageCount?: number;
	words?: number;
	sections?: number;
	structure?: BookStructureMethod;
	confidence?: BookConfidence;
	contentsAccepted?: "auto" | "learner";
	import: BookImportState;
	mapWriter: BookMapWriterState;
}
