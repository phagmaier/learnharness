"use strict";

/**
 * Native right-click menu for text (fork, 2026-11-12; docs/fork/README.md →
 * "Desktop right-click menu"). Chromium's spellchecker underlines words but
 * Electron displays nothing on right-click unless the app builds a menu.
 *
 * Pure: Electron's `context-menu` params in, a Menu template out. main.cjs
 * builds and pops it up. The renderer's own menus (sidebar, graph canvas)
 * call preventDefault, so Chromium never asks for this one there.
 */

const MAX_SUGGESTIONS = 5;

/**
 * @param {{ misspelledWord: string, dictionarySuggestions: string[], isEditable: boolean,
 *   selectionText: string, editFlags: { canCut: boolean, canCopy: boolean, canPaste: boolean, canSelectAll: boolean } }} params
 * @param {{ replaceMisspelling(word: string): void, addWord(word: string): void }} actions
 * @returns {object[]} Menu template; empty when there is nothing to offer.
 */
function contextMenuTemplate(params, actions) {
	const groups = [];

	const word = params.misspelledWord;
	if (word) {
		const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
		groups.push(suggestions.length
			? suggestions.map((suggestion) => ({ label: suggestion, click: () => actions.replaceMisspelling(suggestion) }))
			: [{ label: "No suggestions", enabled: false }]);
		groups.push([{ label: "Add to dictionary", click: () => actions.addWord(word) }]);
	}

	const flags = params.editFlags;
	if (params.isEditable) {
		const editing = [
			flags.canCut && { label: "Cut", role: "cut" },
			flags.canCopy && { label: "Copy", role: "copy" },
			flags.canPaste && { label: "Paste", role: "paste" },
			flags.canSelectAll && { label: "Select All", role: "selectAll" },
		].filter(Boolean);
		if (editing.length) groups.push(editing);
	} else if (params.selectionText.trim() && flags.canCopy) {
		groups.push([{ label: "Copy", role: "copy" }]);
	}

	return groups.flatMap((group, index) => index === 0 ? group : [{ type: "separator" }, ...group]);
}

module.exports = { contextMenuTemplate };
