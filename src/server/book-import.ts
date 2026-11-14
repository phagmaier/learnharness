/**
 * Book converters (fork plan 05 item 1): a PDF (text layer only), EPUB,
 * plain text or Markdown file becomes ordered text blocks, plus the file's
 * own contents when it has them. No model is involved.
 *
 * - PDF: the notes converter's page lines (pdf-markdown.ts), then running
 *   heads and page numbers are dropped and wrapped lines become paragraphs,
 *   continuing across pages. A line-end hyphen keeps its hyphen only when the
 *   joined form appears hyphenated elsewhere in the book.
 * - EPUB: a minimal zip reader, the OPF's spine, the EPUB 3 nav or EPUB 2
 *   NCX for the contents, and each XHTML document walked into blocks with
 *   linkedom. Print page marks (epub:type="pagebreak") become page labels.
 * - Text and Markdown: paragraphs at blank lines; Markdown headings, or
 *   chapter-like lines in plain text, become headings.
 *
 * Refusals carry the learner-facing reason (BookImportRefusal).
 */
import * as path from "node:path";
import { DOMParser, parseHTML } from "linkedom";
import type { BookBlock, BookFormat } from "../core/contracts.ts";
import { countsLookGarbled, garbledCounts, normalizeBookText, type SourceOutlineEntry } from "../core/book.ts";
import { pageLines, type PdfLine, type PdfPageLines } from "../agent/subagents/pdf-markdown.ts";
import { withPdfDocument } from "../agent/subagents/pdf-ops.ts";
import { openZip, ZipError, type ZipReader } from "./unzip.ts";

export class BookImportRefusal extends Error {}

export const MAX_BOOK_BYTES = 100 * 1024 * 1024;
export const MAX_BOOK_PAGES = 3_000;

export const BOOK_REFUSALS = {
	type: "This file type isn't supported. Use PDF, EPUB, text, or Markdown.",
	tooBig: "Too big. Max 100 MB.",
	tooLong: "Too long. Max 3,000 pages.",
	noTextLayer: "This PDF has no text layer. OCR isn't supported.",
	garbled: "This PDF's text is garbled, probably because of how its fonts are encoded. OCR isn't supported, so it can't be imported.",
	drm: "This EPUB is protected (DRM) and can't be read.",
	notText: "This file isn't plain text.",
	unreadable: "Could not open this file.",
	empty: "This file has no readable text.",
} as const;

export interface ConvertedBook {
	title?: string;
	author?: string;
	pageCount?: number;
	blocks: BookBlock[];
	outline?: SourceOutlineEntry[];
	notice?: string;
}

export interface ConvertOptions {
	signal?: AbortSignal;
	/** Progress for the library row ("Importing… page 120 of 600"). */
	onProgress?: (done: number, total: number) => void;
}

const EXTENSIONS: Record<string, BookFormat> = { pdf: "pdf", epub: "epub", txt: "text", text: "text", md: "markdown", markdown: "markdown" };

