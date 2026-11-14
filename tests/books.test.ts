/**
 * Plan 05 item 1: the book rules, without a model. Text normalization for
 * search and quotes, the structure candidates an import finds and their
 * confidence, the garbled-text check, location resolution, and the outline
 * and detail texts. Every expected value is worked by hand from the
 * fixture blocks below.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	bookDetailText,
	bookOutlineText,
	chooseCandidate,
	findNumberedRun,
	normalizeBookText,
	pageLooksGarbled,
	rangeText,
	resolveBookLocation,
	structureCandidates,
	textLooksGarbled,
	wordCount,
	type SourceOutlineEntry,
} from "../src/core/book.ts";
import type { BookBlock, BookNode } from "../src/core/contracts.ts";

type Spec = { heading?: string; level?: 1 | 2 | 3; text?: string; page?: number; pageLabel?: string };
const blocks = (specs: Spec[]): BookBlock[] => specs.map((spec, id) => spec.heading !== undefined
	? { id, kind: "heading", level: spec.level ?? 1, text: spec.heading, ...(spec.page !== undefined ? { page: spec.page } : {}), ...(spec.pageLabel ? { pageLabel: spec.pageLabel } : {}) }
	: { id, kind: "paragraph", text: spec.text!, ...(spec.page !== undefined ? { page: spec.page } : {}), ...(spec.pageLabel ? { pageLabel: spec.pageLabel } : {}) });

const TEN = "the spirit finds itself again in what it took for other";
const words = (n: number) => Array.from({ length: n }, (_, i) => ["shape", "spirit", "other", "self", "truth"][i % 5]).join(" ");

/** Heading A, §1–§15, heading B, §16–§30: blocks 0, 1–15, 16, 17–31. */
function paragraphBook(): BookBlock[] {
	const specs: Spec[] = [{ heading: "A. Consciousness" }];
	for (let n = 1; n <= 15; n++) specs.push({ text: `${n}. ${TEN}.` });
	specs.push({ heading: "B. Self-consciousness" });
	for (let n = 16; n <= 30; n++) specs.push({ text: `${n}. ${TEN}.` });
	return blocks(specs);
}

const ids = (nodes: BookNode[]) => nodes.map((node) => `${node.id}:${node.label}:${node.parentId ?? "-"}:${node.firstBlock}-${node.lastBlock}`);

describe("normalization", () => {
	it("joins a line-end hyphen the same way whether the import kept it or not", () => {
		const joined = normalizeBookText("bursting-\nforth").text;
		assert.equal(joined, "burstingforth");
		assert.equal(normalizeBookText("bursting-forth").text, joined);
		assert.equal(normalizeBookText("burstingforth").text, joined);
		assert.notEqual(normalizeBookText("bursting forth").text, joined);
	});

	it("folds typographic quotes, apostrophes, dashes and ligatures, keeping case", () => {
		assert.equal(normalizeBookText("“Hello” it’s – ﬁne").text, "\"Hello\" it's - fine");
		assert.equal(normalizeBookText("Spirit").text, "Spirit");
	});

	it("folds case and accents for search only", () => {
		assert.equal(normalizeBookText("Élan  VITAL", { search: true }).text, "elan vital");
		assert.equal(normalizeBookText("Élan").text, "Élan");
	});

	it("maps each normalized unit back to its offset in the stored text", () => {
		const { text, map } = normalizeBookText("a  “b”");
		assert.equal(text, "a \"b\"");
		assert.deepEqual(map, [0, 1, 3, 4, 5]);
	});

	it("counts words, keeping contractions and hyphenated words whole", () => {
		assert.equal(wordCount("It's a well-known fact, 1807."), 5);
	});
});

