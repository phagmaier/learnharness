/**
 * Books (fork plan 05): the pure rules. Everything here works without a
 * model: text normalization for search and quote matching, the structure
 * candidates an import finds and how confident each is, the garbled-text
 * check, location parsing and resolution, and the outline and detail texts
 * agents receive.
 *
 * Browser-safe: no IO. The converters (src/server/book-import.ts) turn a
 * file into blocks; these rules turn blocks into candidates.
 */
import type {
	BookBlock,
	BookCandidate,
	BookConfidence,
	BookFormat,
	BookNode,
	BookNodeKind,
	BookRange,
	BookStructureMethod,
} from "./contracts/book.ts";

/** Characters per token, the estimate the course section also uses. */
export const BOOK_CHARS_PER_TOKEN = 4;

// ─── normalization ─────────────────────────────────────────────────────────

/** A normalized text and, for each of its UTF-16 units, the offset of the
 *  original unit it came from (so a match maps back to the stored text). */
export interface NormalizedText {
	text: string;
	map: number[];
}

const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032`\u00B4]/;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/;
const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/;
const LIGATURES = /[\uFB00-\uFB06]/;
const LETTER = /\p{L}/u;

/**
 * Normalize for quote matching (`search: false`) or search (`search: true`).
 * Both: ligatures expanded, typographic quotes, apostrophes and dashes folded
 * to one form, soft hyphens and hyphens between letters dropped (a line-end
 * hyphen the import resolved either way still matches), whitespace collapsed
 * and trimmed. Search also folds case and strips accents; quote matching
 * keeps them.
 */
export function normalizeBookText(input: string, options: { search?: boolean } = {}): NormalizedText {
	const out: string[] = [];
	const map: number[] = [];
	const push = (text: string, at: number) => {
		for (const unit of text) {
			for (let k = 0; k < unit.length; k++) {
				out.push(unit[k]!);
				map.push(at);
			}
		}
	};
	let pendingSpace = -1;
	const search = options.search === true;
	const length = input.length;
	const codePointAt = (index: number) => String.fromCodePoint(input.codePointAt(index)!);
	let i = 0;
	while (i < length) {
		const at = i;
		const code = input.charCodeAt(i);
		// Fast path (agent-selected, for whole books): printable ASCII other
		// than the hyphen and the backtick passes through as itself, lowered
		// for search. Everything else takes the general path below.
		if (code > 0x20 && code < 0x7f && code !== 0x2d && code !== 0x60) {
			if (pendingSpace >= 0) {
				out.push(" ");
				map.push(pendingSpace);
				pendingSpace = -1;
			}
			out.push(search && code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : input[i]!);
			map.push(at);
			i++;
			continue;
		}
		const ch = codePointAt(i);
		i += ch.length;
		if (ch === "\u00AD") continue;
		if (/\s/.test(ch)) {
			if (out.length > 0 && pendingSpace < 0) pendingSpace = at;
			continue;
		}
		let piece = ch;
		if (LIGATURES.test(ch)) piece = ch.normalize("NFKC");
		else if (SINGLE_QUOTES.test(ch)) piece = "'";
		else if (DOUBLE_QUOTES.test(ch)) piece = "\"";
		else if (DASHES.test(ch)) piece = "-";
		if (piece === "-") {
			// A hyphen between letters (possibly across a line break) drops out.
			const before = out.length > 0 && pendingSpace < 0 && LETTER.test(out[out.length - 1]!);
			let j = i;
			while (j < length && /\s/.test(codePointAt(j))) j += codePointAt(j).length;
			const after = j < length && LETTER.test(codePointAt(j));
			if (before && after) {
				// Skip the whitespace that followed the hyphen, too.
				i = j;
				continue;
			}
		}
		if (search) {
			piece = piece.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
			if (!piece) continue;
		}
		if (pendingSpace >= 0) {
			push(" ", pendingSpace);
			pendingSpace = -1;
		}
		push(piece, at);
	}
	return { text: out.join(""), map };
}

/** Words in a text: runs of letters or digits. */
export function wordCount(text: string): number {
	return text.match(/[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

// ─── garbled text ───────────────────────────────────────────────────────────

const WORDLIKE = /^[("\u201C\u2018'[]*[\p{L}][\p{L}\p{M}'\u2019-]*[.,;:!?)\]"\u201D\u2019]*$/u;

/**
 * Whether one page's extracted text looks garbled: mostly symbols rather
 * than letters, or few of its tokens shaped like words. This is the
 * font-encoding failure where every glyph extracts as the wrong character.
 * Very short pages are never judged.
 */
export function pageLooksGarbled(text: string): boolean {
	const visible = text.replace(/\s+/g, "");
	if (visible.length < 80) return false;
	const letters = (visible.match(/\p{L}/gu) ?? []).length;
	if (letters / visible.length < 0.5) return true;
	if ((visible.match(/[\uFFFD\p{Co}]/gu) ?? []).length / visible.length > 0.1) return true;
	const tokens = text.split(/\s+/).filter(Boolean);
	const wordlike = tokens.filter((token) => {
		if (!/\p{L}/u.test(token)) return false;
		// The vowel heuristic diagnoses Latin font soup, not other writing systems.
		if (!NON_LATIN_LETTER.test(token)) {
			// Stripping accents can only add vowels (é → e), so the plain test comes first.
			return WORDLIKE.test(token) && (VOWEL.test(token) || VOWEL.test(token.normalize("NFD").replace(/\p{M}/gu, "")));
		}
		return true;
	}).length;
	return wordlike / tokens.length < 0.4;
}

const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;
const VOWEL = /[aeiouyæøœ]/i;

/** Pages judged (long enough) and pages garbled: the garbled-text rule's
 *  counts, which a long book can sum over chunks of pages. */
export function garbledCounts(pages: readonly string[]): { judged: number; garbled: number } {
	const judged = pages.filter((text) => text.replace(/\s+/g, "").length >= 80);
	return { judged: judged.length, garbled: judged.filter(pageLooksGarbled).length };
}

/** Garbled when most judged pages are. */
export function countsLookGarbled(counts: { judged: number; garbled: number }): boolean {
	return counts.judged > 0 && counts.garbled > counts.judged / 2;
}

/** A book's text is garbled when most of its judged pages are. */
export function textLooksGarbled(pages: readonly string[]): boolean {
	return countsLookGarbled(garbledCounts(pages));
}

// ─── structure candidates ──────────────────────────────────────────────────

/** One entry of a file's own contents, resolved to the block it points at
 *  (null when its destination couldn't be resolved). */
export interface SourceOutlineEntry {
	title: string;
	/** Depth from 1. */
	level: number;
	block: number | null;
}

export interface StructureInput {
	format: BookFormat;
	blocks: readonly BookBlock[];
	/** The PDF's bookmarks or the EPUB's table of contents, when present. */
	outline?: readonly SourceOutlineEntry[];
}

/** A node before ids and ranges are assigned: where it starts and how deep. */
interface Head {
	block: number;
	level: number;
	label: string;
	title: string;
	kind: BookNodeKind;
}

export const APP_PART_WORDS = 2_000;
/** Books shorter than this get no summaries (decision 10). */
export const SHORT_BOOK_WORDS = 20_000;

const NUMBERING = /^((?:chapter|part|book|section|lecture|appendix|preface)\s+(?:[0-9]+|[IVXLCDM]+)[A-Za-z]?|[IVXLCDM]+(?:\.[A-Z0-9]+)+\.?|[IVXLCDM]+\.|[A-Z]\.|[0-9]+(?:\.[0-9]+)*\.?)(?=\s|$)/i;

/** The citation label for a titled section: its numbering when it has one
 *  ("IV", "Chapter 2", "1.3"), else its title, shortened. */
export function labelForTitle(title: string): string {
	const clean = title.replace(/\s+/g, " ").trim();
	const match = clean.match(NUMBERING);
	if (match) return match[1]!.replace(/\.$/, "");
	return clean.length <= 40 ? clean : `${clean.slice(0, 39).trimEnd()}…`;
}

function kindForTitle(title: string): BookNodeKind {
	if (/^(?:part|book)\b/i.test(title)) return "part";
	if (/^chapter\b/i.test(title)) return "chapter";
	return "section";
}

/** Word offsets: words before each block, and the total. */
function wordOffsets(blocks: readonly BookBlock[]): { before: number[]; total: number } {
	const before: number[] = [];
	let total = 0;
	for (const block of blocks) {
		before.push(total);
		total += wordCount(block.text);
	}
	return { before, total };
}

function pageOf(block: BookBlock | undefined): string | undefined {
	if (!block || block.page === undefined) return undefined;
	return block.pageLabel ?? String(block.page);
}

/** The label of the page a block ends on. */
function endPageOf(block: BookBlock | undefined): string | undefined {
	if (!block) return undefined;
	const last = block.breaks?.at(-1);
	if (last) return last.pageLabel ?? String(last.page);
	return pageOf(block);
}

/** Turn ordered heads into nodes with ids, parents and block ranges. A node
 *  runs until the next head at its own level or above. */
export function nodesFromHeads(heads: readonly Head[], blocks: readonly BookBlock[]): BookNode[] {
	const sorted = heads
		.map((head, index) => ({ head, index }))
		.sort((a, b) => a.head.block - b.head.block || a.index - b.index)
		.map(({ head }) => head);
	const lastBlock = blocks.length - 1;
	const nodes: BookNode[] = [];
	const stack: { node: BookNode; level: number }[] = [];
	for (const [index, head] of sorted.entries()) {
		while (stack.length > 0 && stack.at(-1)!.level >= head.level) stack.pop();
		const parent = stack.at(-1)?.node;
		let end = lastBlock;
		for (let k = index + 1; k < sorted.length; k++) {
			if (sorted[k]!.level <= head.level) {
				end = sorted[k]!.block - 1;
				break;
			}
		}
		const firstBlock = Math.min(head.block, lastBlock);
		const node: BookNode = {
			id: `n${index}`,
			...(parent ? { parentId: parent.id } : {}),
			label: head.label,
			title: head.title,
			kind: head.kind,
			level: (parent ? parent.level : 0) + 1,
			firstBlock,
			lastBlock: Math.max(firstBlock, end),
		};
		const from = pageOf(blocks[node.firstBlock]);
		const to = endPageOf(blocks[node.lastBlock]);
		if (from !== undefined && to !== undefined) node.pages = { from, to };
		nodes.push(node);
		stack.push({ node, level: head.level });
	}
	return nodes;
}

const PARAGRAPH_NUMBER = /^\s*(?:[§¶]\s*([0-9]{1,4})\b|([0-9]{1,4})\.\s+\S)/;

interface NumberedRun {
	/** Accepted paragraph starts, in order. */
	entries: { block: number; number: number }[];
	repeats: number;
	max: number;
}

/** The sequence of numbered paragraph starts (§1, §2, … or "1.", "2.", …):
 *  it starts at 1–3 and accepts the next number or one a few ahead (a start
 *  the extraction missed). A bigger jump is taken only when the two starts
 *  after it continue from it, so one stray number can't derail the run.
 *  Anything else (a note "2.", a list restarting at 1) counts as a repeat. */
export function findNumberedRun(blocks: readonly BookBlock[]): NumberedRun {
	const found: { block: number; number: number }[] = [];
	for (const block of blocks) {
		if (block.kind !== "paragraph") continue;
		const match = block.text.match(PARAGRAPH_NUMBER);
		if (match) found.push({ block: block.id, number: Number(match[1] ?? match[2]) });
	}
	const entries: { block: number; number: number }[] = [];
	let repeats = 0;
	let last = 0;
	for (let i = 0; i < found.length; i++) {
		const { number } = found[i]!;
		if (entries.length === 0) {
			if (number <= 3) {
				entries.push(found[i]!);
				last = number;
			}
			continue;
		}
		const resync = number > last + 3 && found[i + 1]?.number === number + 1 && found[i + 2]?.number === number + 2;
		if ((number > last && number <= last + 3) || resync) {
			entries.push(found[i]!);
			last = number;
		} else {
			repeats++;
		}
	}
	return { entries, repeats, max: last };
}

function headingHeads(blocks: readonly BookBlock[]): Head[] {
	return blocks
		.filter((block) => block.kind === "heading" && block.text.length <= 150)
		.map((block) => ({
			block: block.id,
			level: block.level ?? 1,
			label: labelForTitle(block.text),
			title: block.text.replace(/\s+/g, " ").trim(),
			kind: kindForTitle(block.text),
		}));
}

function paragraphHeads(run: NumberedRun, level: number): Head[] {
	return run.entries.map((entry) => ({ block: entry.block, level, label: `§${entry.number}`, title: "", kind: "paragraph" as const }));
}

function appParts(blocks: readonly BookBlock[]): Head[] {
	const heads: Head[] = [];
	let start = -1;
	let words = 0;
	const close = () => {
		if (start >= 0) heads.push({ block: start, level: 1, label: `Part ${heads.length + 1}`, title: "", kind: "app-part" });
		start = -1;
		words = 0;
	};
	for (const block of blocks) {
		const n = wordCount(block.text);
		if (start >= 0 && (words >= APP_PART_WORDS || (words >= APP_PART_WORDS * 0.85 && words + n > APP_PART_WORDS * 1.15))) close();
		if (start < 0) start = block.id;
		words += n;
	}
	// A short last part joins the one before it.
	if (start >= 0 && words < APP_PART_WORDS / 4 && heads.length > 0) return heads;
	close();
	return heads;
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function pct(fraction: number): string {
	return `${Math.round(fraction * 100)}%`;
}

/** The page label at a word offset, when the text has pages. */
function pageAt(blocks: readonly BookBlock[], offsets: ReturnType<typeof wordOffsets>, word: number): string | undefined {
	let index = 0;
	while (index + 1 < blocks.length && offsets.before[index + 1]! <= word) index++;
	return pageOf(blocks[index]);
}

/** Where a word offset falls, as a page ("page 140") or share of the text. */
function placeOf(blocks: readonly BookBlock[], offsets: ReturnType<typeof wordOffsets>, word: number): string {
	let index = 0;
	while (index + 1 < blocks.length && offsets.before[index + 1]! <= word) index++;
	const page = pageOf(blocks[index]);
	return page !== undefined ? `page ${page}` : `${pct(word / Math.max(offsets.total, 1))} of the text`;
}

/** The confidence messages for a file's own contents, by format. */
function outlinePhrases(format: BookFormat) {
	if (format === "epub") {
		return {
			few: (n: number) => `The table of contents has only ${plural(n, "entry", "entries")}.`,
			unresolved: (k: number, n: number) => `Only ${k} of ${n} contents entries point to a place in the text.`,
			order: "The table of contents isn't in the text's order.",
			cover: (from: string, to: string, total: string) => `The table of contents covers only pages ${from}–${to} of ${total}.`,
			stop: (place: string) => `The table of contents stops at ${place}.`,
			start: (place: string) => `The table of contents starts only at ${place}.`,
			skip: (from: string, to: string) => `The table of contents skips from ${from} to ${to}.`,
			titles: (k: number, n: number) => `Only ${k} of ${n} contents titles appear in the text where they point.`,
		};
	}
	return {
		few: (n: number) => `The bookmarks have only ${plural(n, "entry", "entries")}.`,
		unresolved: (k: number, n: number) => `Only ${k} of ${n} bookmarks point to a place in the text.`,
		order: "The bookmarks aren't in the text's order.",
		cover: (from: string, to: string, total: string) => `The bookmarks cover only pages ${from}–${to} of ${total}.`,
		stop: (place: string) => `The bookmarks stop at ${place}.`,
		start: (place: string) => `The bookmarks start only at ${place}.`,
		skip: (from: string, to: string) => `The bookmarks skip from ${from} to ${to}.`,
		titles: (k: number, n: number) => `Only ${k} of ${n} bookmark titles appear in the text where they point.`,
	};
}

function outlineConfidence(input: StructureInput, offsets: ReturnType<typeof wordOffsets>): BookConfidence {
	const outline = input.outline ?? [];
	const say = outlinePhrases(input.format);
	const reasons: string[] = [];
	const resolved = outline.filter((entry): entry is SourceOutlineEntry & { block: number } => entry.block !== null);
	if (outline.length < 2) reasons.push(say.few(outline.length));
	if (resolved.length < outline.length * 0.9) reasons.push(say.unresolved(resolved.length, outline.length));
	let outOfOrder = 0;
	for (let i = 1; i < resolved.length; i++) if (resolved[i]!.block < resolved[i - 1]!.block) outOfOrder++;
	if (outOfOrder > resolved.length * 0.1) reasons.push(say.order);
	if (resolved.length > 0 && offsets.total > 0) {
		const starts = [...new Set(resolved.map((entry) => offsets.before[entry.block] ?? 0))].sort((a, b) => a - b);
		// A stretch is a gap only when it is both over a quarter of the book and
		// far longer than the outline's typical entry: a book of two halves is
		// fine, forty bookmarks in its first fifth are not.
		const spans = [...starts.slice(1).map((start, i) => start - starts[i]!), offsets.total - starts.at(-1)!].sort((a, b) => a - b);
		const typical = spans[Math.floor((spans.length - 1) / 2)] ?? offsets.total;
		const gap = (size: number) => starts.length >= 3 && size > offsets.total / 4 && size > typical * 4;
		const lastStart = starts.at(-1)!;
		const firstStart = starts[0]!;
		const page = (word: number) => placeOf(input.blocks, offsets, word);
		const lastPage = pageOf(input.blocks.at(-1));
		const firstPage = pageAt(input.blocks, offsets, firstStart);
		const lastStartPage = pageAt(input.blocks, offsets, lastStart);
		if (firstStart > offsets.total / 4) reasons.push(say.start(page(firstStart)));
		if (gap(offsets.total - lastStart)) {
			reasons.push(firstPage !== undefined && lastStartPage !== undefined && lastPage !== undefined
				? say.cover(firstPage, lastStartPage, lastPage)
				: say.stop(page(lastStart)));
		} else {
			for (let i = 1; i < starts.length; i++) {
				if (gap(starts[i]! - starts[i - 1]!)) {
					reasons.push(say.skip(page(starts[i - 1]!), page(starts[i]!)));
					break;
				}
			}
		}
		const found = resolved.filter((entry) => titleNear(input.blocks, entry.title, entry.block)).length;
		if (found < resolved.length * 0.7) reasons.push(say.titles(found, resolved.length));
	}
	return { level: reasons.length === 0 ? "confident" : "unsure", reasons };
}

/** Whether an entry's title (its first 60 characters) appears close to the
 *  block it points at. */
function titleNear(blocks: readonly BookBlock[], title: string, block: number): boolean {
	const wanted = normalizeBookText(title, { search: true }).text.slice(0, 60);
	if (wanted.length < 2) return true;
	const window = blocks.slice(Math.max(0, block - 3), block + 16).map((b) => normalizeBookText(b.text, { search: true }).text).join(" ");
	return window.includes(wanted);
}

function numberedConfidence(run: NumberedRun, offsets: ReturnType<typeof wordOffsets>): BookConfidence {
	const reasons: string[] = [];
	const found = run.entries.length;
	if (found < run.max * 0.95) reasons.push(`The paragraph numbers have gaps: ${found.toLocaleString("en-US")} of 1–${run.max.toLocaleString("en-US")} found.`);
	if (run.repeats > found * 0.05) reasons.push(`Some paragraph numbers repeat or run backwards (${plural(run.repeats, "time")}), for example in notes or lists.`);
	const first = run.entries[0];
	if (first && (offsets.before[first.block] ?? 0) > offsets.total / 4) reasons.push("The numbered paragraphs start late in the text.");
	return { level: reasons.length === 0 ? "confident" : "unsure", reasons };
}

const HEADINGS_REASON = "The contents were guessed from the text's headings.";
const APP_MADE_REASON = "No contents, headings or numbered paragraphs were found, so the app divided the text into parts of about 2,000 words.";

function describe(method: BookStructureMethod, nodes: readonly BookNode[]): string {
	const paragraphs = nodes.filter((node) => node.kind === "paragraph");
	const sections = nodes.filter((node) => node.kind !== "paragraph" && node.kind !== "app-part");
	const range = paragraphs.length > 0 ? `${paragraphs[0]!.label}–${paragraphs.at(-1)!.label}` : "";
	switch (method) {
		case "app-made": return `${plural(nodes.length, "part")} of about 2,000 words`;
		case "numbered": return sections.length > 0 ? `${range} under ${plural(sections.length, "heading")}` : range;
		case "headings": return plural(sections.length, "heading");
		case "outline":
		case "model":
			return range ? `${plural(sections.length, "entry", "entries")}, ${range} within them` : plural(sections.length, "entry", "entries");
	}
}

/**
 * Every structure the import can offer, in order of preference (the file's
 * own contents, numbered paragraphs, headings, app-made parts), each with
 * its confidence. Numbered paragraphs that are confident nest inside the
 * file's contents too. App-made parts are always offered when there is text.
 */
export function structureCandidates(input: StructureInput): BookCandidate[] {
	const { blocks } = input;
	if (blocks.length === 0) return [];
	const offsets = wordOffsets(blocks);
	const run = findNumberedRun(blocks);
	const numbered = run.entries.length >= 10 ? numberedConfidence(run, offsets) : null;
	const headings = headingHeads(blocks);
	const candidates: BookCandidate[] = [];
	const make = (method: BookStructureMethod, heads: Head[], confidence: BookConfidence) => {
		const nodes = nodesFromHeads(heads, blocks);
		if (nodes.length > 0) candidates.push({ method, confidence, description: describe(method, nodes), nodes });
	};
	if (input.outline && input.outline.length > 0) {
		const entries = input.outline.filter((entry) => entry.block !== null && entry.title.trim());
		const heads: Head[] = entries.map((entry) => ({
			block: entry.block!,
			level: entry.level,
			label: labelForTitle(entry.title),
			title: entry.title.replace(/\s+/g, " ").trim(),
			kind: kindForTitle(entry.title),
		}));
		const deepest = Math.max(1, ...heads.map((head) => head.level));
		make("outline", numbered?.level === "confident" ? [...heads, ...paragraphHeads(run, deepest + 1)] : heads, outlineConfidence(input, offsets));
	}
	if (numbered) {
		const deepest = Math.max(1, ...headings.map((head) => head.level));
		make("numbered", [...headings, ...paragraphHeads(run, deepest + 1)], numbered);
	}
	if (headings.length >= 2) make("headings", headings, { level: "unsure", reasons: [HEADINGS_REASON] });
	make("app-made", appParts(blocks), { level: "unsure", reasons: [APP_MADE_REASON] });
	return candidates;
}

/** The candidate an import shows first: the first confident one (the
 *  file's contents, then numbered paragraphs), else the first offered. */
export function chooseCandidate(candidates: readonly BookCandidate[]): BookCandidate | undefined {
	return candidates.find((candidate) => candidate.confidence.level === "confident") ?? candidates[0];
}

// ─── the optional model contents pass (item 2) ─────────────────────────────

/** One candidate heading line the contents pass reads. */
export interface DigestLine {
	block: number;
	/** The page label (or number) the line is on, when the text has pages. */
	page?: string;
	/** Set in larger type: a heading block found by the converter. */
	larger: boolean;
	/** The line, shortened to DIGEST_LINE_CHARS. */
	text: string;
}

export interface StructureDigest {
	/** The lines kept, in book order. */
	lines: DigestLine[];
	/** Candidate lines left out to keep the digest under its cap. */
	omitted: number;
}

/** Characters of one line in the digest. */
const DIGEST_LINE_CHARS = 120;
/** A paragraph this short (and of few words) may be a heading set as text. */
const SHORT_LINE_CHARS = 80;
const SHORT_LINE_WORDS = 12;
const CHAPTER_WORD = /^(?:chapter|part|book|section|lecture|appendix|preface|introduction|conclusion|epilogue|prologue|foreword|afterword)\b/i;

/** How a digest line reads: "[12] (p. 14, larger type) Chapter 2 Being". */
export function digestLineText(line: DigestLine): string {
	const notes = [line.page !== undefined ? `p. ${line.page}` : "", line.larger ? "larger type" : ""].filter(Boolean);
	return `[${line.block}]${notes.length > 0 ? ` (${notes.join(", ")})` : ""} ${line.text}`;
}

/** Evenly spread lines (in their order) whose texts fit `budget` characters. */
function spread(lines: readonly DigestLine[], budget: number): DigestLine[] {
	const size = (line: DigestLine) => digestLineText(line).length + 1;
	const total = lines.reduce((sum, line) => sum + size(line), 0);
	if (total <= budget) return [...lines];
	let count = Math.floor(lines.length * budget / total);
	while (count > 0) {
		const picked = Array.from({ length: count }, (_, i) => lines[Math.floor(i * lines.length / count)]!);
		if (picked.reduce((sum, line) => sum + size(line), 0) <= budget) return picked;
		count--;
	}
	return [];
}

/**
 * The digest the optional contents pass reads (decision 9): candidate
 * heading lines with their block ids and pages, never the whole book.
 * Strong candidates are the converter's headings (larger type) and short
 * lines that start like a chapter or a numbered section; weak ones are
 * other short lines. Under the cap (about `capTokens`), strong lines are
 * kept first and the rest spread evenly over the book.
 */
export function structureDigest(blocks: readonly BookBlock[], capTokens = 8_000): StructureDigest {
	const strong: DigestLine[] = [];
	const weak: DigestLine[] = [];
	for (const block of blocks) {
		const text = block.text.replace(/\s+/g, " ").trim();
		if (!text || text.length > 150) continue;
		const short = text.length <= SHORT_LINE_CHARS && wordCount(text) <= SHORT_LINE_WORDS;
		const heading = block.kind === "heading";
		const patterned = CHAPTER_WORD.test(text) || (short && NUMBERING.test(text));
		if (!heading && !patterned && !short) continue;
		const page = pageOf(block);
		const line: DigestLine = {
			block: block.id,
			...(page !== undefined ? { page } : {}),
			larger: heading,
			text: text.length <= DIGEST_LINE_CHARS ? text : `${text.slice(0, DIGEST_LINE_CHARS - 1).trimEnd()}…`,
		};
		(heading || patterned ? strong : weak).push(line);
	}
	const budget = capTokens * BOOK_CHARS_PER_TOKEN;
	const keptStrong = spread(strong, budget);
	const used = keptStrong.reduce((sum, line) => sum + digestLineText(line).length + 1, 0);
	const keptWeak = keptStrong.length === strong.length ? spread(weak, budget - used) : [];
	const lines = [...keptStrong, ...keptWeak].sort((a, b) => a.block - b.block);
	return { lines, omitted: strong.length + weak.length - lines.length };
}

/** A heading the contents pass chose: a digest block, its level and label. */
export interface ModelHeading {
	block: number;
	level: number;
	label: string;
	title: string;
}

const MODEL_REASON = "The model chose these contents from the text's likely heading lines.";

/**
 * The `model` candidate from the contents pass's headings. Like the file's
 * own contents, confident numbered paragraphs nest inside them. It is
 * always unsure: the learner reviews it like any other candidate.
 */
export function modelCandidate(blocks: readonly BookBlock[], headings: readonly ModelHeading[]): BookCandidate | null {
	const heads: Head[] = headings.map((heading) => ({
		block: heading.block,
		level: heading.level,
		label: heading.label,
		title: heading.title,
		kind: kindForTitle(heading.title),
	}));
	const run = findNumberedRun(blocks);
	const numbered = run.entries.length >= 10 && numberedConfidence(run, wordOffsets(blocks)).level === "confident";
	const deepest = Math.max(1, ...heads.map((head) => head.level));
	const nodes = nodesFromHeads(numbered ? [...heads, ...paragraphHeads(run, deepest + 1)] : heads, blocks);
	if (nodes.length === 0) return null;
	return { method: "model", confidence: { level: "unsure", reasons: [MODEL_REASON] }, description: describe("model", nodes), nodes };
}

// ─── locations ──────────────────────────────────────────────────────────────

export type BookLocation =
	| { ok: true; kind: "nodes"; range: BookRange; firstBlock: number; lastBlock: number; label: string }
	| { ok: true; kind: "pages"; firstBlock: number; lastBlock: number; label: string }
	| { ok: true; kind: "blocks"; firstBlock: number; lastBlock: number; label: string }
	| { ok: false; error: string };

const RANGE_SEPARATOR = /[\u2013\u2014-]|\s+to\s+/g;
const PAGE_REF = /^(?:pp?\.\s*|pp?\s+|pages?\s+)([0-9]+|[ivxlcdm]+)(?:\s*[\u2013\u2014-]\s*([0-9]+|[ivxlcdm]+))?$/i;
/** Block numbers (item 4): where a long read_section continues. */
const BLOCK_REF = /^blocks?\s+([0-9]+)(?:\s*[\u2013\u2014-]\s*([0-9]+))?$/i;

/** A node as lines show it: its title when that starts with the label, else label and title. */
export function displayNode(node: BookNode): string {
	if (!node.title) return node.label;
	if (node.title === node.label || node.title.startsWith(node.label)) return node.title;
	return `${node.label} ${node.title}`;
}

/** The descendants of a node, in map order (the map is in preorder). */
function lastDescendantIndex(nodes: readonly BookNode[], index: number): number {
	const ids = new Set([nodes[index]!.id]);
	let last = index;
	for (let k = index + 1; k < nodes.length; k++) {
		const parent = nodes[k]!.parentId;
		if (parent === undefined || !ids.has(parent)) break;
		ids.add(nodes[k]!.id);
		last = k;
	}
	return last;
}

function findNode(nodes: readonly BookNode[], ref: string): { node: BookNode } | { error: string; ambiguous?: true } {
	const trimmed = ref.trim();
	if (/^n[0-9]+$/.test(trimmed)) {
		const node = nodes.find((candidate) => candidate.id === trimmed);
		return node ? { node } : { error: `No section has the id "${trimmed}".` };
	}
	if (/^[0-9]{1,4}$/.test(trimmed) && nodes.some((node) => node.label === `§${trimmed}`)) return findNode(nodes, `§${trimmed}`);
	const key = (text: string) => normalizeBookText(text, { search: true }).text.replace(/^§\s*/, "§").replace(/\.$/, "");
	const wanted = key(trimmed);
	for (const field of ["label", "title"] as const) {
		const matches = nodes.filter((node) => node[field] && key(node[field]) === wanted);
		if (matches.length === 1) return { node: matches[0]! };
		if (matches.length > 1) {
			const list = matches.slice(0, 5).map((node) => `${node.id} (${pathOf(nodes, node)})`).join(", ");
			return { error: `"${trimmed}" matches several sections: ${list}. Use an id.`, ambiguous: true };
		}
	}
	return { error: `"${trimmed}" isn't a section of this book. Use a label or id from the map.` };
}

