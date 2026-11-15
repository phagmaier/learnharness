/**
 * Plan 05 item 3: the library and book pages, rendered. Each library row
 * state with its wording and Try again; the book page's facts (format,
 * size, the map's state and usage, where the contents came from, "Not
 * right" only while nothing uses the book, "Used by" links); "Check the
 * contents" in review and after "Not right" (a replacement model candidate
 * included, and a failed read of the candidates); the delete dialog's
 * refusal (an unreadable user unlinked) and confirmation; and the reader's blocks (margin labels, pages, page
 * breaks inside a paragraph, the marked match). Item 4: the composers'
 * Book control (which books it offers, its menu, Course mode's switch, what
 * a start sends) and the top bar's book chip. Expected wording comes from
 * the plan's Proposed wording, or the agent-selected wording reported with
 * items 3 and 4.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { BookRow, ImportError, LibraryList } from "../components/books-library.tsx";
import { BookFacts } from "../components/book-page.tsx";
import { ContentsReviewBody, ContentsTree, modelPassLabel } from "../components/book-contents-review.tsx";
import { DeleteBookBody } from "../components/delete-book-dialog.tsx";
import { ReaderBlock, ReaderContents, ReaderText } from "../components/book-reader.tsx";
import { blockSegments, bookPickerEntries, contentsRows, marginLabels, methodChoiceLine, type BookPageBook, type LibraryBook } from "../components/book-view.ts";
import { BookModeSwitch, BookPickerMenuBody, composerBookBody } from "../components/book-picker.tsx";
import { BookChip } from "../components/book-chip.tsx";
import { DraftShell, startDraftSession } from "../components/new-session.tsx";
import { SessionStartRefusal } from "../components/start-session.ts";
import { renderWithInteractionLayers } from "./interaction-layer-render.tsx";
type BookNode = import("../src/core/contracts.ts").BookNode;
type BookCandidate = import("../src/core/contracts.ts").BookCandidate;

const doc = (element: React.ReactElement) => parseHTML(`<html><body>${renderToStaticMarkup(element)}</body></html>`).document;
const text = (root: ParentNode, selector: string) => root.querySelector(selector)?.textContent ?? null;

const base: LibraryBook = {
	id: "book_a", title: "Phenomenology", author: "Hegel", format: "pdf", importedAt: "2026-11-14T10:00:00.000Z", pageCount: 610,
	import: { status: "ready" }, mapWriter: { status: "ready", done: 808, total: 808 },
};
const row = (book: Partial<LibraryBook>, onRetry?: () => void) => doc(<ul><BookRow book={{ ...base, ...book }} {...(onRetry ? { onRetry } : {})} /></ul>);

describe("library rows", () => {
	it("shows each state in the plan's wording, with Try again only where it helps", () => {
		const cases: [Partial<LibraryBook>, string, boolean][] = [
			[{ import: { status: "importing" } }, "Importing…", false],
			[{ import: { status: "importing" }, progress: { done: 120, total: 610 } }, "Importing… page 120 of 610", false],
			[{ import: { status: "review" } }, "Check the contents", false],
			[{ mapWriter: { status: "writing", done: 120, total: 808 } }, "Mapping 120 of 808 sections", false],
			[{ mapWriter: { status: "ready", done: 808, total: 808 } }, "Map ready", false],
			[{ mapWriter: { status: "not-needed", done: 0, total: 0 } }, "Short book: no map needed", false],
			[{ mapWriter: { status: "failed", done: 0, total: 808, error: "No model configured — set up your models first" } }, "Map failed: No model configured — set up your models first", true],
			[{ mapWriter: { status: "failed", done: 40, total: 808, error: "Stopped", stopped: true } }, "Map stopped at 40 of 808 sections", true],
			[{ import: { status: "failed", error: "The import was interrupted." }, retryable: true }, "The import was interrupted.", true],
			[{ import: { status: "failed", error: "This PDF has no text layer. OCR isn't supported." }, retryable: false }, "This PDF has no text layer. OCR isn't supported.", false],
		];
		for (const [book, state, retry] of cases) {
			const root = row(book, () => {});
			assert.equal(text(root, '[data-testid="book-state"]'), state);
			assert.equal(root.querySelector('[data-testid="book-retry"]') !== null, retry, state);
		}
	});

	it("names the author, format and size, and links the book page", () => {
		const root = row({});
		assert.equal(text(root, '[data-testid="book-facts"]'), "Hegel · PDF · 610 pages");
		assert.equal(root.querySelector('[data-testid="book-open"]')?.getAttribute("href"), "/books/book_a");
		const epub = row({ format: "epub", author: undefined, pageCount: undefined, sections: 96 } as Partial<LibraryBook>);
		assert.equal(text(epub, '[data-testid="book-facts"]'), "EPUB · 96 sections");
	});

	it("says so when the library is empty or some records can't be read", () => {
		const root = doc(<LibraryList books={[]} unreadable={2} />);
		assert.equal(text(root, '[data-testid="books-empty"]'), "No books yet. Import a PDF, EPUB, text or Markdown file.");
		assert.equal(text(root, '[data-testid="books-unreadable"]'), "2 books in the library can't be read.");
	});

	it("links the book already in the library on a duplicate import", () => {
		const root = doc(<ImportError error="This book is already in your library: Phenomenology." existing={{ id: "book_a", title: "Phenomenology" }} />);
		assert.equal(root.querySelector("a")?.getAttribute("href"), "/books/book_a");
		assert.equal(text(root, '[data-testid="book-import-error"]'), "This book is already in your library: Phenomenology.");
	});
});

const pageBook: BookPageBook = {
	...base, fileName: "p.pdf", bytes: 1, updatedAt: base.importedAt, structure: "outline", contentsAccepted: "auto", sections: 864,
	mapWriter: { status: "ready", done: 864, total: 864, usage: { model: "openai:gpt-mini", inputTokens: 690_000, outputTokens: 8_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, steps: 66 } },
	mapCostUsd: 0.21,
};

describe("the book page's facts", () => {
	it("shows the map's state and usage, the contents' source and Not right while nothing uses the book", () => {
		const root = doc(<BookFacts book={pageBook} usedBy={[]} onNotRight={() => {}} />);
		assert.equal(text(root, '[data-testid="book-format"]'), "PDF");
		assert.equal(text(root, '[data-testid="book-map-state"]'), "Map ready");
		assert.equal(text(root, '[data-testid="book-map-usage"]'), "· gpt-mini · openai · 698k tokens · $0.2100");
		assert.equal(text(root, '[data-testid="book-contents-source"]'), "Contents from the PDF's bookmarks");
		assert.ok(root.querySelector('[data-testid="book-not-right"]'));
		assert.equal(root.querySelector('[data-testid="book-used-by"]'), null);
	});

	it("marks app-made parts and lists users with links instead of Not right", () => {
		const users = [
			{ kind: "course" as const, id: "c1", title: "Hegel course", href: "/course/c1" },
			{ kind: "session" as const, id: "s1", title: "Reading", href: "/chat/s1" },
		];
		const root = doc(<BookFacts book={{ ...pageBook, format: "text", structure: "app-made" }} usedBy={users} />);
		assert.equal(text(root, '[data-testid="book-contents-source"]'), "Divided by the app");
		assert.equal(root.querySelector('[data-testid="book-not-right"]'), null);
		assert.equal(text(root, '[data-testid="book-used-by"]'), "Used by: Hegel course, Reading");
		assert.deepEqual([...root.querySelectorAll('[data-testid="book-used-by"] a')].map((a) => a.getAttribute("href")), ["/course/c1", "/chat/s1"]);
		// A record that can't be read has no page to link.
		const unreadable = doc(<BookFacts book={pageBook} usedBy={[{ kind: "session", id: "s2", title: "a session that can't be read (s2)" }]} />);
		assert.equal(text(unreadable, '[data-testid="book-used-by"]'), "Used by: a session that can't be read (s2)");
		assert.equal(unreadable.querySelector('[data-testid="book-used-by"] a'), null);
	});

	it("hides map facts until the import is ready, and shows a skipped-pages notice", () => {
		const root = doc(<BookFacts book={{ ...pageBook, import: { status: "review", notice: "3 pages have no text and are skipped. OCR isn't supported." }, contentsAccepted: undefined } as BookPageBook} usedBy={[]} />);
		assert.equal(root.querySelector('[data-testid="book-map-state"]'), null);
		assert.equal(root.querySelector('[data-testid="book-contents-source"]'), null);
		assert.equal(text(root, '[data-testid="book-notice"]'), "3 pages have no text and are skipped. OCR isn't supported.");
	});
});

/** Chapter 1 (§1–§3), Chapter 2 (§4), with pages. */
const NODES: BookNode[] = [
	{ id: "n0", label: "Chapter 1", title: "Chapter 1 Being", kind: "chapter", level: 1, firstBlock: 0, lastBlock: 3, pages: { from: "1", to: "4" } },
	{ id: "n1", parentId: "n0", label: "§1", title: "", kind: "paragraph", level: 2, firstBlock: 1, lastBlock: 1, pages: { from: "1", to: "1" } },
	{ id: "n2", parentId: "n0", label: "§2", title: "", kind: "paragraph", level: 2, firstBlock: 2, lastBlock: 2, pages: { from: "2", to: "2" } },
	{ id: "n3", parentId: "n0", label: "§3", title: "", kind: "paragraph", level: 2, firstBlock: 3, lastBlock: 3, pages: { from: "3", to: "4" }, summary: "Being turns into nothing." },
	{ id: "n4", label: "IV.A", title: "Lordship and bondage", kind: "section", level: 1, firstBlock: 4, lastBlock: 4, pages: { from: "5", to: "5" } },
];
const PARTS: BookNode[] = [1, 2, 3].map((n) => ({ id: `n${n - 1}`, label: `Part ${n}`, title: "", kind: "app-part", level: 1, firstBlock: n - 1, lastBlock: n - 1 }));
const candidate = (method: BookCandidate["method"], description: string, nodes = NODES): BookCandidate => ({ method, description, nodes, confidence: { level: "unsure", reasons: [] } });

