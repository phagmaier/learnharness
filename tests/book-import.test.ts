/**
 * Plan 05 item 1: importing books, without a model. The converters on
 * generated files (a PDF with bookmarks, page labels, running heads and a
 * paragraph crossing a page; EPUB 3 and EPUB 2; Markdown and text), the
 * refusals (type, size, duplicate, DRM, no text layer, garbled text, too
 * many pages), the store's guards, and the routes: background conversion,
 * automatic acceptance of confident contents, review of unsure ones,
 * switching candidates, interruption and retry, and renaming. An isolated
 * LH_DATA_DIR is set before any config-loading import.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { tinyPdf, type Run, type TinyPage } from "./helpers/tiny-pdf.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-book-import-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

const { zipFiles } = await import("../src/server/zip.ts");
const { convertBook, probeBook, BOOK_REFUSALS, BookImportRefusal } = await import("../src/server/book-import.ts");
const books = await import("../src/server/books.ts");
const { bookStore, bookDir } = await import("../src/store/books.ts");
const listRoute = await import("../app/api/books/route.ts");
const bookRoute = await import("../app/api/books/[id]/route.ts");
const contentsRoute = await import("../app/api/books/[id]/contents/route.ts");
const retryRoute = await import("../app/api/books/[id]/retry-import/route.ts");
type BookRecord = import("../src/core/contracts.ts").BookRecord;

const seams = { ...books.bookServiceSeams };
afterEach(() => {
	Object.assign(books.bookServiceSeams, seams);
	fs.rmSync(path.join(TMP, "books"), { recursive: true, force: true });
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ─── fixtures ───────────────────────────────────────────────────────────────

const head = (page: number): Run[] => [{ text: "PHENOMENOLOGY OF TESTING", x: 200, y: 760, size: 9 }, { text: String(page), x: 300, y: 40, size: 9 }];
const lines = (start: number, rows: [number, string][]): Run[] => rows.map(([x, text], i) => ({ text, x, y: start - i * 13, size: 10 }));

/** Three pages: bookmarks A (p. 1) and B (p. 2), labels from 101, a
 *  running head and page number on every page, a paragraph crossing pages. */
function bookPdf(): Uint8Array {
	const pages: TinyPage[] = [
		{ runs: [...head(1), { text: "A. Consciousness", x: 72, y: 720, size: 18 }, ...lines(690, [
			[90, "1. The spirit moves through each shape of"],
			[72, "consciousness and finds itself again."],
			[90, "2. What it had taken for other is a hyphen-"],
			[72, "ated word, and the hyphen is dropped."],
			[90, "3. A well-"],
			[72, "known word keeps its hyphen, as well-known shows."],
			[90, "4. This sentence runs on"],
		])] },
		{ runs: [...head(2), ...lines(720, [[72, "onto the next page and ends."]]), { text: "B. Self-consciousness", x: 72, y: 680, size: 18 }, ...lines(650, [[90, "5. Desire is self-consciousness."]])] },
		{ runs: [...head(3), ...lines(720, [[90, "6. Spirit is the ethical life of a people."]])] },
	];
	return tinyPdf(pages, {
		bookmarks: [{ title: "A. Consciousness", page: 1 }, { title: "B. Self-consciousness", page: 2 }],
		pageLabels: [{ start: 0, style: "D", first: 101 }],
		info: { title: "Testing Spirit", author: "G. Tester" },
	});
}

const container = (opf: string) => `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${opf}" media-type="application/oebps-package+xml"/></rootfiles></container>`;
const xhtml = (body: string) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>x</title></head><body>${body}</body></html>`;

function epub(files: Record<string, string | Uint8Array>): Uint8Array {
	return zipFiles([{ name: "mimetype", data: Buffer.from("application/epub+zip") }, ...Object.entries(files).map(([name, text]) => ({ name, data: typeof text === "string" ? Buffer.from(text) : Buffer.from(text) }))]);
}

const CHAPTER_ONE = xhtml(`<h1 id="c1">Chapter 1 Being</h1><p>First para with <em>emphasis</em> text.</p><p id="p2">Second para.</p><div><span epub:type="pagebreak" title="12"/>Loose text in a div.</div>`);
const CHAPTER_TWO = xhtml(`<section><h2 id="s1">Section 1.1 Nothing</h2><p>Nothing is <a href="#n">simply</a> nothing.</p></section>`);

function epub3(extra: Record<string, string> = {}): Uint8Array {
	return epub({
		"META-INF/container.xml": container("OEBPS/content.opf"),
		"OEBPS/content.opf": `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Phenomenology of Testing</dc:title><dc:creator>G. Tester</dc:creator></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
		"OEBPS/nav.xhtml": xhtml(`<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml#c1">Chapter 1 Being</a><ol><li><a href="text/ch1.xhtml#p2">Second</a></li></ol></li><li><a href="text/ch2.xhtml">Chapter 2 Becoming</a></li></ol></nav>`),
		"OEBPS/text/ch1.xhtml": CHAPTER_ONE,
		"OEBPS/text/ch2.xhtml": CHAPTER_TWO,
		...extra,
	});
}