/** The format by extension, checked against the file's opening bytes. */
export function bookFormat(fileName: string, bytes: Uint8Array): BookFormat {
	const extension = path.extname(fileName).slice(1).toLowerCase();
	const format = EXTENSIONS[extension];
	if (!format) throw new BookImportRefusal(BOOK_REFUSALS.type);
	const starts = (text: string) => [...text].every((ch, i) => bytes[i] === ch.charCodeAt(0));
	if (format === "pdf" && !starts("%PDF-")) throw new BookImportRefusal(BOOK_REFUSALS.unreadable);
	if (format === "epub" && !starts("PK")) throw new BookImportRefusal(BOOK_REFUSALS.unreadable);
	return format;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Ids in order, empty blocks dropped. */
function finish(blocks: Omit<BookBlock, "id">[]): BookBlock[] {
	return blocks.filter((block) => block.text.trim()).map((block, id) => ({ ...block, id }));
}

// ─── line joining and hyphens ───────────────────────────────────────────────

const SOFT = "\u00AD";
const TERMINAL = /[.!?:;"\u201D\u2019)\]]$/;
const NUMBERED_START = /^(?:[§¶]\s*[0-9]{1,4}\b|[0-9]{1,4}\.\s+\S)/;

/** Join a wrapped line onto text: a line-end hyphen before a lowercase
 *  letter becomes a soft-hyphen marker, resolved once the whole book is known. */
function joinLine(text: string, line: string): string {
	if (!text) return line;
	if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(line)) return `${text.slice(0, -1)}${SOFT}${line}`;
	return `${text} ${line}`;
}

/** Resolve soft-hyphen markers: keep the hyphen when the book writes the
 *  joined word hyphenated elsewhere, else drop it. Page-break offsets move
 *  with the text. */
function resolveHyphens(blocks: Omit<BookBlock, "id">[]): void {
	const hyphenated = new Set<string>();
	for (const block of blocks) {
		for (const word of block.text.match(/\p{L}+(?:-\p{L}+)+/gu) ?? []) hyphenated.add(word.toLowerCase());
	}
	for (const block of blocks) {
		if (!block.text.includes(SOFT)) continue;
		let out = "";
		let last = 0;
		const shifts: { at: number; delta: number }[] = [];
		for (const match of block.text.matchAll(/(\p{L}+)\u00AD(\p{L}+)/gu)) {
			const index = match.index!;
			const keep = hyphenated.has(`${match[1]}-${match[2]}`.toLowerCase());
			out += block.text.slice(last, index) + match[1] + (keep ? "-" : "") + match[2];
			if (!keep) shifts.push({ at: index + match[1]!.length, delta: -1 });
			last = index + match[0].length;
		}
		out += block.text.slice(last);
		block.text = out.replaceAll(SOFT, "");
		if (block.breaks) {
			block.breaks = block.breaks.map((brk) => ({ ...brk, at: brk.at + shifts.filter((shift) => shift.at < brk.at).reduce((sum, shift) => sum + shift.delta, 0) }));
		}
	}
}

// ─── PDF ────────────────────────────────────────────────────────────────────

type TextPage = Extract<PdfPageLines, { kind: "text" }>;

const marginKey = (text: string) => text.toLowerCase().replace(/[0-9]+/g, "#").replace(/\b[ivxlcdm]+\b/g, "#").replace(/\s+/g, " ").trim();
const PAGE_NUMBER_ONLY = /^[-\u2013\u2014\s]*(?:[0-9]{1,5}|[ivxlcdm]{1,7})[-\u2013\u2014\s]*$/i;

/** Lines in a page's top or bottom two positions that repeat on many pages
 *  (running heads and feet) or are only a page number. Real headings (set
 *  well above body size) are never dropped. */
function dropMargins(pages: TextPage[]): Map<number, PdfLine[]> {
	const edges = (page: TextPage) => {
		const byY = page.lines.filter((line) => !line.rotated).sort((a, b) => b.y - a.y);
		return new Set([...byY.slice(0, 2), ...byY.slice(-2)]);
	};
	const counts = new Map<string, Set<number>>();
	for (const page of pages) {
		for (const line of edges(page)) {
			const key = marginKey(line.text);
			if (!counts.has(key)) counts.set(key, new Set());
			counts.get(key)!.add(page.number);
		}
	}
	const threshold = Math.max(3, pages.length * 0.2);
	const kept = new Map<number, PdfLine[]>();
	for (const page of pages) {
		const edge = edges(page);
		kept.set(page.number, page.lines.filter((line) => {
			if (line.rotated || !edge.has(line) || line.heading === 1 || line.heading === 2) return true;
			if (PAGE_NUMBER_ONLY.test(line.text)) return false;
			return (counts.get(marginKey(line.text))?.size ?? 0) < threshold;
		}));
	}
	return kept;
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

/** Rebuild one page's paragraphs onto the running block list. */
function addPage(blocks: Omit<BookBlock, "id">[], page: TextPage, lines: PdfLine[], pageLabel: string | undefined, startsAt: number[], priorLine: PdfLine | null): PdfLine | null {
	const body = lines.filter((line) => !line.heading && !line.rotated);
	const left = percentile(body.map((line) => line.x0), 0.1);
	const right = percentile(body.map((line) => line.x1), 0.9);
	const gaps: number[] = [];
	for (let i = 1; i < body.length; i++) {
		const gap = body[i - 1]!.y - body[i]!.y;
		if (gap > 0) gaps.push(gap);
	}
	const lineGap = percentile(gaps, 0.5);
	const pageFields = { page: page.number, ...(pageLabel ? { pageLabel } : {}) };
	let previous: PdfLine | null = null;
	let firstBody = true;
	startsAt[page.number] = blocks.length;
	for (const line of lines) {
		const current = blocks.at(-1);
		if (line.heading && line.text.length <= 150) {
			if (current?.kind === "heading" && current.page === page.number && previous?.heading === line.heading && previous.rotated === line.rotated && previous.y - line.y < line.size * 2) {
				current.text = `${current.text} ${line.text}`;
			} else {
				blocks.push({ kind: "heading", level: line.heading, text: line.text, ...pageFields });
			}
			previous = line;
			firstBody = false;
			continue;
		}
		const indented = line.x0 > left + line.size * 0.8;
		const numbered = NUMBERED_START.test(line.text);
		if (firstBody && current?.kind === "paragraph" && priorLine && !priorLine.rotated && !line.rotated && !TERMINAL.test(current.text) && !indented && !numbered) {
			// The paragraph continues from the previous page.
			current.text = joinLine(current.text, line.text);
			current.breaks = [...(current.breaks ?? []), { at: current.text.length - line.text.length, page: page.number, ...(pageLabel ? { pageLabel } : {}) }];
			if (startsAt[page.number] === blocks.length) startsAt[page.number] = blocks.length - 1;
			previous = line;
			firstBody = false;
			continue;
		}
		const breakHere = !current || current.kind !== "paragraph" || firstBody || previous === null || previous.heading !== 0
			|| previous.rotated !== line.rotated
			|| (lineGap > 0 && previous.y - line.y > lineGap * 1.6)
			|| (indented && !(previous.x0 > left + previous.size * 0.8))
			|| (previous.x1 < right - previous.size * 2.5 && TERMINAL.test(previous.text))
			|| (numbered && TERMINAL.test(current.text));
		if (breakHere) blocks.push({ kind: "paragraph", text: line.text, ...pageFields });
		else current.text = joinLine(current.text, line.text);
		previous = line;
		firstBody = false;
	}
	return previous;
}

interface RawOutlineItem { title: string; dest: unknown; items: RawOutlineItem[] }

async function convertPdf(bytes: Uint8Array, options: ConvertOptions): Promise<ConvertedBook> {
	try {
		return await withPdfDocument(bytes, async (doc) => {
			const pageCount = doc.numPages;
			if (pageCount > MAX_BOOK_PAGES) throw new BookImportRefusal(BOOK_REFUSALS.tooLong);
			const labels = await doc.getPageLabels().catch(() => null);
			const metadata = await doc.getMetadata().catch(() => null);
			const info = (metadata?.info ?? {}) as { Title?: unknown; Author?: unknown };
			const pages: PdfPageLines[] = [];
			for (let n = 1; n <= pageCount; n++) {
				pages.push(await pageLines(doc, n, options.signal));
				options.onProgress?.(n, pageCount);
				if (n % 4 === 0) await yieldToEventLoop();
			}
			const textPages = pages.filter((page): page is TextPage => page.kind === "text");
			if (textPages.length === 0) throw new BookImportRefusal(BOOK_REFUSALS.noTextLayer);
			// The whole-book passes below yield between steps, so a long book
			// doesn't hold the server (the plan's performance check).
			await yieldToEventLoop();
			const counts = { judged: 0, garbled: 0 };
			for (let at = 0; at < textPages.length; at += 32) {
				const chunk = garbledCounts(textPages.slice(at, at + 32).map((page) => page.lines.map((line) => line.text).join("\n")));
				counts.judged += chunk.judged;
				counts.garbled += chunk.garbled;
				await yieldToEventLoop();
			}
			if (countsLookGarbled(counts)) throw new BookImportRefusal(BOOK_REFUSALS.garbled);
			const kept = dropMargins(textPages);
			await yieldToEventLoop();
			const blocks: Omit<BookBlock, "id">[] = [];
			const startsAt: number[] = [];
			let priorLine: PdfLine | null = null;
			for (const [index, page] of textPages.entries()) {
				const label = labels?.[page.number - 1];
				priorLine = addPage(blocks, page, kept.get(page.number) ?? [], label && label !== String(page.number) ? label : undefined, startsAt, priorLine);
				if (index % 16 === 15) await yieldToEventLoop();
			}
			await yieldToEventLoop();
			resolveHyphens(blocks);
			await yieldToEventLoop();
			const nonEmpty = blocks.filter((block) => block.text.trim());
			if (nonEmpty.length === 0) throw new BookImportRefusal(BOOK_REFUSALS.noTextLayer);
			const finished = finish(blocks);
			// startsAt indexes the unfiltered list; map pages onto finished ids.
			const idOf = new Map<Omit<BookBlock, "id">, number>();
			let next = 0;
			for (const block of blocks) if (block.text.trim()) idOf.set(block, next++);
			const pageStart = (page: number): number | null => {
				for (let p = page; p <= pageCount; p++) {
					const index = startsAt[p];
					if (index === undefined) continue;
					for (let k = index; k < blocks.length; k++) {
						const id = idOf.get(blocks[k]!);
						if (id !== undefined) return id;
					}
				}
				return null;
			};
			const outline = await pdfOutline(doc, finished, pageStart);
			const skipped = pages.filter((page) => page.kind === "image-only").length;
			return {
				...(typeof info.Title === "string" && info.Title.trim() ? { title: info.Title.trim() } : {}),
				...(typeof info.Author === "string" && info.Author.trim() ? { author: info.Author.trim() } : {}),
				pageCount,
				blocks: finished,
				...(outline.length > 0 ? { outline } : {}),
				...(skipped > 0 ? { notice: `${skipped} ${skipped === 1 ? "page has" : "pages have"} no text and ${skipped === 1 ? "is" : "are"} skipped. OCR isn't supported.` } : {}),
			};
		}, options.signal);
	} catch (error) {
		if (error instanceof BookImportRefusal || (error instanceof Error && error.name === "AbortError")) throw error;
		throw new BookImportRefusal(BOOK_REFUSALS.unreadable);
	}
}

/** The bookmarks, each resolved to the block its page starts with, refined
 *  to the block on that page (or the next) whose text begins with its title. */
async function pdfOutline(
	doc: import("pdfjs-dist/legacy/build/pdf.mjs").PDFDocumentProxy,
	blocks: BookBlock[],
	pageStart: (page: number) => number | null,
): Promise<SourceOutlineEntry[]> {
	const raw = (await doc.getOutline().catch(() => null)) as RawOutlineItem[] | null;
	if (!raw) return [];
	const entries: SourceOutlineEntry[] = [];
	const pageOf = async (dest: unknown): Promise<number | null> => {
		try {
			const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
			if (!Array.isArray(explicit) || explicit.length === 0) return null;
			const target = explicit[0];
			if (typeof target === "number") return target + 1;
			return (await doc.getPageIndex(target as never)) + 1;
		} catch {
			return null;
		}
	};
	const walk = async (items: RawOutlineItem[], level: number) => {
		for (const item of items) {
			const title = String(item.title ?? "").replace(/\s+/g, " ").trim();
			const page = await pageOf(item.dest);
			let block = page === null ? null : pageStart(page);
			if (block !== null && page !== null) {
				const wanted = normalizeBookText(title, { search: true }).text.slice(0, 40);
				for (let k = block; k < Math.min(blocks.length, block + 40); k++) {
					const candidate = blocks[k]!;
					if (candidate.page !== undefined && candidate.page > page + 1) break;
					if (wanted && normalizeBookText(candidate.text, { search: true }).text.startsWith(wanted)) { block = k; break; }
				}
			}
			if (title) entries.push({ title, level, block });
			if (item.items?.length) await walk(item.items, level + 1);
		}
	};
	await walk(raw, 1);
	return entries;
}

// ─── EPUB ───────────────────────────────────────────────────────────────────

const FONT_OBFUSCATION = new Set(["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"]);
const INLINE = new Set(["a", "abbr", "b", "bdi", "bdo", "big", "cite", "code", "data", "dfn", "em", "font", "i", "kbd", "mark", "q", "rp", "rt", "ruby", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time", "tt", "u", "var", "wbr", "img", "br"]);
const TEXT_ALTERNATIVE: Record<string, true> = { math: true, svg: true };
const SKIP = new Set(["script", "style", "head", "title", "desc", "annotation", "annotation-xml", "noscript"]);
const LEAF = new Set(["p", "li", "dt", "dd", "pre", "figcaption", "caption", "td", "th", "address"]);

type XmlElement = { localName?: string; tagName: string; getAttribute(name: string): string | null; childNodes: ArrayLike<XmlNode>; textContent: string | null };
type XmlNode = { nodeType: number; textContent: string | null } & Partial<XmlElement>;

const localName = (el: Partial<XmlElement>) => (el.localName ?? el.tagName ?? "").split(":").pop()!.toLowerCase();

function elements(root: unknown, name: string): XmlElement[] {
	const out: XmlElement[] = [];
	const visit = (node: XmlNode) => {
		if (node.nodeType !== 1) return;
		if (localName(node) === name) out.push(node as XmlElement);
		for (const child of Array.from(node.childNodes ?? [])) visit(child);
	};
	for (const child of Array.from((root as { childNodes: ArrayLike<XmlNode> }).childNodes ?? [])) visit(child);
	return out;
}

function parseXml(text: string): unknown {
	return new DOMParser().parseFromString(text, "text/xml");
}

/** XML parsers accept strings, not encoded bytes. BOM wins, followed by the
 *  XML byte-order signature/declaration; an undeclared document is UTF-8. */
const textOf = (zip: ZipReader, name: string): string | null => {
	const bytes = zip.read(name);
	if (!bytes) return null;
	let encoding = "utf-8";
	if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
	else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
	else if (bytes[0] === 0 && bytes[1] === 0x3c) encoding = "utf-16be";
	else if (bytes[0] === 0x3c && bytes[1] === 0) encoding = "utf-16le";
	else if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
		const declared = bytes.subarray(0, 256).toString("ascii").match(/^<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']+)/i)?.[1];
		if (declared) encoding = declared;
	}
	return new TextDecoder(encoding).decode(bytes);
};
const resolveHref = (base: string, href: string) => {
	const hash = href.indexOf("#");
	const file = hash < 0 ? href : href.slice(0, hash);
	return path.posix.normalize(path.posix.join(path.posix.dirname(base), decodeURIComponent(file)))
		+ (hash < 0 ? "" : `#${decodeURIComponent(href.slice(hash + 1))}`);
};

/** Parse a content document: XHTML as XML, so self-closing elements (a
 *  print page mark `<span epub:type="pagebreak"/>`) stay empty; text/html
 *  as HTML. Returns the body element. */
function contentBody(text: string, xhtml: boolean): XmlElement | null {
	if (xhtml) {
		const doc = parseXml(text);
		return elements(doc, "body")[0] ?? null;
	}
	const { document } = parseHTML(text);
	return (document.body ?? document.documentElement) as unknown as XmlElement | null;
}

/** Walk a content document's body into blocks, recording anchors. */
function walkDocument(html: string, xhtml: boolean, docPath: string, blocks: Omit<BookBlock, "id">[], anchors: Map<string, number>, page: { n: number; label?: string }): void {
	anchors.set(docPath, blocks.length);
	let inline = "";
	let space = false;
	let start: { page?: number; pageLabel?: string } = {};
	let breaks: NonNullable<BookBlock["breaks"]> = [];
	let pending: NonNullable<BookBlock["breaks"]> = [];
	const pageFields = () => (page.label !== undefined ? { page: page.n, pageLabel: page.label } : {});
	/** Normalize while appending, so offsets always count stored UTF-16 units.
	 *  A marker beside whitespace points at the next word, not its separator. */
	const append = (text: string) => {
		for (let i = 0; i < text.length; i++) {
			const char = text[i]!;
			if (/\s/.test(char)) { space = inline.length > 0; continue; }
			if (!inline) start = pageFields();
			if (space) inline += " ";
			space = false;
			for (const brk of pending) brk.at = inline.length;
			breaks.push(...pending);
			pending = [];
			inline += char;
		}
	};
	const flush = (level?: 1 | 2 | 3) => {
		if (inline) {
			for (const brk of pending) brk.at = inline.length;
			breaks.push(...pending);
			blocks.push({ kind: level ? "heading" : "paragraph", ...(level ? { level } : {}), text: inline, ...start, ...(breaks.length ? { breaks } : {}) });
		}
		inline = "";
		space = false;
		breaks = [];
		pending = [];
	};
	/** Record an element's anchor; true when it is a print page mark (skipped).
	 *  A block element starts after any pending inline text is flushed. */
	const mark = (el: XmlElement, block: boolean) => {
		const id = el.getAttribute("id") ?? (localName(el) === "a" ? el.getAttribute("name") : null);
		if (id) anchors.set(`${docPath}#${id}`, blocks.length + (block && inline ? 1 : 0));
		const type = `${el.getAttribute("epub:type") ?? ""} ${el.getAttribute("role") ?? ""}`;
		if (/pagebreak/.test(type)) {
			const label = (el.getAttribute("title") ?? el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
			if (label) {
				page.n += 1;
				page.label = label;
				if (inline) pending.push({ at: inline.length, page: page.n, pageLabel: label });
			}
			return true;
		}
		return false;
	};
	const isInline = (name: string) => INLINE.has(name) || TEXT_ALTERNATIVE[name];
	const hasBlockChild = (el: XmlElement) => Array.from(el.childNodes).some((child) => child.nodeType === 1 && !isInline(localName(child)) && !SKIP.has(localName(child)));
	// Prefer one accessible alternative. Otherwise retain visible MathML/SVG
	// text, excluding metadata/annotations that repeat the same expression.
	const alternative = (el: XmlElement): string => {
		const label = el.getAttribute("aria-label") ?? el.getAttribute("alttext");
		if (label?.trim()) return label;
		const visible = (node: XmlElement): string => Array.from(node.childNodes).map((child) => {
			if (child.nodeType === 3) return child.textContent ?? "";
			if (child.nodeType !== 1 || SKIP.has(localName(child))) return "";
			return visible(child as XmlElement);
		}).join("");
		const text = visible(el);
		return text.trim() ? text : elements(el, "title")[0]?.textContent ?? elements(el, "desc")[0]?.textContent ?? "";
	};
	const inlineText = (el: XmlElement): void => {
		for (const child of Array.from(el.childNodes)) {
			if (child.nodeType === 3) append(child.textContent ?? "");
			else if (child.nodeType === 1) {
				const name = localName(child);
				if (SKIP.has(name) || mark(child as XmlElement, false)) continue;
				if (name === "br") append(" ");
				else if (TEXT_ALTERNATIVE[name]) append(alternative(child as XmlElement));
				else inlineText(child as XmlElement);
			}
		}
	};
	const walk = (el: XmlElement) => {
		for (const child of Array.from(el.childNodes)) {
			if (child.nodeType === 3) { append(child.textContent ?? ""); continue; }
			if (child.nodeType !== 1) continue;
			const node = child as XmlElement;
			const name = localName(node);
			if (SKIP.has(name)) continue;
			if (mark(node, !isInline(name))) continue;
			if (isInline(name)) {
				if (name === "br") append(" ");
				else if (TEXT_ALTERNATIVE[name]) append(alternative(node));
				else inlineText(node);
				continue;
			}
			flush();
			const heading = name.match(/^h([1-6])$/);
			if (heading || (LEAF.has(name) && !hasBlockChild(node))) {
				inlineText(node);
				flush(heading ? Math.min(3, Number(heading[1])) as 1 | 2 | 3 : undefined);
			} else {
				walk(node);
				flush();
			}
		}
	};
	const body = contentBody(html, xhtml);
	if (body) walk(body);
	flush();
}

function convertEpub(bytes: Uint8Array): ConvertedBook {
	let zip: ZipReader;
	try { zip = openZip(bytes, { entryBytes: 64 * 1024 * 1024, totalBytes: 512 * 1024 * 1024 }); }
	catch { throw new BookImportRefusal(BOOK_REFUSALS.unreadable); }
	try {
		if (zip.names.includes("META-INF/rights.xml")) throw new BookImportRefusal(BOOK_REFUSALS.drm);
		const encryption = textOf(zip, "META-INF/encryption.xml");
		if (encryption) {
			const methods = elements(parseXml(encryption), "encryptionmethod").map((el) => el.getAttribute("Algorithm") ?? "");
			if (methods.some((method) => !FONT_OBFUSCATION.has(method))) throw new BookImportRefusal(BOOK_REFUSALS.drm);
		}
		const container = textOf(zip, "META-INF/container.xml");
		const opfPath = container ? elements(parseXml(container), "rootfile")[0]?.getAttribute("full-path") : null;
		const opfText = opfPath ? textOf(zip, opfPath) : null;
		if (!opfPath || !opfText) throw new BookImportRefusal(BOOK_REFUSALS.unreadable);
		const opf = parseXml(opfText);
		const manifest = new Map(elements(opf, "item").map((el) => [el.getAttribute("id") ?? "", {
			href: resolveHref(opfPath, el.getAttribute("href") ?? ""),
			type: el.getAttribute("media-type") ?? "",
			properties: el.getAttribute("properties") ?? "",
		}]));
		const spineEl = elements(opf, "spine")[0];
		const spine = elements(opf, "itemref").map((el) => {
			const item = manifest.get(el.getAttribute("idref") ?? "");
			if (!item) throw new BookImportRefusal(BOOK_REFUSALS.unreadable);
			return item;
		}).filter((item) => /html/.test(item.type));
		const blocks: Omit<BookBlock, "id">[] = [];
		const anchors = new Map<string, number>();
		const page = { n: 0 } as { n: number; label?: string };
		for (const item of spine) {
			const html = textOf(zip, item.href);
			if (html === null) throw new BookImportRefusal(BOOK_REFUSALS.unreadable);
			walkDocument(html, item.type !== "text/html", item.href, blocks, anchors, page);
		}
		resolveHyphens(blocks);
		const finished = finish(blocks);
		if (finished.length === 0) throw new BookImportRefusal(BOOK_REFUSALS.empty);
		// Anchors index the unfiltered list; map them to finished ids.
		const ids: number[] = [];
		let next = 0;
		for (const block of blocks) { ids.push(next); if (block.text.trim()) next++; }
		ids.push(next);
		const blockOf = (href: string): number | null => {
			const index = anchors.get(href) ?? anchors.get(href.split("#")[0]!);
			if (index === undefined) return null;
			const id = ids[Math.min(index, ids.length - 1)]!;
			return id < finished.length ? id : null;
		};
		const outline: SourceOutlineEntry[] = [];
		const nav = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes("nav"));
		const navText = nav ? textOf(zip, nav.href) : null;
		if (nav && navText) {
			const navs = elements(nav.type === "text/html" ? parseHTML(navText).document : parseXml(navText), "nav");
			const toc = navs.find((el) => /\btoc\b/.test(el.getAttribute("epub:type") ?? "")) ?? navs[0];
			const walkList = (list: XmlElement, level: number) => {
				for (const li of Array.from(list.childNodes)) {
					if (li.nodeType !== 1 || localName(li) !== "li") continue;
					const children = Array.from((li as XmlElement).childNodes).filter((child) => child.nodeType === 1) as XmlElement[];
					const link = children.find((child) => localName(child) === "a" || localName(child) === "span");
					const title = (link?.textContent ?? "").replace(/\s+/g, " ").trim();
					const href = link && localName(link) === "a" ? link.getAttribute("href") : null;
					if (title) outline.push({ title, level, block: href ? blockOf(resolveHref(nav.href, href)) : null });
					for (const child of children) if (localName(child) === "ol") walkList(child, level + 1);
				}
			};
			const list = toc ? elements(toc, "ol")[0] : undefined;
			if (list) walkList(list, 1);
		} else {
			const ncxItem = manifest.get(spineEl?.getAttribute("toc") ?? "") ?? [...manifest.values()].find((item) => item.type === "application/x-dtbncx+xml");
			const ncxText = ncxItem ? textOf(zip, ncxItem.href) : null;
			if (ncxItem && ncxText) {
				const ncx = parseXml(ncxText);
				const walkPoints = (parent: XmlElement, level: number) => {
					for (const point of Array.from(parent.childNodes)) {
						if (point.nodeType !== 1 || localName(point) !== "navpoint") continue;
						const label = elements(point, "navlabel")[0];
						const title = (label?.textContent ?? "").replace(/\s+/g, " ").trim();
						const src = Array.from((point as XmlElement).childNodes).find((child) => child.nodeType === 1 && localName(child) === "content") as XmlElement | undefined;
						const href = src?.getAttribute("src");
						if (title) outline.push({ title, level, block: href ? blockOf(resolveHref(ncxItem.href, href)) : null });
						walkPoints(point as XmlElement, level + 1);
					}
				};
				const navMap = elements(ncx, "navmap")[0];
				if (navMap) walkPoints(navMap, 1);
			}
		}
		const title = elements(opf, "title")[0]?.textContent?.trim();
		const author = elements(opf, "creator")[0]?.textContent?.trim();
		return {
			...(title ? { title } : {}),
			...(author ? { author } : {}),
			blocks: finished,
			...(outline.length > 0 ? { outline } : {}),
		};
	} catch (error) {
		if (error instanceof BookImportRefusal) throw error;
		if (error instanceof ZipError) throw new BookImportRefusal(BOOK_REFUSALS.unreadable);
		throw new BookImportRefusal(BOOK_REFUSALS.unreadable);
	}
}

// ─── text and Markdown ──────────────────────────────────────────────────────

const TEXT_HEADING = /^(?:(part|book)\b|(chapter|section|preface|introduction|conclusion|appendix|prologue|epilogue|foreword|afterword)\b|[IVXLCDM]+\.?\s+\S)/i;

function stripInlineMarkdown(text: string): string {
	return text
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
		.replace(/(?<![\w*])([*_])(?=\S)(.+?)(?<=\S)\1(?![\w*])/g, "$2");
}

function convertText(bytes: Uint8Array, markdown: boolean): ConvertedBook {
	if (bytes.subarray(0, 8192).includes(0)) throw new BookImportRefusal(BOOK_REFUSALS.notText);
	const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const blocks: Omit<BookBlock, "id">[] = [];
	for (const chunk of text.split(/\n\s*\n/)) {
		let paragraph = "";
		const push = () => {
			if (paragraph.trim()) blocks.push({ kind: "paragraph", text: markdown ? stripInlineMarkdown(paragraph.trim()) : paragraph.trim() });
			paragraph = "";
		};
		const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
		for (const line of lines) {
			const heading = markdown ? line.match(/^(#{1,6})\s+(.+?)\s*#*$/) : null;
			if (heading) {
				push();
				blocks.push({ kind: "heading", level: Math.min(3, heading[1]!.length) as 1 | 2 | 3, text: stripInlineMarkdown(heading[2]!) });
				continue;
			}
			paragraph = joinLine(paragraph, markdown ? line.replace(/^(?:[-*+]|[0-9]+[.)])\s+(?=\S)/, (m) => /^[0-9]/.test(m) ? m : "") : line);
		}
		if (!markdown && lines.length === 1 && paragraph.length <= 80 && !/[.,;:]$/.test(paragraph)) {
			const match = paragraph.match(TEXT_HEADING);
			const caps = /\p{Lu}{4,}/u.test(paragraph) && !/\p{Ll}/u.test(paragraph);
			if (match || caps) {
				blocks.push({ kind: "heading", level: match?.[1] ? 1 : 2, text: paragraph });
				paragraph = "";
				continue;
			}
		}
		push();
	}
	resolveHyphens(blocks);
	const finished = finish(blocks);
	if (finished.length === 0) throw new BookImportRefusal(BOOK_REFUSALS.empty);
	return { blocks: finished };
}

// ─── entry points ───────────────────────────────────────────────────────────

/** Quick checks before a record exists, so the common refusals answer the
 *  upload itself: a PDF opens and is within the page limit, an EPUB is not
 *  protected, a text file is text. */
export async function probeBook(format: BookFormat, bytes: Uint8Array): Promise<{ pageCount?: number }> {
	if (bytes.length > MAX_BOOK_BYTES) throw new BookImportRefusal(BOOK_REFUSALS.tooBig);
	if (format === "pdf") {
		try {
			const pageCount = await withPdfDocument(bytes, async (doc) => doc.numPages);
			if (pageCount > MAX_BOOK_PAGES) throw new BookImportRefusal(BOOK_REFUSALS.tooLong);
			return { pageCount };
		} catch (error) {
			if (error instanceof BookImportRefusal) throw error;
			throw new BookImportRefusal(BOOK_REFUSALS.unreadable);
		}
	}
	if (format === "epub") {
		let zip: ZipReader;
		try { zip = openZip(bytes, { entryBytes: 64 * 1024 * 1024, totalBytes: 512 * 1024 * 1024 }); }
		catch { throw new BookImportRefusal(BOOK_REFUSALS.unreadable); }
		if (zip.names.includes("META-INF/rights.xml")) throw new BookImportRefusal(BOOK_REFUSALS.drm);
		if (!zip.names.includes("META-INF/container.xml")) throw new BookImportRefusal(BOOK_REFUSALS.unreadable);
		return {};
	}
	if (bytes.subarray(0, 8192).includes(0)) throw new BookImportRefusal(BOOK_REFUSALS.notText);
	return {};
}

export async function convertBook(format: BookFormat, bytes: Uint8Array, options: ConvertOptions = {}): Promise<ConvertedBook> {
	switch (format) {
		case "pdf": return convertPdf(bytes, options);
		case "epub": return convertEpub(bytes);
		case "text": return convertText(bytes, false);
		case "markdown": return convertText(bytes, true);
	}
}
