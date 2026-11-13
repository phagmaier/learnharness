/**
 * Plan 03 item 2: GET /api/chats/:id/export.html. Runs under an isolated
 * LH_DATA_DIR (set before any config-loading import; every app-module
 * import is dynamic), like tests/artifact-ui.test.ts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { parseHTML } from "linkedom";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-export-route-"));
process.env.LH_DATA_DIR = TMP_DATA;

type Get = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let GET: Get;
let createChat: (title: string, kind?: "practice") => { id: string; title: string };
let saveMessages: (id: string, messages: unknown[]) => void;

before(async () => {
	GET = (await import("../app/api/chats/[id]/export.html/route.ts")).GET;
	const server = await import("../src/server/chats.ts");
	createChat = server.createChat as typeof createChat;
	const { chatStore } = await import("../src/store/chats.ts");
	saveMessages = (id, messages) => chatStore.saveMessages(id, messages as never);
});

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const get = (id: string) => GET(new Request(`http://x/api/chats/${id}/export.html`), { params: Promise.resolve({ id }) });

describe("GET /api/chats/:id/export.html", () => {
	it("404s an unknown chat", async () => {
		assert.equal((await get("chat_missing")).status, 404);
	});

	it("refuses Practice sessions", async () => {
		const chat = createChat("Drills", "practice");
		const res = await get(chat.id);
		assert.equal(res.status, 400);
		assert.match(((await res.json()) as { error: string }).error, /Practice/);
	});

	it("downloads a Teach session as a sandboxed, self-contained page", async () => {
		const chat = createChat("Eigenvectors: the basics!");
		saveMessages(chat.id, [
			{ id: "u1", role: "user", content: "What is an eigenvector?", timestamp: 1 },
			{
				id: "a1", role: "assistant", content: [{ type: "text", text: "A vector with $Av = \\lambda v$." }],
				api: "openai-completions", provider: "test", model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: 2,
			},
		]);
		const res = await get(chat.id);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
		assert.equal(res.headers.get("content-security-policy"), "sandbox allow-scripts allow-popups");
		assert.equal(res.headers.get("content-disposition"), 'attachment; filename="eigenvectors-the-basics.html"');
		const { document } = parseHTML(await res.text());
		assert.equal(document.querySelector(".lh-doc-title")?.textContent, "Eigenvectors: the basics!");
		assert.match(document.querySelector(".lh-doc-subtitle")?.textContent ?? "", /^Conversation · \d{1,2} [A-Z][a-z]+ \d{4}$/);
		assert.equal(document.querySelector(".lh-learner .lh-verbatim")?.textContent, "What is an eigenvector?");
		assert.ok(document.querySelector(".lh-doc-body .katex"));
		assert.equal(document.querySelector("script"), null);
	});
});
