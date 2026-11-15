/**
 * Plan 05 item 3: the library's server side. "Used by" scans courses and
 * sessions, counting a record it can't read when its file names the book;
 * deleting a book is refused while anything uses it and
 * otherwise removes its folder, also mid-import; a used book's contents
 * can't change; the reader's text windows and search answer through the
 * routes. Expected values are worked by hand from the fixtures below. An
 * isolated LH_DATA_DIR is set before any config-loading import.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-book-library-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

const books = await import("../src/server/books.ts");
const { bookStore, bookDir } = await import("../src/store/books.ts");
const { courseStore } = await import("../src/store/courses.ts");
const { BOOK_WINDOW_LEAD } = await import("../src/core/book.ts");
const listRoute = await import("../app/api/books/route.ts");
const bookRoute = await import("../app/api/books/[id]/route.ts");
const contentsRoute = await import("../app/api/books/[id]/contents/route.ts");
const structureRoute = await import("../app/api/books/[id]/structure-writer/route.ts");
const textRoute = await import("../app/api/books/[id]/text/route.ts");
const searchRoute = await import("../app/api/books/[id]/search/route.ts");
const retryRoute = await import("../app/api/books/[id]/retry-import/route.ts");
type BookRecord = import("../src/core/contracts.ts").BookRecord;
type CourseRecord = import("../src/core/contracts.ts").CourseRecord;

const seams = { ...books.bookServiceSeams };
afterEach(() => {
	Object.assign(books.bookServiceSeams, seams);
	for (const folder of ["books", "chats", "courses"]) fs.rmSync(path.join(TMP, folder), { recursive: true, force: true });
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (url: string) => new Request(`http://x${url}`);

async function upload(name: string, text: string): Promise<BookRecord> {
	const form = new FormData();
	form.append("file", new File([new TextEncoder().encode(text) as BlobPart], name));
	const response = await listRoute.POST(new Request("http://x/api/books", { method: "POST", body: form }));
	assert.equal(response.status, 200, await response.clone().text());
	return ((await response.json()) as { book: BookRecord }).book;
}

async function settled(id: string): Promise<BookRecord> {
	for (let i = 0; i < 400; i++) {
		const record = bookStore.get(id)!;
		if (record.import.status !== "importing") return record;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("the import never settled");
}

/** A chat record on disk, as item 4 will write them. */
function chat(id: string, fields: Record<string, unknown>, updatedAt = "2026-11-14T10:00:00.000Z"): void {
	fs.mkdirSync(path.join(TMP, "chats"), { recursive: true });
	fs.writeFileSync(path.join(TMP, "chats", `${id}.json`), JSON.stringify({ id, title: id, createdAt: updatedAt, updatedAt, messages: [], version: 2, ...fields }));
}

function course(id: string, title: string, bookId: string, fields: Partial<CourseRecord> = {}): void {
	courseStore.create({
		id, title, goal: "Read it.", createdAt: "2026-11-14T09:00:00.000Z", updatedAt: "2026-11-14T09:00:00.000Z",
		setupChatId: `${id}_setup`, book: { bookId, mode: "follow" },
		units: [{ id: "u1", title: "Unit", goal: "G.", prerequisites: [], status: "in-progress", chatId: `${id}_unit` }],
		proposals: [], evidence: [], ...fields,
	});
}

/** "# One", 3 paragraphs, "# Two", 3 paragraphs: blocks 0, 1–3, 4, 5–7. */
const TWO_CHAPTERS = "# One\n\nFirst para.\n\nSecond para.\n\nThird para.\n\n# Two\n\nFourth para.\n\nFifth para.\n\nSixth para.\n";