function epub2(): Uint8Array {
	return epub({
		"META-INF/container.xml": container("content.opf"),
		"content.opf": `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Old Testing</dc:title></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
		"toc.ncx": `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap><navPoint id="a"><navLabel><text>Chapter 1 Being</text></navLabel><content src="ch1.xhtml#c1"/><navPoint id="b"><navLabel><text>Second</text></navLabel><content src="ch1.xhtml#p2"/></navPoint></navPoint><navPoint id="c"><navLabel><text>Chapter 2 Becoming</text></navLabel><content src="ch2.xhtml"/></navPoint></navMap></ncx>`,
		"ch1.xhtml": CHAPTER_ONE,
		"ch2.xhtml": CHAPTER_TWO,
	});
}

const EPUB_BLOCKS = [
	{ id: 0, kind: "heading", level: 1, text: "Chapter 1 Being" },
	{ id: 1, kind: "paragraph", text: "First para with emphasis text." },
	{ id: 2, kind: "paragraph", text: "Second para." },
	{ id: 3, kind: "paragraph", text: "Loose text in a div.", page: 1, pageLabel: "12" },
	{ id: 4, kind: "heading", level: 2, text: "Section 1.1 Nothing", page: 1, pageLabel: "12" },
	{ id: 5, kind: "paragraph", text: "Nothing is simply nothing.", page: 1, pageLabel: "12" },
];
const EPUB_OUTLINE = [{ title: "Chapter 1 Being", level: 1, block: 0 }, { title: "Second", level: 2, block: 2 }, { title: "Chapter 2 Becoming", level: 1, block: 4 }];

const refusalOf = async (promise: Promise<unknown>) => {
	try { await promise; } catch (error) { if (error instanceof BookImportRefusal) return error.message; throw error; }
	return null;
};

// ─── converters ─────────────────────────────────────────────────────────────

describe("converters", () => {
	it("rebuilds a PDF's paragraphs, dropping running heads and page numbers", async () => {
		const book = await convertBook("pdf", bookPdf());
		assert.equal(book.title, "Testing Spirit");
		assert.equal(book.author, "G. Tester");
		assert.equal(book.pageCount, 3);
		assert.deepEqual(book.blocks.map((block) => [block.kind, block.text, block.page, block.pageLabel]), [
			["heading", "A. Consciousness", 1, "101"],
			["paragraph", "1. The spirit moves through each shape of consciousness and finds itself again.", 1, "101"],
			["paragraph", "2. What it had taken for other is a hyphenated word, and the hyphen is dropped.", 1, "101"],
			["paragraph", "3. A well-known word keeps its hyphen, as well-known shows.", 1, "101"],
			["paragraph", "4. This sentence runs on onto the next page and ends.", 1, "101"],
			["heading", "B. Self-consciousness", 2, "102"],
			["paragraph", "5. Desire is self-consciousness.", 2, "102"],
			["paragraph", "6. Spirit is the ethical life of a people.", 3, "103"],
		]);
		assert.deepEqual(book.blocks[4]!.breaks, [{ at: 25, page: 2, pageLabel: "102" }]);
		assert.equal(book.blocks[4]!.text.slice(25), "onto the next page and ends.");
		assert.deepEqual(book.outline, [{ title: "A. Consciousness", level: 1, block: 0 }, { title: "B. Self-consciousness", level: 1, block: 5 }]);
	});

	it("retains repeated rotated body text at page edges and separates orientations", async () => {
		const book = await convertBook("pdf", tinyPdf(["First", "Second", "Third"].map((word) => ({
			runs: [
				{ text: "Rotated body evidence", x: 40, y: 650, size: 10, rotated: true },
				...lines(700, [[72, `${word} ordinary argument continues`]]),
				{ text: "Rotated conclusion", x: 40, y: 50, size: 10, rotated: true },
			],
		}))));
		for (const [index, word] of ["First", "Second", "Third"].entries()) {
			const blocks = book.blocks.filter((block) => block.page === index + 1);
			assert.deepEqual(blocks.map((block) => block.text).sort(), [
				`${word} ordinary argument continues`,
				"Rotated body evidence",
				"Rotated conclusion",
			].sort());
		}
	});

	it("converts the existing three-page sample", async () => {
		const book = await convertBook("pdf", new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf"))));
		assert.equal(book.pageCount, 3);
		assert.ok(book.blocks.length > 0);
		assert.ok(book.blocks.every((block, index) => block.id === index && block.text.trim()));
	});

	it("reads an EPUB 3 through its spine and nav, with print page marks", async () => {
		const book = await convertBook("epub", epub3());
		assert.equal(book.title, "Phenomenology of Testing");
		assert.equal(book.author, "G. Tester");
		assert.deepEqual(book.blocks, EPUB_BLOCKS);
		assert.deepEqual(book.outline, EPUB_OUTLINE);
	});

	it("reads an EPUB 2 through its NCX", async () => {
		const book = await convertBook("epub", epub2());
		assert.equal(book.title, "Old Testing");
		assert.deepEqual(book.blocks, EPUB_BLOCKS);
		assert.deepEqual(book.outline, EPUB_OUTLINE);
	});

	it("preserves MathML and SVG text or one accessible alternative without metadata duplicates", async () => {
		const book = await convertBook("epub", epub3({
			"OEBPS/text/ch1.xhtml": xhtml(`<p>Equation <math><semantics><mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow><annotation>x+y</annotation></semantics></math> holds.</p><p>Accessible <math aria-label="a squared"><msup><mi>a</mi><mn>2</mn></msup></math>.</p><p>Diagram <svg aria-label="A implies B"><title>A implies B</title><desc>A implies B</desc><text>A implies B</text></svg>.</p><p>Visible <svg><title>Repeated label</title><desc>Repeated label</desc><text>Repeated label</text></svg>.</p><p>Fallback <svg><title>A triangle</title><desc>A triangle</desc><path d="M0 0"/></svg>.</p>`),
		}));
		assert.deepEqual(book.blocks.slice(0, 5).map((block) => block.text), [
			"Equation x+y holds.", "Accessible a squared.", "Diagram A implies B.", "Visible Repeated label.", "Fallback A triangle.",
		]);
	});

	it("decodes EPUB XML documents using UTF-8 and either UTF-16 byte order", async () => {
		for (const encoding of ["utf-8", "utf-16le", "utf-16be"] as const) {
			for (const bom of [false, true]) {
				const files: Record<string, string> = {
					"META-INF/container.xml": container("content.opf"),
					"content.opf": `<?xml version="1.0"?><package><metadata><title>Élan 世界</title><creator>Renée</creator></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c" href="ch.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>`,
					"nav.xhtml": xhtml(`<nav epub:type="toc"><ol><li><a href="ch.xhtml#target">世界</a></li></ol></nav>`),
					"ch.xhtml": xhtml(`<p>Opening.</p><h1 id="target">世界</h1><p>Renée’s café survives.</p>`),
				};
				const encoded = Object.fromEntries(Object.entries(files).map(([name, text]) => {
					const declaration = text.replace(/^<\?xml[^?]*\?>/, `<?xml version="1.0" encoding="${encoding}"?>`);
					const bytes = Buffer.from(declaration, encoding === "utf-8" ? "utf8" : "utf16le");
					if (encoding === "utf-16be") bytes.swap16();
					const prefix = encoding === "utf-8" ? [0xef, 0xbb, 0xbf] : encoding === "utf-16le" ? [0xff, 0xfe] : [0xfe, 0xff];
					return [name, bom ? Buffer.concat([Buffer.from(prefix), bytes]) : bytes];
				}));
				const book = await convertBook("epub", epub(encoded));
				assert.equal(book.title, "Élan 世界");
				assert.equal(book.author, "Renée");
				assert.deepEqual(book.blocks.map((block) => block.text), ["Opening.", "世界", "Renée’s café survives."]);
				assert.deepEqual(book.outline, [{ title: "世界", level: 1, block: 1 }]);
			}
		}
	});

	it("refuses a missing required spine chapter or manifest reference", async () => {
		for (const reference of ["missing-file", "missing-item"]) {
			const manifest = `<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>`
				+ (reference === "missing-file" ? `<item id="c2" href="text/absent.xhtml" media-type="application/xhtml+xml"/>` : "");
			const bytes = epub3({ "OEBPS/content.opf": `<package><manifest>${manifest}</manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>` });
			assert.equal(await refusalOf(convertBook("epub", bytes)), BOOK_REFUSALS.unreadable);
		}
	});

	it("keeps starting pages and normalized UTF-16 offsets for nested inline page marks", async () => {
		const book = await convertBook("epub", epub3({
			"OEBPS/text/ch1.xhtml": xhtml(`<span epub:type="pagebreak" title="10"/><p id="c1">  Alpha 😀  <em>before <span epub:type="pagebreak" title="11"/> \n beta <strong><span epub:type="pagebreak" title="12"/></strong><span epub:type="pagebreak" title="13"/> \t gamma</em> end. </p><p id="p2">Next page.</p>`),
		}));
		assert.deepEqual(book.blocks.slice(0, 2), [
			{ id: 0, kind: "paragraph", text: "Alpha 😀 before beta gamma end.", page: 1, pageLabel: "10", breaks: [
				{ at: 16, page: 2, pageLabel: "11" }, { at: 21, page: 3, pageLabel: "12" }, { at: 21, page: 4, pageLabel: "13" },
			] },
			{ id: 1, kind: "paragraph", text: "Next page.", page: 4, pageLabel: "13" },
		]);
		assert.deepEqual(book.outline?.slice(0, 2).map((entry) => entry.block), [0, 1]);
	});

	it("decodes EPUB navigation fragments before looking up anchors", async () => {
		const book = await convertBook("epub", epub3({
			"OEBPS/nav.xhtml": xhtml(`<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml#section%20%C3%A9">Target</a></li></ol></nav>`),
			"OEBPS/text/ch1.xhtml": xhtml(`<p>Opening, not the target.</p><h1 id="section é">Target</h1><p>Target body.</p>`),
		}));
		assert.deepEqual(book.outline, [{ title: "Target", level: 1, block: 1 }]);
	});

	it("accepts font obfuscation but refuses a protected EPUB", async () => {
		const obfuscated = `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><enc:CipherData><enc:CipherReference URI="OEBPS/font.otf"/></enc:CipherData></enc:EncryptedData></encryption>`;
		assert.equal((await convertBook("epub", epub3({ "META-INF/encryption.xml": obfuscated }))).blocks.length, 6);
		const protectedBook = obfuscated.replace("http://www.idpf.org/2008/embedding", "http://www.w3.org/2001/04/xmlenc#aes128-cbc");
		assert.equal(await refusalOf(convertBook("epub", epub3({ "META-INF/encryption.xml": protectedBook }))), BOOK_REFUSALS.drm);
		assert.equal(await refusalOf(probeBook("epub", epub3({ "META-INF/rights.xml": "<rights/>" }))), BOOK_REFUSALS.drm);
	});

	it("reads Markdown headings and strips inline markup", async () => {
		const book = await convertBook("markdown", new TextEncoder().encode("# Title\n\nPara with **bold** and [a link](http://x) and `code`.\n\n## Sub\n- item one\n- item two\n"));
		assert.deepEqual(book.blocks.map((block) => [block.kind, block.level, block.text]), [
			["heading", 1, "Title"],
			["paragraph", undefined, "Para with bold and a link and code."],
			["heading", 2, "Sub"],
			["paragraph", undefined, "item one item two"],
		]);
	});

	it("finds chapter-like lines in plain text and joins wrapped lines", async () => {
		const book = await convertBook("text", new TextEncoder().encode("﻿Chapter 1\r\n\r\nSome text wrapped\nacross lines with a hyphen-\nated word.\n\nCHAPTER TWO\n\nMore."));
		assert.deepEqual(book.blocks.map((block) => [block.kind, block.level, block.text]), [
			["heading", 2, "Chapter 1"],
			["paragraph", undefined, "Some text wrapped across lines with a hyphenated word."],
			["heading", 2, "CHAPTER TWO"],
			["paragraph", undefined, "More."],
		]);
	});

	it("refuses files without usable text", async () => {
		assert.equal(await refusalOf(probeBook("text", new Uint8Array([0x61, 0, 0x62]))), BOOK_REFUSALS.notText);
		assert.equal(await refusalOf(convertBook("pdf", tinyPdf([{ image: true }, { image: true }]))), BOOK_REFUSALS.noTextLayer);
		const soup = "!#$%&'()*+,-./0123456789:;<=>?@[]^_{|}~";
		const garbled = tinyPdf([1, 2, 3].map(() => ({ runs: lines(720, Array.from({ length: 8 }, () => [72, `${soup} ${soup}`] as [number, string])) })));
		assert.equal(await refusalOf(convertBook("pdf", garbled)), BOOK_REFUSALS.garbled);
		assert.equal(await refusalOf(probeBook("pdf", tinyPdf(Array.from({ length: 3001 }, () => ({}))))), BOOK_REFUSALS.tooLong);
		assert.equal(await refusalOf(probeBook("pdf", new TextEncoder().encode("%PDF-1.4 not really"))), BOOK_REFUSALS.unreadable);
	});

	it("notes image-only pages it skipped", async () => {
		const book = await convertBook("pdf", tinyPdf([{ runs: lines(720, [[72, "Some real text on the page."]]) }, { image: true }]));
		assert.equal(book.notice, "1 page has no text and is skipped. OCR isn't supported.");
	});
});