/** A node's place: its ancestors' labels and its own display text. */
export function pathOf(nodes: readonly BookNode[], node: BookNode): string {
	const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
	const parts = [displayNode(node)];
	let parent = node.parentId ? byId.get(node.parentId) : undefined;
	while (parent) {
		parts.unshift(parent.label);
		parent = parent.parentId ? byId.get(parent.parentId) : undefined;
	}
	return parts.join(" › ");
}

function pageBlocks(blocks: readonly BookBlock[], from: string, to: string): { firstBlock: number; lastBlock: number } | null {
	const ordinal = (label: string) => {
		if (/^[0-9]+$/.test(label)) return Number(label);
		if (!/^[ivxlcdm]+$/i.test(label)) return NaN;
		const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
		const digits = [...label.toLowerCase()].map((digit) => values[digit]!);
		return digits.reduce((sum, value, i) => sum + (value < (digits[i + 1] ?? 0) ? -value : value), 0);
	};
	const start = ordinal(from);
	const end = ordinal(to);
	if (end < start || /^[0-9]/.test(from) !== /^[0-9]/.test(to)) return null;
	const inPrintedRange = (label: string | undefined) => label !== undefined
		&& /^[0-9]/.test(label) === /^[0-9]/.test(from)
		&& ordinal(label) >= start && ordinal(label) <= end;
	// Printed labels win for the entire request, including labels on page breaks.
	// A partial printed range must not borrow an endpoint from physical numbering.
	const printed = blocks.some((block) => inPrintedRange(block.pageLabel) || block.breaks?.some((brk) => inPrintedRange(brk.pageLabel)));
	const matches = (block: BookBlock, page: string) => {
		const at = (entry: { page?: number; pageLabel?: string }) => printed
			? (entry.pageLabel ?? String(entry.page)).toLowerCase() === page.toLowerCase()
			: String(entry.page) === page;
		return at(block) || block.breaks?.some(at);
	};
	const first = blocks.findIndex((block) => matches(block, from));
	if (first < 0) return null;
	let last = -1;
	for (let i = blocks.length - 1; i >= first; i--) if (matches(blocks[i]!, to)) { last = i; break; }
	return last < 0 ? null : { firstBlock: first, lastBlock: last };
}

