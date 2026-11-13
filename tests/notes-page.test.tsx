/**
 * Plan 03 item 4: the notes page's pure pieces and the Practice redirect.
 * SSR renders of the list rows, the chip, the note frame, the request form,
 * and the selected-note pane; the server page runs under an isolated
 * LH_DATA_DIR (set before any config-loading import).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notes-page-"));
process.env.LH_DATA_DIR = TMP;

const {
	EMPTY_NOTES, INTERACTIVE_LABEL, NEW_NOTE_PLACEHOLDER, NoteFrame, NoteListRow, NotePane, NoteRequestForm,
	noteFrameSandbox, sortNotes,
} = await import("../components/notes-page.tsx");
type NoteView = import("../components/notes-page.tsx").NoteView;
const { NotesChip } = await import("../components/notes-chip.tsx");
const { isSessionPath } = await import("../components/sidebar.tsx");
const { chatStore } = await import("../src/store/chats.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const note = (over: Partial<NoteView>): NoteView => ({
	id: "note_a", title: "Eigen basics", instruction: "", interactive: false, status: "ready",
	createdAt: "2026-11-13T10:00:00.000Z", updatedAt: "2026-11-13T10:01:00.000Z", ...over,
});
const dom = (html: string) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
const noop = () => {};

describe("note list rows", () => {
	it("show each state: ready, writing, failed, stopped, rewriting; the instruction's first line or Default note; the Interactive tag", () => {
		const row = (n: NoteView) => dom(renderToStaticMarkup(<NoteListRow note={n} selected={false} onSelect={noop} />));
		const ready = row(note({}));
		assert.equal(ready.querySelector("[data-status]")?.getAttribute("data-status"), "ready");
		assert.equal(ready.querySelector('[data-testid="note-status"]'), null);
		assert.ok(ready.body.textContent?.includes("Default note"));
		assert.equal(ready.querySelector('[data-testid="note-interactive-tag"]'), null);

		const writing = row(note({ title: "", status: "writing", instruction: "only diagonalization\nand more" }));
		assert.ok(writing.body.textContent?.includes("Writing note…"));
		assert.equal(writing.querySelector('[data-testid="note-status"]')?.textContent, "Writing…");
		assert.ok(writing.body.textContent?.includes("only diagonalization"));
		assert.ok(!writing.body.textContent?.includes("and more"));

		assert.equal(row(note({ status: "failed", error: "boom" })).querySelector('[data-testid="note-status"]')?.textContent, "Failed");
		assert.equal(row(note({ status: "failed", stopped: true, error: "Stopped" })).querySelector('[data-testid="note-status"]')?.textContent, "Stopped");
		assert.equal(row(note({ regenerating: { instruction: "", interactive: false, startedAt: "x" } })).querySelector('[data-testid="note-status"]')?.textContent, "Rewriting…");
		assert.equal(row(note({ regenerating: { instruction: "", interactive: false, startedAt: "x", error: "no" } })).querySelector('[data-testid="note-status"]'), null);
		assert.ok(row(note({ interactive: true })).querySelector('[data-testid="note-interactive-tag"]'));
	});

	it("are listed newest first", () => {
		const sorted = sortNotes([note({ id: "old", createdAt: "2026-11-01T00:00:00.000Z" }), note({ id: "new", createdAt: "2026-11-12T00:00:00.000Z" })]);
		assert.deepEqual(sorted.map((n) => n.id), ["new", "old"]);
	});
});

describe("notes chip", () => {
	it("links to the notes page and shows the count only when notes exist", () => {
		const none = dom(renderToStaticMarkup(<NotesChip chatId="chat_1" count={0} />));
		assert.equal(none.querySelector("a")?.getAttribute("href"), "/chat/chat_1/notes");
		assert.equal(none.querySelector('[data-testid="notes-chip-count"]'), null);
		const three = dom(renderToStaticMarkup(<NotesChip chatId="chat_1" count={3} />));
		assert.equal(three.querySelector('[data-testid="notes-chip-count"]')?.textContent, "3");
		assert.equal(three.querySelector("a")?.getAttribute("aria-label"), "Notes (3)");
	});
});

describe("note frame", () => {
	it("never runs a plain note's scripts, runs an interactive note's, and never shares the app's origin", () => {
		const plain = dom(renderToStaticMarkup(<NoteFrame chatId="chat_1" note={note({})} inverted={false} />)).querySelector("iframe")!;
		assert.equal(plain.getAttribute("sandbox"), "allow-popups allow-popups-to-escape-sandbox");
		assert.equal(plain.getAttribute("src"), "/api/chats/chat_1/notes/note_a?v=2026-11-13T10%3A01%3A00.000Z");
		const interactive = dom(renderToStaticMarkup(<NoteFrame chatId="chat_1" note={note({ interactive: true })} inverted />)).querySelector("iframe")!;
		assert.equal(interactive.getAttribute("sandbox"), "allow-scripts allow-popups allow-popups-to-escape-sandbox");
		assert.match(interactive.getAttribute("style") ?? "", /invert\(1\) hue-rotate\(180deg\)/);
		for (const flags of [noteFrameSandbox(false), noteFrameSandbox(true)]) assert.ok(!flags.includes("allow-same-origin"));
	});
});

describe("note request form", () => {
	it("carries the proposed placeholder and checkbox label, prefilled for Regenerate", () => {
		const form = dom(renderToStaticMarkup(
			<NoteRequestForm instruction="only diagonalization" interactive busy={false} submitLabel="Regenerate"
				onInstruction={noop} onInteractive={noop} onSubmit={noop} onCancel={noop} />,
		));
		const box = form.querySelector("textarea")!;
		assert.equal(box.getAttribute("placeholder"), NEW_NOTE_PLACEHOLDER);
		assert.equal(box.textContent, "only diagonalization");
		assert.ok(form.querySelector('input[type="checkbox"]')?.hasAttribute("checked"));
		assert.ok(form.body.textContent?.includes(INTERACTIVE_LABEL));
		assert.equal(form.querySelector('[data-testid="note-submit"]')?.textContent, "Regenerate");
	});
});

describe("selected note pane", () => {
	const pane = (n: NoteView, rewrite: { instruction: string; interactive: boolean } | null = null) => dom(renderToStaticMarkup(
		<NotePane chatId="chat_1" note={n} inverted={false} onInverted={noop} rewrite={rewrite} rewriteBusy={false}
			onRewriteOpen={noop} onRewriteChange={noop} onRewriteSubmit={noop} onRetry={noop} onStop={noop} onDelete={noop} />,
	));

	it("shows a ready note with its toolbar and info line (instruction, model, cost)", () => {
		const ready = pane(note({ instruction: "I struggle with lambda", model: "openrouter:anthropic/claude-opus-5.5", costUsd: 0.0123 }));
		for (const id of ["note-download", "note-regenerate", "note-delete", "note-frame"]) assert.ok(ready.querySelector(`[data-testid="${id}"]`), id);
		assert.ok(ready.querySelector('[role="switch"][aria-label="Invert note colors"]'));
		assert.equal(ready.querySelector('[data-testid="note-download"]')?.getAttribute("href"), "/api/chats/chat_1/notes/note_a?download=1");
		const info = ready.querySelector('[data-testid="note-info"]')?.textContent ?? "";
		assert.match(info, /^“I struggle with lambda” · .+ · \$0\.01/);
	});

	it("opens Regenerate prefilled with the note's instruction and Interactive choice", () => {
		const open = pane(note({ instruction: "short", interactive: true }), { instruction: "short", interactive: true });
		assert.equal(open.querySelector("textarea")?.textContent, "short");
		assert.ok(open.querySelector('input[type="checkbox"]')?.hasAttribute("checked"));
	});

	it("keeps the old version visible while rewriting, with Stop; shows a failed rewrite's error", () => {
		const rewriting = pane(note({ regenerating: { instruction: "x", interactive: false, startedAt: "t" } }));
		assert.ok(rewriting.querySelector('[data-testid="note-rewriting"] [data-testid="note-stop"]'));
		assert.ok(rewriting.querySelector('[data-testid="note-frame"]'));
		assert.equal(rewriting.querySelector('[data-testid="note-regenerate"]'), null);
		const failedRewrite = pane(note({ regenerating: { instruction: "x", interactive: false, startedAt: "t", error: "Provider said no." } }));
		assert.match(failedRewrite.querySelector('[data-testid="note-rewrite-error"]')?.textContent ?? "", /Provider said no\. The current version is kept\./);
		assert.ok(failedRewrite.querySelector('[data-testid="note-frame"]'));
	});

	it("shows a failed or stopped note's message with Try again and Delete, and a writing note with Stop", () => {
		const failed = pane(note({ status: "failed", error: "Context too long." }));
		assert.ok(failed.body.textContent?.includes("Context too long."));
		assert.ok(failed.querySelector('[data-testid="note-retry"]'));
		assert.ok(failed.querySelector('[data-testid="note-delete"]'));
		assert.equal(failed.querySelector('[data-testid="note-frame"]'), null);
		assert.ok(pane(note({ status: "failed", stopped: true, error: "Stopped" })).body.textContent?.includes("Stopped."));
		assert.ok(pane(note({ status: "writing", title: "" })).querySelector('[data-testid="note-writing"] [data-testid="note-stop"]'));
	});

	it("uses the proposed empty-state wording", () => {
		assert.equal(EMPTY_NOTES, "No notes yet. Write one from this session at any time.");
	});
});

describe("notes route page", () => {
	it("redirects a Practice session to its chat and keeps the session highlighted in the sidebar", async () => {
		const page = (await import("../app/chat/[id]/notes/page.tsx")).default;
		const practice = chatStore.createChat("Drills", "practice");
		await assert.rejects(page({ params: Promise.resolve({ id: practice.id }) }), (error: unknown) => {
			const digest = String((error as { digest?: string }).digest ?? "");
			return digest.startsWith("NEXT_REDIRECT") && digest.includes(`/chat/${practice.id}`) && !digest.includes("/notes");
		});
		await assert.rejects(page({ params: Promise.resolve({ id: "chat_missing" }) }), (error: unknown) =>
			String((error as { digest?: string }).digest ?? "").includes("404"));
		assert.equal(isSessionPath(`/chat/${practice.id}/notes`, practice.id), true);
		assert.equal(isSessionPath(`/chat/${practice.id}`, practice.id), true);
		assert.equal(isSessionPath(`/chat/${practice.id}x/notes`, practice.id), false);
	});
});