describe("garbled text", () => {
	const english = "Self-consciousness exists in and for itself when, and by the fact that, it so exists for another; that is, it exists only in being acknowledged.";
	const symbols = "!#$%&'()*+,-./0123456789:;<=>?@[]^_{|}~ ".repeat(4);
	const consonants = "xqz brtk vlmn skrt gzzp wmmr tkvl prst xqzz brtt vlnn skrr gzzz wmmm tkkl prrt xqqz brrk vvmn sssr ".repeat(2);

	it("passes ordinary prose and flags symbol soup or vowelless tokens", () => {
		assert.equal(pageLooksGarbled(english), false);
		assert.equal(pageLooksGarbled(symbols), true);
		assert.equal(pageLooksGarbled(consonants), true);
	});

	it("accepts Cyrillic and CJK prose without treating their scripts as nonwords", () => {
		for (const prose of [
			"Самосознание существует само по себе и для себя лишь постольку, поскольку оно существует для другого самосознания. ",
			"意识通过经验认识世界，也在认识世界的过程中认识自身。真理不是静止的结果，而是在不断发展的过程中逐渐显现的整体。",
			"意識は経験を通して世界を理解し、自分自身についても学びます。その過程で新しい問いが生まれ、理解が深まります。",
		]) assert.equal(pageLooksGarbled(prose.repeat(3)), false, prose);
		assert.equal(pageLooksGarbled("école âme œuvre où été ".repeat(10)), false);
		assert.equal(pageLooksGarbled("\uFFFD\uE001\uE002".repeat(80)), true);
		assert.equal(pageLooksGarbled(`${english} ${"\uE001".repeat(40)}`), true);
	});

	it("never judges a page with almost no text", () => {
		assert.equal(pageLooksGarbled("#$%"), false);
	});

	it("calls a book garbled only when most judged pages are", () => {
		assert.equal(textLooksGarbled([english, english, symbols]), false);
		assert.equal(textLooksGarbled([symbols, consonants, english]), true);
		assert.equal(textLooksGarbled(["", "short"]), false);
	});
});

describe("numbered paragraphs", () => {
	it("nests a clean §1–§30 run under its two headings, confidently", () => {
		const candidates = structureCandidates({ format: "text", blocks: paragraphBook() });
		assert.deepEqual(candidates.map((candidate) => candidate.method), ["numbered", "headings", "app-made"]);
		const numbered = candidates[0]!;
		assert.deepEqual(numbered.confidence, { level: "confident", reasons: [] });
		assert.equal(numbered.description, "§1–§30 under 2 headings");
		const nodeIds = ids(numbered.nodes);
		assert.equal(nodeIds[0], "n0:A:-:0-15");
		assert.equal(nodeIds[1], "n1:§1:n0:1-1");
		assert.equal(nodeIds[15], "n15:§15:n0:15-15");
		assert.equal(nodeIds[16], "n16:B:-:16-31");
		assert.equal(nodeIds[31], "n31:§30:n16:31-31");
		assert.equal(chooseCandidate(candidates)!.method, "numbered");
	});

	it("is unsure when numbers are missing, and recovers after the gap", () => {
		const book = paragraphBook().filter((block) => !/^[5-9]\. /.test(block.text));
		const run = findNumberedRun(book.map((block, id) => ({ ...block, id })));
		assert.equal(run.entries.length, 25);
		assert.equal(run.max, 30);
		const numbered = structureCandidates({ format: "text", blocks: book.map((block, id) => ({ ...block, id })) })[0]!;
		assert.deepEqual(numbered.confidence.reasons, ["The paragraph numbers have gaps: 25 of 1–30 found."]);
	});

	it("is unsure when numbers repeat, as notes do", () => {
		const specs: Spec[] = [];
		for (let n = 1; n <= 30; n++) {
			specs.push({ text: `${n}. ${TEN}.` });
			if (n === 20) for (let k = 0; k < 3; k++) specs.push({ text: `2. See the note on ${TEN}.` });
		}
		const numbered = structureCandidates({ format: "text", blocks: blocks(specs) }).find((candidate) => candidate.method === "numbered")!;
		assert.deepEqual(numbered.confidence.reasons, ["Some paragraph numbers repeat or run backwards (3 times), for example in notes or lists."]);
	});

	it("is unsure when the run starts late in the text", () => {
		const specs: Spec[] = Array.from({ length: 60 }, () => ({ text: TEN }));
		for (let n = 1; n <= 20; n++) specs.push({ text: `${n}. ${TEN}.` });
		const numbered = structureCandidates({ format: "text", blocks: blocks(specs) }).find((candidate) => candidate.method === "numbered")!;
		assert.deepEqual(numbered.confidence.reasons, ["The numbered paragraphs start late in the text."]);
	});

	it("doesn't take a short numbered list for numbered paragraphs", () => {
		const book = blocks([{ heading: "Intro" }, { text: "1. First point." }, { text: "2. Second point." }, { text: "3. Third point." }, { heading: "More" }, { text: TEN }]);
		assert.deepEqual(structureCandidates({ format: "text", blocks: book }).map((candidate) => candidate.method), ["headings", "app-made"]);
	});

	it("accepts the § sign and ignores a year opening a sentence", () => {
		const book = blocks([{ text: "§1 First." }, { text: "§ 2 Second." }, { text: "1807 was the year." }, { text: "§3. Third." }]);
		assert.deepEqual(findNumberedRun(book).entries.map((entry) => entry.number), [1, 2, 3]);
	});
});

