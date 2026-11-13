/**
 * Desktop right-click menu (electron/context-menu.cjs): Chromium's
 * spellchecker underlines words but Electron shows no menu unless the app
 * builds one. Fork design: docs/fork/README.md → "Desktop right-click menu".
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { contextMenuTemplate } = require("../electron/context-menu.cjs") as {
	contextMenuTemplate(params: Params, actions: Actions): Item[];
};

type Params = {
	misspelledWord: string;
	dictionarySuggestions: string[];
	isEditable: boolean;
	selectionText: string;
	editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
};
type Actions = { replaceMisspelling(word: string): void; addWord(word: string): void };
type Item = { label?: string; role?: string; type?: string; enabled?: boolean; click?: () => void };

const NO_FLAGS = { canCut: false, canCopy: false, canPaste: false, canSelectAll: false };
const ALL_FLAGS = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };

function params(overrides: Partial<Params>): Params {
	return { misspelledWord: "", dictionarySuggestions: [], isEditable: false, selectionText: "", editFlags: NO_FLAGS, ...overrides };
}
function recorder() {
	const calls: [string, string][] = [];
	return { calls, actions: { replaceMisspelling: (w: string) => calls.push(["replace", w]), addWord: (w: string) => calls.push(["add", w]) } };
}
const labels = (items: Item[]) => items.map((i) => i.type === "separator" ? "---" : i.label);

test("a misspelled word lists suggestions, then Add to dictionary, then editing items", () => {
	const { calls, actions } = recorder();
	const items = contextMenuTemplate(params({
		misspelledWord: "teh", dictionarySuggestions: ["the", "tea"], isEditable: true, editFlags: { ...ALL_FLAGS, canCut: false, canCopy: false },
	}), actions);
	assert.deepEqual(labels(items), ["the", "tea", "---", "Add to dictionary", "---", "Paste", "Select All"]);
	items[0]?.click?.();
	items.find((i) => i.label === "Add to dictionary")?.click?.();
	assert.deepEqual(calls, [["replace", "the"], ["add", "teh"]]);
});

test("at most five suggestions are shown", () => {
	const items = contextMenuTemplate(params({
		misspelledWord: "wrd", dictionarySuggestions: ["a", "b", "c", "d", "e", "f", "g"], isEditable: true,
	}), recorder().actions);
	assert.deepEqual(labels(items), ["a", "b", "c", "d", "e", "---", "Add to dictionary"]);
});

test("a misspelled word without suggestions shows a disabled No suggestions line", () => {
	const items = contextMenuTemplate(params({ misspelledWord: "qzxv", isEditable: true }), recorder().actions);
	assert.deepEqual(labels(items), ["No suggestions", "---", "Add to dictionary"]);
	assert.equal(items[0]?.enabled, false);
	assert.equal(items[0]?.click, undefined);
});

test("an editable field shows only the editing items its flags allow, as native roles", () => {
	const items = contextMenuTemplate(params({ isEditable: true, editFlags: ALL_FLAGS }), recorder().actions);
	assert.deepEqual(labels(items), ["Cut", "Copy", "Paste", "Select All"]);
	assert.deepEqual(items.map((i) => i.role), ["cut", "copy", "paste", "selectAll"]);
	assert.deepEqual(labels(contextMenuTemplate(params({ isEditable: true, editFlags: { ...NO_FLAGS, canPaste: true } }), recorder().actions)), ["Paste"]);
});

test("selected read-only text offers Copy", () => {
	const items = contextMenuTemplate(params({ selectionText: "a passage", editFlags: { ...NO_FLAGS, canCopy: true, canSelectAll: true } }), recorder().actions);
	assert.deepEqual(labels(items), ["Copy"]);
	assert.equal(items[0]?.role, "copy");
});

test("an empty, non-editable area produces no menu", () => {
	assert.deepEqual(contextMenuTemplate(params({ editFlags: { ...NO_FLAGS, canSelectAll: true } }), recorder().actions), []);
	assert.deepEqual(contextMenuTemplate(params({ selectionText: "   ", editFlags: { ...NO_FLAGS, canCopy: true } }), recorder().actions), []);
});

/** Run the REAL main.cjs with a stub Electron API (as desktop-platform.test.ts
 * does), declining the single-instance lock so no server starts, then fire
 * the window's context-menu listener. */
test("the app window pops the menu up and routes its actions to the window", async () => {
	const { readFileSync } = await import("node:fs");
	const { dirname } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const { runInNewContext } = await import("node:vm");
	const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
	const mainRequire = createRequire(mainFile);
	const listeners = new Map<string, (...args: unknown[]) => void>();
	const calls: unknown[][] = [];
	class FakeWindow {
		webContents = {
			on: (name: string, listener: (...args: unknown[]) => void) => { listeners.set(name, listener); },
			setWindowOpenHandler() {},
			replaceMisspelling: (word: string) => calls.push(["replace", word]),
			session: { addWordToSpellCheckerDictionary: (word: string) => calls.push(["add", word]) },
		};
		loadURL() {}
		once() {}
	}
	const menu: { built?: Item[] } = {};
	const electron = {
		app: { setName() {}, getPath: () => "/fixture/LearnHarness", setPath() {}, requestSingleInstanceLock: () => false, quit() {} },
		BrowserWindow: FakeWindow,
		Menu: { buildFromTemplate: (template: Item[]) => { menu.built = template; return { popup: (options: unknown) => calls.push(["popup", options]) }; } },
		nativeTheme: { shouldUseDarkColors: true, themeSource: "system", on() {} },
		session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
	};
	const context = {
		require: (id: string) => id === "electron" ? electron : mainRequire(id),
		process: { platform: "linux", argv: [], env: {}, on() {} },
		__dirname: dirname(mainFile),
	};
	runInNewContext(readFileSync(mainFile, "utf8"), context, { filename: mainFile });
	const win = runInNewContext('createWindow("http://127.0.0.1:9000")', context);
	const onContextMenu = listeners.get("context-menu");
	assert.ok(onContextMenu, "createWindow registers a context-menu listener");

	onContextMenu({}, params({ editFlags: NO_FLAGS }));
	assert.equal(menu.built, undefined, "nothing to offer: no menu is built");

	onContextMenu({}, params({ misspelledWord: "teh", dictionarySuggestions: ["the"], isEditable: true }));
	// The earlier assert narrowed menu.built to undefined; the listener has since set it.
	const built = menu.built as Item[] | undefined;
	assert.deepEqual(labels(built ?? []), ["the", "---", "Add to dictionary"]);
	built?.[0]?.click?.();
	built?.[2]?.click?.();
	assert.equal(calls.length, 3);
	assert.deepEqual(calls[0]?.[0], "popup");
	assert.equal((calls[0]?.[1] as { window: unknown }).window, win);
	assert.deepEqual(calls.slice(1), [["replace", "the"], ["add", "teh"]]);
});