/**
 * Resolve a location as agents and links write it: a node id ("n12"), a
 * label ("§187", "IV", "Chapter 2"), a title, a range of either ("§178–§196",
 * "§178-196", "n3 to n9"), pages ("p. 114", "pp. 114–116"), or block
 * numbers ("blocks 341–512", which a long read_section names to continue).
 */
export function resolveBookLocation(nodes: readonly BookNode[], blocks: readonly BookBlock[], input: string): BookLocation {
	const text = input.trim();
	if (!text) return { ok: false, error: "Give a location: a section label or id from the map, or pages (\"p. 114\")." };
	const block = text.match(BLOCK_REF);
	if (block) {
		const first = Number(block[1]);
		const last = block[2] === undefined ? first : Number(block[2]);
		if (last < first) return { ok: false, error: `The blocks end (${last}) before they start (${first}).` };
		if (last >= blocks.length) return { ok: false, error: `This book's blocks run from 0 to ${blocks.length - 1}.` };
		return { ok: true, kind: "blocks", firstBlock: first, lastBlock: last, label: first === last ? `block ${first}` : `blocks ${first}–${last}` };
	}
	const page = text.match(PAGE_REF);
	if (page) {
		const from = page[1]!;
		const to = page[2] ?? from;
		const found = pageBlocks(blocks, from, to);
		if (!found) return { ok: false, error: `This book has no page "${from === to ? from : `${from}–${to}`}".` };
		return { ok: true, kind: "pages", ...found, label: from === to ? `p. ${from}` : `pp. ${from}–${to}` };
	}
	const whole = findNode(nodes, text);
	if ("error" in whole && whole.ambiguous) return { ok: false, error: whole.error };
	let fromRef = text;
	let toRef = text;
	if ("error" in whole) {
		const ranges: { from: string; to: string }[] = [];
		let endpointError: { error: string; score: number } | undefined;
		for (const separator of text.matchAll(RANGE_SEPARATOR)) {
			const left = text.slice(0, separator.index).trim();
			const right = text.slice(separator.index + separator[0].length).trim();
			const to = /^[0-9]+$/.test(right) && /^§/.test(left) ? `§${right}` : right;
			const fromNode = findNode(nodes, left);
			const toNode = findNode(nodes, to);
			if ("node" in fromNode && "node" in toNode) ranges.push({ from: left, to });
			else {
				const error = "error" in fromNode ? fromNode.error : "error" in toNode ? toNode.error : undefined;
				const score = Number("node" in fromNode) + Number("node" in toNode) + (separator[0] === "-" ? 0 : 0.5);
				if (error !== undefined && (endpointError === undefined || score > endpointError.score)) endpointError = { error, score };
			}
		}
		if (ranges.length > 1) return { ok: false, error: `"${text}" matches several ranges. Use section ids with "to".` };
		if (ranges.length === 0) return { ok: false, error: endpointError?.error ?? whole.error };
		fromRef = ranges[0]!.from;
		toRef = ranges[0]!.to;
	}
	const from = findNode(nodes, fromRef);
	if ("error" in from) return { ok: false, error: from.error };
	const to = fromRef === toRef ? from : findNode(nodes, toRef);
	if ("error" in to) return { ok: false, error: to.error };
	const fromIndex = nodes.indexOf(from.node);
	const toIndex = nodes.indexOf(to.node);
	if (toIndex < fromIndex) return { ok: false, error: `The range ends (${to.node.label}) before it starts (${from.node.label}).` };
	const end = nodes[lastDescendantIndex(nodes, toIndex)]!;
	return {
		ok: true,
		kind: "nodes",
		range: { from: from.node.id, to: to.node.id },
		firstBlock: from.node.firstBlock,
		lastBlock: Math.max(to.node.lastBlock, end.lastBlock),
		label: from.node === to.node ? from.node.label : `${from.node.label}–${to.node.label}`,
	};
}