// ─── routes ─────────────────────────────────────────────────────────────────

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function upload(name: string, bytes: Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
	const form = new FormData();
	form.append("file", new File([bytes as BlobPart], name));
	const request = new Request("http://localhost/api/books", { method: "POST", body: form });
	const withHeaders = Object.keys(headers).length > 0 ? new Request(request, { headers: { ...Object.fromEntries(request.headers), ...headers } }) : request;
	return listRoute.POST(withHeaders);
}

async function settled(id: string): Promise<BookRecord> {
	for (let i = 0; i < 400; i++) {
		const record = bookStore.get(id)!;
		if (record.import.status !== "importing") return record;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("the import never settled");
}

async function imported(name: string, bytes: Uint8Array): Promise<BookRecord> {
	const response = await upload(name, bytes);
	assert.equal(response.status, 200, await response.clone().text());
	const { book } = await response.json() as { book: BookRecord };
	assert.equal(book.import.status, "importing");
	return settled(book.id);
}

const paragraphs = (count: number, wordsEach: number) => Array.from({ length: count }, (_, i) => `${i + 1}. ${Array.from({ length: wordsEach }, () => "spirit").join(" ")}.`).join("\n\n");

describe("importing through the routes", () => {
	it("accepts confident contents at once; a long book's map writer waits to start", async () => {
		const accepted: string[] = [];
		books.bookServiceSeams.contentsAccepted = (id) => accepted.push(id);
		const record = await imported("Long Spirit.txt", new TextEncoder().encode(paragraphs(30, 700)));
		assert.equal(record.title, "Long Spirit");
		assert.equal(record.import.status, "ready");
		assert.equal(record.structure, "numbered");
		assert.equal(record.contentsAccepted, "auto");
		assert.deepEqual(record.mapWriter, { status: "waiting", done: 0, total: 0 });
		assert.equal(record.words, 30 * 701);
		assert.deepEqual(accepted, [record.id]);
		const read = await (await bookRoute.GET(new Request("http://x"), params(record.id))).json() as { book: { sections: number }; map: { nodes: unknown[] } };
		assert.equal(read.book.sections, 30);
		assert.equal(read.map.nodes.length, 30);
		assert.ok(fs.existsSync(path.join(bookDir(record.id), "original.txt")));
	});

	it("marks a short confident book as needing no map", async () => {
		const record = await imported("short.txt", new TextEncoder().encode(paragraphs(12, 10)));
		assert.equal(record.contentsAccepted, "auto");
		assert.deepEqual(record.mapWriter, { status: "not-needed", done: 0, total: 0 });
	});

	it("holds unsure contents for review, then switches and accepts", async () => {
		const accepted: string[] = [];
		books.bookServiceSeams.contentsAccepted = (id) => accepted.push(id);
		const record = await imported("guess.md", new TextEncoder().encode("# Preface\n\nOpening words.\n\n# Chapter 1 Being\n\nBeing is.\n\n# Chapter 2 Nothing\n\nNothing is.\n"));
		assert.equal(record.import.status, "review");
		assert.equal(record.structure, "headings");
		assert.equal(record.contentsAccepted, undefined);
		assert.deepEqual(record.confidence, { level: "unsure", reasons: ["The contents were guessed from the text's headings."] });
		assert.deepEqual(accepted, []);
		const contents = await (await contentsRoute.GET(new Request("http://x"), params(record.id))).json() as { current: string; candidates: { method: string; description: string }[] };
		assert.equal(contents.current, "headings");
		assert.deepEqual(contents.candidates.map((candidate) => [candidate.method, candidate.description]), [["headings", "3 headings"], ["app-made", "1 part of about 2,000 words"]]);
		const bad = await contentsRoute.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ method: "outline" }) }), params(record.id));
		assert.equal(bad.status, 400);
		const switched = await contentsRoute.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ method: "app-made" }) }), params(record.id));
		const { book } = await switched.json() as { book: BookRecord };
		assert.equal(book.import.status, "ready");
		assert.equal(book.structure, "app-made");
		assert.equal(book.contentsAccepted, "learner");
		assert.deepEqual(book.mapWriter, { status: "not-needed", done: 0, total: 0 });
		assert.deepEqual(bookStore.readMap(record.id)!.nodes.map((node) => node.label), ["Part 1"]);
		assert.deepEqual(accepted, [record.id]);
	});

	it("accepts the shown contents with Looks right", async () => {
		const record = await imported("guess2.md", new TextEncoder().encode("# One\n\nA.\n\n# Two\n\nB.\n"));
		const response = await contentsRoute.PUT(new Request("http://x", { method: "PUT", body: "{}" }), params(record.id));
		const { book } = await response.json() as { book: BookRecord };
		assert.equal(book.structure, "headings");
		assert.equal(book.contentsAccepted, "learner");
		assert.equal(book.import.status, "ready");
	});

	it("accepts replacement model contents without discarding summaries on an unchanged acceptance", async () => {
		const accepted: string[] = [];
		books.bookServiceSeams.contentsAccepted = (id) => accepted.push(id);
		const record = await imported("replacement.md", new TextEncoder().encode("# Chapter 1 First\n\nFirst body.\n\n# Chapter 2 Second\n\nSecond body."));
		bookStore.update(record.id, (current) => ({ ...current, words: 30_000 }));
		const originalCandidates = bookStore.readCandidates(record.id)!.candidates;
		const confidence = { level: "unsure" as const, reasons: ["Model contents."] };
		const firstNode = { id: "n0", label: "Chapter 1", title: "First", kind: "chapter" as const, level: 1, firstBlock: 0, lastBlock: 3 };
		const selectModel = () => contentsRoute.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ method: "model" }) }), params(record.id));
		bookStore.writeCandidates(record.id, { candidates: [...originalCandidates, { method: "model", confidence, description: "1 entry", nodes: [firstNode] }] });
		assert.equal((await selectModel()).status, 200);
		const summarized = { ...firstNode, summary: "The first chapter introduces the topic.", terms: ["topic"] };
		bookStore.writeMap(record.id, { nodes: [summarized] });
		bookStore.update(record.id, (current) => ({ ...current, mapWriter: { status: "ready", done: 1, total: 1 } }));

		assert.equal((await selectModel()).status, 200);
		assert.deepEqual(bookStore.readMap(record.id)!.nodes, [summarized]);
		assert.equal(bookStore.get(record.id)!.mapWriter.status, "ready");
		assert.equal(accepted.length, 1);

		// A new pass can correct just a title, or choose a different span.
		for (const replacement of [
			{ ...firstNode, title: "Corrected first chapter" },
			{ ...firstNode, label: "Chapter 2", title: "Second", firstBlock: 2 },
		]) {
			bookStore.writeCandidates(record.id, { candidates: [...originalCandidates, { method: "model", confidence, description: "1 entry", nodes: [replacement] }] });
			assert.equal((await selectModel()).status, 200);
			assert.deepEqual(bookStore.readMap(record.id)!.nodes, [replacement]);
			assert.deepEqual(bookStore.get(record.id)!.mapWriter, { status: "waiting", done: 0, total: 0 });
		}
		assert.equal(accepted.length, 3, "only a changed candidate restarts the map writer");
	});

	for (const damage of ["newer", "damaged"] as const) {
		it(`refuses contents acceptance and switching without changing a ${damage} map`, async () => {
			const accepted: string[] = [];
			books.bookServiceSeams.contentsAccepted = (id) => accepted.push(id);
			const record = await imported("guess.md", new TextEncoder().encode("# Preface\n\nOpening words.\n\n# Chapter 1 Being\n\nBeing is.\n\n# Chapter 2 Nothing\n\nNothing is.\n"));
			assert.equal(record.import.status, "review");
			const mapPath = path.join(bookDir(record.id), "map.json");
			const recordPath = path.join(bookDir(record.id), "book.json");
			const map = JSON.parse(fs.readFileSync(mapPath, "utf8")) as { version: number };
			fs.writeFileSync(mapPath, damage === "newer" ? JSON.stringify({ ...map, version: 9 }) : "{broken");
			const mapBytes = fs.readFileSync(mapPath);
			const recordBytes = fs.readFileSync(recordPath);
			for (const body of [{}, { method: "headings" }, { method: "app-made" }]) {
				const response = await contentsRoute.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }), params(record.id));
				assert.equal(response.status, 409);
				assert.deepEqual(fs.readFileSync(mapPath), mapBytes);
				assert.deepEqual(fs.readFileSync(recordPath), recordBytes);
				assert.deepEqual(accepted, []);
			}
		});
	}

	it("imports each format end to end", async () => {
		const pdf = await imported("spirit.pdf", bookPdf());
		assert.equal(pdf.title, "Testing Spirit");
		assert.equal(pdf.structure, "outline");
		assert.equal(pdf.contentsAccepted, "auto");
		assert.deepEqual(bookStore.readMap(pdf.id)!.nodes.map((node) => [node.label, node.pages]), [["A", { from: "101", to: "102" }], ["B", { from: "102", to: "103" }]]);
		const epubBook = await imported("testing.epub", epub3());
		assert.equal(epubBook.title, "Phenomenology of Testing");
		// The fixture's nav names chapter 2 "Chapter 2 Becoming", but its text
		// opens with "Section 1.1 Nothing": the import asks for review.
		assert.equal(epubBook.import.status, "review");
		assert.deepEqual(epubBook.confidence, { level: "unsure", reasons: ["Only 2 of 3 contents titles appear in the text where they point."] });
		assert.equal(bookStore.readText(epubBook.id)!.blocks.length, 6);
	});

	it("refuses before creating anything: type, size, duplicates, unreadable files", async () => {
		const type = await upload("notes.docx", new Uint8Array([1, 2, 3]));
		assert.equal(type.status, 400);
		assert.deepEqual(await type.json(), { error: BOOK_REFUSALS.type });
		const big = await upload("big.txt", new TextEncoder().encode("x"), { "content-length": String(200 * 1024 * 1024) });
		assert.equal(big.status, 413);
		assert.deepEqual(await big.json(), { error: "Too big. Max 100 MB." });
		const first = await imported("same.txt", new TextEncoder().encode("Same text."));
		const again = await upload("renamed copy.txt", new TextEncoder().encode("Same text."));
		assert.equal(again.status, 409);
		assert.deepEqual(await again.json(), { error: "This book is already in your library: same.", existing: { id: first.id, title: "same" } });
		const broken = await upload("broken.pdf", new TextEncoder().encode("%PDF-1.4 nothing"));
		assert.equal(broken.status, 400);
		assert.equal(bookStore.list().books.length, 1);
	});

	it("records a refusal found during conversion on the book", async () => {
		const record = await imported("scan.pdf", tinyPdf([{ image: true }]));
		assert.deepEqual(record.import, { status: "failed", error: BOOK_REFUSALS.noTextLayer });
	});

	it("reads an import left running by a closed app as interrupted, and Try again finishes it", async () => {
		const now = new Date().toISOString();
		bookStore.create({
			id: "book_interrupted_1", title: "Left behind", format: "text", fileName: "left.txt", sha256: "abc", bytes: 10,
			importedAt: now, updatedAt: now, import: { status: "importing" }, mapWriter: { status: "waiting", done: 0, total: 0 },
		}, new TextEncoder().encode("Chapter 1\n\nText."));
		const read = await (await bookRoute.GET(new Request("http://x"), params("book_interrupted_1"))).json() as { book: BookRecord };
		assert.deepEqual(read.book.import, { status: "failed", error: books.BOOK_INTERRUPTED });
		const retried = await retryRoute.POST(new Request("http://x", { method: "POST" }), params("book_interrupted_1"));
		assert.equal(retried.status, 200);
		assert.equal((await settled("book_interrupted_1")).import.status, "review");
		const notFailed = await retryRoute.POST(new Request("http://x", { method: "POST" }), params("book_interrupted_1"));
		assert.equal(notFailed.status, 409);
	});

	it("renames title and author", async () => {
		const record = await imported("rename.txt", new TextEncoder().encode("Some text."));
		const put = (body: unknown) => bookRoute.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }), params(record.id));
		const renamed = await (await put({ title: "  The  Real Title ", author: "Hegel" })).json() as { book: BookRecord };
		assert.equal(renamed.book.title, "The Real Title");
		assert.equal(renamed.book.author, "Hegel");
		assert.equal((await put({ title: "  " })).status, 400);
		const cleared = await (await put({ author: "" })).json() as { book: BookRecord };
		assert.equal(cleared.book.author, undefined);
	});
});

