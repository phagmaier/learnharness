/**
 * Plan 04 item 8: unit notes, the course Notes tab, and "Practice this
 * unit". The resolver keeps a unit session's notes under its course and
 * every other session's where phase 0 put them (a crash's duplicate unit
 * session included); setup sessions stay refused; the course archive has a
 * folder per unit, read back with a minimal zip reader; the Notes tab
 * groups notes under unit headings and its picker defaults to the selected
 * unit; the practice context is checked against hand-written text, with
 * and without propositions and with the graph off; and a session started
 * through the route links to its unit and produces practice evidence.
 * Fakes only (pi-ai's faux provider writes notes); an isolated LH_DATA_DIR
 * is set before any config-loading import.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import { after, afterEach, before, describe, it, mock } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-notes-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

const { chatStore } = await import("../src/store/chats.ts");
const { courseStore } = await import("../src/store/courses.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const notes = await import("../src/server/notes.ts");
const courses = await import("../src/server/courses.ts");
const { deleteChatSession } = await import("../src/server/chats.ts");
const core = await import("../src/core/index.ts");
const chatNotesRoute = await import("../app/api/chats/[id]/notes/route.ts");
const chatArchiveRoute = await import("../app/api/chats/[id]/notes/archive.zip/route.ts");
const courseNotesRoute = await import("../app/api/courses/[id]/notes/route.ts");
const courseArchiveRoute = await import("../app/api/courses/[id]/notes/archive.zip/route.ts");
const chatsRoute = await import("../app/api/chats/route.ts");
const sessionNotesPage = (await import("../app/chat/[id]/notes/page.tsx")).default;
const newSessionPage = (await import("../app/chat/new/page.tsx")).default;
const { CourseNotesPage } = await import("../components/course-notes.tsx");
const { NotesChip } = await import("../components/notes-chip.tsx");
const { DraftShell, startDraftSession } = await import("../components/new-session.tsx");
const { GraphContextCard } = await import("../components/graph-context-card.tsx");
const { courseMemberIds } = await import("../components/session-list.ts");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { renderToStaticMarkup } = await import("react-dom/server");
const { installModalDom } = await import("./modal-dom.ts");
type PiEngine = import("../src/agent/models.ts").PiEngine;
type CourseRecord = import("../src/core/contracts/course.ts").CourseRecord;
type UnitHandoff = import("../src/core/contracts/course.ts").UnitHandoff;
type NoteEntry = import("../src/core/contracts/notes.ts").NoteEntry;
type LhMessage = import("../src/core/native-messages.ts").LhMessage;

const SETTINGS = { version: 1, models: { strong: { model: { provider: "test", id: "strong-model" } }, cheap: { model: { provider: "test", id: "cheap" } }, vision: { model: { provider: "test", id: "vision" } } } } as const;
const noteSeams = { ...notes.noteServiceSeams };

before(() => settingsStore.writeSettings(structuredClone(SETTINGS) as never));
afterEach(() => {
	Object.assign(notes.noteServiceSeams, noteSeams);
	settingsStore.writeSettings(structuredClone(SETTINGS) as never);
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ─── helpers ────────────────────────────────────────────────────────────────

let submits = 0;
/** The note writer's engine, scripted to submit each title in turn. */
function writeNotesTitled(...titles: string[]): void {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(titles.map((title): FauxResponseStep =>
		fauxAssistantMessage([fauxToolCall("submit_note", { title, body: `<p>${title}</p>` }, { id: `s${++submits}` })], { stopReason: "toolUse" })));
	const engine = { model: faux.getModel(), level: "off", streamFn: (model, context, options) => faux.streamSimple(model, context, options) } as PiEngine;
	notes.noteServiceSeams.buildEngine = () => engine;
}

