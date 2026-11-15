/**
 * Plan 05 item 2: the book map writer and the optional contents pass.
 * Leaves are summarized in batches within the text budget, then parents
 * from their children's summaries; a long section is read in windows; a
 * bad submission goes back to the model; each finished batch is stored at
 * once, so Stop keeps it and Try again writes the rest; an interrupted
 * writer reads as such; the writer starts by itself on acceptance (both
 * kinds) and never in review, needs nothing for a short book, fails at
 * once with no Cheap model, is discarded when the contents switch, and
 * resolves through bookMapper on the Cheap slot with purpose user. The
 * contents pass reads a capped digest and its result becomes a reviewable
 * `model` candidate. Fakes only (pi-ai's faux provider); an isolated
 * LH_DATA_DIR is set before any config-loading import. Expected values are
 * worked by hand from the fixtures below.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	type FauxResponseFactory,
	type FauxResponseStep,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-book-maps-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

const { settingsStore } = await import("../src/store/settings.ts");
const { bookStore } = await import("../src/store/books.ts");
const books = await import("../src/server/books.ts");
const maps = await import("../src/server/book-maps.ts");
const { activityFeed } = await import("../src/server/observability.ts");
const { structureDigest, modelCandidate } = await import("../src/core/book.ts");
const { BOOK_MAP_PARTS_PROMPT, BOOK_MAP_SECTIONS_PROMPT, BOOK_STRUCTURE_PROMPT, textWindows, writeBookMap, findBookStructure, prepareStructurePass } = await import("../src/agent/subagents/book-mapper.ts");
const listRoute = await import("../app/api/books/route.ts");
const bookRoute = await import("../app/api/books/[id]/route.ts");
const contentsRoute = await import("../app/api/books/[id]/contents/route.ts");
const mapWriterRoute = await import("../app/api/books/[id]/map-writer/route.ts");
const structureRoute = await import("../app/api/books/[id]/structure-writer/route.ts");
const abortRoute = await import("../app/api/activity/abort/route.ts");
type PiEngine = import("../src/agent/models.ts").PiEngine;
type BookRecord = import("../src/core/contracts.ts").BookRecord;
type BookBlock = import("../src/core/contracts.ts").BookBlock;
type BookNode = import("../src/core/contracts.ts").BookNode;

const SETTINGS = { version: 1, models: { strong: { model: { provider: "test", id: "strong" } }, cheap: { model: { provider: "test", id: "cheap" } }, vision: { model: { provider: "test", id: "vision" } } } } as const;
const mapSeams = { ...maps.bookMapServiceSeams };
const bookSeams = { ...books.bookServiceSeams };

before(() => settingsStore.writeSettings(structuredClone(SETTINGS) as never));
afterEach(async () => {
	// Let writers still settling from a failed assertion finish first.
	for (let i = 0; i < 200 && activityFeed().bookWriters.length > 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
	Object.assign(maps.bookMapServiceSeams, mapSeams);
	Object.assign(books.bookServiceSeams, bookSeams);
	settingsStore.writeSettings(structuredClone(SETTINGS) as never);
	fs.rmSync(path.join(TMP, "books"), { recursive: true, force: true });
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ─── the writer's engine (faux) ─────────────────────────────────────────────

function scripted(steps: FauxResponseStep[], contextWindow = 128_000, maxTokens = 16_384) {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 }, models: [{ id: "cheap-faux", contextWindow, maxTokens }] });
	// The faux transport does not apply production context clamping. Apply the
	// real provider oracle to each response, independently of the writer's plan.
	faux.setResponses(steps.map((step): FauxResponseFactory => async (context, options, state, model) => {
		const response = typeof step === "function" ? await step(context, options, state, model) : step;
		const answer = response.content.map((part) => part.type === "toolCall" ? part.name + JSON.stringify(part.arguments) : part.type === "text" ? part.text : part.thinking).join("");
		const available = buildBaseOptions(model, context, options, undefined).maxTokens!;
		assert.ok(available >= Math.max(64, Math.ceil(answer.length / 3.5)), `production output limit ${available} cannot hold ${answer.length} answer characters`);
		return response;
	}));
	const requests: TranscriptContext[] = [];
	const engine: PiEngine = {
		model: faux.getModel(), level: "off",
		streamFn: (model, context, options) => {
			requests.push(structuredClone(context));
			return faux.streamSimple(model, context, options);
		},
	} as PiEngine;
	return { engine, requests };
}

function useEngine(engine: PiEngine): unknown[][] {
	const built: unknown[][] = [];
	maps.bookMapServiceSeams.buildEngine = (...args) => { built.push(args); return engine; };
	return built;
}

const userText = (context: TranscriptContext) => context.messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("")).join("\n");
const textOf = (content: unknown) => typeof content === "string" ? content : Array.isArray(content) ? content.map((p: { type?: string; text?: string }) => (p.type === "text" ? p.text ?? "" : "")).join("") : "";
const systemText = (context: TranscriptContext) => context.messages.filter((m) => (m.role as string) === "system").map((m) => textOf((m as { content: unknown }).content)).join("\n");
const toolResults = (context: TranscriptContext) => context.messages.flatMap((m) => m.role === "toolResult" ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])) : []).join("\n");
const sectionIds = (context: TranscriptContext) => [...userText(context).matchAll(/<section id="(n[0-9]+)"/g)].map((match) => match[1]!);

let calls = 0;
const submit = (name: string, args: object) => fauxAssistantMessage([fauxToolCall(name, args as never, { id: `c${++calls}` })], { stopReason: "toolUse" });

/** A model that summarizes every section it's given: "Summary of <id>". */
const mapper: FauxResponseFactory = (context) => {
	const sections = [...userText(context).matchAll(/<section id="(n[0-9]+)"([^>]*)>/g)].map((match) => ({ id: match[1]!, untitled: /\buntitled\b/.test(match[2]!) }));
	return submit("submit_summaries", {
		summaries: sections.map((section) => ({ id: section.id, summary: `Summary of ${section.id}`, terms: [`term-${section.id}`], ...(section.untitled ? { title: `Title of ${section.id}` } : {}) })),
	});
};
const mappers = (n: number) => Array.from({ length: n }, () => mapper);

