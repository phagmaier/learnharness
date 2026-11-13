/**
 * Plan 03 item 3: note storage, the note writer, its lifecycle, the engine
 * it runs on, the notes routes, and the activity row. Fakes only: pi-ai's
 * faux provider scripts submit_note calls, and the headlessOverride fake
 * renders Mermaid. Runs under an isolated LH_DATA_DIR (set before any
 * config-loading import; every app-module import is dynamic).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import { after, afterEach, before, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FauxResponseStep,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notes-"));
process.env.LH_DATA_DIR = TMP;

const notes = await import("../src/server/notes.ts");
const noteStore = await import("../src/store/notes.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { headlessOverride } = await import("../src/agent/subagents/headless.ts");
const { subscribe } = await import("../src/core/events.ts");
const { buildSubagentSteer } = await import("../src/core/contracts/jobs.ts");
const { activityFeed } = await import("../src/server/observability.ts");
const { CURRENT_NOTES_VERSION } = await import("../src/core/contracts/notes.ts");
type PiEngine = import("../src/agent/models.ts").PiEngine;
type NoteEntry = import("../src/core/contracts/notes.ts").NoteEntry;

const ASSETS_FREE_NOTE = "<h2>Eigenvectors</h2><p>An eigenvector keeps its direction: \\(Av = \\lambda v\\).</p>";
const FIGURE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10"/></svg>';

const defaultSeams = { ...notes.noteServiceSeams };

before(() => {
	settingsStore.writeSettings({ version: 1, models: { strong: { model: { provider: "test", id: "strong-model" } }, cheap: { model: { provider: "test", id: "cheap" } }, vision: { model: { provider: "test", id: "vision" } } } });
	headlessOverride.current = {
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => { throw new Error("unexpected demo run"); },
		renderSvg: async () => { throw new Error("unexpected svg render"); },
		renderPdfPages: async () => { throw new Error("unexpected pdf render"); },
		renderMermaid: async (sources) => ({
			status: "rendered",
			diagrams: sources.map((source) => source.includes("BROKEN")
				? { ok: false as const, error: "Parse error on line 2" }
				: { ok: true as const, svg: "<svg data-mermaid-fake></svg>" }),
		}),
	};
});

afterEach(() => {
	Object.assign(notes.noteServiceSeams, defaultSeams);
});

after(() => {
	headlessOverride.current = undefined;
	fs.rmSync(TMP, { recursive: true, force: true });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function scripted(steps: FauxResponseStep[]) {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	const requests: TranscriptContext[] = [];
	const engine: PiEngine = {
		model: faux.getModel(),
		level: "off",
		streamFn: (model, context, options) => {
			requests.push(structuredClone(context));
			return faux.streamSimple(model, context, options);
		},
	} as PiEngine;
	return { engine, requests };
}

let calls = 0;
const submit = (title: string, body: string) =>
	fauxAssistantMessage([fauxToolCall("submit_note", { title, body }, { id: `s${++calls}` })], { stopReason: "toolUse" });

function useEngine(engine: PiEngine) {
	notes.noteServiceSeams.buildEngine = () => engine;
}

function makeChat(title = "Eigenvectors"): string {
	const chat = chatStore.createChat(title);
	chatStore.saveMessages(chat.id, [
		{ id: "u1", role: "user", content: "What is an eigenvector?", timestamp: 1 },
		{
			id: "a1", role: "assistant",
			content: [{ type: "text", text: "A vector $v$ with $Av = \\lambda v$." }, { type: "toolCall", id: "c_vis", name: "visual", arguments: { brief: "Two vectors under A" } }],
			api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "toolUse", timestamp: 2,
		},
		{ id: "r1", role: "toolResult", toolCallId: "c_vis", toolName: "visual", content: [{ type: "text", text: "Dispatched" }], details: { jobId: "j1" }, isError: false, timestamp: 3 },
		buildSubagentSteer({ id: "j1", kind: "visual", toolCallId: "c_vis" }, { svg: FIGURE_SVG }),
	] as never);
	return chat.id;
}

/** Wait until the note has no writer running in this process. */
async function settled(chatId: string, noteId: string): Promise<NoteEntry> {
	for (let i = 0; i < 400; i++) {
		const running = notes.noteWriterActivities().some((row) => row.noteId === noteId);
		if (!running) return notes.getNote(chatId, noteId)!;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("note writer never settled");
}

function toolResultTexts(context: TranscriptContext): string[] {
	return context.messages.flatMap((message) => message.role === "toolResult"
		? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
		: []);
}

// ─── the store ──────────────────────────────────────────────────────────────

describe("note store", () => {
	const entry = (id: string): NoteEntry => ({ id, title: id, instruction: "", interactive: false, status: "ready", createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z" });

	it("creates, lists, updates and deletes notes with their files", () => {
		const dir = path.join(TMP, "store-basic");
		const store = noteStore.noteStoreAt(dir);
		assert.deepEqual(store.list(), []);
		store.add(entry("n1"));
		store.add(entry("n2"));
		store.writeHtml("n1", "<p>one</p>");
		assert.deepEqual(store.list().map((n) => n.id), ["n1", "n2"]);
		assert.equal(store.update("n2", (n) => ({ ...n, title: "Two" }))?.title, "Two");
		assert.equal(store.update("missing", (n) => n), undefined);
		assert.equal(store.readHtml("n1"), "<p>one</p>");
		assert.equal(store.remove("n1"), true);
		assert.equal(store.readHtml("n1"), null);
		assert.equal(fs.existsSync(path.join(dir, "n1.html")), false);
		assert.deepEqual(store.list().map((n) => n.id), ["n2"]);
		const saved = JSON.parse(fs.readFileSync(path.join(dir, "notes.json"), "utf8"));
		assert.equal(saved.version, CURRENT_NOTES_VERSION);
	});

	it("reads an unstamped index as version 1 and refuses a newer one", () => {
		const dir = path.join(TMP, "store-version");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "notes.json"), JSON.stringify({ notes: [entry("old")] }));
		const store = noteStore.noteStoreAt(dir);
		assert.deepEqual(store.list().map((n) => n.id), ["old"]);
		fs.writeFileSync(path.join(dir, "notes.json"), JSON.stringify({ version: CURRENT_NOTES_VERSION + 1, notes: [] }));
		assert.throws(() => store.list(), noteStore.NotesUnreadableError);
		assert.throws(() => store.add(entry("new")), noteStore.NotesUnreadableError);
		assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "notes.json"), "utf8")).version, CURRENT_NOTES_VERSION + 1, "a newer index is never rewritten");
	});

	it("refuses unsafe chat and note ids", () => {
		assert.throws(() => noteStore.sessionNoteStore("../chats"), /Invalid chat id/);
		const store = noteStore.noteStoreAt(path.join(TMP, "store-ids"));
		assert.throws(() => store.writeHtml("../escape", "x"), /Invalid note id/);
		assert.throws(() => store.add(entry("a/b")), /Invalid note id/);
		assert.equal(store.readHtml("../../etc/passwd"), null);
		assert.equal(fs.existsSync(path.join(TMP, "escape.html")), false);
	});

	it("turns a note left writing by a closed app into an interrupted failure, and keeps an interrupted rewrite's old version", () => {
		const chatId = makeChat("Interrupted");
		const store = noteStore.sessionNoteStore(chatId);
		store.add({ ...entry("w1"), status: "writing", title: "" });
		store.add({ ...entry("r1"), regenerating: { instruction: "shorter", interactive: false, startedAt: "2026-11-13T01:00:00.000Z" } });
		store.writeHtml("r1", "<p>old version</p>");
		const listed = notes.listNotes(chatId);
		assert.equal(listed.find((n) => n.id === "w1")?.status, "failed");
		assert.equal(listed.find((n) => n.id === "w1")?.error, "Interrupted when the app closed");
		const rewrite = listed.find((n) => n.id === "r1")!;
		assert.equal(rewrite.status, "ready");
		assert.equal(rewrite.regenerating?.error, "Interrupted when the app closed");
		assert.equal(store.readHtml("r1"), "<p>old version</p>");
	});
});