describe("the contents", () => {
	it("folds numbered paragraphs under a section into one run", () => {
		assert.deepEqual(contentsRows(NODES).map((r) => r.kind === "node" ? r.node.id : `run:${r.nodes.map((n) => n.id).join(",")}`), ["n0", "run:n1,n2,n3", "n4"]);
		const root = doc(<ContentsTree nodes={NODES} />);
		assert.deepEqual([...root.querySelectorAll('[data-testid="contents-node"]')].map((li) => li.textContent), ["Chapter 1 Beingpp. 1–4", "IV.ALordship and bondagep. 5"]);
		assert.equal(text(root, '[data-testid="contents-run"]'), "§1–§3 · 3 numbered paragraphspp. 1–4");
	});

	it("names each method on Not right as the plan's examples do", () => {
		assert.equal(methodChoiceLine("pdf", candidate("numbered", "§1–§808 under 12 headings")), "Numbered paragraphs: §1–§808 under 12 headings");
		assert.equal(methodChoiceLine("pdf", candidate("headings", "2 headings")), "Headings: 2");
		assert.equal(methodChoiceLine("text", candidate("app-made", "5 parts of about 2,000 words")), "Parts of about 2,000 words: 5");
		assert.equal(methodChoiceLine("epub", candidate("outline", "2 entries")), "The EPUB's table of contents: 2 entries");
		assert.equal(modelPassLabel({ tokens: 6_400, model: { provider: "openai", id: "gpt-mini" } }), "Find the contents with the model (about 6k tokens on gpt-mini)");
		assert.equal(modelPassLabel(null), "Find the contents with the model");
	});

	const review = (props: Partial<React.ComponentProps<typeof ContentsReviewBody>>) => doc(<ContentsReviewBody
		format="pdf" mode="review" current="outline" currentNodes={NODES} confidence={{ level: "unsure", reasons: ["The bookmarks cover only pages 1–140 of 610."] }}
		candidates={[candidate("outline", "2 entries"), candidate("numbered", "§1–§3 under 1 heading"), candidate("app-made", "3 parts of about 2,000 words", PARTS)]}
		loaded loadError={null}
		choosing={false} selected={null} estimate={{ tokens: 6_000, model: { provider: "openai", id: "gpt-mini" } }} estimateError={null}
		modelPass={undefined} busy={false} error={null}
		onLooksRight={() => {}} onNotRight={() => {}} onSelect={() => {}} onUse={() => {}} onBack={() => {}} onFindWithModel={() => {}} onRetryLoad={() => {}}
		{...props}
	/>);

	it("asks in review, with the reasons and the found contents", () => {
		const root = review({});
		assert.equal(text(root, '[data-testid="contents-unsure"] h2'), "We're not sure these contents are right.");
		assert.equal(text(root, '[data-testid="contents-reasons"]'), "The bookmarks cover only pages 1–140 of 610.");
		assert.ok(root.querySelector('[data-testid="contents-looks-right"]'));
		assert.ok(root.querySelector('[data-testid="contents-not-right"]'));
		assert.equal(root.querySelector('[data-testid="contents-viewing"]')?.getAttribute("data-method"), "outline");
		assert.equal(root.querySelector('[data-testid="contents-methods"]'), null);
	});

	it("lists the other methods after Not right, the selected one's contents with Use these, then the model pass", () => {
		const root = review({ choosing: true, selected: "numbered" });
		assert.deepEqual([...root.querySelectorAll('[data-testid="contents-method"]')].map((b) => b.textContent), ["Numbered paragraphs: §1–§3 under 1 heading", "Parts of about 2,000 words: 3"]);
		assert.equal(root.querySelector('[data-method="numbered"]')?.getAttribute("aria-checked"), "true");
		assert.equal(root.querySelector('[data-testid="contents-viewing"]')?.getAttribute("data-method"), "numbered");
		assert.ok(root.querySelector('[data-testid="contents-use"]'));
		assert.equal(text(root, '[data-testid="contents-find-with-model"]'), "Find the contents with the model (about 6k tokens on gpt-mini)");
		assert.equal(root.querySelector('[data-testid="contents-looks-right"]'), null);
	});

	it("shows the model pass running, failing, or unavailable", () => {
		assert.ok(review({ choosing: true, modelPass: { status: "writing" } }).querySelector('[data-testid="contents-finding"]'));
		assert.equal(text(review({ choosing: true, modelPass: { status: "failed", error: "Stopped", stopped: true } }), '[data-testid="contents-model-error"]'), "The model pass ended: Stopped");
		const none = review({ choosing: true, estimate: { tokens: 6_000, model: null }, estimateError: "No model configured — set up your models first" });
		assert.equal(none.querySelector('[data-testid="contents-find-with-model"]')?.hasAttribute("disabled"), true);
	});

	it("offers Cancel instead of the review box on a ready book's Not right", () => {
		const root = review({ mode: "switch", choosing: true });
		assert.equal(root.querySelector('[data-testid="contents-unsure"]'), null);
		assert.equal(text(root, '[data-testid="contents-back"]'), "Cancel");
	});

	it("offers a new model pass's contents when the book already uses the model's", () => {
		const methods = (root: Document) => [...root.querySelectorAll('[data-testid="contents-method"]')].map((b) => b.getAttribute("data-method"));
		const base = { mode: "switch" as const, choosing: true, current: "model" as const, currentNodes: NODES, selected: "model" as const };
		// The new pass found other contents than the map holds: it can be used.
		const replaced = review({ ...base, candidates: [candidate("outline", "2 entries"), candidate("model", "3 parts", PARTS)] });
		assert.deepEqual(methods(replaced), ["outline", "model"]);
		assert.equal(replaced.querySelector('[data-testid="contents-viewing"]')?.getAttribute("data-method"), "model");
		assert.ok(replaced.querySelector('[data-testid="contents-use"]'));
		// The model's contents in use aren't offered as an alternative to themselves.
		const same = review({ ...base, candidates: [candidate("outline", "2 entries"), candidate("model", "2 sections")] });
		assert.deepEqual(methods(same), ["outline"]);
		assert.equal(same.querySelector('[data-testid="contents-viewing"]'), null);
	});

	it("shows the map as the found contents, and a failed read of the others with Try again", () => {
		const root = review({ candidates: [], loaded: false, loadError: "Couldn't reach the app. Try again." });
		assert.equal(text(root, '[data-testid="contents-load-error"]'), "Couldn't reach the app. Try again.");
		assert.equal(text(root, '[data-testid="contents-load-retry"]'), "Try again");
		assert.equal(root.querySelectorAll('[data-testid="contents-viewing"] [data-testid="contents-node"]').length, 2);
		assert.equal(root.querySelector('[data-testid="contents-looks-right"]')?.hasAttribute("disabled"), false);
		// Without a map there is nothing to accept.
		const none = review({ currentNodes: null });
		assert.equal(none.querySelector('[data-testid="contents-viewing"]'), null);
		assert.equal(none.querySelector('[data-testid="contents-looks-right"]')?.hasAttribute("disabled"), true);
		// The others aren't said to be missing before they're read.
		const unread = review({ choosing: true, candidates: [], loaded: false });
		assert.equal(unread.body.textContent!.includes("The import found no other contents."), false);
		assert.equal(review({ choosing: true, candidates: [candidate("outline", "2 entries")] }).body.textContent!.includes("The import found no other contents."), true);
	});
});