async function settled(chatId: string, noteId: string): Promise<NoteEntry> {
	for (let i = 0; i < 400; i++) {
		if (!notes.noteWriterActivities().some((row) => row.noteId === noteId)) return notes.getNote(chatId, noteId)!;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("note writer never settled");
}

async function writeNote(chatId: string, title: string): Promise<NoteEntry> {
	writeNotesTitled(title);
	const created = notes.createNote(chatId, {});
	assert.ok(created.ok, JSON.stringify(created));
	const note = await settled(chatId, created.note.id);
	assert.equal(note.status, "ready");
	return note;
}

const lesson = (): LhMessage[] => [{ id: "u1", role: "user", content: "Teach me.", timestamp: 1 } as never];

const HANDOFF: UnitHandoff = {
	writtenAt: "2026-11-20T10:00:00.000Z",
	completion: "confirmed",
	topics: [
		{ nodeId: "matrix", title: "Matrix of a linear map", status: "solid", reason: "last check right at 90% confidence" },
		{ nodeId: "kernel", title: "Kernel and image", status: "shaky", reason: "last check wrong" },
		{ nodeId: "basis", title: "Change of basis", status: "unchecked", reason: "free-recall answers only" },
		{ nodeId: "similar", title: "Similar matrices", status: "not-reached", reason: "not reached" },
	],
	observations: {
		judged: [{ nodeId: "basis", status: "shaky", reason: "mixed up the two bases" }],
		alsoShaky: ["column space versus row space"],
		misconceptionsRepaired: ["every map is invertible"],
		carriedForward: ["more 3×3 practice"],
	},
	writer: { status: "ready" },
};

let counter = 0;
/** A course with a setup session, two units with sessions (unit 1
 *  completed with a handoff, unit 2 in progress), and unit 3 not started. */
function seededCourse(): { course: CourseRecord; setupId: string; unit1: string; unit2: string } {
	const courseId = `course_notes_${++counter}`;
	const setup = chatStore.createChat("Setup", undefined, { role: "setup", courseId });
	const one = chatStore.createChat("Linear algebra · 1. Vectors and span", undefined, { role: "unit", courseId, unitId: "vectors" });
	const two = chatStore.createChat("Linear algebra · 2. Linear maps", undefined, { role: "unit", courseId, unitId: "maps" });
	for (const chat of [one, two]) chatStore.saveMessages(chat.id, lesson());
	const course: CourseRecord = {
		id: courseId, title: "Linear algebra", goal: "Eigenvectors.", createdAt: "2026-11-20T09:00:00.000Z", updatedAt: "2026-11-20T09:00:00.000Z", setupChatId: setup.id,
		units: [
			{ id: "vectors", title: "Vectors and span", goal: "Span and independence.", prerequisites: [], status: "completed", chatId: one.id, completion: "confirmed", completedAt: HANDOFF.writtenAt, handoff: HANDOFF },
			{ id: "maps", title: "Linear maps", goal: "Maps as matrices.", prerequisites: ["vectors"], status: "in-progress", chatId: two.id },
			{ id: "eigen", title: "Eigenvectors", goal: "Diagonalize.", prerequisites: ["maps"], status: "not-started" },
		],
		proposals: [], evidence: [],
	};
	courseStore.create(course);
	return { course, setupId: setup.id, unit1: one.id, unit2: two.id };
}

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

const redirectsTo = (target: string) => (error: unknown) => {
	const digest = String((error as { digest?: string }).digest ?? "");
	return digest.startsWith("NEXT_REDIRECT") && digest.includes(target);
};

// ─── where notes live ───────────────────────────────────────────────────────

describe("the notes folder resolver", () => {
	it("puts a unit session's notes under its course and leaves standalone and duplicate sessions' notes where phase 0 put them", async () => {
		const { course, unit1 } = seededCourse();
		const standalone = chatStore.createChat("Eigenvalues");
		chatStore.saveMessages(standalone.id, lesson());
		// A crash's duplicate: it points at unit 1, but the course records another session.
		const duplicate = chatStore.createChat("Duplicate", undefined, { role: "unit", courseId: course.id, unitId: "vectors" });
		chatStore.saveMessages(duplicate.id, lesson());

		const unitNote = await writeNote(unit1, "Span");
		await writeNote(standalone.id, "Eigen basics");
		await writeNote(duplicate.id, "Stray");

		const unitDir = path.join(TMP, "courses", course.id, "notes", unit1);
		assert.ok(fs.existsSync(path.join(unitDir, "notes.json")));
		assert.equal(fs.existsSync(path.join(TMP, "notes", unit1)), false, "nothing under the standalone folder");
		assert.ok(fs.existsSync(path.join(TMP, "notes", standalone.id, "notes.json")));
		assert.ok(fs.existsSync(path.join(TMP, "notes", duplicate.id, "notes.json")));
		assert.equal(fs.existsSync(path.join(TMP, "courses", course.id, "notes", duplicate.id)), false);

		// The session routes read through the resolver.
		const listed = await (await chatNotesRoute.GET(new Request("http://x"), ctx({ id: unit1 }))).json() as { notes: NoteEntry[] };
		assert.deepEqual(listed.notes.map((note) => note.title), ["Span"]);
		assert.ok(notes.readNoteHtml(unit1, unitNote.id)?.includes("<p>Span</p>"));
	});

	it("preserves legacy notes when migration fails and moves them on retry without losing later notes", async () => {
		const { course, unit2 } = seededCourse();
		const legacy = path.join(TMP, "notes", unit2);
		const destination = path.join(TMP, "courses", course.id, "notes", unit2);
		fs.mkdirSync(legacy, { recursive: true });
		const entry: NoteEntry = { id: "note_old", title: "Old note", instruction: "", interactive: false, status: "ready", createdAt: "2026-11-15T10:00:00.000Z", updatedAt: "2026-11-15T10:00:00.000Z" };
		const index = JSON.stringify({ version: 2, notes: [entry] });
		fs.writeFileSync(path.join(legacy, "notes.json"), index);
		fs.writeFileSync(path.join(legacy, "note_old.html"), "<p>legacy</p>");

		const rename = fs.renameSync;
		const failure = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
			if (String(from) === legacy) throw Object.assign(new Error("EACCES: injected migration failure"), { code: "EACCES" });
			return rename(from, to);
		});
		// The resolver uses node:fs's ESM namespace; update that binding too.
		syncBuiltinESMExports();
		try {
			const listed = await chatNotesRoute.GET(new Request("http://x"), ctx({ id: unit2 }));
			assert.equal(listed.status, 409, "a failed move must not masquerade as an empty notes list");
			const { error } = await listed.json() as { error: string };
			assert.ok(error, "the refusal explains the failure");
			const sessionArchive = await chatArchiveRoute.GET(new Request("http://x"), ctx({ id: unit2 }));
			assert.equal(sessionArchive.status, 409, "the session archive must not omit legacy notes");
			const courseArchive = await courseArchiveRoute.GET(new Request("http://x"), ctx({ id: course.id }));
			assert.equal(courseArchive.status, 409, "the course archive must not omit legacy notes");
			assert.equal((await courseArchive.json() as { error: string }).error, `Unit 2 (Linear maps): ${error}`);

			writeNotesTitled("New note");
			const created = await chatNotesRoute.POST(new Request("http://x", { method: "POST", body: "{}" }), ctx({ id: unit2 }));
			assert.equal(created.status, 409, "a new note must not create a destination that strands older notes");
			assert.equal(notes.noteWriterActivities().some((row) => row.chatId === unit2), false);
			assert.equal(fs.existsSync(destination), false);
			assert.equal(fs.readFileSync(path.join(legacy, "notes.json"), "utf8"), index);
			assert.equal(fs.readFileSync(path.join(legacy, "note_old.html"), "utf8"), "<p>legacy</p>");
		} finally {
			failure.mock.restore();
			syncBuiltinESMExports();
		}

		assert.deepEqual(notes.listNotes(unit2).map((note) => note.id), ["note_old"]);
		assert.equal(fs.existsSync(legacy), false);
		assert.equal(notes.readNoteHtml(unit2, "note_old"), "<p>legacy</p>");
		const archive = await courseArchiveRoute.GET(new Request("http://x"), ctx({ id: course.id }));
		assert.equal(archive.status, 200);
		assert.deepEqual([...unzip(Buffer.from(await archive.arrayBuffer()))], [["2-linear-maps/old-note.html", "<p>legacy</p>"]]);
		const added = await writeNote(unit2, "New note");
		assert.deepEqual(notes.listNotes(unit2).map((note) => note.id), ["note_old", added.id]);
	});

	it("refuses setup sessions, and answers 409 while a unit's course can't be read", async () => {
		const { course, setupId, unit1 } = seededCourse();
		assert.deepEqual(notes.createNote(setupId, {}), { ok: false, status: 400, error: notes.SETUP_NO_NOTES });
		assert.equal((await chatNotesRoute.GET(new Request("http://x"), ctx({ id: setupId }))).status, 400);
		fs.writeFileSync(path.join(TMP, "courses", course.id, "course.json"), "{ damaged");
		const refused = await chatNotesRoute.GET(new Request("http://x"), ctx({ id: unit1 }));
		assert.equal(refused.status, 409);
		assert.match((await refused.json() as { error: string }).error, /^This session's course can't be read: /);
	});

	it("deleting a unit session removes its notes from the course and keeps the course's other files", async () => {
		const { course, unit1, unit2 } = seededCourse();
		await writeNote(unit1, "Span");
		await writeNote(unit2, "Maps");
		const outcome = await deleteChatSession(unit1, "preserve-graph");
		assert.equal(outcome.ok, true);
		const dir = path.join(TMP, "courses", course.id);
		assert.equal(fs.existsSync(path.join(dir, "notes", unit1)), false);
		assert.ok(fs.existsSync(path.join(dir, "notes", unit2, "notes.json")));
		assert.ok(fs.existsSync(path.join(dir, "course.json")) && fs.existsSync(path.join(dir, "progress.md")));
	});

	it("a unit's Notes chip and its session notes page lead to the course's Notes tab with the unit selected", async () => {
		const { course, unit2 } = seededCourse();
		const chip = parseHTML(renderToStaticMarkup(<NotesChip chatId={unit2} count={1} href={`/course/${course.id}/notes?unit=maps`} />)).document;
		assert.equal(chip.querySelector("a")?.getAttribute("href"), `/course/${course.id}/notes?unit=maps`);
		await assert.rejects(sessionNotesPage({ params: Promise.resolve({ id: unit2 }) }), redirectsTo(`/course/${course.id}/notes?unit=maps`));
	});
});