// ─── the writer and its lifecycle ───────────────────────────────────────────

describe("note writer", () => {
	it("writes the stored file from one submit, with title, model and usage", async () => {
		const chatId = makeChat();
		const { engine, requests } = scripted([submit("Eigenvectors, briefly", `${ASSETS_FREE_NOTE}<figure data-figure="F1"><figcaption>Two vectors</figcaption></figure><pre class="mermaid">graph LR\n A-->B</pre>`)]);
		useEngine(engine);
		const created = notes.createNote(chatId, { instruction: "  I struggle with lambda  ", interactive: false });
		assert.ok(created.ok);
		assert.equal(created.note.status, "writing");
		const note = await settled(chatId, created.note.id);
		assert.equal(note.status, "ready");
		assert.equal(note.title, "Eigenvectors, briefly");
		assert.equal(note.instruction, "I struggle with lambda");
		assert.match(note.model ?? "", /:/);
		assert.equal(note.usage?.steps, 1);

		const user = JSON.stringify(requests[0]);
		assert.ok(user.includes("You write study notes for a learner"), "the note writer's system prompt");
		assert.ok(user.includes("[Figure F1]"), "the session text marks the figure");
		assert.ok(user.includes("F1 (figure): Two vectors under A"));
		assert.ok(user.includes("Learner's instruction: I struggle with lambda"));

		const html = notes.readNoteHtml(chatId, note.id)!;
		const { document } = parseHTML(html);
		assert.equal(document.querySelector(".lh-doc-title")?.textContent, "Eigenvectors, briefly");
		assert.match(document.querySelector(".lh-doc-subtitle")?.textContent ?? "", /^Notes from Eigenvectors · .+ · “I struggle with lambda”$/);
		assert.ok(document.querySelector(".lh-doc-body .katex"));
		assert.ok(document.querySelector('figure[data-figure="F1"] > img')?.getAttribute("src")?.startsWith("data:image/svg+xml;base64,"));
		assert.ok(document.querySelector(".lh-diagram svg[data-mermaid-fake]"));
		assert.equal(document.querySelector("script"), null);
	});

	const RULES: Array<{ rule: string; body: string; problem: RegExp; interactive?: boolean }> = [
		{ rule: "page elements", body: "<html><body><p>x</p></body></html>", problem: /<html> isn't allowed/ },
		{ rule: "embedding elements", body: '<p>x</p><iframe src="data:,"></iframe>', problem: /<iframe> isn't allowed/ },
		{ rule: "external images", body: '<p>x</p><img src="https://example.com/a.png">', problem: /External resource "https:\/\/example.com\/a.png"/ },
		{ rule: "external CSS", body: '<p style="background:url(//cdn.example/x.png)">x</p>', problem: /style attribute loads something from outside/ },
		{ rule: "scripts in a plain note", body: "<p>x</p><script>1</script>", problem: /<script> is only allowed in an interactive note/ },
		{ rule: "style elements in a plain note", body: "<style>p{}</style><p>x</p>", problem: /<style> is only allowed in an interactive note/ },
		{ rule: "event handlers in a plain note", body: '<p onclick="x()">x</p>', problem: /onclick are only allowed in an interactive note/ },
		{ rule: "javascript: URLs in a plain note", body: '<a href="javascript:alert(1)">x</a>', problem: /javascript: URLs are only allowed/ },
		{ rule: "external scripts even when interactive", body: '<script src="https://cdn.example/lib.js"></script><p>x</p>', problem: /External resource/, interactive: true },
		{ rule: "unknown figures", body: '<figure data-figure="F9"></figure><p>x</p>', problem: /data-figure="F9" names no figure.*Listed figures: F1/ },
		{ rule: "an empty body", body: "  ", problem: /The body is empty/ },
		{ rule: "a formula that doesn't render", body: "<p>\\(\\nosuch\\)</p>", problem: /The formula \\\(\\nosuch\\\) doesn't render: .*Undefined control sequence/ },
		{ rule: "a diagram that doesn't render", body: '<p>x</p><pre class="mermaid">graph LR\nBROKEN --></pre>', problem: /A Mermaid diagram doesn't render: Parse error on line 2/ },
	];
	for (const { rule, body, problem, interactive } of RULES) {
		it(`sends ${rule} back to the model, which fixes it`, async () => {
			const chatId = makeChat();
			const { engine, requests } = scripted([submit("First try", body), submit("Fixed", ASSETS_FREE_NOTE)]);
			useEngine(engine);
			const created = notes.createNote(chatId, { interactive: interactive === true });
			assert.ok(created.ok);
			const note = await settled(chatId, created.note.id);
			assert.equal(note.status, "ready", note.error);
			assert.equal(note.title, "Fixed");
			assert.equal(requests.length, 2);
			const feedback = toolResultTexts(requests[1]!).join("\n");
			assert.match(feedback, problem);
			assert.match(feedback, /Fix these problems and call submit_note again/);
		});
	}

	it("keeps a note whose formulas still fail after three fixes, showing each source in a box", async () => {
		const chatId = makeChat();
		const broken = "<p>Still \\(\\nosuch\\) here.</p>";
		const { engine, requests } = scripted([submit("A", broken), submit("B", broken), submit("C", broken), submit("D", broken)]);
		useEngine(engine);
		const created = notes.createNote(chatId, {});
		assert.ok(created.ok);
		const note = await settled(chatId, created.note.id);
		assert.equal(note.status, "ready");
		assert.equal(note.title, "D");
		assert.equal(requests.length, 4);
		const { document } = parseHTML(notes.readNoteHtml(chatId, note.id)!);
		assert.equal(document.querySelector(".lh-failed-inline")?.textContent, "\\(\\nosuch\\)");
	});

	it("fails a note whose structural problems outlast the fix attempts", async () => {
		const chatId = makeChat();
		const bad = "<p>x</p><script>1</script>";
		const { engine } = scripted([submit("A", bad), submit("B", bad), submit("C", bad), submit("D", bad)]);
		useEngine(engine);
		const created = notes.createNote(chatId, {});
		assert.ok(created.ok);
		const note = await settled(chatId, created.note.id);
		assert.equal(note.status, "failed");
		assert.match(note.error ?? "", /stopped without producing a note/);
		assert.equal(notes.readNoteHtml(chatId, note.id), null);
	});

	it("keeps scripts in an interactive note, which runs them offline", async () => {
		const chatId = makeChat();
		const { engine } = scripted([submit("Slider", '<style>.s{}</style><input class="s" type="range" oninput="draw()"><script>function draw(){}</script>')]);
		useEngine(engine);
		const created = notes.createNote(chatId, { interactive: true });
		assert.ok(created.ok);
		const note = await settled(chatId, created.note.id);
		assert.equal(note.status, "ready", note.error);
		assert.equal(note.interactive, true);
		const html = notes.readNoteHtml(chatId, note.id)!;
		assert.ok(html.includes("<script>function draw(){}</script>"));
		assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'/);
	});

	it("stops a note while it is being written", async () => {
		const chatId = makeChat();
		const { engine } = scripted([
			(_context, options) => new Promise((_resolve, reject) => {
				options?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
			}),
		]);
		useEngine(engine);
		const created = notes.createNote(chatId, {});
		assert.ok(created.ok);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(notes.stopNote(chatId, created.note.id), true);
		const note = await settled(chatId, created.note.id);
		assert.equal(note.status, "failed");
		assert.equal(note.stopped, true);
		assert.equal(note.error, "Stopped");
		assert.equal(notes.stopNote(chatId, created.note.id), false, "nothing left to stop");
	});

	it("rewrites a note only after the new version succeeds, and keeps the old file byte for byte on failure", async () => {
		const chatId = makeChat();
		const first = scripted([submit("Version one", ASSETS_FREE_NOTE)]);
		useEngine(first.engine);
		const created = notes.createNote(chatId, {});
		assert.ok(created.ok);
		await settled(chatId, created.note.id);
		const original = fs.readFileSync(path.join(TMP, "notes", chatId, `${created.note.id}.html`));

		// A rewrite that fails: the old file and title stay; the error shows.
		const failing = scripted([fauxAssistantMessage([fauxText("I won't submit.")]), fauxAssistantMessage([fauxText("Still no.")]), fauxAssistantMessage([fauxText("No.")]), fauxAssistantMessage([fauxText("No.")])]);
		useEngine(failing.engine);
		const rewrite = notes.regenerateNote(chatId, created.note.id, { instruction: "shorter", interactive: false });
		assert.ok(rewrite.ok);
		assert.equal(rewrite.note.status, "ready");
		assert.equal(rewrite.note.regenerating?.instruction, "shorter");
		const failed = await settled(chatId, created.note.id);
		assert.equal(failed.title, "Version one");
		assert.equal(failed.instruction, "");
		assert.match(failed.regenerating?.error ?? "", /stopped without producing a note/);
		assert.deepEqual(fs.readFileSync(path.join(TMP, "notes", chatId, `${created.note.id}.html`)), original);

		// A rewrite that succeeds replaces both and clears the rewrite state.
		const second = scripted([submit("Version two", "<p>Shorter.</p>")]);
		useEngine(second.engine);
		assert.ok(notes.regenerateNote(chatId, created.note.id, { instruction: "shorter", interactive: false }).ok);
		const done = await settled(chatId, created.note.id);
		assert.equal(done.title, "Version two");
		assert.equal(done.instruction, "shorter");
		assert.equal(done.regenerating, undefined);
		assert.ok(notes.readNoteHtml(chatId, done.id)!.includes("Shorter."));
	});

	it("refuses to rewrite a note while it is being written", async () => {
		const chatId = makeChat();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const { engine } = scripted([async () => { await gate; return submit("Late", ASSETS_FREE_NOTE); }]);
		useEngine(engine);
		const created = notes.createNote(chatId, {});
		assert.ok(created.ok);
		const refused = notes.regenerateNote(chatId, created.note.id, {});
		assert.equal(refused.ok, false);
		assert.equal(!refused.ok && refused.status, 409);
		release();
		assert.equal((await settled(chatId, created.note.id)).status, "ready");
	});

	it("refuses a session too long for the model's context window, naming the model", async () => {
		const chatId = makeChat();
		const { engine } = scripted([submit("Never", ASSETS_FREE_NOTE)]);
		useEngine({ ...engine, model: { ...engine.model, name: "Tiny Model", contextWindow: 1000, maxTokens: 500 } } as PiEngine);
		const created = notes.createNote(chatId, {});
		assert.ok(created.ok);
		const note = await settled(chatId, created.note.id);
		assert.equal(note.status, "failed");
		assert.match(note.error ?? "", /too long for Tiny Model .* larger context window/);
	});

	it("refuses Practice sessions and sessions without a Strong model", () => {
		const practice = chatStore.createChat("Drills", "practice");
		const refused = notes.createNote(practice.id, {});
		assert.equal(!refused.ok && refused.status, 400);
		notes.noteServiceSeams.buildEngine = defaultSeams.buildEngine;
		const saved = settingsStore.readSettings();
		settingsStore.writeSettings({ version: 1 });
		try {
			const none = notes.createNote(makeChat(), {});
			assert.equal(!none.ok && none.status, 503);
			assert.equal(!none.ok && none.code, "models_not_configured");
		} finally {
			settingsStore.writeSettings(saved ?? { version: 1 });
		}
	});
});

// ─── the engine ─────────────────────────────────────────────────────────────

describe("note writer engine", () => {
	it("resolves from the Strong slot through the noteWriter role, with purpose user, and is admitted through the worker pool", async () => {
		const built: unknown[][] = [];
		const { engine } = scripted([]);
		let activeDuringRequest = -1;
		const pool = () => (globalThis as Record<symbol, { active: number } | undefined>)[Symbol.for("lh.worker-request-admission.pool.v1")];
		const observed: PiEngine = {
			...engine,
			streamFn: (model, context, options) => {
				activeDuringRequest = pool()?.active ?? -1;
				return createFauxResponse(model, context, options);
			},
		};
		const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
		faux.setResponses([submit("Pooled", ASSETS_FREE_NOTE)]);
		const createFauxResponse = faux.streamSimple.bind(faux);
		notes.noteServiceSeams.buildEngine = (...args) => { built.push(args); return { ...observed, model: faux.getModel() }; };
		const chatId = makeChat();
		const created = notes.createNote(chatId, {});
		assert.ok(created.ok);
		assert.equal((await settled(chatId, created.note.id)).status, "ready");
		assert.equal(built.length, 1);
		const [spec, background] = built[0]!;
		assert.deepEqual({ provider: (spec as { provider: string }).provider, id: (spec as { id: string }).id }, { provider: "test", id: "strong-model" });
		assert.equal(background, false, "the learner asked for the note: purpose user, not background");
		assert.ok(activeDuringRequest >= 1, "the request held a worker-pool permit");
	});
});

// ─── routes ─────────────────────────────────────────────────────────────────

describe("notes routes", () => {
	const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

	/** Read a zip back: local headers, deflated entries. */
	function unzip(buffer: Buffer): Map<string, string> {
		const out = new Map<string, string>();
		let offset = 0;
		while (buffer.readUInt32LE(offset) === 0x04034b50) {
			const method = buffer.readUInt16LE(offset + 8);
			const size = buffer.readUInt32LE(offset + 18);
			const nameLength = buffer.readUInt16LE(offset + 26);
			const extra = buffer.readUInt16LE(offset + 28);
			const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
			const start = offset + 30 + nameLength + extra;
			const data = buffer.subarray(start, start + size);
			out.set(name, (method === 8 ? inflateRawSync(data) : data).toString("utf8"));
			offset = start + size;
		}
		return out;
	}

	it("list, create, view, download, regenerate, stop, archive and delete", async () => {
		const list = (await import("../app/api/chats/[id]/notes/route.ts"));
		const one = (await import("../app/api/chats/[id]/notes/[noteId]/route.ts"));
		const regenerate = (await import("../app/api/chats/[id]/notes/[noteId]/regenerate/route.ts"));
		const stop = (await import("../app/api/chats/[id]/notes/[noteId]/stop/route.ts"));
		const archive = (await import("../app/api/chats/[id]/notes/archive.zip/route.ts"));
		const chatId = makeChat("Linear maps: notes");
		useEngine(scripted([submit("Eigen basics", ASSETS_FREE_NOTE), submit("Eigen basics", "<p>Second note.</p>")]).engine);

		assert.equal((await list.GET(new Request("http://x"), ctx({ id: "chat_missing" }))).status, 404);
		const created = await list.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ instruction: "", interactive: false }) }), ctx({ id: chatId }));
		assert.equal(created.status, 202);
		const { note } = await created.json() as { note: NoteEntry };
		await settled(chatId, note.id);
		const second = await (await list.POST(new Request("http://x", { method: "POST", body: "{}" }), ctx({ id: chatId }))).json() as { note: NoteEntry };
		await settled(chatId, second.note.id);
		assert.equal((await list.POST(new Request("http://x", { method: "POST", body: "nope" }), ctx({ id: chatId }))).status, 400);

		const listed = await (await list.GET(new Request("http://x"), ctx({ id: chatId }))).json() as { notes: NoteEntry[] };
		assert.deepEqual(listed.notes.map((n) => n.status), ["ready", "ready"]);

		const view = await one.GET(new Request("http://x"), ctx({ id: chatId, noteId: note.id }));
		assert.equal(view.status, 200);
		assert.equal(view.headers.get("content-security-policy"), "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox");
		assert.equal(view.headers.get("content-disposition"), null);
		assert.ok((await view.text()).includes("Eigen basics"));
		const download = await one.GET(new Request("http://x?download=1"), ctx({ id: chatId, noteId: note.id }));
		assert.equal(download.headers.get("content-disposition"), 'attachment; filename="eigen-basics.html"');
		assert.equal(download.headers.get("content-security-policy"), "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox");
		assert.equal((await one.GET(new Request("http://x"), ctx({ id: chatId, noteId: "note_missing" }))).status, 404);

		const zip = await archive.GET(new Request("http://x"), ctx({ id: chatId }));
		assert.equal(zip.headers.get("content-type"), "application/zip");
		assert.equal(zip.headers.get("content-disposition"), 'attachment; filename="linear-maps-notes-notes.zip"');
		const files = unzip(Buffer.from(await zip.arrayBuffer()));
		assert.deepEqual([...files.keys()], ["eigen-basics.html", "eigen-basics-2.html"]);
		assert.equal(files.get("eigen-basics.html"), notes.readNoteHtml(chatId, note.id));

		assert.equal((await stop.POST(new Request("http://x", { method: "POST" }), ctx({ id: chatId, noteId: note.id }))).status, 409);
		useEngine(scripted([submit("Rewritten", "<p>New.</p>")]).engine);
		const rewritten = await regenerate.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ instruction: "short", interactive: false }) }), ctx({ id: chatId, noteId: note.id }));
		assert.equal(rewritten.status, 202);
		assert.equal((await settled(chatId, note.id)).title, "Rewritten");

		assert.equal((await one.DELETE(new Request("http://x", { method: "DELETE" }), ctx({ id: chatId, noteId: note.id }))).status, 200);
		assert.equal((await one.DELETE(new Request("http://x", { method: "DELETE" }), ctx({ id: chatId, noteId: note.id }))).status, 404);
		const after = await (await list.GET(new Request("http://x"), ctx({ id: chatId }))).json() as { notes: NoteEntry[] };
		assert.deepEqual(after.notes.map((n) => n.id), [second.note.id]);

		const practice = chatStore.createChat("Drills", "practice");
		assert.equal((await list.GET(new Request("http://x"), ctx({ id: practice.id }))).status, 400);
	});
});