// ─── outline and detail texts ──────────────────────────────────────────────

function outlineLine(node: BookNode, hidden: number, withTerms: boolean): string {
	const indent = "  ".repeat(node.level - 1);
	const summary = node.summary ? ` — ${node.summary}` : "";
	const more = hidden > 0 ? ` (${plural(hidden, "section")})` : "";
	const terms = withTerms && node.terms && node.terms.length > 0 ? `\n${indent}  Terms: ${node.terms.join(", ")}` : "";
	return `${indent}[${node.id}] ${displayNode(node)}${summary}${more}${terms}`;
}

function descendantCounts(nodes: readonly BookNode[]): Map<string, number> {
	const counts = new Map<string, number>();
	const byId = new Map(nodes.map((node) => [node.id, node]));
	for (const node of nodes) {
		let parent = node.parentId ? byId.get(node.parentId) : undefined;
		while (parent) {
			counts.set(parent.id, (counts.get(parent.id) ?? 0) + 1);
			parent = parent.parentId ? byId.get(parent.parentId) : undefined;
		}
	}
	return counts;
}

/** Render nodes down to `depth`, counting what lies below it. */
function renderToDepth(nodes: readonly BookNode[], depth: number, withTerms: boolean): string[] {
	const counts = descendantCounts(nodes);
	const lines: string[] = [];
	for (const node of nodes) {
		if (node.level > depth) continue;
		const hidden = node.level === depth ? counts.get(node.id) ?? 0 : 0;
		lines.push(outlineLine(node, hidden, withTerms));
	}
	return lines;
}