describe("Used by", () => {
	it("lists courses, then sessions not covered by a listed course", async () => {
		const book = await settled((await upload("Hegel.md", TWO_CHAPTERS)).id);
		course("course_a", "Hegel course", book.id);
		// The setup's link isn't back-filled yet: the course names it.
		chat("course_a_setup", { title: "Hegel course setup", course: { role: "setup" }, book: { bookId: book.id } });
		chat("course_a_unit", { title: "Unit 1", course: { role: "unit", courseId: "course_a", unitId: "u1" } });
		chat("teach_old", { title: "Reading Hegel", book: { bookId: book.id } }, "2026-11-14T08:00:00.000Z");
		chat("setup_pending", { title: "New course setup", course: { role: "setup" }, book: { bookId: book.id } }, "2026-11-14T11:00:00.000Z");
		chat("other_book", { title: "Kant", book: { bookId: "book_other" } });
		chat("plain", { title: "No book" });
		course("course_b", "Kant course", "book_other");

		assert.deepEqual(books.bookUsers(book.id), [
			{ kind: "course", id: "course_a", title: "Hegel course", href: "/course/course_a" },
			{ kind: "session", id: "setup_pending", title: "New course setup", href: "/chat/setup_pending" },
			{ kind: "session", id: "teach_old", title: "Reading Hegel", href: "/chat/teach_old" },
		]);
		const read = await (await bookRoute.GET(get(""), params(book.id))).json() as { usedBy: unknown[]; book: { mapCostUsd: unknown } };
		assert.equal(read.usedBy.length, 3);
		assert.equal(read.book.mapCostUsd, null);
		const light = await (await bookRoute.GET(get("/?users=0"), params(book.id))).json() as { usedBy?: unknown; book: { id: string } };
		assert.deepEqual([light.book.id, "usedBy" in light], [book.id, false]);
	});

	it("still finds a setup session whose course record can't be read", async () => {
		const book = await settled((await upload("Damaged.md", TWO_CHAPTERS)).id);
		fs.mkdirSync(path.join(TMP, "courses", "course_bad"), { recursive: true });
		fs.writeFileSync(path.join(TMP, "courses", "course_bad", "course.json"), "{ not json");
		chat("bad_setup", { title: "Broken course setup", course: { role: "setup", courseId: "course_bad" }, book: { bookId: book.id } });
		assert.deepEqual(books.bookUsers(book.id).map((user) => user.id), ["bad_setup"]);
	});

	it("counts a record it can't read whose file names the book, without a link", async () => {
		const book = await settled((await upload("Unreadable.md", TWO_CHAPTERS)).id);
		await contentsRoute.PUT(new Request("http://x", { method: "PUT", body: "{}" }), params(book.id));
		// Saved by a newer build (chats are version 2, courses version 1), or damaged.
		chat("newer", { title: "From a newer app", version: 3, book: { bookId: book.id } });
		fs.writeFileSync(path.join(TMP, "chats", "damaged.json"), `{ "title": "Half", "book": { "bookId": "${book.id}"`);
		fs.writeFileSync(path.join(TMP, "chats", "unrelated.json"), "{ not json");
		fs.mkdirSync(path.join(TMP, "courses", "course_new"), { recursive: true });
		fs.writeFileSync(path.join(TMP, "courses", "course_new", "course.json"), JSON.stringify({ id: "course_new", version: 2, title: "Newer", book: { bookId: book.id, mode: "follow" } }));
		// Its setup names the listed course, so the course covers it.
		chat("newer_setup", { title: "Newer setup", course: { role: "setup", courseId: "course_new" }, book: { bookId: book.id } });

		assert.deepEqual(books.bookUsers(book.id), [
			{ kind: "course", id: "course_new", title: "a course that can't be read (course_new)" },
			{ kind: "session", id: "damaged", title: "a session that can't be read (damaged)" },
			{ kind: "session", id: "newer", title: "a session that can't be read (newer)" },
		]);
		const refused = await bookRoute.DELETE(get(""), params(book.id));
		assert.equal(refused.status, 409);
		assert.equal(((await refused.json()) as { error: string }).error,
			"This book is used by: a course that can't be read (course_new), a session that can't be read (damaged), a session that can't be read (newer). Delete them first, or keep the book.");
		assert.ok(fs.existsSync(bookDir(book.id)));
		const switched = await contentsRoute.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ method: "app-made" }) }), params(book.id));
		assert.equal(switched.status, 409);

		// Only files that name the book count.
		for (const name of ["newer", "damaged", "newer_setup"]) fs.rmSync(path.join(TMP, "chats", `${name}.json`));
		fs.rmSync(path.join(TMP, "courses", "course_new"), { recursive: true });
		assert.deepEqual(books.bookUsers(book.id), []);
		assert.equal((await bookRoute.DELETE(get(""), params(book.id))).status, 200);
	});

	it("never calls a book unused when a session can't be opened", async () => {
		const book = await settled((await upload("Unopened.md", TWO_CHAPTERS)).id);
		// A directory where a record should be: reading it fails like an unreadable file.
		fs.mkdirSync(path.join(TMP, "chats", "unopened.json"), { recursive: true });
		assert.throws(() => books.bookUsers(book.id), { code: "EISDIR" });
		await assert.rejects(bookRoute.DELETE(get(""), params(book.id)));
		assert.ok(fs.existsSync(bookDir(book.id)));
	});
});

