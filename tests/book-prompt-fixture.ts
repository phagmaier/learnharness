/**
 * The item-4 book fixture (plan 05), shared by the prompt and session
 * tests: a PDF with a part, two chapters and numbered paragraphs, its map
 * with summaries and terms, and the book part of its prompt section written
 * out by hand.
 */
type BookBlock = import("../src/core/contracts.ts").BookBlock;
type BookNode = import("../src/core/contracts.ts").BookNode;

export const P111 = "§111. Immediate certainty does not take over the truth, for its truth is the universal.";
export const BLOCKS: BookBlock[] = [
	{ id: 0, kind: "heading", level: 1, text: "A. Consciousness", page: 1 },
	{ id: 1, kind: "heading", level: 2, text: "I. Sense-certainty", page: 1 },
	{ id: 2, kind: "paragraph", text: "§90. The knowledge which is at the start, immediately our object, can be nothing but immediate knowledge.", page: 1 },
	{ id: 3, kind: "paragraph", text: "§91. But, on the face of it, sense-certainty itself proclaims itself to be the truest certainty.", page: 2 },
	{ id: 4, kind: "heading", level: 2, text: "II. Perception", page: 3 },
	{ id: 5, kind: "paragraph", text: P111, page: 3, breaks: [{ at: P111.indexOf("for its"), page: 4 }] },
	{ id: 6, kind: "paragraph", text: "§112. The wealth of sense-knowledge belongs to perception, not to immediate certainty.", page: 4 },
];
export const NODES: BookNode[] = [
	{ id: "n0", label: "A", title: "A. Consciousness", kind: "part", level: 1, firstBlock: 0, lastBlock: 6, pages: { from: "1", to: "4" }, summary: "Consciousness learns that its object is its own doing.", terms: ["consciousness"] },
	{ id: "n1", parentId: "n0", label: "I", title: "I. Sense-certainty", kind: "chapter", level: 2, firstBlock: 1, lastBlock: 3, pages: { from: "1", to: "2" }, summary: "The richest knowledge proves the poorest.", terms: ["this", "now", "here"] },
	{ id: "n2", parentId: "n1", label: "§90", title: "", kind: "paragraph", level: 3, firstBlock: 2, lastBlock: 2, pages: { from: "1", to: "1" }, summary: "Immediate knowing takes its object as it is." },
	{ id: "n3", parentId: "n1", label: "§91", title: "", kind: "paragraph", level: 3, firstBlock: 3, lastBlock: 3, pages: { from: "2", to: "2" }, summary: "Sense-certainty claims to be the truest knowledge." },
	{ id: "n4", parentId: "n0", label: "II", title: "II. Perception", kind: "chapter", level: 2, firstBlock: 4, lastBlock: 6, pages: { from: "3", to: "4" }, summary: "Perception takes the thing as a unity of properties.", terms: ["thing", "properties"] },
	{ id: "n5", parentId: "n4", label: "§111", title: "", kind: "paragraph", level: 3, firstBlock: 5, lastBlock: 5, pages: { from: "3", to: "4" } },
	{ id: "n6", parentId: "n4", label: "§112", title: "", kind: "paragraph", level: 3, firstBlock: 6, lastBlock: 6, pages: { from: "4", to: "4" } },
];
export const HEGEL = { title: "Phenomenology of Spirit", author: "G. W. F. Hegel", format: "pdf" as const, structure: "numbered" as const, mapWriter: { status: "ready" as const } };

export const OUTLINE = [
	"[n0] A. Consciousness — Consciousness learns that its object is its own doing.",
	"  [n1] I. Sense-certainty — The richest knowledge proves the poorest.",
	"    [n2] §90 — Immediate knowing takes its object as it is.",
	"    [n3] §91 — Sense-certainty claims to be the truest knowledge.",
	"  [n4] II. Perception — Perception takes the thing as a unity of properties.",
	"    [n5] §111",
	"    [n6] §112",
].join("\n");

export const BOOK_PART = [
	"## Phenomenology of Spirit, by G. W. F. Hegel",
	"Cite places as the book does, with the page: \"§90 (p. 1)\".",
	"The tools take a place as an id or label from the outline (\"n2\", \"§90\"), a range (\"§90–§91\"), or pages (\"p. 1\").",
	`### Outline\n${OUTLINE}`,
].join("\n\n");