/** How a set of nodes fitted its budget. `collapsed` are the shown nodes
 *  whose subsections were left out (counted instead); `hidden` are the
 *  nodes cut from the end when even the top level didn't fit. */
export interface FittedBookNodes {
	text: string;
	complete: boolean;
	collapsed: BookNode[];
	hidden: BookNode[];
}

/** The deepest rendering that fits the budget; at worst the top level, cut short. */
export function fitBookNodes(nodes: readonly BookNode[], budgetTokens: number, withTerms: boolean): FittedBookNodes {
	if (nodes.length === 0) return { text: "", complete: true, collapsed: [], hidden: [] };
	const budget = budgetTokens * BOOK_CHARS_PER_TOKEN;
	// A selected paragraph and a selected chapter are both roots, regardless
	// of their levels in the whole book.
	const depths = new Map<string, number>();
	const relativeNodes = nodes.map((node) => {
		const level = (node.parentId ? depths.get(node.parentId) ?? 0 : 0) + 1;
		depths.set(node.id, level);
		return { ...node, level };
	});
	const original = new Map(nodes.map((node) => [node.id, node]));
	const maxDepth = Math.max(...depths.values());
	const counts = descendantCounts(relativeNodes);
	for (let depth = maxDepth; depth >= 1; depth--) {
		const lines = renderToDepth(relativeNodes, depth, withTerms);
		const text = lines.join("\n");
		if (text.length <= budget || depth === 1) {
			const shown = relativeNodes.filter((node) => node.level <= depth);
			const collapsedOf = (list: typeof shown) => list.filter((node) => node.level === depth && (counts.get(node.id) ?? 0) > 0).map((node) => original.get(node.id)!);
			if (text.length <= budget) {
				const collapsed = collapsedOf(shown);
				return { text, complete: collapsed.length === 0, collapsed, hidden: [] };
			}
			const kept: string[] = [];
			let size = 0;
			for (const line of lines) {
				if (size + line.length + 1 > budget - 60) break;
				kept.push(line);
				size += line.length + 1;
			}
			const notice = `… (${plural(lines.length - kept.length, "more section")}; open them with book_map)`;
			return {
				text: kept.length > 0 ? `${kept.join("\n")}\n${notice}` : notice,
				complete: false,
				collapsed: collapsedOf(shown.slice(0, kept.length)),
				hidden: shown.slice(kept.length).map((node) => original.get(node.id)!),
			};
		}
	}
	return { text: "", complete: true, collapsed: [], hidden: [] };
}