// ─── the course's notes and archive ─────────────────────────────────────────

describe("the course's notes", () => {
	it("lists every started unit's notes in course order, and archives them in a folder per unit", async () => {
		const { course, unit1, unit2 } = seededCourse();
		await writeNote(unit1, "Span");
		await writeNote(unit1, "Span");
		await writeNote(unit2, "Kernels");

		const listed = await (await courseNotesRoute.GET(new Request("http://x"), ctx({ id: course.id }))).json() as { units: Array<{ unitId: string; number: number; title: string; chatId: string; notes: NoteEntry[] }> };
		assert.deepEqual(listed.units.map((unit) => [unit.number, unit.unitId, unit.title, unit.chatId, unit.notes.map((note) => note.title)]), [
			[1, "vectors", "Vectors and span", unit1, ["Span", "Span"]],
			[2, "maps", "Linear maps", unit2, ["Kernels"]],
		]);
		assert.equal((await courseNotesRoute.GET(new Request("http://x"), ctx({ id: "course_missing" }))).status, 404);

		const zip = await courseArchiveRoute.GET(new Request("http://x"), ctx({ id: course.id }));
		assert.equal(zip.headers.get("content-type"), "application/zip");
		assert.equal(zip.headers.get("content-disposition"), 'attachment; filename="linear-algebra-notes.zip"');
		const files = unzip(Buffer.from(await zip.arrayBuffer()));
		assert.deepEqual([...files.keys()], ["1-vectors-and-span/span.html", "1-vectors-and-span/span-2.html", "2-linear-maps/kernels.html"]);
		assert.ok(files.get("2-linear-maps/kernels.html")?.includes("<p>Kernels</p>"));
	});

	it("refuses the archive, naming the unit, when one unit's notes can't be read", async () => {
		const { course, unit2 } = seededCourse();
		await writeNote(unit2, "Kernels");
		fs.writeFileSync(path.join(TMP, "courses", course.id, "notes", unit2, "notes.json"), "{ damaged");
		const refused = await courseArchiveRoute.GET(new Request("http://x"), ctx({ id: course.id }));
		assert.equal(refused.status, 409);
		assert.equal((await refused.json() as { error: string }).error, "Unit 2 (Linear maps): This session's notes index is damaged and can't be read.");
		const listed = await (await courseNotesRoute.GET(new Request("http://x"), ctx({ id: course.id }))).json() as { units: Array<{ unitId: string; error?: string }> };
		assert.deepEqual(listed.units.map((unit) => [unit.unitId, unit.error]), [["vectors", undefined], ["maps", "This session's notes index is damaged and can't be read."]]);
	});
});