/** A model call that waits until the writer is stopped. */
const untilStopped: FauxResponseStep = async (_context, options) => {
	await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }));
	throw Object.assign(new Error("aborted"), { name: "AbortError" });
};

async function until(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 1_000; i++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${what}`);
}
const settledWriter = async (id: string, kind: "map" | "contents" = "map") => {
	await until(() => !maps.isBookWriterRunning(id, kind), `the ${kind} writer of ${id}`);
	return bookStore.get(id)!;
};

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) => new Request("http://x", { method: "POST", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
const put = (body: unknown) => new Request("http://x", { method: "PUT", body: JSON.stringify(body) });

// ─── fixtures ───────────────────────────────────────────────────────────────

const filler = (length: number, lead: string) => `${lead} ${"spirit ".repeat(Math.ceil(length / 7))}`.slice(0, length);

/** Heading A, §1–§3, heading B, §4–§5: blocks 0, 1–3, 4, 5–6. Each §
 *  paragraph is exactly 3,000 characters. */
const SPIRIT_BLOCKS: BookBlock[] = [
	{ id: 0, kind: "heading", level: 1, text: "A. Consciousness" },
	{ id: 1, kind: "paragraph", text: filler(3_000, "1.") },
	{ id: 2, kind: "paragraph", text: filler(3_000, "2.") },
	{ id: 3, kind: "paragraph", text: filler(3_000, "3.") },
	{ id: 4, kind: "heading", level: 1, text: "B. Self-consciousness" },
	{ id: 5, kind: "paragraph", text: filler(3_000, "4.") },
	{ id: 6, kind: "paragraph", text: filler(3_000, "5.") },
];
const paragraph = (id: string, parentId: string, n: number, block: number): BookNode => ({ id, parentId, label: `§${n}`, title: "", kind: "paragraph", level: 2, firstBlock: block, lastBlock: block });
const SPIRIT_NODES: BookNode[] = [
	{ id: "n0", label: "A", title: "A. Consciousness", kind: "section", level: 1, firstBlock: 0, lastBlock: 3 },
	paragraph("n1", "n0", 1, 1),
	paragraph("n2", "n0", 2, 2),
	paragraph("n3", "n0", 3, 3),
	{ id: "n4", label: "B", title: "B. Self-consciousness", kind: "section", level: 1, firstBlock: 4, lastBlock: 6 },
	paragraph("n5", "n4", 4, 5),
	paragraph("n6", "n4", 5, 6),
];

let seeded = 0;
function seedBook(options: { blocks?: BookBlock[]; nodes?: BookNode[]; mapWriter?: BookRecord["mapWriter"]; structureWriter?: BookRecord["structureWriter"] } = {}): string {
	const id = `book_seed_${++seeded}`;
	const now = new Date().toISOString();
	bookStore.create({
		id, title: "Map Spirit", author: "G. Tester", format: "text", fileName: "spirit.txt", sha256: id, bytes: 1,
		importedAt: now, updatedAt: now, words: 30_000, structure: "numbered", confidence: { level: "confident", reasons: [] },
		contentsAccepted: "auto", import: { status: "ready" },
		mapWriter: options.mapWriter ?? { status: "waiting", done: 0, total: 0 },
		...(options.structureWriter ? { structureWriter: options.structureWriter } : {}),
	}, new Uint8Array([1]));
	bookStore.writeText(id, { blocks: options.blocks ?? SPIRIT_BLOCKS });
	bookStore.writeMap(id, { nodes: options.nodes ?? SPIRIT_NODES });
	return id;
}

async function upload(name: string, text: string): Promise<BookRecord> {
	const form = new FormData();
	form.append("file", new File([new TextEncoder().encode(text) as BlobPart], name));
	const response = await listRoute.POST(new Request("http://localhost/api/books", { method: "POST", body: form }));
	assert.equal(response.status, 200, await response.clone().text());
	const { book } = await response.json() as { book: BookRecord };
	await until(() => bookStore.get(book.id)!.import.status !== "importing", "the import");
	return bookStore.get(book.id)!;
}

const words = (n: number) => Array.from({ length: n }, () => "spirit").join(" ");
/** 30 numbered paragraphs of 701 words: confident, and long enough for a map. */
const LONG_NUMBERED = Array.from({ length: 30 }, (_, i) => `${i + 1}. ${words(700)}.`).join("\n\n");
/** Two headings over 22 paragraphs of 1,000 words: unsure (headings only),
 *  so it waits for review. */
const thousands = (n: number) => Array.from({ length: n }, () => `${words(1_000)}.`).join("\n\n");
const LONG_HEADINGS = `# One\n\n${thousands(11)}\n\n# Two\n\n${thousands(11)}\n`;

// ─── the map writer ─────────────────────────────────────────────────────────

describe("the map writer", () => {
	it("summarizes leaves in batches within the text budget, then parents from their children's summaries", async () => {
		const { engine, requests } = scripted(mappers(20), 8_192);
		useEngine(engine);
		const id = seedBook();
		const started = maps.startBookMapWriter(id);
		assert.deepEqual(started?.mapWriter, { status: "writing", done: 0, total: 7 });
		const record = await settledWriter(id);

		const leafRequests = requests.filter((request) => systemText(request) === BOOK_MAP_SECTIONS_PROMPT);
		const partRequests = requests.filter((request) => systemText(request) === BOOK_MAP_PARTS_PROMPT);
		assert.deepEqual(leafRequests.flatMap(sectionIds), ["n1", "n2", "n3", "n5", "n6"]);
		assert.deepEqual(partRequests.flatMap(sectionIds), ["n0", "n4"]);
		assert.equal(requests.indexOf(partRequests[0]!), leafRequests.length, "all leaves precede the bottom-up parent pass");
		assert.ok(userText(leafRequests[0]!).includes(`<section id="n1" label="§1" within="A">\n${SPIRIT_BLOCKS[1]!.text}\n</section>`));
		assert.ok(userText(partRequests[0]!).includes(`<section id="n0" label="A" title="A. Consciousness">\n- [n1] §1 — Summary of n1 (terms: term-n1)\n- [n2] §2 — Summary of n2 (terms: term-n2)\n- [n3] §3 — Summary of n3 (terms: term-n3)\n</section>`));

		const nodes = bookStore.readMap(id)!.nodes;
		assert.deepEqual(nodes.map((node) => [node.id, node.summary, node.terms]), SPIRIT_NODES.map((node) => [node.id, `Summary of ${node.id}`, [`term-${node.id}`]]));
		assert.equal(record.mapWriter.status, "ready");
		assert.deepEqual([record.mapWriter.done, record.mapWriter.total, record.mapWriter.usage?.steps], [7, 7, requests.length]);
		assert.equal(record.mapWriter.model, record.mapWriter.usage?.model);
	});

	it("stores each finished batch at once: Stop keeps it, and Try again writes only the rest", async () => {
		const first = scripted([mapper, untilStopped], 8_192);
		useEngine(first.engine);
		const id = seedBook();
		maps.startBookMapWriter(id);
		await until(() => first.requests.length === 2, "the second call");
		const saved = sectionIds(first.requests[0]!);
		assert.ok(saved.length > 0 && saved.length < 5, "a completed leaf batch is retained before Stop");
		assert.deepEqual(bookStore.readMap(id)!.nodes.filter((node) => node.summary).map((node) => node.id), saved);
		assert.deepEqual(activityFeed().bookWriters.map((row) => [row.id, row.title, row.activity]), [[`${id}:map`, "Book map · Map Spirit", `${saved.length} of 7 sections`]]);
		assert.equal((await abortRoute.POST(post({ kind: "book-map-writer", id: `${id}:contents` }))).status, 400, "the id names the other writer");
		assert.equal((await abortRoute.POST(post({ kind: "book-map-writer", id: `${id}:map` }))).status, 200);
		const stopped = await settledWriter(id);
		assert.deepEqual([stopped.mapWriter.status, stopped.mapWriter.error, stopped.mapWriter.stopped, stopped.mapWriter.done, stopped.mapWriter.total], ["failed", "Stopped", true, saved.length, 7]);
		assert.deepEqual(bookStore.readMap(id)!.nodes.filter((node) => node.summary).map((node) => node.id), saved);

		const second = scripted(mappers(20), 8_192);
		useEngine(second.engine);
		const retried = await mapWriterRoute.POST(post(), params(id));
		assert.equal(retried.status, 200);
		const done = await settledWriter(id);
		assert.deepEqual(second.requests.flatMap(sectionIds), ["n1", "n2", "n3", "n5", "n6"].filter((id) => !saved.includes(id)).concat(["n0", "n4"]));
		assert.deepEqual([done.mapWriter.status, done.mapWriter.done, done.mapWriter.error, done.mapWriter.stopped], ["ready", 7, undefined, undefined]);
		assert.equal(done.mapWriter.usage?.steps, 1 + second.requests.length, "the map's usage carries over a Try again on the same model");
		assert.equal((await mapWriterRoute.POST(post(), params(id))).status, 409, "the map is written");
	});

	it("sends a missing or unknown id, a duplicate, and the length limits back to the model", async () => {
		const nodes: BookNode[] = [
			{ id: "n0", label: "Part 1", title: "", kind: "app-part", level: 1, firstBlock: 0, lastBlock: 0 },
			{ id: "n1", label: "Part 2", title: "", kind: "app-part", level: 1, firstBlock: 1, lastBlock: 1 },
		];
		const blocks: BookBlock[] = [{ id: 0, kind: "paragraph", text: "First part." }, { id: 1, kind: "paragraph", text: "Second part." }];
		const long = "x".repeat(201);
		const { engine, requests } = scripted([
			submit("submit_summaries", { summaries: [{ id: "n0", summary: long, terms: ["a", "b", "c", "d", "e", "f", "g"] }, { id: "n9", summary: "Ghost." }] }),
			submit("submit_summaries", { summaries: [{ id: "n0", summary: "Ok.", title: "T".repeat(61) }, { id: "n1", summary: "Ok.", title: "Fine", terms: ["t".repeat(61)] }, { id: "n1", summary: "Again." }] }),
			mapper,
		]);
		useEngine(engine);
		const id = seedBook({ blocks, nodes });
		maps.startBookMapWriter(id);
		const record = await settledWriter(id);

		assert.equal(requests.length, 3);
		assert.ok(userText(requests[0]!).includes(`<section id="n0" label="Part 1" untitled>\nFirst part.\n</section>`));
		const firstProblems = toolResults(requests[1]!);
		for (const problem of [
			`- The summary of n0 is longer than 200 characters; shorten it: “${"x".repeat(60)}…”`,
			"- Section n0 has 7 terms; give at most 6.",
			"- Section n0 is untitled: give it a short title.",
			`- There is no section "n9" here. Give exactly these ids: n0, n1.`,
			"- Missing section: n1. Give every section id given.",
		]) assert.ok(firstProblems.includes(problem), `${problem} in:\n${firstProblems}`);
		const secondProblems = toolResults(requests[2]!).slice(firstProblems.length);
		for (const problem of [
			`- The title of n0 is longer than 60 characters; shorten it: “${"T".repeat(60)}…”`,
			`- A term of n1 is longer than 60 characters; shorten it: “${"t".repeat(60)}…”`,
			"- Section n1 is given twice. Give each section once.",
		]) assert.ok(secondProblems.includes(problem), `${problem} in:\n${secondProblems}`);

		assert.equal(record.mapWriter.status, "ready");
		assert.deepEqual(bookStore.readMap(id)!.nodes.map((node) => [node.label, node.title, node.summary]), [["Part 1", "Title of n0", "Summary of n0"], ["Part 2", "Title of n1", "Summary of n1"]]);
	});

	it("reads a section longer than one batch in windows, each later one given the summary so far", async () => {
		const blocks: BookBlock[] = Array.from({ length: 10 }, (_, i) => ({ id: i, kind: "paragraph" as const, text: filler(2_000, `Paragraph ${i + 1}.`) }));
		const nodes: BookNode[] = [{ id: "n0", label: "Chapter 1", title: "Chapter 1 Being", kind: "chapter", level: 1, firstBlock: 0, lastBlock: 9 }];
		let window = 0;
		const windowed: FauxResponseFactory = () => { window++; return submit("submit_summaries", { summaries: [{ id: "n0", summary: `Window ${window}`, terms: [`t${window}`] }] }); };
		const { engine, requests } = scripted(Array.from({ length: 30 }, () => windowed), 8_192);
		useEngine(engine);
		const id = seedBook({ blocks, nodes });
		maps.startBookMapWriter(id);
		const record = await settledWriter(id);

		assert.ok(requests.length > 1, "the long section needs consecutive windows");
		assert.ok(userText(requests[0]!).includes(`This section is long, so you read it in ${requests.length} parts. This is part 1.`));
		for (let index = 1; index < requests.length; index++) {
			assert.ok(userText(requests[index]!).includes(`This is part ${index + 1}.\nYour summary of the earlier parts: Window ${index}\nTerms so far: t${index}\nWrite the summary and terms of the whole section so far.`));
		}
		const windowTexts = requests.map((request) => userText(request).match(/<section[^>]*>\n([\s\S]*)\n<\/section>/)![1]!);
		assert.equal(windowTexts.join(" ").replace(/\s+/g, " ").trim(), blocks.map((block) => block.text).join(" ").replace(/\s+/g, " ").trim());
		assert.deepEqual(bookStore.readMap(id)!.nodes.map((node) => [node.summary, node.terms]), [[`Window ${requests.length}`, [`t${requests.length}`]]]);
		assert.deepEqual([record.mapWriter.status, record.mapWriter.done, record.mapWriter.total], ["ready", 1, 1]);
	});

	it("reads writers left running by a closed app as interrupted, keeping their progress, and Try again continues", async () => {
		const nodes = SPIRIT_NODES.map((node) => node.id === "n1" || node.id === "n2" ? { ...node, summary: `Summary of ${node.id}` } : node);
		const id = seedBook({ nodes, mapWriter: { status: "writing", done: 2, total: 7 }, structureWriter: { status: "writing" } });
		const read = await (await bookRoute.GET(new Request("http://x"), params(id))).json() as { book: BookRecord };
		assert.deepEqual(read.book.mapWriter, { status: "failed", done: 2, total: 7, error: "Interrupted." });
		assert.deepEqual(read.book.structureWriter, { status: "failed", error: "Interrupted." });
		const { engine, requests } = scripted(mappers(20), 8_192);
		useEngine(engine);
		assert.equal((await mapWriterRoute.POST(post(), params(id))).status, 200);
		assert.equal((await settledWriter(id)).mapWriter.status, "ready");
		assert.deepEqual(requests.flatMap(sectionIds), ["n3", "n5", "n6", "n0", "n4"]);
	});
});

// ─── when it runs ───────────────────────────────────────────────────────────

describe("when the map writer runs", () => {
	it("starts by itself once confident contents are accepted at import", async () => {
		// 30 paragraphs of about 4,900 characters; a 48,000-character budget
		// holds 9 of them per call: 9, 9, 9 and 3.
		const { engine, requests } = scripted(mappers(4));
		useEngine(engine);
		const record = await upload("Long Spirit.txt", LONG_NUMBERED);
		assert.equal(record.contentsAccepted, "auto");
		const done = await settledWriter(record.id);
		assert.deepEqual(requests.map((request) => sectionIds(request).length), [9, 9, 9, 3]);
		assert.deepEqual([done.mapWriter.status, done.mapWriter.done, done.mapWriter.total], ["ready", 30, 30]);
	});

	it("waits while the contents are in review, and starts once the learner accepts them", async () => {
		const { engine, requests } = scripted(mappers(4));
		const built = useEngine(engine);
		const record = await upload("Two Halves.md", LONG_HEADINGS);
		assert.equal(record.import.status, "review");
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(built.length, 0);
		assert.deepEqual(bookStore.get(record.id)!.mapWriter, { status: "waiting", done: 0, total: 0 });
		assert.equal((await mapWriterRoute.POST(post(), params(record.id))).status, 409, "no map before the contents are accepted");

		assert.equal((await contentsRoute.PUT(put({}), params(record.id))).status, 200);
		const done = await settledWriter(record.id);
		// Each half (about 77,000 characters) is read in two windows of the
		// 48,000-character budget.
		assert.equal(requests.length, 4);
		assert.deepEqual([done.mapWriter.status, done.mapWriter.done, done.mapWriter.total], ["ready", 2, 2]);
	});

	it("needs nothing for a short book", async () => {
		const { engine } = scripted([]);
		const built = useEngine(engine);
		const record = await upload("short.txt", Array.from({ length: 12 }, (_, i) => `${i + 1}. ${words(10)}.`).join("\n\n"));
		assert.deepEqual(record.mapWriter, { status: "not-needed", done: 0, total: 0 });
		assert.equal(maps.isBookWriterRunning(record.id, "map"), false);
		assert.equal(built.length, 0);
		const retried = await mapWriterRoute.POST(post(), params(record.id));
		assert.equal(retried.status, 409);
		assert.deepEqual(await retried.json(), { error: "This book is short: it needs no map." });
	});

	it("is discarded when the contents switch, and the new map gets its own writer", async () => {
		// The app-made parts of 22,002 words: 11 parts of two 1,000-word
		// paragraphs (about 14,000 characters), 3 per call.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const gated: FauxResponseFactory = async (context, options, state, model) => { await gate; return mapper(context, options, state, model); };
		const { engine, requests } = scripted([untilStopped, gated, ...mappers(3)]);
		useEngine(engine);
		const record = await upload("Two Halves.md", LONG_HEADINGS);
		assert.equal((await contentsRoute.PUT(put({}), params(record.id))).status, 200);
		await until(() => requests.length === 1, "the first call");
		const switched = await contentsRoute.PUT(put({ method: "app-made" }), params(record.id));
		assert.equal(switched.status, 200);
		// The new writer's first call waits; the old one has been aborted.
		await until(() => requests.length === 2, "the new writer's first call");
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(bookStore.get(record.id)!.mapWriter, { status: "writing", done: 0, total: 11 }, "the discarded writer recorded nothing");
		release();
		const done = await settledWriter(record.id);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const final = bookStore.get(record.id)!;
		assert.equal(final.structure, "app-made");
		assert.deepEqual([final.mapWriter.status, final.mapWriter.done, final.mapWriter.total, final.mapWriter.error], ["ready", 11, 11, undefined], "the discarded writer never wrote its Stop");
		assert.equal(done.mapWriter.status, "ready");
		assert.deepEqual(requests.slice(1).map((request) => sectionIds(request).length), [3, 3, 3, 2]);
		const nodes = bookStore.readMap(record.id)!.nodes;
		assert.ok(nodes.every((node) => node.kind === "app-part" && node.title === `Title of ${node.id}` && node.summary === `Summary of ${node.id}`));
	});

	it("is stopped when the book is deleted (item 3), and writes nothing after", async () => {
		const { engine, requests } = scripted([untilStopped]);
		useEngine(engine);
		const record = await upload("Doomed.md", LONG_HEADINGS);
		assert.equal((await contentsRoute.PUT(put({}), params(record.id))).status, 200);
		await until(() => requests.length === 1, "the first call");
		assert.equal(activityFeed().bookWriters.length, 1);
		const deleted = await bookRoute.DELETE(new Request("http://x", { method: "DELETE" }), params(record.id));
		assert.equal(deleted.status, 200);
		assert.equal(maps.isBookWriterRunning(record.id, "map"), false);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepEqual(activityFeed().bookWriters, []);
		assert.equal(fs.existsSync(path.join(TMP, "books", record.id)), false, "the stopped writer never recreated the folder");
	});

	it("without a Cheap model, imports and fails the writer at once; Try again works once a model is set", async () => {
		settingsStore.writeSettings({ version: 1, models: { strong: SETTINGS.models.strong } } as never);
		const { engine } = scripted(mappers(4));
		const built = useEngine(engine);
		const record = await upload("Long Spirit.txt", LONG_NUMBERED);
		assert.equal(record.import.status, "ready");
		assert.deepEqual(bookStore.get(record.id)!.mapWriter, { status: "failed", done: 0, total: 30, error: "No model configured — set up your models first" });
		assert.equal(built.length, 0);
		const refused = await mapWriterRoute.POST(post(), params(record.id));
		assert.equal(refused.status, 503);
		assert.deepEqual(await refused.json(), { error: "No model configured — set up your models first" });

		settingsStore.writeSettings(structuredClone(SETTINGS) as never);
		assert.equal((await mapWriterRoute.POST(post(), params(record.id))).status, 200);
		assert.equal((await settledWriter(record.id)).mapWriter.status, "ready");
	});

	it("resolves its engine through bookMapper from the Cheap slot, with purpose user, in the worker pool", async () => {
		let activeDuringRequest = -1;
		const pool = () => (globalThis as Record<symbol, { active: number } | undefined>)[Symbol.for("lh.worker-request-admission.pool.v1")];
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		faux.setResponses([mapper]);
		const built = useEngine({
			model: faux.getModel(), level: "off",
			streamFn: (model, context, options) => { activeDuringRequest = pool()?.active ?? -1; return faux.streamSimple(model, context, options); },
		} as PiEngine);
		const id = seedBook({ blocks: [{ id: 0, kind: "paragraph", text: "Text." }], nodes: [{ id: "n0", label: "Part 1", title: "", kind: "app-part", level: 1, firstBlock: 0, lastBlock: 0 }] });
		maps.startBookMapWriter(id);
		assert.equal((await settledWriter(id)).mapWriter.status, "ready");
		assert.equal(built.length, 1);
		const [spec, background] = built[0]!;
		assert.deepEqual({ provider: (spec as { provider: string }).provider, id: (spec as { id: string }).id }, { provider: "test", id: "cheap" });
		assert.equal(background, false, "the learner imported the book: purpose user, not background");
		assert.ok(activeDuringRequest >= 1, "the request held a worker-pool permit");

		settingsStore.writeSettings({ ...structuredClone(SETTINGS), agent: { models: { bookMapper: { model: { provider: "test", id: "override-model" } } } } } as never);
		maps.bookMapperEngine();
		assert.equal((built.at(-1)![0] as { id: string }).id, "override-model", "an override for the role wins over the Cheap slot");
	});
});

// ─── batching ───────────────────────────────────────────────────────────────

describe("batching", () => {
	for (const contextWindow of [8_192, 128_000]) {
		it(`finishes full-sized answers and long windows within a ${contextWindow}-token model's production limits`, async () => {
			const blocks: BookBlock[] = Array.from({ length: 43 }, (_, id) => ({
				id, kind: "paragraph", text: id === 0 ? filler(60_000, "Long first part.") : `Short part ${id}.`,
			}));
			const nodes: BookNode[] = blocks.map((block) => ({
				id: `n${block.id}`, label: `Part ${block.id + 1} ${"label ".repeat(20)}`, title: "", kind: "app-part", level: 1,
				firstBlock: block.id, lastBlock: block.id,
			}));
			const fullAnswer: FauxResponseFactory = (context) => submit("submit_summaries", {
				summaries: sectionIds(context).map((id) => ({
					id, summary: "s".repeat(200), terms: Array.from({ length: 6 }, () => "t".repeat(60)), title: "h".repeat(60),
				})),
			});
			const { engine, requests } = scripted(Array.from({ length: 100 }, () => fullAnswer), contextWindow, contextWindow === 8_192 ? 2_048 : 16_384);
			const saved = new Map<string, { summary: string; terms: string[]; title?: string }>();
			await writeBookMap({
				bookId: "budgeted-map", bookTitle: "Book title ".repeat(80), author: "Author ".repeat(40),
				blocks, nodes, engine,
				onSummaries: (written) => {
					for (const [id, summary] of written) {
						assert.equal(saved.has(id), false, "window summaries are stored only when the whole section is finished");
						saved.set(id, summary);
					}
				},
			});
			assert.deepEqual([...saved.keys()], nodes.map((node) => node.id));
			assert.ok([...saved.values()].every((entry) => entry.summary.length === 200 && entry.terms.length === 6 && entry.title?.length === 60));
			assert.ok(requests.every((request) => sectionIds(request).length <= 40));
			const longWindows = requests.filter((request) => sectionIds(request).includes("n0"));
			assert.ok(longWindows.length > 1);
			assert.ok(userText(longWindows[1]!).includes(`Your summary of the earlier parts: ${"s".repeat(200)}\nTerms so far: ${Array.from({ length: 6 }, () => "t".repeat(60)).join(", ")}\nTitle so far: ${"h".repeat(60)}`));
			const texts = longWindows.map((request) => userText(request).match(/<section[^>]*>\n([\s\S]*)\n<\/section>/)![1]!);
			assert.ok(texts.every((text) => text.length <= 48_000), "the 12k text ceiling still applies on large models");
			assert.equal(texts.join(" ").replace(/\s+/g, " ").trim(), blocks[0]!.text.replace(/\s+/g, " ").trim());
			assert.deepEqual(requests.filter((request) => !sectionIds(request).includes("n0")).flatMap(sectionIds), nodes.slice(1).map((node) => node.id));
		});
	}

	it("fails before provider dispatch when even one useful window and answer cannot fit", async () => {
		const { engine, requests } = scripted([mapper], 4_000);
		await assert.rejects(writeBookMap({
			bookId: "too-small-map", bookTitle: "Book", engine,
			blocks: [{ id: 0, kind: "paragraph", text: filler(2_000, "Text.") }],
			nodes: [{ id: "n0", label: "Part 1", title: "", kind: "app-part", level: 1, firstBlock: 0, lastBlock: 0 }],
			onSummaries: () => assert.fail("no partial summary"),
		}), /context or output limit is too small/);
		assert.equal(requests.length, 0, "do not ask a real provider for a one-token answer");
	});

	it("splits a long text at line breaks, and inside a line at a space", () => {
		assert.deepEqual(textWindows("aaaa\nbbbb\ncccc", 9), ["aaaa\nbbbb", "cccc"]);
		assert.deepEqual(textWindows("one two three four", 9), ["one two", "three", "four"]);
	});
});

// ─── the contents pass ──────────────────────────────────────────────────────

describe("the contents pass", () => {
	const blocks: BookBlock[] = [
		{ id: 0, kind: "heading", level: 1, text: "Chapter 1 Being" },
		{ id: 1, kind: "paragraph", text: filler(300, "A long paragraph of body text") },
		{ id: 2, kind: "paragraph", text: "A short line" },
		{ id: 3, kind: "paragraph", text: "Chapter 2 Nothing" },
		{ id: 4, kind: "paragraph", text: "1.2 Becoming" },
		{ id: 5, kind: "heading", level: 1, text: filler(160, "An overlong heading") },
	];

	it("digests candidate heading lines, keeping strong ones first under the cap", () => {
		// Lines: "[0] (larger type) Chapter 1 Being" (34 with its newline),
		// "[2] A short line" (17, weak), "[3] Chapter 2 Nothing" (22),
		// "[4] 1.2 Becoming" (17). Strong lines take 73 characters.
		assert.deepEqual(structureDigest(blocks).lines.map((line) => [line.block, line.larger]), [[0, true], [2, false], [3, false], [4, false]]);
		const fits = structureDigest(blocks, 20); // 80 characters: the strong lines, no room for the weak one
		assert.deepEqual([fits.lines.map((line) => line.block), fits.omitted], [[0, 3, 4], 1]);
		const tight = structureDigest(blocks, 10); // 40 characters: one strong line
		assert.deepEqual([tight.lines.map((line) => line.block), tight.omitted], [[0], 3]);
	});

	it("previews and executes the same sampled contents with complete answers on an 8192-token model", async () => {
		const many: BookBlock[] = Array.from({ length: 600 }, (_, id) => ({
			id, kind: id % 3 === 0 ? "heading" : "paragraph", level: 1,
			text: id % 3 === 0 ? filler(110, `Chapter ${id + 1} Heading`) : `A brief note ${id}`,
			page: id + 1, pageLabel: `page-${id + 1}`,
		}));
		const raw = structureDigest(many);
		const response: FauxResponseFactory = (context) => submit("submit_structure", {
			headings: [...userText(context).matchAll(/^\[(\d+)\]/gm)].map((match) => ({
				block: Number(match[1]), level: 1, label: "l".repeat(40), title: "h".repeat(150),
			})),
		});
		const { engine, requests } = scripted([response, response], 8_192, 4_096);
		useEngine(engine);
		const id = seedBook({ blocks: many, nodes: [] });
		const input = { bookTitle: "Map Spirit", author: "G. Tester", blocks: many.length, digest: raw, engine };
		const prepared = prepareStructurePass(input);
		assert.deepEqual(prepareStructurePass({ ...input, digest: prepared.digest }), prepared, "preparing the server-selected digest again is idempotent");
		assert.ok(prepared.digest.lines.length > 0 && prepared.digest.lines.length < raw.lines.length);
		assert.ok(prepared.digest.lines.every((line) => line.larger), "strong headings precede weak short lines under pressure");
		assert.equal(prepared.digest.lines[0]!.block, 0);
		assert.ok(prepared.digest.lines.at(-1)!.block > 540, "sample across the book, not only its beginning");
		assert.ok(prepared.digest.lines.every((line) => prepared.prompt.includes(`p. page-${line.block + 1}`)), "page labels survive sampling");
		assert.equal(prepared.digest.omitted, raw.omitted + raw.lines.length - prepared.digest.lines.length);
		assert.ok(prepareStructurePass({ ...input, engine: undefined }).digest.lines.length > prepared.digest.lines.length, "without a selected model the existing upper digest cap remains available");

		const estimateResponse = await structureRoute.GET(new Request("http://x"), params(id));
		assert.equal(estimateResponse.status, 200);
		const estimate = await estimateResponse.json() as { lines: number; tokens: number };
		assert.deepEqual([estimate.lines, estimate.tokens], [prepared.digest.lines.length, prepared.tokens]);
		assert.equal((await structureRoute.POST(post(), params(id))).status, 200);
		const done = await settledWriter(id, "contents");
		assert.equal(done.structureWriter?.status, "ready", done.structureWriter?.error);
		assert.equal(userText(requests[0]!), prepared.prompt, "POST sends exactly the digest and metadata previewed by GET");
		const candidate = bookStore.readCandidates(id)!.candidates.find((entry) => entry.method === "model")!;
		assert.deepEqual(candidate.nodes.map((node) => node.firstBlock), prepared.digest.lines.map((line) => line.block));
		assert.ok(candidate.nodes.every((node) => node.label.length === 40 && node.title.length === 150));
		const direct = await findBookStructure({ bookId: "direct-budgeted-contents", bookTitle: input.bookTitle, author: input.author, blocks: many, digest: raw, engine });
		assert.deepEqual(direct.map((heading) => heading.block), prepared.digest.lines.map((line) => line.block));
		assert.equal(userText(requests[1]!), prepared.prompt, "direct callers use the same safe selection");
	});

	it("reserves answer space under the output cap and validates only headings actually submitted", async () => {
		const many: BookBlock[] = Array.from({ length: 80 }, (_, id) => ({ id, kind: "heading", level: 1, text: `Chapter ${id + 1} A heading` }));
		const raw = structureDigest(many);
		let selected: number[] = [];
		const response: FauxResponseFactory = (context) => {
			selected = [...userText(context).matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
			return submit("submit_structure", { headings: selected.map((block) => ({ block, level: 1, label: "l".repeat(40), title: "h".repeat(150) })) });
		};
		const { engine, requests } = scripted([
			(context) => {
				const given = new Set([...userText(context).matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1])));
				const omitted = raw.lines.find((line) => !given.has(line.block))!;
				return submit("submit_structure", { headings: [{ block: omitted.block, level: 1, label: "Not given" }] });
			},
			response,
		], 128_000, 1_024);
		const headings = await findBookStructure({ bookId: "output-limited-contents", bookTitle: "Book", blocks: many, digest: raw, engine });
		assert.ok(selected.length > 0 && selected.length < many.length);
		assert.deepEqual(headings.map((heading) => heading.block), selected);
		assert.ok(toolResults(requests[1]!).includes("isn't one of the lines given"), "an original candidate removed by sizing is not accepted");

		const tiny = scripted([], 4_000);
		assert.throws(() => prepareStructurePass({ bookTitle: "Book", blocks: many.length, digest: raw, engine: tiny.engine }), /context or output limit is too small/);
		assert.equal(tiny.requests.length, 0);
	});

	it("nests confident numbered paragraphs inside the model's headings", () => {
		const numbered: BookBlock[] = [
			{ id: 0, kind: "paragraph", text: "Part One" },
			...Array.from({ length: 12 }, (_, i) => ({ id: i + 1, kind: "paragraph" as const, text: filler(120, `${i + 1}.`) })),
		];
		const candidate = modelCandidate(numbered, [{ block: 0, level: 1, label: "Part One", title: "Part One" }])!;
		assert.equal(candidate.method, "model");
		assert.equal(candidate.description, "1 entry, §1–§12 within them");
		assert.deepEqual(candidate.nodes.slice(0, 2).map((node) => [node.id, node.label, node.kind, node.parentId, node.level, node.firstBlock, node.lastBlock]), [
			["n0", "Part One", "part", undefined, 1, 0, 12],
			["n1", "§1", "paragraph", "n0", 2, 1, 1],
		]);
		assert.equal(candidate.nodes.length, 13);
	});

	const GUESS = "# Preface\n\nOpening words.\n\n# Chapter 1 Being\n\nBeing is.\n\n# Chapter 2 Nothing\n\nNothing is.\n";

	it("turns the model's headings into a reviewable candidate, sending bad ids and levels back first", async () => {
		const { engine, requests } = scripted([
			submit("submit_structure", { headings: [{ block: 99, level: 1, label: "X" }, { block: 2, level: 3, label: "Chapter 1" }, { block: 0, level: 1, label: "Preface" }] }),
			submit("submit_structure", { headings: [{ block: 2, level: 1, label: "Chapter 1" }, { block: 4, level: 1, label: "Chapter 2" }, { block: 5, level: 2, label: "2.1", title: "Nothing at all" }] }),
		]);
		useEngine(engine);
		const record = await upload("guess.md", GUESS);
		assert.equal(record.import.status, "review");

		const estimate = await (await structureRoute.GET(new Request("http://x"), params(record.id))).json() as { tokens: number; lines: number; model: unknown };
		assert.equal(estimate.lines, 6);
		assert.deepEqual(estimate.model, { provider: "test", id: "cheap" });

		const started = await structureRoute.POST(post(), params(record.id));
		assert.equal(started.status, 200);
		assert.equal((await structureRoute.POST(post(), params(record.id))).status, 409, "one pass at a time");
		const done = await settledWriter(record.id, "contents");

		assert.equal(systemText(requests[0]!), BOOK_STRUCTURE_PROMPT);
		assert.equal(userText(requests[0]!), "Book: guess\n\nThe text has 6 blocks. These are its candidate heading lines, in book order, each as [block id] (page, larger type) text.\n\n[0] (larger type) Preface\n[1] Opening words.\n[2] (larger type) Chapter 1 Being\n[3] Being is.\n[4] (larger type) Chapter 2 Nothing\n[5] Nothing is.");
		const problems = toolResults(requests[1]!);
		for (const problem of ["- Block 99 isn't one of the lines given.", "- The first heading (block 2) must be level 1.", "- The headings must be in book order: block 0 comes after block 2."]) {
			assert.ok(problems.includes(problem), `${problem} in:\n${problems}`);
		}

		assert.equal(done.structureWriter?.status, "ready");
		assert.ok(done.structureWriter?.usage);
		assert.deepEqual([done.structure, done.import.status, done.mapWriter.status], ["headings", "review", "waiting"], "nothing is accepted by the pass itself");
		const contents = await (await contentsRoute.GET(new Request("http://x"), params(record.id))).json() as { candidates: { method: string; description: string; confidence: unknown; nodes: BookNode[] }[] };
		const model = contents.candidates.find((candidate) => candidate.method === "model")!;
		assert.equal(model.description, "3 entries");
		assert.deepEqual(model.confidence, { level: "unsure", reasons: ["The model chose these contents from the text's likely heading lines."] });
		assert.deepEqual(model.nodes.map((node) => [node.id, node.label, node.title, node.kind, node.parentId, node.firstBlock, node.lastBlock]), [
			["n0", "Chapter 1", "Chapter 1 Being", "chapter", undefined, 2, 3],
			["n1", "Chapter 2", "Chapter 2 Nothing", "chapter", undefined, 4, 5],
			["n2", "2.1", "Nothing at all", "section", "n1", 5, 5],
		]);

		const accepted = await contentsRoute.PUT(put({ method: "model" }), params(record.id));
		const { book } = await accepted.json() as { book: BookRecord };
		assert.deepEqual([book.structure, book.contentsAccepted, book.mapWriter.status], ["model", "learner", "not-needed"]);
	});

	it("fails plainly when the model finds no headings, and refuses a book with no heading lines", async () => {
		const { engine } = scripted([submit("submit_structure", { headings: [] })]);
		useEngine(engine);
		const record = await upload("guess.md", GUESS);
		assert.equal((await structureRoute.POST(post(), params(record.id))).status, 200);
		assert.deepEqual((await settledWriter(record.id, "contents")).structureWriter?.error, "The model found no headings in this book.");

		const prose = await upload("prose.txt", `${words(40)}.\n\n${words(40)}.`);
		const refused = await structureRoute.POST(post(), params(prose.id));
		assert.equal(refused.status, 409);
		assert.deepEqual(await refused.json(), { error: "This book has no lines that look like headings." });
	});

	it("shows in Background agents with Stop", async () => {
		const { engine } = scripted([untilStopped]);
		useEngine(engine);
		const record = await upload("guess.md", GUESS);
		assert.equal((await structureRoute.POST(post(), params(record.id))).status, 200);
		assert.deepEqual(activityFeed().bookWriters.map((row) => [row.id, row.title, row.activity]), [[`${record.id}:contents`, "Book contents · guess", "Finding the contents"]]);
		assert.equal((await abortRoute.POST(post({ kind: "book-contents-writer", id: `${record.id}:contents` }))).status, 200);
		const stopped = await settledWriter(record.id, "contents");
		assert.deepEqual(stopped.structureWriter, { status: "failed", error: "Stopped", stopped: true });
		assert.equal((await abortRoute.POST(post({ kind: "book-contents-writer", id: `${record.id}:contents` }))).status, 409, "nothing left to stop");
	});
});
