/**
 * Plan 05 item 4: the book in agents' prompts and tools, as pure texts. The
 * citation and location lines per kind of book, the section's parts (map
 * progress, a unit's reading), the composition per agent (the prober's and
 * unit teacher's additions, nothing for the practitioner), the outline
 * collapsing under its budget, and the three tools' answers: book_map with
 * its "narrow to" line, read_section with labels, page markers, its cap and
 * continuation, and search_book. Expected texts are written by hand from the
 * fixture below.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BOOK_OUTLINE_TOKENS,
	bookCitationLine,
	bookLocationsLine,
	bookMapText,
	bookPromptParts,
	bookUnreadableParts,
	readSectionText,
	searchBookText,
} from "../src/core/book-prompt.ts";
import { resolveBookLocation, searchableBlocks } from "../src/core/book.ts";
import { BOOK_DOCTRINE, PROBER_BOOK_ADDITION, TEACHER_UNIT_READING_ADDITION, bookPromptSection } from "../src/agent/book-prompts.ts";
type BookBlock = import("../src/core/contracts.ts").BookBlock;
type BookNode = import("../src/core/contracts.ts").BookNode;

import { BLOCKS, BOOK_PART, HEGEL, NODES, OUTLINE, P111 } from "./book-prompt-fixture.ts";

const PERCEPTION_DETAIL = [
	"[n4] II. Perception — Perception takes the thing as a unity of properties.",
	"  Terms: thing, properties",
	"  [n5] §111",
	"  [n6] §112",
].join("\n");

const appParts = (pages: boolean): BookNode[] => [1, 2].map((n) => ({
	id: `n${n - 1}`, label: `Part ${n}`, title: n === 1 ? "The opening" : "Going on", kind: "app-part" as const, level: 1,
	firstBlock: n - 1, lastBlock: n - 1, ...(pages ? { pages: { from: String(n * 5), to: String(n * 5 + 7) } } : {}),
}));
const withoutPages = NODES.map(({ pages: _pages, ...node }) => node);

// ─── the section ────────────────────────────────────────────────────────────

describe("the book section", () => {
	it("cites as each kind of book does, with examples from the book", () => {
		assert.equal(bookCitationLine(HEGEL, NODES), "Cite places as the book does, with the page: \"§90 (p. 1)\".");
		assert.equal(bookCitationLine({ format: "epub", structure: "numbered" }, withoutPages), "Cite places as the book does: \"§90\".");
		assert.equal(bookCitationLine({ format: "pdf", structure: "app-made" }, appParts(true)), "Cite places by page: \"p. 5\". The app divided this book into parts; never cite them.");
		assert.equal(bookCitationLine({ format: "text", structure: "app-made" }, appParts(false)), "Cite places by the app's part numbers: \"Part 1\". The book has no structure of its own.");
	});

	it("names the location forms this book has", () => {
		assert.equal(bookLocationsLine(NODES), "The tools take a place as an id or label from the outline (\"n2\", \"§90\"), a range (\"§90–§91\"), or pages (\"p. 1\").");
		assert.equal(bookLocationsLine(withoutPages), "The tools take a place as an id or label from the outline (\"n2\", \"§90\") or a range (\"§90–§91\").");
		assert.equal(bookLocationsLine([NODES[0]!]), "The tools take a place as an id or label from the outline (\"n0\", \"A\") or pages (\"pp. 1–4\").");
	});

	it("is the header, citation, locations and outline; a followed unit adds its reading", () => {
		assert.deepEqual(bookPromptParts(HEGEL, NODES), { book: BOOK_PART });
		assert.equal((bookPromptParts({ ...HEGEL, author: undefined }, NODES) as { book: string }).book.split("\n")[0], "## Phenomenology of Spirit");
		assert.deepEqual(bookPromptParts(HEGEL, NODES, [{ from: "n4", to: "n4" }]), {
			book: BOOK_PART,
			reading: { heading: "## This unit's reading: II (Perception)", detail: PERCEPTION_DETAIL },
		});
		// A reading naming nodes the map no longer has adds nothing.
		assert.deepEqual(bookPromptParts(HEGEL, NODES, [{ from: "n40", to: "n41" }]), { book: BOOK_PART });
	});

	it("says summaries are still coming while the map is written", () => {
		for (const status of ["waiting", "writing"] as const) {
			const { book } = bookPromptParts({ ...HEGEL, mapWriter: { status } }, NODES) as { book: string };
			assert.ok(book.includes("or pages (\"p. 1\").\nSummaries are still being written; the outline shows those done.\n\n### Outline"), status);
		}
		for (const status of ["ready", "not-needed", "failed"] as const) {
			const { book } = bookPromptParts({ ...HEGEL, mapWriter: { status } }, NODES) as { book: string };
			assert.ok(!book.includes("Summaries are still being written"), status);
		}
	});

	it("collapses the outline to whole levels within its budget", () => {
		// 3 parts × 300 paragraphs with 100-character summaries: about
		// 33k tokens in full, so only the parts show, each with its count.
		const big: BookNode[] = [];
		for (let part = 0; part < 3; part++) {
			const id = `n${big.length}`;
			big.push({ id, label: `Part ${part + 1}`, title: `Part ${part + 1}`, kind: "part", level: 1, firstBlock: part * 300, lastBlock: part * 300 + 299 });
			for (let p = 0; p < 300; p++) {
				const at = part * 300 + p;
				big.push({ id: `n${big.length}`, parentId: id, label: `§${at + 1}`, title: "", kind: "paragraph", level: 2, firstBlock: at, lastBlock: at, summary: "x".repeat(100) });
			}
		}
		const { book } = bookPromptParts({ ...HEGEL, structure: "numbered" }, big) as { book: string };
		const outline = book.slice(book.indexOf("### Outline\n") + "### Outline\n".length);
		assert.equal(outline, "[n0] Part 1 (300 sections)\n[n301] Part 2 (300 sections)\n[n602] Part 3 (300 sections)");
		assert.ok(outline.length <= BOOK_OUTLINE_TOKENS * 4);
	});

	it("composes per agent: the prober's addition, the unit teacher's before the reading, the setup agent's plain", () => {
		const parts = bookPromptParts(HEGEL, NODES, [{ from: "n4", to: "n4" }]);
		assert.ok(BOOK_DOCTRINE.startsWith("# The learner's book\n\nThis session studies a book from the learner's library."));
		assert.equal(bookPromptSection("prober", parts), [BOOK_DOCTRINE, PROBER_BOOK_ADDITION, BOOK_PART, "## This unit's reading: II (Perception)", PERCEPTION_DETAIL].join("\n\n"));
		assert.equal(bookPromptSection("teacher", parts), [BOOK_DOCTRINE, BOOK_PART, "## This unit's reading: II (Perception)", TEACHER_UNIT_READING_ADDITION, PERCEPTION_DETAIL].join("\n\n"));
		assert.equal(bookPromptSection("setup", parts), [BOOK_DOCTRINE, BOOK_PART, "## This unit's reading: II (Perception)", PERCEPTION_DETAIL].join("\n\n"));
		// No reading: no unit-teacher addition either.
		assert.equal(bookPromptSection("teacher", bookPromptParts(HEGEL, NODES)), [BOOK_DOCTRINE, BOOK_PART].join("\n\n"));
		assert.equal(bookPromptSection("practice", parts), null, "the practitioner reads the book from item 7");
		assert.ok(!BOOK_DOCTRINE.includes("quote_passage"), "quoting arrives with its tool in item 5");
	});

	it("tells the agent plainly when the book can't be read", () => {
		const parts = bookUnreadableParts("Phenomenology of Spirit", "This book was saved by a newer version of the app.");
		assert.equal(bookPromptSection("teacher", parts), "# The learner's book\n\nThis session's book, \"Phenomenology of Spirit\", can't be read right now (this book was saved by a newer version of the app). Teach without it; if the learner asks about it, say so.");
		assert.equal(bookPromptSection("prober", parts), bookPromptSection("teacher", parts));
	});
});

// ─── the tools ──────────────────────────────────────────────────────────────

describe("read_section", () => {
	it("reads a range with page markers, folding labels the text already starts with", () => {
		assert.deepEqual(readSectionText(NODES, BLOCKS, "§90–§91"), { text: [
			"§90–§91 (Sense-certainty), pp. 1–2",
			"[p. 1]\n§90. The knowledge which is at the start, immediately our object, can be nothing but immediate knowledge.",
			"[p. 2]\n§91. But, on the face of it, sense-certainty itself proclaims itself to be the truest certainty.",
		].join("\n\n") });
	});

	it("marks headings, and a page that starts inside a paragraph", () => {
		assert.deepEqual(readSectionText(NODES, BLOCKS, "II"), { text: [
			"II (Perception), pp. 3–4",
			"[p. 3]\n## II. Perception",
			"§111. Immediate certainty does not take over the truth, [p. 4] for its truth is the universal.",
			"§112. The wealth of sense-knowledge belongs to perception, not to immediate certainty.",
		].join("\n\n") });
		assert.equal(readSectionText(NODES, BLOCKS, "pp. 3–4").text.split("\n")[0], "pp. 3–4");
	});

	it("labels a section whose text doesn't start with its label", () => {
		const blocks: BookBlock[] = [{ id: 0, kind: "paragraph", text: "In the beginning the part speaks." }, { id: 1, kind: "paragraph", text: "It goes on." }];
		const nodes: BookNode[] = [
			{ id: "n0", label: "Part 1", title: "Opening", kind: "app-part", level: 1, firstBlock: 0, lastBlock: 0 },
			{ id: "n1", label: "I", title: "", kind: "section", level: 1, firstBlock: 1, lastBlock: 1 },
		];
		assert.equal(readSectionText(nodes, blocks, "n0 to n1").text, "Part 1–I\n\n[Part 1]\nIn the beginning the part speaks.\n\n[I]\nIt goes on.");
	});

	it("stops at about 8k tokens and names where to continue, which reads on", () => {
		// 30 blocks of 2,000 characters: a block and its separator take 2,002 of
		// the 32,000 characters, so 15 blocks fit (30,030) and a 16th would not.
		const blocks: BookBlock[] = Array.from({ length: 30 }, (_, id) => ({ id, kind: "paragraph", text: `${id}`.padEnd(2_000, "a") }));
		const nodes: BookNode[] = [{ id: "n0", label: "Chapter 1", title: "Chapter 1", kind: "chapter", level: 1, firstBlock: 0, lastBlock: 29 }];
		const first = readSectionText(nodes, blocks, "Chapter 1").text;
		assert.ok(first.endsWith(`${"14".padEnd(2_000, "a")}\n\nContinues: call read_section with at "blocks 15–29"`), first.slice(-120));
		assert.ok(!first.includes("15".padEnd(2_000, "a")));
		const rest = readSectionText(nodes, blocks, "blocks 15–29").text;
		assert.ok(rest.startsWith(`blocks 15–29\n\n${"15".padEnd(2_000, "a")}`));
		assert.ok(rest.endsWith("29".padEnd(2_000, "a")), "the rest fits");
		assert.ok(readSectionText(nodes, blocks, "blocks 14–15").text.endsWith("15".padEnd(2_000, "a")));
	});

	it("continues within an oversized block without losing text or the rest of the range", () => {
		const opening = "Every idea depends on its conditions. ".repeat(12_000);
		const blocks: BookBlock[] = [
			{ id: 0, kind: "paragraph", text: opening },
			{ id: 1, kind: "paragraph", text: "The next paragraph." },
			{ id: 2, kind: "paragraph", text: "Outside the requested range." },
		];
		let at = "blocks 0–1";
		let recovered = "";
		const locations = new Set<string>();
		for (;;) {
			assert.ok(!locations.has(at), "a continuation must make progress");
			locations.add(at);
			const result = readSectionText([], blocks, at);
			assert.equal(result.error, undefined, result.text);
			assert.ok(result.text.length <= 32_000, `returned ${result.text.length} characters`);
			const continuation = result.text.match(/\n\nContinues: call read_section with at "([^"]+)"$/);
			const body = result.text.slice(result.text.indexOf("\n\n") + 2, continuation?.index);
			recovered += body;
			if (!continuation) break;
			at = continuation[1]!;
			assert.ok(locations.size < 30, "the bounded reads must finish");
		}
		assert.equal(recovered, `${opening}\n\nThe next paragraph.`);
	});

	it("resumes on the right page and preserves Unicode across partial blocks", () => {
		const text = "α😀 ".repeat(20_000);
		const blocks: BookBlock[] = [{ id: 0, kind: "paragraph", text, page: 1, breaks: [{ at: 4, page: 2 }] }];
		const first = readSectionText([], blocks, "block 0 from offset 4").text;
		assert.ok(first.startsWith("block 0 from offset 4, p. 2\n\n[p. 2]\n"));
		const next = first.match(/\n\nContinues: call read_section with at "([^"]+)"$/)!;
		assert.ok(next, "a partial block has a continuation");
		const offset = Number(next[1]!.match(/offset (\d+)$/)![1]);
		const body = first.slice(first.indexOf("[p. 2]\n") + "[p. 2]\n".length, next.index);
		assert.equal(body, text.slice(4, offset));
		assert.ok(!/[\uD800-\uDBFF]$/.test(body), "a surrogate pair must stay together");
		assert.ok(first.length <= 32_000);
		const following = readSectionText([], blocks, next[1]!).text;
		assert.ok(following.startsWith(`${next[1]}, p. 2\n\n[p. 2]\n`));
	});

	it("sends a location it can't find back to the model", () => {
		assert.deepEqual(readSectionText(NODES, BLOCKS, "§999"), { text: "\"§999\" isn't a section of this book. Use a label or id from the map.", error: true });
		assert.deepEqual(readSectionText(NODES, BLOCKS, "blocks 5–9"), { text: "This book's blocks run from 0 to 6.", error: true });
	});
});

describe("block locations", () => {
	it("resolve as a block or a range of blocks", () => {
		assert.deepEqual(resolveBookLocation(NODES, BLOCKS, "blocks 2–3"), { ok: true, kind: "blocks", firstBlock: 2, lastBlock: 3, label: "blocks 2–3" });
		assert.deepEqual(resolveBookLocation(NODES, BLOCKS, "block 4"), { ok: true, kind: "blocks", firstBlock: 4, lastBlock: 4, label: "block 4" });
		assert.deepEqual(resolveBookLocation(NODES, BLOCKS, "blocks 3-2"), { ok: false, error: "The blocks end (2) before they start (3)." });
		assert.deepEqual(resolveBookLocation(NODES, BLOCKS, "blocks 2–3 from offset 5"), {
			ok: true, kind: "blocks", firstBlock: 2, lastBlock: 3, firstOffset: 5, label: "blocks 2–3 from offset 5",
		});
		assert.equal(readSectionText(NODES, BLOCKS, "block 2 from offset 9999").error, true);
		assert.equal(readSectionText([], [{ id: 0, kind: "paragraph", text: "a😀b" }], "block 0 from offset 2").error, true);
	});
});

describe("book_map", () => {
	it("shows the map under a location with summaries and terms", () => {
		assert.deepEqual(bookMapText(NODES, BLOCKS, "I"), { text: [
			"Map of I (Sense-certainty):",
			"[n1] I. Sense-certainty — The richest knowledge proves the poorest.",
			"  Terms: this, now, here",
			"  [n2] §90 — Immediate knowing takes its object as it is.",
			"  [n3] §91 — Sense-certainty claims to be the truest knowledge.",
		].join("\n") });
		assert.ok(bookMapText(NODES, BLOCKS).text.startsWith("Map of the whole book:\n[n0] A. Consciousness — Consciousness learns that its object is its own doing.\n  Terms: consciousness\n"));
		assert.deepEqual(bookMapText(NODES, BLOCKS, "p. 3"), { text: "book_map takes a section or a range from the outline, not pages or blocks. Read those with read_section.", error: true });
	});

	it("over its cap, collapses levels and names where to narrow", () => {
		// 3 parts × 40 paragraphs with 150-character summaries and terms:
		// about 9k tokens in full, so the parts show with their counts.
		const big: BookNode[] = [];
		for (let part = 0; part < 3; part++) {
			const id = `n${big.length}`;
			big.push({ id, label: `Part ${part + 1}`, title: ["Part 1. Force", "Part 2. Life", "Part 3. Spirit"][part]!, kind: "part", level: 1, firstBlock: part * 40, lastBlock: part * 40 + 39 });
			for (let p = 0; p < 40; p++) {
				big.push({ id: `n${big.length}`, parentId: id, label: `§${part * 40 + p + 1}`, title: "", kind: "paragraph", level: 2, firstBlock: part * 40 + p, lastBlock: part * 40 + p, summary: "s".repeat(150), terms: ["term"] });
			}
		}
		assert.deepEqual(bookMapText(big, []), { text: [
			"Map of the whole book:",
			"[n0] Part 1. Force (40 sections)",
			"[n41] Part 2. Life (40 sections)",
			"[n82] Part 3. Spirit (40 sections)",
			"",
			"Too large to show in full. Narrow to one of: n0 (Part 1. Force), n41 (Part 2. Life), n82 (Part 3. Spirit)",
		].join("\n") });
		const one = bookMapText(big, [], "n41").text;
		assert.ok(one.startsWith("Map of Part 2 (Life):\n[n41] Part 2. Life\n  [n42] §41 — "), one.slice(0, 80));
		assert.ok(!one.includes("Too large"), "one part fits");
	});

	it("lets an oversized selected chapter reach every child through its narrowing advice", () => {
		const chapter: BookNode = { id: "n0", label: "Chapter 1", title: "The argument", kind: "chapter", level: 1, firstBlock: 0, lastBlock: 199 };
		const children: BookNode[] = Array.from({ length: 200 }, (_, i) => ({
			id: `n${i + 1}`, parentId: "n0", label: `Section ${i + 1}`, title: `Topic ${i + 1}`,
			kind: "section", level: 2, firstBlock: i, lastBlock: i, summary: "s".repeat(150),
		}));
		const nodes = [chapter, ...children];
		const pending = ["n0"];
		const visited = new Set<string>();
		const visible = new Set<string>();
		while (pending.length > 0) {
			const at = pending.shift()!;
			assert.ok(!visited.has(at), `narrowing repeats ${at}`);
			visited.add(at);
			const answer = bookMapText(nodes, [], at);
			assert.equal(answer.error, undefined);
			for (const match of answer.text.matchAll(/^\s*\[(n\d+)\] .* — s{150}$/gm)) visible.add(match[1]!);
			const advice = answer.text.split("Narrow to one of: ")[1];
			if (advice) {
				for (const choice of advice.split(", ")) {
					const location = choice.match(/^(n\d+(?: to n\d+)?)/)?.[1];
					assert.ok(location, `unusable narrowing advice: ${choice}`);
					pending.push(location);
				}
			}
			assert.ok(visited.size < 250, "navigation must finish");
		}
		assert.deepEqual([...visible].sort(), children.map((node) => node.id).sort());
	});

	it("keeps all subtrees reachable when there are more than 30 narrowing choices", () => {
		const nodes: BookNode[] = [{ id: "n0", label: "Chapter 1", title: "The argument", kind: "chapter", level: 1, firstBlock: 0, lastBlock: 159 }];
		for (let section = 0; section < 40; section++) {
			const parentId = `n${nodes.length}`;
			nodes.push({ id: parentId, parentId: "n0", label: `Section ${section + 1}`, title: "", kind: "section", level: 2, firstBlock: section * 4, lastBlock: section * 4 + 3, summary: "s".repeat(150) });
			for (let p = 0; p < 4; p++) {
				nodes.push({ id: `n${nodes.length}`, parentId, label: `§${section * 4 + p + 1}`, title: "", kind: "paragraph", level: 3, firstBlock: section * 4 + p, lastBlock: section * 4 + p, summary: "s".repeat(150) });
			}
		}
		const first = bookMapText(nodes, [], "n0").text;
		const advice = first.split("Narrow to one of: ")[1]!.split(", ");
		assert.equal(advice.length, 30);
		assert.equal(advice.at(-1), "n146 to n196");
		const rest = bookMapText(nodes, [], "n146 to n196").text;
		assert.ok(rest.includes("[n150] §120 — "), "the first grouped subtree is readable");
		assert.ok(rest.includes("[n200] §160 — "), "the last subtree wasn't lost to an ellipsis");
		assert.ok(!rest.includes("Too large"), "the remaining group fits");
	});

	it("when even the top level doesn't fit, names the range left out", () => {
		const flat: BookNode[] = Array.from({ length: 400 }, (_, i) => ({ id: `n${i}`, label: `§${i + 1}`, title: "", kind: "paragraph" as const, level: 1, firstBlock: i, lastBlock: i, summary: "s".repeat(150) }));
		const { text } = bookMapText(flat, []);
		const shown = text.split("\n").filter((line) => line.startsWith("[n")).length;
		assert.ok(shown > 50 && shown < 400, String(shown));
		assert.ok(text.endsWith(`\n\nToo large to show in full. Narrow to one of: n${shown} to n399`), text.slice(-80));
		assert.ok(text.includes(`[n${shown - 1}] §${shown} — `) && !text.includes(`[n${shown}] `));
	});
});

describe("search_book", () => {
	const searchable = searchableBlocks(BLOCKS);
	it("lists matches with their place, page and the text around them", () => {
		const { text } = searchBookText(NODES, BLOCKS, searchable, "CERTAINTY");
		const lines = text.split("\n");
		// Blocks 1, 3 (twice), 5 and 6 hold "certainty".
		assert.equal(lines[0], "5 matches:");
		assert.equal(lines[1], "- I (n1), p. 1: \"I. Sense-certainty\"");
		assert.ok(lines[2]!.startsWith("- §91 (n3), p. 2: \"") && lines[3]!.startsWith("- §91 (n3), p. 2: \""));
		assert.equal(lines[4], `- §111 (n5), p. 3: "${P111}"`);
		assert.equal(lines[5], "- §112 (n6), p. 4: \"§112. The wealth of sense-knowledge belongs to perception, not to immediate certainty.\"");
		assert.equal(lines.length, 6);
	});

	it("says how many there are past 20, and when there are none", () => {
		const blocks: BookBlock[] = Array.from({ length: 25 }, (_, id) => ({ id, kind: "paragraph", text: `Word ${id}.` }));
		const { text } = searchBookText([], blocks, searchableBlocks(blocks), "word");
		assert.equal(text.split("\n")[0], "25 matches; showing the first 20. Add words to narrow it.");
		assert.equal(text.split("\n").length, 21);
		assert.equal(text.split("\n")[1], "- block 0: \"Word 0.\"");
		assert.deepEqual(searchBookText(NODES, BLOCKS, searchable, "absolute knowing"), { text: "No matches for \"absolute knowing\"." });
		assert.deepEqual(searchBookText(NODES, BLOCKS, searchable, "  "), { text: "Give a word or phrase to search for.", error: true });
		assert.equal(searchBookText(NODES, BLOCKS, searchable, "x".repeat(501)).error, true);
	});
});
