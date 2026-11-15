/**
 * Plan 05 item 3 review repairs: the book pages' stateful behavior, mounted
 * in linkedom with a fake fetch that holds each request until the test
 * answers it (or answers windows through the real core window function).
 * A late jump never replaces a later one's window; a search jump's window
 * holds its match even when the blocks above it are long; "Check the
 * contents" recovers from a failed read by Try again and on reconnect; and
 * the book page keeps refreshing while the delete dialog merely stands
 * open, holding refreshes off only during the delete request itself.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { BookReader } from "../components/book-reader.tsx";
import { ContentsReview } from "../components/book-contents-review.tsx";
import { BookPage, type BookPageData } from "../components/book-page.tsx";
import type { BookPageBook } from "../components/book-view.ts";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { bookTextWindow } from "../src/core/book.ts";
import { installModalDom } from "./modal-dom.ts";
type BookBlock = import("../src/core/contracts.ts").BookBlock;
type BookNode = import("../src/core/contracts.ts").BookNode;

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const restoreDom = installModalDom(dom);
after(restoreDom);
// The reader measures where to scroll; layout is not what these tests check.
const box = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
dom.window.HTMLElement.prototype.getBoundingClientRect = box as () => DOMRect;
dom.window.HTMLInputElement.prototype.select = function () {};
Object.assign(dom.window, { getSelection: () => ({ rangeCount: 0, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0 }) });

// ─── fakes ──────────────────────────────────────────────────────────────────

interface Held { url: string; method: string; resolve: (response: Response) => void; reject: (error: unknown) => void }
const originalFetch = globalThis.fetch;
let held: Held[] = [];
let requests: string[] = [];
/** Answers a request at once, or returns undefined to hold it. */
let serve: (url: string, method: string) => Response | undefined = () => undefined;

function installFetch() {
	held = [];
	requests = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		requests.push(`${method} ${url}`);
		const now = serve(url, method);
		if (now) return now;
		return new Promise<Response>((resolve, reject) => held.push({ url, method, resolve, reject }));
	}) as typeof fetch;
}

/** Settle the first held request that `match` picks. */
async function answer(match: (request: Held) => boolean, outcome: Response | Error) {
	const index = held.findIndex(match);
	assert.ok(index >= 0, `no held request matches; held: ${held.map((h) => `${h.method} ${h.url}`).join(", ")}`);
	const [request] = held.splice(index, 1);
	await act(async () => {
		if (outcome instanceof Error) request!.reject(outcome);
		else request!.resolve(outcome);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
const urlHas = (part: string) => (request: Held) => request.url.includes(part);

let events: { open: () => void; emit: (name: string, payload: unknown) => void } = { open() {}, emit() {} };
function connect(): NotifySource {
	let opened = () => {};
	const handlers = new Map<string, (data: string) => void>();
	events = { open: () => opened(), emit: (name, payload) => handlers.get(name)?.(JSON.stringify(payload)) };
	return { close() {}, onOpen(cb) { opened = cb; }, onEvent(name, cb) { handlers.set(name, cb); } };
}

const pushed: string[] = [];
const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push(href: string) { pushed.push(href); }, replace() {}, async prefetch() {} };

let root: Root | undefined;
let host: HTMLDivElement | undefined;
async function mount(children: React.ReactNode) {
	installFetch();
	pushed.length = 0;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<InteractionLayersProvider>
				<AppRouterContext.Provider value={router as never}>
					<ServerEventsProvider connect={connect}>{children}</ServerEventsProvider>
				</AppRouterContext.Provider>
			</InteractionLayersProvider>,
		);
	});
}
afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = undefined;
	await new Promise((resolve) => setTimeout(resolve, 5));
	host?.remove();
	globalThis.fetch = originalFetch;
	serve = () => undefined;
});

const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
async function click(selector: string) {
	const target = q(selector);
	assert.ok(target, selector);
	await act(async () => { target.click(); });
}
const blockIds = () => [...document.querySelectorAll('[data-testid="reader-block"]')].map((el) => Number(el.getAttribute("data-block")));

/** The text route's window contract, answered by the core function. */
function textWindow(blocks: BookBlock[], nodes: readonly BookNode[], url: string): Response {
	const query = new URL(url, "http://x").searchParams;
	const around = query.get("around");
	const at = query.get("at");
	const before = query.get("before");
	const request = around !== null ? { around: nodes.find((node) => node.id === around)!.firstBlock }
		: at !== null ? { around: Number(at) }
		: before !== null ? { before: Number(before) }
		: { from: Number(query.get("from") ?? 0) };
	const { from, to } = bookTextWindow(blocks, request);
	return Response.json({ from, to, total: blocks.length, blocks: blocks.slice(from, to + 1) });
}

