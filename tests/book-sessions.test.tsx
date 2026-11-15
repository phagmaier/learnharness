/**
 * Plan 05 item 4: attaching a book and the book in agents' turns. A Teach
 * session or course setup starts with a book through POST /api/chats (a
 * setup keeping its follow/reference mode; refusals for a book in review,
 * an unknown book, a practice session); creating the course copies both;
 * each turn of the prober, teacher and setup agent carries the book section
 * (after the course section) and the three book tools, reading the real
 * library; a unit of a followed book adds its reading; a book that can't be
 * read is said plainly and gets no tools; the dynamic-prompt accounting
 * counts the section as sent. Fakes only (pi-ai's faux provider); an
 * isolated LH_DATA_DIR is set before any config-loading import.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it, mock } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type AssistantMessage,
	type FauxResponseFactory,
	type FauxResponseStep,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { BLOCKS, BOOK_PART, NODES } from "./book-prompt-fixture.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-book-sessions-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { courseStore } = await import("../src/store/courses.ts");
const { bookStore, bookDir, newBookId } = await import("../src/store/books.ts");
const { createProberAgent, createSetupAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { BOOK_DOCTRINE, PROBER_BOOK_ADDITION, TEACHER_UNIT_READING_ADDITION } = await import("../src/agent/book-prompts.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { dynamicPromptEstimate } = await import("../src/server/compaction.ts");
const courses = await import("../src/server/courses.ts");
const { sessionBookView, courseBookView } = await import("../src/server/book-sessions.ts");
const chatsRoute = await import("../app/api/chats/route.ts");
type PiEngine = import("../src/agent/models.ts").PiEngine;
type LhMessage = import("../src/core/native-messages.ts").LhMessage;
type BookRecord = import("../src/core/contracts.ts").BookRecord;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ─── fixtures ───────────────────────────────────────────────────────────────

/** The fixture book in the library, its import ready unless told otherwise. */
function storeBook(fields: Partial<BookRecord> = {}): BookRecord {
	const id = newBookId();
	const at = "2026-11-14T09:00:00.000Z";
	const record: BookRecord = {
		id, title: "Phenomenology of Spirit", author: "G. W. F. Hegel", format: "pdf", fileName: "hegel.pdf", sha256: id, bytes: 1,
		importedAt: at, updatedAt: at, pageCount: 4, words: 90, structure: "numbered", confidence: { level: "confident", reasons: [] },
		contentsAccepted: "auto", import: { status: "ready" }, mapWriter: { status: "ready", done: 7, total: 7 }, ...fields,
	};
	bookStore.create(record, new Uint8Array([1]));
	bookStore.writeText(id, { blocks: BLOCKS });
	bookStore.writeMap(id, { nodes: NODES });
	return record;
}

const READ_90_91 = [
	"§90–§91 (Sense-certainty), pp. 1–2",
	"[p. 1]\n§90. The knowledge which is at the start, immediately our object, can be nothing but immediate knowledge.",
	"[p. 2]\n§91. But, on the face of it, sense-certainty itself proclaims itself to be the truest certainty.",
].join("\n\n");

function scripted(steps: FauxResponseStep[]) {
	const contexts: TranscriptContext[] = [];
	const faux = createFauxCore({});
	faux.setResponses(steps.map((step) => async (context: TranscriptContext): Promise<AssistantMessage> => {
		contexts.push(context);
		return typeof step === "function" ? await (step as FauxResponseFactory)(context, undefined, undefined as never, undefined as never) : step;
	}));
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple } as PiEngine;
	return { engine, contexts };
}

type Factory = NonNullable<Parameters<typeof handleChatRequest>[1]>;

/** The agent the handler chose, built for real on the faux engine with the
 *  handler's options (the book among them). */
function factory(chatId: string, engine: PiEngine, kinds: string[] = []): Factory {
	return (opts) => {
		kinds.push(opts.agentKind ?? "?");
		const deps = { chatId, chatStore, jobStore, spawn: () => {} };
		if (opts.agentKind === "setup") return createSetupAgent(deps, { ...opts, engine });
		if (opts.agentKind === "teacher") return createTeacherAgent(deps, { ...opts, engine });
		return createProberAgent({ ...deps, deliver: () => {} }, { ...opts, engine });
	};
}

