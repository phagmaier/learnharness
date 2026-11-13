/** Child-only crash injection: operates solely on the test's LH_DATA_DIR. */
import fs from "node:fs";
import { sessionNoteStore } from "../../src/store/notes.ts";

const [chatId, noteId, boundary] = process.argv.slice(2);
if (!process.env.LH_DATA_DIR || !chatId || !noteId || !["before-index", "after-index"].includes(boundary!)) throw new Error("Missing isolated crash-test arguments");
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
	if (String(to).endsWith("notes.json") && boundary === "before-index") process.exit(86);
	rename(from, to);
	if (String(to).endsWith("notes.json") && boundary === "after-index") process.exit(86);
};
sessionNoteStore(chatId).publish(noteId, "<p>Replacement.</p>", ({ regenerating: _rewrite, ...entry }) => ({
	...entry, title: "Replacement", instruction: "new instruction", interactive: true, status: "ready", updatedAt: "2026-11-13T01:00:00Z",
}));
throw new Error("Crash boundary was not reached");