describe("the store", () => {
	const now = new Date().toISOString();
	const record = (id: string, importedAt = now): BookRecord => ({
		id, title: id, format: "text", fileName: `${id}.txt`, sha256: id, bytes: 1, importedAt, updatedAt: now,
		import: { status: "ready" }, mapWriter: { status: "not-needed", done: 0, total: 0 },
	});

	it("round-trips, lists newest first, and keeps fields it doesn't know", () => {
		bookStore.create(record("book_a", "2026-01-01T00:00:00.000Z"), new Uint8Array([1]));
		bookStore.create(record("book_b", "2026-02-01T00:00:00.000Z"), new Uint8Array([2]));
		assert.deepEqual(bookStore.list().books.map((book) => book.id), ["book_b", "book_a"]);
		const file = path.join(bookDir("book_a"), "book.json");
		fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), futureField: { kept: true } }));
		books.renameBook("book_a", { title: "Renamed" });
		const stored = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.deepEqual(stored.futureField, { kept: true });
		assert.equal(stored.version, 1);
		assert.deepEqual([...bookStore.readOriginal(stored)], [1]);
	});

	it("refuses a newer or damaged record and never rewrites it", async () => {
		bookStore.create(record("book_new"), new Uint8Array([1]));
		const file = path.join(bookDir("book_new"), "book.json");
		fs.writeFileSync(file, JSON.stringify({ ...record("book_new"), version: 2 }));
		const newer = await bookRoute.GET(new Request("http://x"), params("book_new"));
		assert.equal(newer.status, 409);
		assert.deepEqual(await newer.json(), { error: "This book was saved by a newer version of the app." });
		fs.writeFileSync(file, "{ not json");
		const damagedResponse = await bookRoute.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ title: "x" }) }), params("book_new"));
		assert.equal(damagedResponse.status, 409);
		assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
		assert.deepEqual(bookStore.list().unreadable, ["book_new"]);
	});

	it("treats unsafe ids as unknown and refuses a newer data file", async () => {
		assert.equal((await bookRoute.GET(new Request("http://x"), params("../etc"))).status, 404);
		bookStore.create(record("book_data"), new Uint8Array([1]));
		bookStore.writeMap("book_data", { nodes: [] });
		fs.writeFileSync(path.join(bookDir("book_data"), "map.json"), JSON.stringify({ version: 9, nodes: [] }));
		assert.equal((await bookRoute.GET(new Request("http://x"), params("book_data"))).status, 409);
	});
});