async function runTurn(chatId: string, input: unknown, build: Factory): Promise<Response> {
	const ack = await handleChatRequest(new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, input }) }), build);
	if (ack.status === 200) {
		const handle = runningTurn(chatId);
		if (handle) await new Response(handle.subscribe()).text();
	}
	return ack;
}

async function createSession(body: Record<string, unknown>): Promise<Response> {
	return chatsRoute.POST(new Request("http://test/api/chats", { method: "POST", body: JSON.stringify(body) }));
}

async function sessionWith(body: Record<string, unknown>): Promise<string> {
	const response = await createSession(body);
	assert.equal(response.status, 200, await response.clone().text());
	const { id } = await response.json() as { id: string };
	chatStore.saveSettings(id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return id;
}

/** The request's system prompt, as the provider receives it. */
function systemPrompt(context: TranscriptContext): string {
	const system = context.messages.filter((message) => (message.role as string) === "system") as unknown as Array<{ content?: unknown }>;
	return system.map((message) => typeof message.content === "string" ? message.content
		: Array.isArray(message.content) ? message.content.map((part: { text?: string }) => part.text ?? "").join("") : "").join("\n");
}
const declares = (context: TranscriptContext, tool: string) => JSON.stringify(context.messages.filter((m) => (m.role as string) === "system")).includes(`"${tool}"`);
const BOOK_TOOLS = ["book_map", "read_section", "search_book"];

function concludeProbe(chatId: string): void {
	const messages = chatStore.getChat(chatId)!.messages;
	chatStore.saveMessages(chatId, [
		...messages,
		{ ...fauxAssistantMessage([fauxToolCall("probe_done", {}, { id: "probe-1" })], { stopReason: "toolUse" }), id: "probe-response" } as LhMessage,
		{ id: "probe-result", role: "toolResult", toolCallId: "probe-1", toolName: "probe_done", content: [], details: { ok: true }, isError: false, timestamp: 1 } as LhMessage,
		{ id: "learner-next", role: "user", content: "Let's go on.", timestamp: 2 } as LhMessage,
	]);
}

const toolResultText = (context: TranscriptContext) => {
	const last = context.messages.at(-1) as { role: string; content: Array<{ text?: string }>; isError?: boolean };
	assert.equal(last.role, "toolResult");
	return { text: last.content.map((part) => part.text ?? "").join(""), isError: last.isError ?? false };
};

// ─── starting with a book ───────────────────────────────────────────────────

describe("starting a session with a book", () => {
	it("stores the book on a Teach session, and on a setup with its mode", async () => {
		const book = storeBook();
		const teach = await sessionWith({ title: "Hegel", book: { bookId: book.id, mode: "reference" } });
		assert.deepEqual(chatStore.getChat(teach)!.book, { bookId: book.id }, "a Teach session has no mode");
		const follow = await sessionWith({ title: "Hegel course", course: { role: "setup" }, book: { bookId: book.id } });
		assert.deepEqual(chatStore.getChat(follow)!.book, { bookId: book.id, mode: "follow" }, "follow by default");
		const reference = await sessionWith({ title: "Hegel course", course: { role: "setup" }, book: { bookId: book.id, mode: "reference" } });
		assert.deepEqual(chatStore.getChat(reference)!.book, { bookId: book.id, mode: "reference" });
		assert.equal(chatStore.getChat(await sessionWith({ title: "No book" }))!.book, undefined);
	});

	it("refuses a book in review, an unknown book, a practice session and a bad mode, creating nothing", async () => {
		const review = storeBook({ import: { status: "review" }, contentsAccepted: undefined });
		const importing = storeBook({ import: { status: "importing" } });
		const before = chatStore.listChats().length;
		const refusals = [
			[{ title: "x", book: { bookId: review.id } }, 409, "Check this book's contents first."],
			[{ title: "x", book: { bookId: importing.id } }, 409, "This book's import isn't finished."],
			[{ title: "x", book: { bookId: "book_missing" } }, 404, "This book is no longer in the library."],
			[{ title: "x", book: { bookId: "../etc" } }, 404, "This book is no longer in the library."],
			[{ title: "x", kind: "practice", book: { bookId: review.id } }, 400, "Practice sessions can't have a book."],
			[{ title: "x", course: { role: "setup" }, book: { bookId: review.id, mode: "skim" } }, 400, "Invalid book mode"],
			[{ title: "x", book: "book" }, 400, "Invalid book"],
		] as const;
		for (const [body, status, error] of refusals) {
			const response = await createSession(body);
			const answer = await response.json() as { error: string; code?: string };
			assert.deepEqual([response.status, answer.error], [status, error], JSON.stringify(body));
			// The composer names an unavailable book; malformed requests stay generic.
			assert.equal(answer.code, status === 400 ? undefined : "book-unavailable", JSON.stringify(body));
		}
		assert.equal(chatStore.listChats().length, before);
	});
});

// ─── the book in turns ──────────────────────────────────────────────────────

describe("a Teach session's book in its turns", () => {
	it("gives the prober the section with its addition and the tools, which read the library", async () => {
		const book = storeBook();
		const chatId = await sessionWith({ title: "Hegel", book: { bookId: book.id } });
		const { engine, contexts } = scripted([
			() => fauxAssistantMessage([fauxToolCall("read_section", { at: "§90–§91" }, { id: "read-1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("search_book", { query: "absolute knowing" }, { id: "search-1" }), fauxToolCall("read_section", { at: "§999" }, { id: "read-2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("What do you make of §90?")]),
		]);
		const kinds: string[] = [];
		assert.equal((await runTurn(chatId, { type: "text", text: "teach me the Phenomenology" }, factory(chatId, engine, kinds))).status, 200);
		assert.deepEqual(kinds, ["prober"]);
		const prompt = systemPrompt(contexts[0]!);
		const section = [BOOK_DOCTRINE, PROBER_BOOK_ADDITION, BOOK_PART].join("\n\n");
		assert.ok(prompt.endsWith(`\n\n---\n\n${section}`), "the section closes the app's prompt");
		for (const tool of BOOK_TOOLS) assert.ok(declares(contexts[0]!, tool), tool);

		assert.deepEqual(toolResultText(contexts[1]!), { text: READ_90_91, isError: false });
		const results = contexts[2]!.messages.filter((m) => m.role === "toolResult").slice(-2) as unknown as Array<{ content: Array<{ text: string }>; isError: boolean }>;
		assert.deepEqual(results.map((r) => [r.content[0]!.text, r.isError]), [
			["No matches for \"absolute knowing\".", false],
			["\"§999\" isn't a section of this book. Use a label or id from the map.", true],
		]);

		// The accounting counts the section as sent: its share of the prompt
		// (separator included) at 4 characters per token.
		const baseline = dynamicPromptEstimate(chatId, 0).previous;
		assert.ok(baseline);
		assert.equal(baseline.tokens, Math.ceil((section.length + "\n\n---\n\n".length) / 4));
	});

	it("gives the teacher the section without the prober's addition", async () => {
		const book = storeBook();
		const chatId = await sessionWith({ title: "Hegel", book: { bookId: book.id } });
		concludeProbe(chatId);
		const { engine, contexts } = scripted([() => fauxAssistantMessage([fauxText("Planning.")])]);
		const kinds: string[] = [];
		assert.equal((await runTurn(chatId, { type: "text", text: "Ready." }, factory(chatId, engine, kinds))).status, 200);
		assert.deepEqual(kinds, ["teacher"]);
		const prompt = systemPrompt(contexts[0]!);
		assert.ok(prompt.endsWith(`\n\n---\n\n${[BOOK_DOCTRINE, BOOK_PART].join("\n\n")}`));
		for (const tool of BOOK_TOOLS) assert.ok(declares(contexts[0]!, tool), tool);
	});

	it("is absent from a session without a book", async () => {
		const chatId = await sessionWith({ title: "Plain" });
		const { engine, contexts } = scripted([() => fauxAssistantMessage([fauxText("Hi.")])]);
		assert.equal((await runTurn(chatId, { type: "text", text: "teach me" }, factory(chatId, engine))).status, 200);
		assert.ok(!systemPrompt(contexts[0]!).includes("# The learner's book"));
		for (const tool of BOOK_TOOLS) assert.ok(!declares(contexts[0]!, tool), tool);
		assert.equal(dynamicPromptEstimate(chatId, 0).previous, undefined, "nothing dynamic to measure");
	});

	it("says a book that can't be read, and gives no tools", async () => {
		const book = storeBook();
		const chatId = await sessionWith({ title: "Hegel", book: { bookId: book.id } });
		fs.writeFileSync(path.join(bookDir(book.id), "book.json"), JSON.stringify({ ...book, version: 9 }));
		const { engine, contexts } = scripted([() => fauxAssistantMessage([fauxText("Hi.")])]);
		assert.equal((await runTurn(chatId, { type: "text", text: "teach me" }, factory(chatId, engine))).status, 200);
		assert.ok(systemPrompt(contexts[0]!).endsWith(`\n\n---\n\n# The learner's book\n\nThis session's book, "${book.id}", can't be read right now (this book was saved by a newer version of the app). Teach without it; if the learner asks about it, say so.`));
		for (const tool of BOOK_TOOLS) assert.ok(!declares(contexts[0]!, tool), tool);
		assert.deepEqual(sessionBookView(chatStore.getChat(chatId)!), { bookId: book.id, title: "Book" });
	});

	it("reads fresh each turn: summaries written meanwhile join the outline", async () => {
		const book = storeBook({ mapWriter: { status: "writing", done: 0, total: 7 } });
		bookStore.writeMap(book.id, { nodes: NODES.map(({ summary: _s, terms: _t, ...node }) => node) });
		const chatId = await sessionWith({ title: "Hegel", book: { bookId: book.id } });
		const { engine, contexts } = scripted([() => fauxAssistantMessage([fauxText("One.")]), () => fauxAssistantMessage([fauxText("Two.")])]);
		assert.equal((await runTurn(chatId, { type: "text", text: "a" }, factory(chatId, engine))).status, 200);
		const first = systemPrompt(contexts[0]!);
		assert.ok(first.includes("Summaries are still being written; the outline shows those done.\n\n### Outline\n[n0] A. Consciousness\n"));
		const firstTokens = dynamicPromptEstimate(chatId, 0).previous!.tokens;
		bookStore.writeMap(book.id, { nodes: NODES });
		bookStore.update(book.id, (record) => ({ ...record, mapWriter: { status: "ready", done: 7, total: 7 } }));
		assert.equal((await runTurn(chatId, { type: "text", text: "b" }, factory(chatId, engine))).status, 200);
		const second = systemPrompt(contexts[1]!);
		assert.ok(second.endsWith(`\n\n---\n\n${[BOOK_DOCTRINE, PROBER_BOOK_ADDITION, BOOK_PART].join("\n\n")}`));
		assert.ok(dynamicPromptEstimate(chatId, 0).previous!.tokens > firstTokens, "the grown section is measured");
	});
});

describe("a book that changes while a request is prepared", () => {
	it("sends and counts the map as it stands when the request goes out", async () => {
		const bare = NODES.map(({ summary: _s, terms: _t, ...node }) => node);
		const book = storeBook({ mapWriter: { status: "writing", done: 0, total: 7 } });
		bookStore.writeMap(book.id, { nodes: bare });
		const chatId = await sessionWith({ title: "Hegel", book: { bookId: book.id } });
		// The map writer lands its batch at the first async boundary after the
		// handler first read the map.
		const readMap = bookStore.readMap;
		let scheduled = false;
		const spy = mock.method(bookStore, "readMap", (id: string) => {
			const map = readMap(id);
			if (id === book.id && !scheduled) {
				scheduled = true;
				queueMicrotask(() => {
					bookStore.writeMap(book.id, { nodes: NODES });
					bookStore.update(book.id, (record) => ({ ...record, mapWriter: { status: "ready", done: 7, total: 7 } }));
				});
			}
			return map;
		});
		const { engine, contexts } = scripted([() => fauxAssistantMessage([fauxText("Hi.")])]);
		try { assert.equal((await runTurn(chatId, { type: "text", text: "teach me" }, factory(chatId, engine))).status, 200); }
		finally { spy.mock.restore(); }
		const section = [BOOK_DOCTRINE, PROBER_BOOK_ADDITION, BOOK_PART].join("\n\n");
		assert.ok(systemPrompt(contexts[0]!).endsWith(`\n\n---\n\n${section}`), "the summaries written meanwhile are sent");
		assert.equal(dynamicPromptEstimate(chatId, 0).previous!.tokens, Math.ceil((section.length + "\n\n---\n\n".length) / 4), "and counted");
	});
});

// ─── courses ────────────────────────────────────────────────────────────────

const PROPOSAL = {
	title: "Reading Hegel",
	goal: "Follow the Phenomenology's opening argument.",
	units: [
		{ key: "sense", title: "Sense-certainty", goal: "Follow §90–§110.", prerequisites: [], startingPoint: "new" },
		{ key: "perception", title: "Perception", goal: "Follow §111–§131.", prerequisites: ["sense"], startingPoint: "new" },
	],
};

/** A setup session with the book that proposed PROPOSAL, then the course. */
async function courseWithBook(mode: "follow" | "reference"): Promise<{ bookId: string; setupId: string; courseId: string; unitChatId: string }> {
	const book = storeBook();
	const setupId = await sessionWith({ title: "Reading Hegel", course: { role: "setup" }, book: { bookId: book.id, mode } });
	const { engine, contexts } = scripted([
		() => fauxAssistantMessage([fauxToolCall("propose_course", PROPOSAL, { id: "prop-1" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage([fauxText("Two units.")]),
	]);
	const kinds: string[] = [];
	assert.equal((await runTurn(setupId, { type: "text", text: "a course on this book" }, factory(setupId, engine, kinds))).status, 200);
	assert.deepEqual(kinds, ["setup"]);
	// The setup agent reads the book too: the section without additions.
	assert.ok(systemPrompt(contexts[0]!).endsWith(`\n\n---\n\n${[BOOK_DOCTRINE, BOOK_PART].join("\n\n")}`));
	for (const tool of BOOK_TOOLS) assert.ok(declares(contexts[0]!, tool), tool);
	const created = courses.createCourseFromSetup({ setupChatId: setupId, toolCallId: "prop-1", title: PROPOSAL.title, goal: PROPOSAL.goal, units: PROPOSAL.units });
	assert.ok(created.ok && created.chatId, JSON.stringify(created));
	chatStore.saveSettings(created.chatId, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return { bookId: book.id, setupId, courseId: created.courseId, unitChatId: created.chatId };
}

describe("a course's book", () => {
	it("is copied from the setup with its mode, and its units take it", async () => {
		const { bookId, setupId, courseId, unitChatId } = await courseWithBook("reference");
		assert.deepEqual(courseStore.get(courseId)!.book, { bookId, mode: "reference" });
		const view = { bookId, title: "Phenomenology of Spirit" };
		assert.deepEqual(sessionBookView(chatStore.getChat(setupId)!), view);
		assert.deepEqual(sessionBookView(chatStore.getChat(unitChatId)!), view);
		assert.deepEqual(courseBookView(courseStore.get(courseId)!.book), view);
		assert.equal(sessionBookView(chatStore.getChat(await sessionWith({ title: "Plain" }))!), undefined);
	});

	it("gives a unit of a followed book its reading after the course section; a reference book gives none", async () => {
		const followed = await courseWithBook("follow");
		courseStore.update(followed.courseId, (course) => ({ ...course, units: course.units.map((unit, i) => i === 0 ? { ...unit, reading: [{ from: "n1", to: "n1" }] } : unit) }));
		concludeProbe(followed.unitChatId);
		const { engine, contexts } = scripted([() => fauxAssistantMessage([fauxText("Plan.")]), () => fauxAssistantMessage([fauxText("Probe.")])]);
		assert.equal((await runTurn(followed.unitChatId, { type: "text", text: "Ready." }, factory(followed.unitChatId, engine))).status, 200);
		const reading = [
			"## This unit's reading: I (Sense-certainty)",
			TEACHER_UNIT_READING_ADDITION,
			[
				"[n1] I. Sense-certainty — The richest knowledge proves the poorest.",
				"  Terms: this, now, here",
				"  [n2] §90 — Immediate knowing takes its object as it is.",
				"  [n3] §91 — Sense-certainty claims to be the truest knowledge.",
			].join("\n"),
		].join("\n\n");
		const teacher = systemPrompt(contexts[0]!);
		assert.ok(teacher.endsWith(`\n\n---\n\n${[BOOK_DOCTRINE, BOOK_PART, reading].join("\n\n")}`), teacher.slice(-400));
		assert.ok(teacher.indexOf("# Course context") < teacher.indexOf("# The learner's book"), "after the course section");

		const reference = await courseWithBook("reference");
		courseStore.update(reference.courseId, (course) => ({ ...course, units: course.units.map((unit, i) => i === 0 ? { ...unit, reading: [{ from: "n1", to: "n1" }] } : unit) }));
		assert.equal((await runTurn(reference.unitChatId, { type: "continue" }, factory(reference.unitChatId, engine))).status, 200);
		const prober = systemPrompt(contexts[1]!);
		assert.ok(prober.endsWith(`\n\n---\n\n${[BOOK_DOCTRINE, PROBER_BOOK_ADDITION, BOOK_PART].join("\n\n")}`), "a reference book's units have no reading");
	});
});