describe("the file's own contents", () => {
	/** 40 pages, one 50-word paragraph per page; chapter openings at 0, 10, 20, 30. */
	function pagedBook(): BookBlock[] {
		return blocks(Array.from({ length: 40 }, (_, i) => ({
			text: i % 10 === 0 ? `Chapter ${i / 10 + 1} The part ${i / 10 + 1} ${words(45)}` : words(50),
			page: i + 1,
		})));
	}
	const chapters = (blocksAt: (number | null)[]): SourceOutlineEntry[] => blocksAt.map((block, k) => ({ title: `Chapter ${k + 1} The part ${k + 1}`, level: 1, block }));

	it("is confident when the bookmarks resolve, run in order, cover the book and name what's there", () => {
		const candidates = structureCandidates({ format: "pdf", blocks: pagedBook(), outline: chapters([0, 10, 20, 30]) });
		assert.equal(candidates[0]!.method, "outline");
		assert.deepEqual(candidates[0]!.confidence, { level: "confident", reasons: [] });
		assert.equal(candidates[0]!.description, "4 entries");
		assert.deepEqual(candidates[0]!.nodes.map((node) => [node.label, node.firstBlock, node.lastBlock, node.pages]), [
			["Chapter 1", 0, 9, { from: "1", to: "10" }],
			["Chapter 2", 10, 19, { from: "11", to: "20" }],
			["Chapter 3", 20, 29, { from: "21", to: "30" }],
			["Chapter 4", 30, 39, { from: "31", to: "40" }],
		]);
		assert.equal(chooseCandidate(candidates)!.method, "outline");
	});

	it("is unsure when the bookmarks cluster at the start", () => {
		const book = blocks(Array.from({ length: 40 }, (_, i) => ({ text: i < 8 ? `Section ${i + 1} ${words(49)}` : words(50), page: i + 1 })));
		const outline = Array.from({ length: 8 }, (_, i) => ({ title: `Section ${i + 1}`, level: 1, block: i }));
		const outlineCandidate = structureCandidates({ format: "pdf", blocks: book, outline })[0]!;
		assert.deepEqual(outlineCandidate.confidence.reasons, ["The bookmarks cover only pages 1–8 of 40."]);
		assert.equal(chooseCandidate(structureCandidates({ format: "pdf", blocks: book, outline }))!.method, "outline", "the best unsure candidate is shown for review");
	});

	it("checks leading coverage even for two bookmarks, but accepts two halves", () => {
		const book = blocks(Array.from({ length: 100 }, (_, i) => ({ text: `Section ${i + 1} ${words(48)}`, page: i + 1 })));
		const outlineAt = (starts: number[]) => starts.map((block) => ({ title: `Section ${block + 1}`, level: 1, block }));
		const late = structureCandidates({ format: "pdf", blocks: book, outline: outlineAt([80, 90]) })[0]!;
		assert.equal(late.confidence.level, "unsure");
		assert.deepEqual(late.confidence.reasons, ["The bookmarks start only at page 81."]);
		assert.deepEqual(structureCandidates({ format: "pdf", blocks: book, outline: outlineAt([0, 50]) })[0]!.confidence, { level: "confident", reasons: [] });
		// Leading coverage is independent of the typical 30-page chapter span.
		assert.equal(structureCandidates({ format: "pdf", blocks: book, outline: outlineAt([30, 60, 90]) })[0]!.confidence.level, "unsure");
	});

	it("names unresolved, out-of-order and misnamed bookmarks", () => {
		const unresolved = structureCandidates({ format: "pdf", blocks: pagedBook(), outline: chapters([0, null, null, 30]) })[0]!;
		assert.deepEqual(unresolved.confidence.reasons, ["Only 2 of 4 bookmarks point to a place in the text."]);
		const unordered = structureCandidates({ format: "pdf", blocks: pagedBook(), outline: [0, 20, 10, 30].map((block) => ({ title: `Chapter ${block / 10 + 1} The part ${block / 10 + 1}`, level: 1, block })) })[0]!;
		assert.deepEqual(unordered.confidence.reasons, ["The bookmarks aren't in the text's order."]);
		const misnamed = structureCandidates({ format: "pdf", blocks: pagedBook(), outline: ["Foo", "Bar", "Baz", "Qux"].map((title, k) => ({ title, level: 1, block: k * 10 })) })[0]!;
		assert.deepEqual(misnamed.confidence.reasons, ["Only 0 of 4 bookmark titles appear in the text where they point."]);
	});

	it("speaks of the table of contents for an EPUB", () => {
		const few = structureCandidates({ format: "epub", blocks: pagedBook(), outline: chapters([0]) })[0]!;
		assert.deepEqual(few.confidence.reasons, ["The table of contents has only 1 entry."]);
	});

	it("nests confident numbered paragraphs inside the bookmarks", () => {
		const outline = [{ title: "A. Consciousness", level: 1, block: 0 }, { title: "B. Self-consciousness", level: 1, block: 16 }];
		const candidates = structureCandidates({ format: "pdf", blocks: paragraphBook(), outline });
		assert.deepEqual(candidates.map((candidate) => candidate.method), ["outline", "numbered", "headings", "app-made"]);
		assert.equal(candidates[0]!.confidence.level, "confident");
		assert.equal(candidates[0]!.description, "2 entries, §1–§30 within them");
		assert.equal(ids(candidates[0]!.nodes)[17], "n17:§16:n16:17-17");
	});
});