describe("the delete dialog", () => {
	const users = [{ kind: "course" as const, id: "c1", title: "Hegel course", href: "/course/c1" }, { kind: "session" as const, id: "s1", title: "Reading", href: "/chat/s1" }];
	const body = (usedBy: typeof users | null) => doc(<DeleteBookBody title="Phenomenology" users={usedBy} busy={false} failure={null} onClose={() => {}} onDelete={() => {}} />);

	it("refuses while the book is used, linking each user", () => {
		const root = body(users);
		assert.equal(text(root, '[data-testid="delete-book-used"]'), "This book is used by: Hegel course, Reading. Delete them first, or keep the book.");
		assert.deepEqual([...root.querySelectorAll('[data-testid="delete-book-user"]')].map((a) => a.getAttribute("href")), ["/course/c1", "/chat/s1"]);
		assert.equal(root.querySelector('[data-testid="delete-book-confirm"]'), null);
		const unreadable = doc(<DeleteBookBody title="Phenomenology" users={[users[0]!, { kind: "session", id: "s2", title: "a session that can't be read (s2)" }]} busy={false} failure={null} onClose={() => {}} onDelete={() => {}} />);
		assert.equal(text(unreadable, '[data-testid="delete-book-used"]'), "This book is used by: Hegel course, a session that can't be read (s2). Delete them first, or keep the book.");
		assert.deepEqual([...unreadable.querySelectorAll('[data-testid="delete-book-user"]')].map((a) => a.tagName), ["A", "SPAN"]);
		assert.equal(unreadable.querySelector('[data-testid="delete-book-confirm"]'), null);
	});

	it("confirms otherwise, saying what goes", () => {
		const root = body([]);
		assert.equal(text(root, "h2"), "Delete book?");
		assert.equal(text(root, '[data-testid="delete-book-line"]'), "This deletes the book's copy and its map. Your sessions and courses are not affected.");
		assert.equal(root.querySelector('[data-testid="delete-book-confirm"]')?.hasAttribute("disabled"), false);
		assert.equal(body(null).querySelector('[data-testid="delete-book-confirm"]')?.hasAttribute("disabled"), true, "Delete waits until the users are read");
	});
});