// ─── the Notes tab ──────────────────────────────────────────────────────────

const view = (over: Partial<NoteEntry>): NoteEntry => ({
	id: "note_x", title: "Note", instruction: "", interactive: false, status: "ready",
	createdAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z", ...over,
});
const UNITS = [
	{ unitId: "vectors", number: 1, title: "Vectors and span", chatId: "chat_u1", notes: [view({ id: "note_span", title: "Span", createdAt: "2026-11-20T10:00:00.000Z" })] },
	{ unitId: "maps", number: 2, title: "Linear maps", chatId: "chat_u2", notes: [] },
	{ unitId: "eigen", number: 3, title: "Eigenvectors", chatId: "chat_u3", notes: [
		view({ id: "note_old", title: "Eigen old", createdAt: "2026-11-21T10:00:00.000Z" }),
		view({ id: "note_new", title: "Eigen new", createdAt: "2026-11-22T10:00:00.000Z" }),
	] },
];
const COURSE = { id: "course_tab", title: "Linear algebra", units: [{ status: "completed" as const }, { status: "in-progress" as const }, { status: "in-progress" as const }] };

async function withNotesTab(props: { initialUnitId?: string | null }, run: (page: { document: Document; calls: Array<{ url: string; method: string; body?: unknown }>; click: (selector: string) => Promise<void> }) => Promise<void>): Promise<void> {
	const pageDom = parseHTML('<html><body><div id="root"></div></body></html>');
	const globals = { window: pageDom.window, self: pageDom.window, document: pageDom.document, Element: pageDom.window.Element, HTMLElement: pageDom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModal = installModalDom(pageDom);
	const originalFetch = globalThis.fetch;
	const calls: Array<{ url: string; method: string; body?: unknown }> = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
		if (init?.method === "POST") return Response.json({ note: view({ id: `note_${calls.length}`, title: "", status: "writing", createdAt: "2026-11-23T10:00:00.000Z" }) }, { status: 202 });
		throw new TypeError("offline");
	}) as typeof fetch;
	const root = createRoot(pageDom.document.getElementById("root")!);
	try {
		await act(async () => root.render(
			<InteractionLayersProvider><ServerEventsProvider connect={() => ({ onEvent() {}, onOpen() {}, close() {} })}>
				<CourseNotesPage course={COURSE} initialUnits={structuredClone(UNITS)} initialUnitId={props.initialUnitId ?? null} />
			</ServerEventsProvider></InteractionLayersProvider>,
		));
		await run({
			document: pageDom.document as unknown as Document,
			calls,
			click: async (selector) => {
				const target = pageDom.document.querySelector<HTMLElement>(selector);
				assert.ok(target, selector);
				await act(async () => target.click());
			},
		});
	} finally {
		await act(async () => root.unmount());
		globalThis.fetch = originalFetch;
		restoreModal();
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
}