describe("deleting a book", () => {
	it("is refused while used, naming the users; afterwards it removes the folder", async () => {
		const book = await settled((await upload("Used.md", TWO_CHAPTERS)).id);
		course("course_a", "Hegel course", book.id);
		chat("teach", { title: "Reading Hegel", book: { bookId: book.id } });

		const refused = await bookRoute.DELETE(get(""), params(book.id));
		assert.equal(refused.status, 409);
		const body = await refused.json() as { error: string; usedBy: { title: string; href: string }[] };
		assert.equal(body.error, "This book is used by: Hegel course, Reading Hegel. Delete them first, or keep the book.");
		assert.deepEqual(body.usedBy.map((user) => user.href), ["/course/course_a", "/chat/teach"]);
		assert.ok(fs.existsSync(bookDir(book.id)));

		courseStore.remove("course_a");
		fs.rmSync(path.join(TMP, "chats", "teach.json"));
		const deleted = await bookRoute.DELETE(get(""), params(book.id));
		assert.equal(deleted.status, 200);
		assert.deepEqual(await deleted.json(), { ok: true });
		assert.equal(fs.existsSync(bookDir(book.id)), false);
		assert.equal((await bookRoute.GET(get(""), params(book.id))).status, 404);
		assert.deepEqual(books.listBooks().books, []);
		assert.equal((await bookRoute.DELETE(get(""), params(book.id))).status, 404);
	});

	it("stops an import still converting, which never recreates the folder", async () => {
		const accepted: string[] = [];
		books.bookServiceSeams.contentsAccepted = (id) => accepted.push(id);
		// Directly through the service: conversion writes nothing before its
		// first yield to the event loop, so the delete lands mid-import.
		const imported = await books.importBook("Mid-import.md", new TextEncoder().encode(TWO_CHAPTERS));
		assert.ok(!books.isBookRefusal(imported));
		const book = imported.book;
		assert.equal(bookStore.get(book.id)!.import.status, "importing");
		assert.deepEqual(books.deleteBook(book.id), { ok: true });
		for (let i = 0; i < 20 && books.isImportRunning(book.id); i++) await new Promise((resolve) => setTimeout(resolve, 10));
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(books.isImportRunning(book.id), false);
		assert.equal(fs.existsSync(bookDir(book.id)), false, "the aborted import wrote nothing");
		assert.deepEqual(accepted, []);
	});

	it("deletes a book whose record is damaged", async () => {
		const book = await settled((await upload("Broken.md", TWO_CHAPTERS)).id);
		fs.writeFileSync(path.join(bookDir(book.id), "book.json"), "{ damaged");
		assert.equal((await bookRoute.DELETE(get(""), params(book.id))).status, 200);
		assert.equal(fs.existsSync(bookDir(book.id)), false);
	});
});

describe("a used book's contents", () => {
	it("can't be switched or found again by the model", async () => {
		const book = await settled((await upload("Locked.md", TWO_CHAPTERS)).id);
		assert.equal(book.import.status, "review");
		assert.equal((await contentsRoute.PUT(new Request("http://x", { method: "PUT", body: "{}" }), params(book.id))).status, 200);
		chat("teach", { title: "Reading", book: { bookId: book.id } });
		const switched = await contentsRoute.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ method: "app-made" }) }), params(book.id));
		assert.equal(switched.status, 409);
		assert.deepEqual(await switched.json(), { error: "A course or session uses this book, so its contents can't change." });
		assert.equal(bookStore.get(book.id)!.structure, "headings");
		// Re-accepting what's shown changes nothing, so it stays allowed.
		assert.equal((await contentsRoute.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ method: "headings" }) }), params(book.id))).status, 200);
		const pass = await structureRoute.POST(new Request("http://x", { method: "POST" }), params(book.id));
		assert.equal(pass.status, 409);
		assert.equal(((await pass.json()) as { error: string }).error, "A course or session uses this book, so its contents can't change.");
	});
});