/** The whole-book outline every turn receives (decision 2): whole levels
 *  from the top down while they fit, deeper ones counted. */
export function bookOutlineText(nodes: readonly BookNode[], budgetTokens = 3_000): string {
	return fitBookNodes(nodes, budgetTokens, false).text;
}

/** The nodes inside some ranges, with their descendants, in map order. */
export function nodesInRanges(nodes: readonly BookNode[], ranges: readonly BookRange[]): BookNode[] {
	const keep = new Set<number>();
	for (const range of ranges) {
		const from = nodes.findIndex((node) => node.id === range.from);
		const to = nodes.findIndex((node) => node.id === range.to);
		if (from < 0 || to < from) continue;
		const end = lastDescendantIndex(nodes, to);
		for (let k = from; k <= end; k++) keep.add(k);
	}
	return [...keep].sort((a, b) => a - b).map((index) => nodes[index]!);
}

/** A unit's reading in full detail (decision 2): summaries and key terms
 *  down to the leaves while they fit, one level less otherwise. */
export function bookDetailText(nodes: readonly BookNode[], ranges: readonly BookRange[], budgetTokens = 4_000): string {
	return fitBookNodes(nodesInRanges(nodes, ranges), budgetTokens, true).text;
}

/** "§178–§196 (Lordship and bondage)": a range as the cards show it. */
export function rangeText(nodes: readonly BookNode[], range: BookRange): string {
	const from = nodes.find((node) => node.id === range.from);
	const to = nodes.find((node) => node.id === range.to);
	if (!from || !to) return "(unknown range)";
	const label = from === to ? from.label : `${from.label}–${to.label}`;
	// Name the range by the innermost titled node containing both ends.
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const ancestors = (node: BookNode) => {
		const list: BookNode[] = [node];
		let parent = node.parentId ? byId.get(node.parentId) : undefined;
		while (parent) { list.push(parent); parent = parent.parentId ? byId.get(parent.parentId) : undefined; }
		return list;
	};
	const shared = ancestors(from).find((node) => ancestors(to).includes(node) && node.title);
	const name = shared && shared.title !== label ? shared.title.replace(new RegExp(`^${shared.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.?\\s*`), "") : "";
	return name && name !== label ? `${label} (${name})` : label;
}