/** Submit the New note form (linkedom doesn't submit on a button click). */
async function submitNote(document: Document): Promise<void> {
	const form = document.querySelector<HTMLFormElement>('[data-testid="note-request-form"]');
	assert.ok(form);
	await act(async () => { form.dispatchEvent(new (document.defaultView as unknown as typeof globalThis).Event("submit", { bubbles: true, cancelable: true })); });
}

/** Set a <select>'s value the way React's change tracking sees it. */
async function choose(select: HTMLSelectElement, value: string): Promise<void> {
	await act(async () => {
		// linkedom's select.value is read-only; it reads the selected option.
		for (const option of select.querySelectorAll("option")) {
			if (option.getAttribute("value") === value) option.setAttribute("selected", "");
			else option.removeAttribute("selected");
		}
		select.dispatchEvent(new (select.ownerDocument.defaultView as unknown as typeof globalThis).Event("change", { bubbles: true }));
	});
}

describe("the course Notes tab", () => {
	it("groups notes under unit headings in course order, newest first, and opens on the newest note", async () => withNotesTab({}, async ({ document }) => {
		const groups = [...document.querySelectorAll('[data-testid="notes-unit-group"]')];
		assert.deepEqual(groups.map((group) => group.querySelector('[data-testid="notes-unit"]')?.textContent), ["1. Vectors and span", "2. Linear maps", "3. Eigenvectors"]);
		assert.deepEqual(groups.map((group) => [...group.querySelectorAll('[data-testid="note-row"]')].map((row) => row.getAttribute("data-note-id"))), [["note_span"], [], ["note_new", "note_old"]]);
		assert.equal(groups[1]!.querySelector('[data-testid="notes-unit-empty"]')?.textContent, "No notes yet");
		assert.equal(document.querySelector('[data-testid="note-row"][aria-current="true"]')?.getAttribute("data-note-id"), "note_new");
		assert.equal(document.querySelector('[data-testid="notes-unit"][aria-current="true"]')?.textContent, "3. Eigenvectors");
		assert.equal(document.querySelector('[data-testid="note-frame"]')?.getAttribute("src"), "/api/chats/chat_u3/notes/note_new?v=2026-11-20T10%3A00%3A00.000Z");
		assert.equal(document.querySelector('[data-testid="course-tab-notes"]')?.getAttribute("aria-current"), "page");
		assert.equal(document.querySelector('[data-testid="course-progress"]')?.textContent, "1 of 3 units completed");
	}));

	it("opens with the requested unit selected; New note's unit picker defaults to it and writes to the picked unit's session", async () => withNotesTab({ initialUnitId: "maps" }, async ({ document, calls, click }) => {
		assert.equal(document.querySelector('[data-testid="notes-unit"][aria-current="true"]')?.textContent, "2. Linear maps");
		assert.equal(document.querySelector('[data-testid="notes-empty"]')?.textContent, "No notes for this unit yet.");
		await click('[data-testid="note-new"]');
		const picker = document.querySelector<HTMLSelectElement>('[data-testid="note-unit"]')!;
		assert.deepEqual([...picker.querySelectorAll("option")].map((option) => [option.getAttribute("value"), option.textContent]), [
			["chat_u1", "1. Vectors and span"], ["chat_u2", "2. Linear maps"], ["chat_u3", "3. Eigenvectors"],
		]);
		assert.equal(picker.value, "chat_u2");
		await submitNote(document);
		assert.deepEqual(calls.filter((call) => call.method === "POST").map((call) => call.url), ["/api/chats/chat_u2/notes"]);

		// Selecting a note selects its unit: the next New note defaults there.
		await click('[data-note-id="note_span"]');
		assert.equal(document.querySelector('[data-testid="notes-unit"][aria-current="true"]')?.textContent, "1. Vectors and span");
		await click('[data-testid="note-new"]');
		assert.equal(document.querySelector<HTMLSelectElement>('[data-testid="note-unit"]')!.value, "chat_u1");
		await choose(document.querySelector<HTMLSelectElement>('[data-testid="note-unit"]')!, "chat_u3");
		await submitNote(document);
		assert.deepEqual(calls.filter((call) => call.method === "POST").map((call) => call.url), ["/api/chats/chat_u2/notes", "/api/chats/chat_u3/notes"]);
	}));

	it("exports the selected note's unit", async () => withNotesTab({}, async ({ calls, click }) => {
		await click('[data-note-id="note_span"]');
		await click('[data-testid="notes-export"]');
		assert.ok(calls.some((call) => call.url === "/api/chats/chat_u1/export.html"));
	}));
});