describe("the reader", () => {
	it("splits a block at its page breaks and around a match", () => {
		const block = { text: "one two three four", breaks: [{ at: 8, page: 6, pageLabel: "xii" }] };
		assert.deepEqual(blockSegments(block, { start: 4, end: 13 }), [
			{ kind: "text", text: "one " },
			{ kind: "text", text: "two ", mark: true },
			{ kind: "page", page: "xii" },
			{ kind: "text", text: "three", mark: true },
			{ kind: "text", text: " four" },
		]);
	});

	it("labels sections in the left margin and pages in the right, once per page", () => {
		const blocks = [
			{ id: 0, kind: "heading" as const, level: 1 as const, text: "Chapter 1 Being", page: 1 },
			{ id: 1, kind: "paragraph" as const, text: "1. Being, pure being.", page: 1 },
			{ id: 2, kind: "paragraph" as const, text: "2. Nothing, pure nothing, runs on", page: 2, breaks: [{ at: 15, page: 3 }] },
			{ id: 3, kind: "paragraph" as const, text: "3. Becoming.", page: 3 },
		];
		const root = doc(<ReaderText blocks={blocks} labels={marginLabels(NODES)} highlight={null} />);
		const rendered = [...root.querySelectorAll('[data-testid="reader-block"]')].map((el) => ({
			label: el.querySelector('[data-testid="reader-label"]')?.textContent ?? null,
			page: el.querySelector('[data-testid="reader-page"]')?.textContent ?? null,
			breaks: [...el.querySelectorAll('[data-testid="reader-page-break"]')].map((b) => b.textContent),
		}));
		assert.deepEqual(rendered, [
			{ label: null, page: "p. 1", breaks: [] },
			{ label: "§1", page: null, breaks: [] },
			{ label: "§2", page: "p. 2", breaks: ["p. 3"] },
			{ label: "§3", page: null, breaks: [] },
		]);
		assert.equal(root.querySelector("h2")?.className.includes("font-title"), true);
	});

	it("marks a search match and lists summaries in the contents", () => {
		const marked = doc(<ReaderBlock block={{ id: 0, kind: "paragraph", text: "Spirit is bone." }} highlight={{ start: 10, end: 14 }} />);
		assert.equal(text(marked, '[data-testid="reader-mark"]'), "bone");
		const contents = doc(<ReaderContents nodes={NODES} onOpen={() => {}} />);
		assert.deepEqual([...contents.querySelectorAll('[data-testid="reader-entry"]')].map((b) => b.getAttribute("data-node")), ["n0", "n4"]);
		assert.equal(text(contents, '[data-testid="reader-run"]'), "§1–§3");
		// A book of numbered paragraphs only lists them open, with summaries.
		const flat = doc(<ReaderContents nodes={NODES.slice(1, 4).map(({ parentId: _p, ...node }) => ({ ...node, level: 1 }))} onOpen={() => {}} />);
		assert.equal(flat.querySelectorAll('[data-testid="reader-entry"]').length, 3);
		assert.equal(text(flat, '[data-testid="reader-summary"]'), "Being turns into nothing.");
	});
});