// ─── activity and events ────────────────────────────────────────────────────

describe("note writer activity", () => {
	it("shows a running writer as \"Note · <session title>\" with its cost, stops it from the dock, and announces changes", async () => {
		const chatId = makeChat("Spectral theorem");
		const events: Array<{ type: string; chatId?: string }> = [];
		const unsubscribe = subscribe((event) => events.push(event as { type: string; chatId?: string }));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const { engine } = scripted([
			submit("Wrong", "<p>x</p><script>1</script>"),
			async (_context, options) => {
				await Promise.race([gate, new Promise((resolve) => options?.signal?.addEventListener("abort", resolve, { once: true }))]);
				throw Object.assign(new Error("aborted"), { name: "AbortError" });
			},
		]);
		useEngine(engine);
		try {
			const created = notes.createNote(chatId, {});
			assert.ok(created.ok);
			let row: ReturnType<typeof activityFeed>["noteWriters"][number] | undefined;
			for (let i = 0; i < 200 && !row?.usage; i++) {
				row = activityFeed().noteWriters.find((r) => r.noteId === created.note.id);
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			assert.equal(row?.title, "Note · Spectral theorem");
			assert.equal(row?.chatId, chatId);
			assert.equal(row?.activity, "Writing");
			assert.equal(row?.usage?.steps, 1, "live usage after the first model call");
			assert.ok("costUsd" in row!);

			const abort = (await import("../app/api/activity/abort/route.ts")).POST;
			const res = await abort(new Request("http://x", { method: "POST", body: JSON.stringify({ kind: "note-writer", id: row!.id }) }));
			assert.equal(res.status, 200);
			const note = await settled(chatId, created.note.id);
			assert.equal(note.stopped, true);
			assert.equal(activityFeed().noteWriters.some((r) => r.noteId === created.note.id), false);
			assert.ok(events.some((e) => e.type === "notes-changed" && e.chatId === chatId));
			assert.ok(events.some((e) => e.type === "activity-changed"));
		} finally {
			release();
			unsubscribe();
		}
	});
});