describe("headings and app-made parts", () => {
	it("offers detected headings as unsure", () => {
		const book = blocks([{ heading: "Preface" }, { text: TEN }, { heading: "Chapter 1 Being" }, { text: TEN }, { heading: "Chapter 2 Nothing" }, { text: TEN }]);
		const candidates = structureCandidates({ format: "markdown", blocks: book });
		assert.deepEqual(candidates.map((candidate) => candidate.method), ["headings", "app-made"]);
		assert.deepEqual(candidates[0]!.confidence, { level: "unsure", reasons: ["The contents were guessed from the text's headings."] });
		assert.equal(candidates[0]!.description, "3 headings");
		assert.deepEqual(candidates[0]!.nodes.map((node) => [node.label, node.kind]), [["Preface", "section"], ["Chapter 1", "chapter"], ["Chapter 2", "chapter"]]);
	});

	it("keeps compound section numbering as the citation label", () => {
		const titles = ["IV.A. Lordship and bondage", "IV.B Freedom", "IV. Consciousness", "A. Introduction", "1.3.2 Development", "Chapter 2 Being"];
		const book = blocks(titles.map((heading) => ({ heading })));
		const nodes = structureCandidates({ format: "markdown", blocks: book })[0]!.nodes;
		assert.deepEqual(nodes.map((node) => node.label), ["IV.A", "IV.B", "IV", "A", "1.3.2", "Chapter 2"]);
		assert.deepEqual(resolveBookLocation(nodes, book, "IV.A"), { ok: true, kind: "nodes", range: { from: "n0", to: "n0" }, firstBlock: 0, lastBlock: 0, label: "IV.A" });
	});

	it("divides plain text into parts of about 2,000 words at paragraph breaks", () => {
		const thirty = blocks(Array.from({ length: 30 }, () => ({ text: words(300) })));
		const parts = structureCandidates({ format: "text", blocks: thirty });
		assert.equal(parts.length, 1);
		assert.equal(parts[0]!.method, "app-made");
		assert.equal(parts[0]!.description, "5 parts of about 2,000 words");
		// 7 blocks reach 2,100 words; the last 2 (600 words) stand on their own.
		assert.deepEqual(parts[0]!.nodes.map((node) => [node.label, node.title, node.kind, node.firstBlock, node.lastBlock]), [
			["Part 1", "", "app-part", 0, 6], ["Part 2", "", "app-part", 7, 13], ["Part 3", "", "app-part", 14, 20],
			["Part 4", "", "app-part", 21, 27], ["Part 5", "", "app-part", 28, 29],
		]);
		// One block left over (300 words) joins the part before it.
		const tail = structureCandidates({ format: "text", blocks: thirty.slice(0, 29) })[0]!;
		assert.deepEqual(tail.nodes.map((node) => [node.firstBlock, node.lastBlock]), [[0, 6], [7, 13], [14, 20], [21, 28]]);
	});

	it("finds nothing in an empty text", () => {
		assert.deepEqual(structureCandidates({ format: "text", blocks: [] }), []);
	});
});