describe("reading through the routes", () => {
	it("serves windows forward, backward and around a section", async () => {
		const book = await settled((await upload("Windows.md", TWO_CHAPTERS)).id);
		const nodes = bookStore.readMap(book.id)!.nodes;
		const two = nodes.find((node) => node.title === "Two")!;
		assert.equal(two.firstBlock, 4);
		type Window = { from: number; to: number; total: number; blocks: { id: number; text: string }[] };
		const read = async (query: string) => (await (await textRoute.GET(get(`/text?${query}`), params(book.id))).json()) as Window;

		const start = await read("");
		assert.deepEqual([start.from, start.to, start.total], [0, 7, 8]);
		assert.deepEqual(start.blocks.map((block) => block.text), ["One", "First para.", "Second para.", "Third para.", "Two", "Fourth para.", "Fifth para.", "Sixth para."]);
		const around = await read(`around=${two.id}`);
		assert.deepEqual([around.from, around.to], [4 - BOOK_WINDOW_LEAD, 7]);
		const at = await read("at=5");
		assert.deepEqual([at.from, at.to], [5 - BOOK_WINDOW_LEAD, 7]);
		const forward = await read("from=6");
		assert.deepEqual(forward.blocks.map((block) => block.id), [6, 7]);
		const backward = await read("before=3");
		assert.deepEqual(backward.blocks.map((block) => block.id), [0, 1, 2]);
		const past = await read("from=99");
		assert.deepEqual([past.from, past.to, past.blocks.length], [99, 98, 0]);

		assert.equal((await textRoute.GET(get("/text?from=-1"), params(book.id))).status, 400);
		assert.equal((await textRoute.GET(get("/text?at=x"), params(book.id))).status, 400);
		assert.equal((await textRoute.GET(get("/text?around=n99"), params(book.id))).status, 404);
		assert.equal((await textRoute.GET(get("/text"), params("book_missing"))).status, 404);
	});

	it("refuses text and search while the import is still converting", async () => {
		books.bookServiceSeams.contentsAccepted = () => {};
		const book = await upload("Converting.md", TWO_CHAPTERS);
		const text = await textRoute.GET(get("/text"), params(book.id));
		const search = await searchRoute.GET(get("/search?q=para"), params(book.id));
		assert.deepEqual([text.status, search.status], [409, 409]);
		assert.deepEqual(await text.json(), { error: "This book's text isn't ready yet." });
		await settled(book.id);
	});

	it("searches case- and accent-insensitively, with sections and snippets", async () => {
		const book = await settled((await upload("Search.md", "# Lordship\n\nThe Élan of self-consciousness.\n\n# Bondage\n\nSELF-CONSCIOUSNESS again, and élan.\n")).id);
		const nodes = bookStore.readMap(book.id)!.nodes;
		type Hits = { total: number; hits: { block: number; label: string; start: number; end: number; before: string; match: string; after: string }[] };
		const search = async (q: string) => (await (await searchRoute.GET(get(`/search?q=${encodeURIComponent(q)}`), params(book.id))).json()) as Hits;

		const elan = await search("elan");
		assert.equal(elan.total, 2);
		assert.deepEqual(elan.hits.map((hit) => [hit.block, hit.label, hit.match, hit.start, hit.end]), [
			[1, nodes[0]!.label, "Élan", 4, 8],
			[3, nodes[1]!.label, "élan", 30, 34],
		]);
		assert.deepEqual([elan.hits[0]!.before, elan.hits[0]!.after], ["The ", " of self-consciousness."]);
		// The hyphen between letters folds away on both sides.
		const self = await search("Self-Consciousness");
		assert.deepEqual(self.hits.map((hit) => hit.match), ["self-consciousness", "SELF-CONSCIOUSNESS"]);
		assert.deepEqual(await search("   "), { hits: [], total: 0 });
		assert.equal((await searchRoute.GET(get(`/search?q=${"x".repeat(501)}`), params(book.id))).status, 400);
	});
});

describe("a failed import's Try again", () => {
	it("is offered for an interruption, not for a refusal of the file itself", async () => {
		const blank = await settled((await upload("Blank.txt", "   \n\n   \n")).id);
		assert.deepEqual(blank.import, { status: "failed", error: "This file has no readable text." });
		const interrupted = await settled((await upload("Cut.md", TWO_CHAPTERS)).id);
		bookStore.update(interrupted.id, (record) => ({ ...record, import: { status: "importing" } }));

		const listed = new Map(books.listBooks().books.map((book) => [book.id, book]));
		assert.equal(listed.get(blank.id)!.retryable, false);
		assert.deepEqual([listed.get(interrupted.id)!.import.error, listed.get(interrupted.id)!.retryable], ["The import was interrupted.", true]);

		const refused = await retryRoute.POST(new Request("http://x", { method: "POST" }), params(blank.id));
		assert.equal(refused.status, 409);
		assert.deepEqual(await refused.json(), { error: "This file has no readable text." });
		assert.equal((await retryRoute.POST(new Request("http://x", { method: "POST" }), params(interrupted.id))).status, 200);
		assert.equal((await settled(interrupted.id)).import.status, "review");
	});
});