const paragraphs = (count: number, text: (id: number) => string): BookBlock[] => Array.from({ length: count }, (_, id) => ({ id, kind: "paragraph", text: text(id) }));
const chapter = (id: string, label: string, firstBlock: number, lastBlock: number): BookNode => ({ id, label, title: label, kind: "chapter", level: 1, firstBlock, lastBlock });

// ─── the reader ─────────────────────────────────────────────────────────────

describe("the reader's jumps", () => {
	const blocks = paragraphs(400, (id) => `Block ${id}.`);
	const nodes = [chapter("c1", "Chapter 1", 0, 149), chapter("c101", "Chapter 101", 150, 299), chapter("c201", "Chapter 201", 300, 399)];
	const respond = (url: string) => textWindow(blocks, nodes, url);

	it("never lets an earlier jump's late window replace a later jump's", async () => {
		await mount(<BookReader bookId="book_a" nodes={nodes} />);
		await answer(urlHas("/text"), respond("/text"));
		assert.deepEqual([blockIds()[0], blockIds().at(-1)], [0, 119]);

		await click('[data-node="c101"]');
		await click('[data-node="c201"]');
		await answer(urlHas("around=c201"), respond("?around=c201"));
		assert.equal(blockIds()[0], 296, "Chapter 201 opens 4 blocks above its start");
		await answer(urlHas("around=c101"), respond("?around=c101"));
		assert.equal(blockIds()[0], 296, "the late Chapter 101 window is dropped");
		assert.ok(!blockIds().includes(150));
	});

	it("drops a pending jump's window when a later jump lands inside the loaded text", async () => {
		await mount(<BookReader bookId="book_a" nodes={nodes} />);
		await answer(urlHas("/text"), respond("/text"));
		await click('[data-node="c201"]');
		await click('[data-node="c1"]'); // block 0, already loaded
		await answer(urlHas("around=c201"), respond("?around=c201"));
		assert.deepEqual([blockIds()[0], blockIds().at(-1)], [0, 119]);
	});

	it("opens a search match inside its window when the blocks above it are long", async () => {
		// 20,000 characters each: three blocks fill a window's budget.
		const long = paragraphs(12, (id) => `${id === 8 ? "Spirit" : "Other"} `.padEnd(20_000, "x"));
		const longNodes = [chapter("c", "Chapter", 0, 11)];
		serve = (url) => {
			if (url.includes("/search")) return Response.json({ total: 1, hits: [{ block: 8, start: 0, end: 6, before: "", match: "Spirit", after: " xxx…" }] });
			if (url.includes("/text")) return textWindow(long, longNodes, url);
			return undefined;
		};
		await mount(<BookReader bookId="book_a" nodes={longNodes} />);
		assert.deepEqual(blockIds(), [0, 1, 2]);
		const search = q<HTMLInputElement>('[data-testid="reader-search"]')!;
		await act(async () => {
			search.focus();
			// Past React's value tracker, as typing would be. React loaded
			// before this DOM existed, so its input polyfill notices the new
			// value on a key event.
			Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "Spirit");
			search.dispatchEvent(new dom.window.Event("keyup", { bubbles: true }));
		});
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
		await click('[data-testid="reader-hit"]');
		assert.ok(blockIds().includes(8), `the match's block is in the window: ${blockIds().join(",")}`);
		assert.equal(q('[data-testid="reader-mark"]')?.textContent, "Spirit");
	});
});

// ─── "Check the contents" ───────────────────────────────────────────────────

const NODES: BookNode[] = [chapter("n0", "Chapter 1", 0, 3), chapter("n1", "Chapter 2", 4, 7)];
const reviewBook: BookPageBook = {
	id: "book_a", title: "Phenomenology", format: "pdf", importedAt: "2026-11-14T10:00:00.000Z", fileName: "p.pdf", bytes: 1,
	updatedAt: "2026-11-14T10:00:00.000Z", structure: "outline", confidence: { level: "unsure", reasons: [] },
	import: { status: "review" }, mapWriter: { status: "waiting", done: 0, total: 0 }, mapCostUsd: null,
};
const candidates = [
	{ method: "outline", description: "2 entries", nodes: NODES, confidence: { level: "unsure", reasons: [] } },
	{ method: "headings", description: "1 heading", nodes: [chapter("h0", "Only", 0, 7)], confidence: { level: "unsure", reasons: [] } },
];