// ─── "Practice this unit" ───────────────────────────────────────────────────

const node = (id: string, name: string, statement: string, chatId: string) => ({
	id, name, statement, aliases: [] as string[], createdAt: "2026-11-20T10:00:00.000Z", provenance: [{ chatId, messageId: "m1" }],
});

/** Worked by hand from HANDOFF: not-reached topics left out; computed
 *  shaky topics, then the writer's shaky judgment and extra item. */
const CONTEXT_HEAD = [
	"[Session context] — practice for a unit of the learner's course, chosen by the learner:",
	"Course: Linear algebra. Unit 1: Vectors and span.",
	"Unit goal: Span and independence.",
	"Topics the unit taught: Matrix of a linear map; Kernel and image; Change of basis",
	"Shaky at the end of the unit:",
	"- Kernel and image: last check wrong",
	"- Change of basis: mixed up the two bases (model-written)",
	"- column space versus row space (model-written)",
];

describe("the practice context", () => {
	it("reads as the plan's text, with and without propositions", () => {
		const { course } = seededCourse();
		const picks = [{ id: "n_span01", name: "Span", statement: "The span of a set is every linear combination of it." }];
		assert.equal(core.unitPracticeContext(course, "vectors", picks)!.text, [
			...CONTEXT_HEAD,
			"Propositions (id — name: statement; the problem tool's target field uses these ids):",
			"- [n_span01] Span: The span of a set is every linear combination of it.",
		].join("\n"));
		assert.equal(core.unitPracticeContext(course, "vectors", [])!.text, CONTEXT_HEAD.join("\n"));
		// A unit without a handoff, and a writer that hasn't finished.
		assert.equal(core.unitPracticeContext(course, "maps", [])!.text, [
			"[Session context] — practice for a unit of the learner's course, chosen by the learner:",
			"Course: Linear algebra. Unit 2: Linear maps.",
			"Unit goal: Maps as matrices.",
			"Topics the unit taught: none recorded",
			"Shaky at the end of the unit: none recorded",
		].join("\n"));
		assert.deepEqual(core.handoffShakyItems({ ...HANDOFF, writer: { status: "writing" } }), ["Kernel and image: last check wrong"]);
		assert.equal(core.unitPracticeContext(course, "missing", []), null);
	});

	it("adds the unit's extracted propositions from the graph, and leaves them out with the graph off", () => {
		const { course, unit1, unit2 } = seededCourse();
		graphStore.appendNode(node(`n_${unit1}_a`, "Span", "The span of a set is every linear combination of it.", unit1));
		graphStore.appendNode(node(`n_${unit2}_b`, "Kernel", "The kernel is what maps to zero.", unit2));
		const started = courses.unitPracticeStart(course.id, "vectors");
		assert.ok(started.ok);
		assert.deepEqual(started.link, { role: "practice", courseId: course.id, unitId: "vectors" });
		assert.equal(started.message.customType, "graph-context");
		assert.equal(started.message.content, [
			...CONTEXT_HEAD,
			"Propositions (id — name: statement; the problem tool's target field uses these ids):",
			`- [n_${unit1}_a] Span: The span of a set is every linear combination of it.`,
		].join("\n"));
		assert.deepEqual((started.message.details as { propositions: unknown[] }).propositions, [{ id: `n_${unit1}_a`, name: "Span", statement: "The span of a set is every linear combination of it." }]);

		settingsStore.writeSettings({ ...structuredClone(SETTINGS), graph: { enabled: false } } as never);
		const graphOff = courses.unitPracticeStart(course.id, "vectors");
		assert.ok(graphOff.ok);
		assert.equal(graphOff.message.content, CONTEXT_HEAD.join("\n"));

		assert.deepEqual(courses.unitPracticeStart(course.id, "eigen"), { ok: false, status: 409, error: "This unit hasn't started yet." });
		assert.deepEqual(courses.unitPracticeStart(course.id, "nope"), { ok: false, status: 404, error: "Unknown unit" });
	});

	it("the transcript card names the unit and shows its goal, topics and shaky items", () => {
		const { course } = seededCourse();
		const context = core.unitPracticeContext(course, "vectors", [])!;
		const html = renderToStaticMarkup(<GraphContextCard data={{ propositions: [], chains: [], unit: context.unit }} />);
		const toggle = parseHTML(html).document.querySelector('[data-testid="graph-context-toggle"]')!;
		assert.equal(toggle.textContent, "Unit contextUnit 1: Vectors and span");
		const plain = parseHTML(renderToStaticMarkup(<GraphContextCard data={{ propositions: [{ id: "n", name: "N", statement: "S" }], chains: [] }} />)).document;
		assert.equal(plain.querySelector('[data-testid="graph-context-toggle"]')!.textContent, "Graph context1 proposition");
	});
});