describe("locations", () => {
	const book = paragraphBook();
	const nodes = structureCandidates({ format: "text", blocks: book })[0]!.nodes;
	const resolve = (input: string) => resolveBookLocation(nodes, book, input);

	it("resolves numbered paragraphs however they are written", () => {
		for (const input of ["§5", "§ 5", "5", "n5"]) {
			assert.deepEqual(resolve(input), { ok: true, kind: "nodes", range: { from: "n5", to: "n5" }, firstBlock: 5, lastBlock: 5, label: "§5" }, input);
		}
	});

	it("resolves ranges, including a bare second number", () => {
		const expected = { ok: true, kind: "nodes", range: { from: "n3", to: "n7" }, firstBlock: 3, lastBlock: 7, label: "§3–§7" };
		assert.deepEqual(resolve("§3–§7"), expected);
		assert.deepEqual(resolve("§3-7"), expected);
		assert.deepEqual(resolve("n3 to n7"), expected);
	});

	it("resolves a section by id, label or title, with its whole subtree", () => {
		const expected = { ok: true, kind: "nodes", range: { from: "n16", to: "n16" }, firstBlock: 16, lastBlock: 31, label: "B" };
		assert.deepEqual(resolve("n16"), expected);
		assert.deepEqual(resolve("B"), expected);
		assert.deepEqual(resolve("B. Self-consciousness"), expected);
		assert.deepEqual(resolve("A to B"), { ok: true, kind: "nodes", range: { from: "n0", to: "n16" }, firstBlock: 0, lastBlock: 31, label: "A–B" });
	});

	it("refuses reversed ranges, unknown labels and ambiguous ones", () => {
		assert.deepEqual(resolve("§7–§3"), { ok: false, error: "The range ends (§3) before it starts (§7)." });
		assert.deepEqual(resolve("§99"), { ok: false, error: "\"§99\" isn't a section of this book. Use a label or id from the map." });
		const twice: BookNode[] = [
			{ id: "n0", label: "I", title: "I. Sense-certainty", kind: "section", level: 1, firstBlock: 0, lastBlock: 0 },
			{ id: "n1", label: "I", title: "I. Force", kind: "section", level: 1, firstBlock: 1, lastBlock: 1 },
		];
		const ambiguous = resolveBookLocation(twice, book, "I");
		assert.equal(ambiguous.ok, false);
		assert.match((ambiguous as { error: string }).error, /^"I" matches several sections: n0 \(I\. Sense-certainty\), n1 \(I\. Force\)\. Use an id\.$/);
	});

	it("finds range boundaries without splitting hyphens inside titles", () => {
		const book = blocks([{ heading: "Sense-certainty" }, { text: TEN }, { heading: "Perception" }, { text: TEN }]);
		const nodes = structureCandidates({ format: "markdown", blocks: book })[0]!.nodes;
		const expected = { ok: true, kind: "nodes", range: { from: "n0", to: "n1" }, firstBlock: 0, lastBlock: 3, label: "Sense-certainty–Perception" };
		for (const input of ["Sense-certainty–Perception", "Sense-certainty-Perception", "Sense-certainty to Perception"]) {
			assert.deepEqual(resolveBookLocation(nodes, book, input), expected, input);
		}
		assert.deepEqual(resolveBookLocation(nodes, book, "Sense-certainty"), { ok: true, kind: "nodes", range: { from: "n0", to: "n0" }, firstBlock: 0, lastBlock: 1, label: "Sense-certainty" });
		assert.deepEqual(resolveBookLocation(nodes, book, "Sense-certainty–Unknown"), { ok: false, error: "\"Unknown\" isn't a section of this book. Use a label or id from the map." });
		assert.deepEqual(resolveBookLocation(nodes, book, "Perception–Sense-certainty"), { ok: false, error: "The range ends (Sense-certainty) before it starts (Perception)." });
		const repeated = [...nodes, { ...nodes[1]!, id: "n2", firstBlock: 4, lastBlock: 4 }];
		const ambiguous = resolveBookLocation(repeated, book, "Sense-certainty–Perception");
		if (ambiguous.ok) assert.fail("An ambiguous endpoint must not resolve.");
		assert.match(ambiguous.error, /"Perception" matches several sections/);
		const asciiAmbiguous = resolveBookLocation(repeated, book, "Sense-certainty-Perception");
		if (asciiAmbiguous.ok) assert.fail("An ambiguous ASCII-range endpoint must not resolve.");
		assert.match(asciiAmbiguous.error, /"Perception" matches several sections/);
		const overlapping = blocks(["A", "B-C", "A-B", "C"].map((heading) => ({ heading })));
		const overlappingNodes = structureCandidates({ format: "markdown", blocks: overlapping })[0]!.nodes;
		assert.deepEqual(resolveBookLocation(overlappingNodes, overlapping, "A-B-C"), { ok: false, error: "\"A-B-C\" matches several ranges. Use section ids with \"to\"." });
	});

	it("resolves pages by their printed label or number, and keeps 'Preface' a section", () => {
		const paged = blocks([{ heading: "Preface", page: 1, pageLabel: "v" }, { text: TEN, page: 1, pageLabel: "v" }, { text: TEN, page: 2 }, { text: TEN, page: 3 }]);
		const pagedNodes = structureCandidates({ format: "pdf", blocks: paged, outline: [{ title: "Preface", level: 1, block: 0 }, { title: "Body", level: 1, block: 2 }] })[0]!.nodes;
		assert.deepEqual(resolveBookLocation(pagedNodes, paged, "p. v"), { ok: true, kind: "pages", firstBlock: 0, lastBlock: 1, label: "p. v" });
		assert.deepEqual(resolveBookLocation(pagedNodes, paged, "pp. 2–3"), { ok: true, kind: "pages", firstBlock: 2, lastBlock: 3, label: "pp. 2–3" });
		assert.deepEqual(resolveBookLocation(pagedNodes, paged, "p. 99"), { ok: false, error: "This book has no page \"99\"." });
		assert.equal((resolveBookLocation(pagedNodes, paged, "Preface") as { kind?: string }).kind, "nodes");
	});

	it("prefers printed pages consistently, including page breaks and partial ranges", () => {
		const paged = blocks([
			{ text: TEN, page: 1, pageLabel: "i" },
			{ text: TEN, page: 2, pageLabel: "ii" },
			{ text: TEN, page: 3, pageLabel: "1" },
			{ text: TEN, page: 4, pageLabel: "2" },
			{ text: TEN, page: 5, pageLabel: "3" },
		]);
		const resolve = (input: string) => resolveBookLocation([], paged, input);
		assert.deepEqual(resolve("p. 1"), { ok: true, kind: "pages", firstBlock: 2, lastBlock: 2, label: "p. 1" });
		assert.deepEqual(resolve("pp. 1–3"), { ok: true, kind: "pages", firstBlock: 2, lastBlock: 4, label: "pp. 1–3" });
		assert.deepEqual(resolve("pp. 4–5"), { ok: true, kind: "pages", firstBlock: 3, lastBlock: 4, label: "pp. 4–5" });
		assert.deepEqual(resolve("pp. 2–4"), { ok: false, error: "This book has no page \"2–4\"." });
		assert.deepEqual(resolve("pp. 3–1"), { ok: false, error: "This book has no page \"3–1\"." });
		paged[3]!.breaks = [{ at: 5, page: 5, pageLabel: "3" }];
		paged.pop();
		assert.deepEqual(resolve("p. 3"), { ok: true, kind: "pages", firstBlock: 3, lastBlock: 3, label: "p. 3" });
		// An absent label means the printed number equals the physical page.
		const implicit = blocks([{ text: TEN, page: 1 }, { text: TEN, page: 2, pageLabel: "2" }, { text: TEN, page: 3 }]);
		assert.deepEqual(resolveBookLocation([], implicit, "pp. 1–3"), { ok: true, kind: "pages", firstBlock: 0, lastBlock: 2, label: "pp. 1–3" });
	});
});