describe("Check the contents", () => {
	it("recovers from a failed read with Try again and on reconnect", async () => {
		await mount(<ContentsReview book={reviewBook} currentNodes={NODES} mode="review" onDone={() => {}} />);
		await answer(urlHas("/contents"), new TypeError("offline"));
		assert.equal(q('[data-testid="contents-load-error"]')?.textContent, "Couldn't reach the app. Try again.");
		// The found contents are the book's map, so they show and can be accepted.
		assert.equal(q('[data-testid="contents-viewing"]')?.getAttribute("data-method"), "outline");
		assert.equal(q('[data-testid="contents-looks-right"]')?.hasAttribute("disabled"), false);

		await click('[data-testid="contents-load-retry"]');
		await answer(urlHas("/contents"), Response.json({ current: "outline", candidates }));
		assert.equal(q('[data-testid="contents-load-error"]'), null);
		await click('[data-testid="contents-not-right"]');
		assert.deepEqual([...document.querySelectorAll('[data-testid="contents-method"]')].map((el) => el.getAttribute("data-method")), ["headings"]);

		// A reconnect reads the candidates again (events may have been missed).
		const before = requests.filter((r) => r.includes("/contents")).length;
		await act(async () => { events.open(); });
		assert.equal(requests.filter((r) => r.includes("/contents")).length, before + 1);
	});

	it("doesn't claim there are no other contents before they're read", async () => {
		await mount(<ContentsReview book={{ ...reviewBook, import: { status: "ready" }, contentsAccepted: "auto" }} currentNodes={NODES} mode="switch" onDone={() => {}} onCancel={() => {}} />);
		assert.ok(q('[data-testid="contents-methods"]'));
		assert.ok(!document.body.textContent!.includes("The import found no other contents."));
		await answer(urlHas("/contents"), Response.json({ current: "outline", candidates: candidates.slice(0, 1) }));
		assert.ok(document.body.textContent!.includes("The import found no other contents."));
	});
});

// ─── the book page and its delete dialog ────────────────────────────────────

describe("the book page while deleting", () => {
	const blocks = paragraphs(8, (id) => `Block ${id}.`);
	const readyBook: BookPageBook = { ...reviewBook, import: { status: "ready" }, contentsAccepted: "auto", mapWriter: { status: "not-needed", done: 0, total: 0 } };
	const initial: BookPageData = { book: readyBook, map: { version: 1, nodes: NODES }, usedBy: [] };
	let title = readyBook.title;
	const pageServe = (url: string, method: string) => {
		if (url.includes("/text")) return textWindow(blocks, NODES, url);
		if (method === "GET" && url.startsWith("/api/books/book_a")) return Response.json({ book: { ...readyBook, title }, map: { version: 1, nodes: NODES }, ...(url.includes("users=0") ? {} : { usedBy: [] }) });
		return undefined; // DELETE is held
	};
	const bookReads = () => requests.filter((r) => r.startsWith("GET /api/books/book_a") && !r.includes("/text")).length;

	async function openDialog() {
		title = readyBook.title;
		serve = pageServe;
		await mount(<BookPage initial={initial} />);
		await click('[data-testid="book-menu"]');
		await click('[data-testid="book-delete"]');
		assert.ok(q('[data-testid="delete-book-dialog"]'));
		assert.ok(q('[data-testid="delete-book-confirm"]'));
	}

	it("still refreshes while the dialog stands open, and after Cancel", async () => {
		await openDialog();
		title = "Phenomenology of Spirit";
		await act(async () => { events.emit("books-changed", { bookId: "book_a" }); });
		assert.equal(q('[data-testid="book-title"]')?.textContent, "Phenomenology of Spirit");
		assert.equal(q('[data-testid="delete-book-title"]')?.textContent, "Phenomenology of Spirit");
		await click('[data-testid="delete-book-cancel"]');
		assert.equal(q('[data-testid="delete-book-dialog"]'), null);
	});

	it("holds refreshes off only during the delete request, catching up when it's refused", async () => {
		await openDialog();
		await click('[data-testid="delete-book-confirm"]');
		const reads = bookReads();
		await act(async () => { events.emit("books-changed", { bookId: "book_a" }); });
		assert.equal(bookReads(), reads, "no refetch of a book being deleted");
		title = "Renamed meanwhile";
		const usedBy = [{ kind: "session", id: "s1", title: "Reading", href: "/chat/s1" }];
		await answer((r) => r.method === "DELETE", Response.json({ error: "This book is used by: Reading. Delete them first, or keep the book.", usedBy }, { status: 409 }));
		assert.equal(bookReads(), reads + 1, "the refused delete catches up");
		assert.equal(q('[data-testid="book-title"]')?.textContent, "Renamed meanwhile");
		assert.equal(q('[data-testid="delete-book-used"]')?.textContent, "This book is used by: Reading. Delete them first, or keep the book.");
	});

	it("goes to the library after a delete, without refetching the deleted book", async () => {
		await openDialog();
		await click('[data-testid="delete-book-confirm"]');
		await answer((r) => r.method === "DELETE", Response.json({ ok: true }));
		const reads = bookReads();
		await act(async () => { events.emit("books-changed", { bookId: "book_a" }); });
		assert.equal(bookReads(), reads);
		assert.deepEqual(pushed, ["/books"]);
	});
});