/** Whether two maps hold the same contents. Summaries and key terms are
 *  not contents: accepting an unchanged candidate keeps those already
 *  written. A new model pass can change the contents without changing the
 *  method, so callers compare contents, never only methods. */
export function sameBookContents(a: readonly BookNode[], b: readonly BookNode[]): boolean {
	return a.length === b.length && a.every((node, i) => {
		const other = b[i]!;
		return node.id === other.id && node.parentId === other.parentId
			&& node.label === other.label && node.title === other.title
			&& node.kind === other.kind && node.level === other.level
			&& node.firstBlock === other.firstBlock && node.lastBlock === other.lastBlock
			&& node.pages?.from === other.pages?.from && node.pages?.to === other.pages?.to;
	});
}

// ─── reading and search (item 3) ───────────────────────────────────────────

/** The deepest node whose text holds a block (the map is in preorder, so
 *  the last match is the deepest). */
export function nodeAtBlock(nodes: readonly BookNode[], block: number): BookNode | undefined {
	let found: BookNode | undefined;
	for (const node of nodes) {
		if (node.firstBlock > block) break;
		if (node.lastBlock >= block) found = node;
	}
	return found;
}

/** The page (its printed label when it has one) at an offset in a block. */
export function pageAtOffset(block: BookBlock, offset: number): string | undefined {
	let page = block.pageLabel ?? (block.page !== undefined ? String(block.page) : undefined);
	for (const brk of block.breaks ?? []) {
		if (brk.at > offset) break;
		page = brk.pageLabel ?? String(brk.page);
	}
	return page;
}