// ─── item 4: attaching a book ───────────────────────────────────────────────

describe("the Book control", () => {
	it("offers ready books, lists one in review as unavailable, and leaves out the rest", () => {
		const books: LibraryBook[] = [
			{ ...base, id: "b_ready", title: "Ready" },
			{ ...base, id: "b_review", title: "In review", import: { status: "review" } },
			{ ...base, id: "b_importing", title: "Importing", import: { status: "importing" } },
			{ ...base, id: "b_failed", title: "Failed", import: { status: "failed", error: "x" } },
			{ ...base, id: "b_short", title: "Short", format: "markdown", author: undefined, pageCount: undefined, sections: 4, mapWriter: { status: "not-needed", done: 0, total: 0 } },
		];
		assert.deepEqual(bookPickerEntries(books), [
			{ id: "b_ready", title: "Ready", facts: "Hegel · PDF · 610 pages" },
			{ id: "b_review", title: "In review", facts: "Hegel · PDF · 610 pages", unavailable: "Check its contents first" },
			{ id: "b_short", title: "Short", facts: "Markdown · 4 sections" },
		]);
	});

	it("renders the menu's books, a book in review disabled, and the empty and failed states", () => {
		const root = doc(<BookPickerMenuBody entries={bookPickerEntries([{ ...base, title: "Ready" }, { ...base, id: "b_review", title: "In review", import: { status: "review" } }])} error={null} onPick={() => {}} />);
		const options = [...root.querySelectorAll('[data-testid="book-picker-option"]')];
		assert.deepEqual(options.map((o) => [o.getAttribute("data-book"), o.textContent, o.hasAttribute("disabled")]), [
			["book_a", "ReadyHegel · PDF · 610 pages", false],
			["b_review", "In reviewCheck its contents first", true],
		]);
		const empty = doc(<BookPickerMenuBody entries={[]} error={null} onPick={() => {}} />);
		assert.equal(text(empty, '[data-testid="book-picker-empty"]'), "No books ready yet. Import one in Books.");
		assert.equal(empty.querySelector('[data-testid="book-picker-empty"] a')?.getAttribute("href"), "/books");
		assert.equal(text(doc(<BookPickerMenuBody entries={null} error="The library couldn't be read." onPick={() => {}} />), '[data-testid="book-picker-error"]'), "The library couldn't be read.");
		const modes = doc(<BookModeSwitch value="reference" onChange={() => {}} />);
		assert.deepEqual([...modes.querySelectorAll('[role="radio"]')].map((b) => [b.textContent, b.getAttribute("aria-checked")]), [["Follow its structure", "false"], ["Reference only", "true"]]);
	});

	it("sends the book with a Teach or Course start, with Course mode's choice, and never with Practice", async () => {
		const book = { bookId: "book_a", title: "Phenomenology" };
		assert.deepEqual(composerBookBody("teach", book, "reference"), { book: { bookId: "book_a" } });
		assert.deepEqual(composerBookBody("course", book, "reference"), { book: { bookId: "book_a", mode: "reference" } });
		assert.deepEqual(composerBookBody("practice", book, "follow"), {});
		assert.deepEqual(composerBookBody("course", null, "follow"), {});
		const calls: unknown[] = [];
		const storage = new Map<string, string>();
		Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } } });
		const f = (async (_url: string, init?: RequestInit) => { calls.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ id: "chat_new" })); }) as typeof fetch;
		try {
			await startDraftSession("read Hegel", f, undefined, undefined, undefined, undefined, null, { book, mode: "reference" });
			await startDraftSession("a Hegel course", f, "course", undefined, undefined, undefined, null, { book, mode: "follow" });
			await startDraftSession("practice Hegel", f, "practice", [], undefined, undefined, null, { book, mode: "follow" });
		} finally { Reflect.deleteProperty(globalThis, "sessionStorage"); }
		assert.deepEqual(calls, [
			{ title: "read Hegel", book: { bookId: "book_a" } },
			{ title: "a Hegel course", course: { role: "setup" }, book: { bookId: "book_a", mode: "follow" } },
			{ title: "practice Hegel", kind: "practice" },
		]);
	});
});