describe("starting a \"Practice this unit\" session", () => {
	it("the draft page attaches the unit; the draft shows its chip and sends the link instead of picks", async () => {
		const { course } = seededCourse();
		const page = await newSessionPage({ searchParams: Promise.resolve({ mode: "practice", course: course.id, unit: "vectors" }) });
		assert.deepEqual(page.props.initialUnit, { courseId: course.id, unitId: "vectors", number: 1, title: "Vectors and span" });
		assert.equal(page.props.mode, "practice");
		const plain = await newSessionPage({ searchParams: Promise.resolve({ mode: "practice", course: course.id, unit: "eigen" }) });
		assert.equal(plain.props.initialUnit, null, "a unit that hasn't started opens a plain practice draft");
		assert.equal(core.unitPracticePrompt(1, "Vectors and span"), "Practice unit 1: Vectors and span");

		const shell = parseHTML(renderToStaticMarkup(
			<InteractionLayersProvider><DraftShell busy={false} text="Practice unit 1: Vectors and span" onChange={() => {}} onSend={() => {}} mode="practice" unit={{ number: 1, title: "Vectors and span" }} picks={[{ id: "n", name: "N", statement: "S" }]} /></InteractionLayersProvider>,
		)).document;
		assert.equal(shell.querySelector('[data-testid="practice-unit-chip"]')?.textContent, "Unit 1: Vectors and span");
		assert.ok(shell.querySelector('[data-testid="practice-unit-clear"]'));
		assert.equal(shell.querySelector('[data-testid="practice-props-chip"]'), null, "the unit takes the node picker's place");

		const bodies: unknown[] = [];
		const storage = new Map<string, string>();
		Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } } });
		try {
			const f = (async (_url: string, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ id: "chat_new" }); }) as typeof fetch;
			assert.equal(await startDraftSession("Practice unit 1: Vectors and span", f, "practice", [{ id: "n", name: "N", statement: "S" }], undefined, undefined, { courseId: course.id, unitId: "vectors" }), "/chat/chat_new");
			assert.deepEqual(bodies, [{ title: "Practice unit 1: Vectors and span", kind: "practice", course: { role: "practice", courseId: course.id, unitId: "vectors" } }]);
		} finally {
			Reflect.deleteProperty(globalThis, "sessionStorage");
		}
	});

	it("POST /api/chats creates a linked practice session whose message 0 is the unit's context, outside any course group", async () => {
		const { course } = seededCourse();
		const before = chatStore.listChats().length;
		for (const [unitId, status] of [["eigen", 409], ["nope", 404]] as const) {
			const refused = await chatsRoute.POST(new Request("http://x/api/chats", { method: "POST", body: JSON.stringify({ title: "x", kind: "practice", course: { role: "practice", courseId: course.id, unitId } }) }));
			assert.equal(refused.status, status);
		}
		assert.equal(chatStore.listChats().length, before, "a refused start creates no session");

		const res = await chatsRoute.POST(new Request("http://x/api/chats", { method: "POST", body: JSON.stringify({
			title: "Practice unit 1: Vectors and span", kind: "practice",
			course: { role: "practice", courseId: course.id, unitId: "vectors" },
			graphContext: { propositions: [{ id: "n_pick", name: "Pick", statement: "Ignored." }] },
		}) }));
		const { id } = await res.json() as { id: string };
		const record = chatStore.getChat(id)!;
		assert.equal(record.kind, "practice");
		assert.deepEqual(record.course, { role: "practice", courseId: course.id, unitId: "vectors" });
		assert.equal(record.messages.length, 1);
		const marker = record.messages[0] as { customType?: string; content?: string; details?: { unit?: { unitId: string } } };
		assert.equal(marker.customType, "graph-context");
		assert.ok(marker.content?.startsWith(CONTEXT_HEAD[0]!) && !marker.content.includes("n_pick"));
		assert.equal(marker.details?.unit?.unitId, "vectors");
		assert.ok(record.settings?.model, "stamped with the Strong slot like any new session");

		// An ordinary Practice row: never a member of the course group.
		const { courses: summaries } = courses.listCourseSummaries();
		assert.equal(courseMemberIds(summaries).has(id), false);
	});

	it("its concluded problems become the unit's practice evidence", async () => {
		const { course } = seededCourse();
		const res = await chatsRoute.POST(new Request("http://x/api/chats", { method: "POST", body: JSON.stringify({ title: "Practice unit 1", kind: "practice", course: { role: "practice", courseId: course.id, unitId: "vectors" } }) }));
		const { id } = await res.json() as { id: string };
		const record = chatStore.getChat(id)!;
		const call = (callId: string, name: string, args: unknown) => ({
			id: `a_${callId}`, role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], api: "openai-completions", provider: "test", model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "toolUse", timestamp: 1,
		});
		const result = (callId: string, name: string, timestamp: number) => ({ id: `r_${callId}`, role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: "ok" }], details: null, isError: false, timestamp });
		chatStore.saveMessages(id, [
			...record.messages,
			call("pr1", "problem", { statement: "Show the span is a plane.", mode: "recall", modelSolution: "…", target: ["n_span01"] }), result("pr1", "problem", 2),
			call("c1", "conclude", { outcome: "solved", verdict: "…", rung: "R1", missClass: null, retest: false }), result("c1", "conclude", Date.parse("2026-11-21T09:00:00.000Z")),
		] as never);
		courses.syncSessionEvidence(chatStore.getChat(id)!);
		assert.deepEqual(courseStore.get(course.id)!.evidence.filter((event) => event.type === "practice"), [
			{ type: "practice", id: `${id}:pr1`, at: "2026-11-21T09:00:00.000Z", practiceChatId: id, unitId: "vectors", problemCallId: "pr1", outcome: "solved", rung: 1, targets: ["n_span01"] },
		]);
	});
});