/** How many blocks a reader window holds at most, and roughly how much text. */
export const BOOK_WINDOW_BLOCKS = 120;
export const BOOK_WINDOW_CHARS = 60_000;
/** Blocks shown above a jump target at most, so it isn't flush with the top. */
export const BOOK_WINDOW_LEAD = 4;

export type BookWindowRequest = { from: number } | { before: number } | { around: number };

/**
 * A window of blocks for the reader, as inclusive indexes (`to < from` when
 * empty): forward from a block, backward from just before one, or around a
 * jump target. A window ends at BOOK_WINDOW_BLOCKS blocks or once
 * BOOK_WINDOW_CHARS characters are reached, and always holds at least one
 * block when any is in range.
 *
 * Around a target, the window starts up to BOOK_WINDOW_LEAD blocks above it,
 * fewer when those blocks would use up the character budget: the target is
 * always in the window.
 */
export function bookTextWindow(blocks: readonly BookBlock[], request: BookWindowRequest): { from: number; to: number } {
	const total = blocks.length;
	const forward = (start: number) => {
		const from = Math.max(0, start);
		let to = from - 1;
		let chars = 0;
		while (to + 1 < total && to + 1 - from < BOOK_WINDOW_BLOCKS && (to < from || chars < BOOK_WINDOW_CHARS)) {
			to++;
			chars += blocks[to]!.text.length;
		}
		return { from, to };
	};
	if ("from" in request) return forward(request.from);
	if ("around" in request) {
		const target = Math.min(Math.max(0, request.around), Math.max(0, total - 1));
		// The lead stays under the budget, so forward() still reaches the target.
		let start = target;
		let lead = 0;
		while (start > 0 && target - start < BOOK_WINDOW_LEAD && lead + blocks[start - 1]!.text.length < BOOK_WINDOW_CHARS) {
			start--;
			lead += blocks[start]!.text.length;
		}
		return forward(start);
	}
	const to = Math.min(request.before, total) - 1;
	let from = to + 1;
	let chars = 0;
	while (from - 1 >= 0 && to - (from - 1) < BOOK_WINDOW_BLOCKS && (from > to || chars < BOOK_WINDOW_CHARS)) {
		from--;
		chars += blocks[from]!.text.length;
	}
	return { from, to };
}

export interface BookSearchHit {
	block: number;
	/** The deepest section holding the match. */
	nodeId?: string;
	label?: string;
	/** The page at the match (its printed label when it has one). */
	page?: string;
	/** The match in the block's stored text, as UTF-16 offsets. */
	start: number;
	end: number;
	/** The stored text around the match, cut at spaces, with "…" where cut. */
	before: string;
	match: string;
	after: string;
}

export interface BookSearchResult {
	hits: BookSearchHit[];
	/** Every match in the book, also those past the limit. */
	total: number;
}

const SNIPPET_CHARS = 80;

/** The search form of every block, computed once per book and cached by
 *  the caller (the plan's performance check: per-query normalization of a
 *  600-page book costs about 100× more). */
export function searchableBlocks(blocks: readonly BookBlock[]): string[] {
	return blocks.map((block) => normalizeBookText(block.text, { search: true }).text);
}

/** Map a match in a block's search form back to its stored text. */
function storedSpan(text: string, at: number, length: number): { start: number; end: number } {
	const { map } = normalizeBookText(text, { search: true });
	const start = map[at] ?? 0;
	let end = (map[at + length - 1] ?? start) + 1;
	// A surrogate pair, or combining marks search dropped, belong to the match.
	if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]!)) end++;
	while (end < text.length && /\p{M}/u.test(text[end]!)) end++;
	return { start, end };
}

function snippet(text: string, start: number, end: number): Pick<BookSearchHit, "before" | "match" | "after"> {
	let from = Math.max(0, start - SNIPPET_CHARS);
	if (from > 0) { const space = text.indexOf(" ", from); from = space >= 0 && space < start ? space + 1 : from; }
	let to = Math.min(text.length, end + SNIPPET_CHARS);
	if (to < text.length) { const space = text.lastIndexOf(" ", to); to = space > end ? space : to; }
	return {
		before: `${from > 0 ? "…" : ""}${text.slice(from, start)}`,
		match: text.slice(start, end),
		after: `${text.slice(end, to)}${to < text.length ? "…" : ""}`,
	};
}

/**
 * Search a book: case- and accent-insensitive, typographic marks folded
 * (normalizeBookText), the query matched as one phrase within a block. Hits
 * come in book order, up to `limit`; `total` counts them all.
 */
export function searchBookBlocks(
	blocks: readonly BookBlock[],
	searchable: readonly string[],
	nodes: readonly BookNode[],
	query: string,
	limit = 100,
): BookSearchResult {
	const wanted = normalizeBookText(query, { search: true }).text;
	const hits: BookSearchHit[] = [];
	let total = 0;
	if (!wanted) return { hits, total };
	for (let index = 0; index < searchable.length; index++) {
		const haystack = searchable[index]!;
		let at = haystack.indexOf(wanted);
		while (at >= 0) {
			total++;
			if (hits.length < limit) {
				const block = blocks[index]!;
				const span = storedSpan(block.text, at, wanted.length);
				const node = nodeAtBlock(nodes, block.id);
				const page = pageAtOffset(block, span.start);
				hits.push({
					block: block.id,
					...(node ? { nodeId: node.id, label: node.label } : {}),
					...(page !== undefined ? { page } : {}),
					...span,
					...snippet(block.text, span.start, span.end),
				});
			}
			at = haystack.indexOf(wanted, at + wanted.length);
		}
	}
	return { hits, total };
}