describe("the book chip", () => {
	it("shows the book's title and opens its page", () => {
		const root = doc(<BookChip book={{ bookId: "book_a", title: "Phenomenology of Spirit" }} />);
		const chip = root.querySelector('[data-testid="book-chip"]')!;
		assert.equal(chip.getAttribute("href"), "/books/book_a");
		assert.equal(chip.textContent, "Phenomenology of Spirit");
		assert.equal(chip.getAttribute("aria-label"), "Book: Phenomenology of Spirit");
	});
});

describe("a start refused for its book", () => {
	it("says why and what to do, while other failures keep the generic retry notice", async () => {
		const storage = new Map<string, string>();
		Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } } });
		const answering = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
		const book = { book: { bookId: "book_a", title: "Phenomenology" }, mode: "follow" as const };
		try {
			await assert.rejects(startDraftSession("read", answering(404, { error: "This book is no longer in the library.", code: "book-unavailable" }), undefined, undefined, undefined, undefined, null, book),
				(error: unknown) => error instanceof SessionStartRefusal && error.message === "This book is no longer in the library. Choose another book, or clear it.");
			await assert.rejects(startDraftSession("read", answering(500, { error: "boom" }), undefined, undefined, undefined, undefined, null, book),
				(error: unknown) => !(error instanceof SessionStartRefusal) && error instanceof Error && error.message === "Couldn’t open the session. Your message is still here. Try sending again.");
		} finally { Reflect.deleteProperty(globalThis, "sessionStorage"); }
		const shell = (startError: boolean | string) => text(parseHTML(`<html><body>${renderWithInteractionLayers(<DraftShell busy={false} text="read" onChange={() => {}} onSend={() => {}} startError={startError} />)}</body></html>`).document, '[role="alert"]');
		assert.equal(shell("Check this book's contents first. Choose another book, or clear it."), "Check this book's contents first. Choose another book, or clear it.");
		assert.equal(shell(true), "Couldn’t open the session. Your message is still here. Try sending again.");
	});
});