describe("outline and detail texts", () => {
	const book = paragraphBook();
	const nodes = structureCandidates({ format: "text", blocks: book })[0]!.nodes.map((node) => node.id === "n0"
		? { ...node, summary: "Knowing begins with the certainty of the senses.", terms: ["sense-certainty", "this"] }
		: node.id === "n5" ? { ...node, summary: "The now is shown to be a universal.", terms: ["now", "universal"] } : node);

	it("includes every level when it fits, with ids and summaries", () => {
		const text = bookOutlineText(nodes);
		const lines = text.split("\n");
		assert.equal(lines.length, 32);
		assert.equal(lines[0], "[n0] A. Consciousness — Knowing begins with the certainty of the senses.");
		assert.equal(lines[5], "  [n5] §5 — The now is shown to be a universal.");
		assert.equal(lines[16], "[n16] B. Self-consciousness");
	});

	it("collapses deeper levels into counts when the budget is small", () => {
		assert.equal(bookOutlineText(nodes, 40), "[n0] A. Consciousness — Knowing begins with the certainty of the senses. (15 sections)\n[n16] B. Self-consciousness (15 sections)");
	});

	it("cuts the top level short, saying how much is left, when even it doesn't fit", () => {
		// 25 tokens = 100 characters, 60 kept back for the notice: one 38-character line fits.
		const three: BookNode[] = ["Sense-certainty and the this", "Perception and the thing", "Force and the understanding"].map((title, i) => (
			{ id: `n${i}`, label: ["I", "II", "III"][i]!, title: `${["I", "II", "III"][i]}. ${title}`, kind: "section", level: 1, firstBlock: i, lastBlock: i }));
		assert.equal(bookOutlineText(three, 25), "[n0] I. Sense-certainty and the this\n… (2 more sections; open them with book_map)");
	});

	it("gives a unit's reading in detail, with key terms", () => {
		const text = bookDetailText(nodes, [{ from: "n0", to: "n0" }]);
		const lines = text.split("\n");
		assert.equal(lines[0], "[n0] A. Consciousness — Knowing begins with the certainty of the senses.");
		assert.equal(lines[1], "  Terms: sense-certainty, this");
		assert.ok(lines.includes("  [n5] §5 — The now is shown to be a universal."));
		assert.ok(lines.includes("    Terms: now, universal"));
		assert.ok(!text.includes("[n16]"));
	});

	it("preserves every selected root when a mixed-depth reading collapses", () => {
		const reading = [{ from: "n5", to: "n5" }, { from: "n16", to: "n16" }];
		assert.equal(bookDetailText(nodes, reading, 40), "[n5] §5 — The now is shown to be a universal.\n  Terms: now, universal\n[n16] B. Self-consciousness (15 sections)");
		const full = bookDetailText(nodes, reading);
		assert.ok(full.startsWith("[n5] §5 — The now is shown to be a universal.\n  Terms: now, universal\n[n16] B. Self-consciousness\n  [n17] §16"));
	});

	it("names a range by its innermost titled section", () => {
		assert.equal(rangeText(nodes, { from: "n17", to: "n31" }), "§16–§30 (Self-consciousness)");
		assert.equal(rangeText(nodes, { from: "n5", to: "n5" }), "§5 (Consciousness)");
		assert.equal(rangeText(nodes, { from: "n5", to: "n20" }), "§5–§19");
	});
});
