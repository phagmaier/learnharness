import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { piModels } from "../src/agent/models.ts";
import { refreshChatGPTModels, chatGPTModels, chatGPTStatus, chatGPTScope, chatGPTScopeCurrent, chatGPTLease, chatGPTAbortController } from "../src/agent/chatgpt-bridge.ts";
const send = Object.getOwnPropertyDescriptor(process, "send"), connected = Object.getOwnPropertyDescriptor(process, "connected");
const desktopMarker = process.env.LH_DESKTOP_SERVER, desktopSecret = process.env.LH_DESKTOP_API_SECRET;
const pending: any[] = [];
const model = piModels().getModels("openai").find((m) => m.api === "openai-responses")!;
const ipc = (m: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", m);
const status = (account: string, background = true) => ({ available: true, pending: false, allowBackgroundUse: background, activeId: account, accounts: [{ id: account, connected: true, background: !background, planEnabled: true }], error: null });
const value = (name: string, revision: number, account = "A", authorityRevision = 1) => ({ epoch: account === "A" ? 1 : 2, authorityRevision, revision, status: status(account), accountId: account, models: [{ id: model.id, name }] });
function reply(request: any, v: unknown) { ipc({ channel: "lh:chatgpt", id: request.id, op: request.op, ok: true, value: v }); }
before(() => {
 process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
 Object.defineProperty(process, "connected", { configurable: true, value: true });
 Object.defineProperty(process, "send", { configurable: true, value: (m: unknown, cb?: () => void) => { pending.push(m); cb?.(); return true; } });
});
after(() => {
 if (desktopMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = desktopMarker;
 if (desktopSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = desktopSecret;
 if (send) Object.defineProperty(process, "send", send); else delete process.send;
 if (connected) Object.defineProperty(process, "connected", connected); else delete (process as { connected?: boolean }).connected;
});
test("overlapping catalog requests only install the newest generation", async () => {
 const old = refreshChatGPTModels([model as never]), latest = refreshChatGPTModels([model as never]);
 reply(pending[1], value("newest", 2)); await latest;
 reply(pending[0], value("stale", 1)); await old;
 assert.equal(chatGPTModels()[0]?.name, "newest");
});
test("consent-only status does not discard current-authority catalog or overwrite newer consent from an old status embedded in models", async () => {
 const refresh = refreshChatGPTModels([model as never]); const request = pending.at(-1);
 ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 1, authorityRevision: 1, revision: 3 }, status: status("A", false), invalidate: "background" });
 reply(request, value("same authority", 2)); await refresh;
 assert.equal(chatGPTModels()[0]?.name, "same authority"); assert.equal(chatGPTStatus().allowBackgroundUse, false);
 const scope = chatGPTScope(model.id); assert(chatGPTScopeCurrent(scope));
 const foreground = chatGPTAbortController(false), background = chatGPTAbortController(true);
 ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 1, authorityRevision: 1, revision: 4 }, status: status("A", false), invalidate: "background" });
 ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 1, authorityRevision: 1, revision: 5 }, status: status("A", true), invalidate: "none" });
 assert(!foreground.controller.signal.aborted); assert(background.controller.signal.aborted); assert(chatGPTScopeCurrent(scope));
 foreground.release(); background.release();
});
test("account/full and catalog authority changes reject outstanding old leases without silently switching identity", async () => {
 const scope = chatGPTScope(model.id); const lease = chatGPTLease(scope, false); const request = pending.at(-1);
 ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 2, authorityRevision: 2, revision: 6 }, status: status("B"), invalidate: "all" });
 assert.equal(chatGPTModels().length, 0); assert(!chatGPTScopeCurrent(scope));
 reply(request, { epoch: 1, authorityRevision: 1, revision: 5, accountId: "A", accessToken: "dummy-old" });
 await assert.rejects(lease, /stale/);
 const refresh = refreshChatGPTModels([model as never]); reply(pending.at(-1), value("B", 7, "B", 2)); await refresh;
 const newScope = chatGPTScope(model.id); assert.equal(newScope.accountId, "B");
 ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 2, authorityRevision: 3, revision: 8 }, status: status("B"), invalidate: "none" });
 assert.equal(chatGPTModels().length, 0); await assert.rejects(chatGPTLease(newScope, false));
});
// Fork (docs/fork/plans/01-small-fixes.md §5b): account models pi's catalog
// does not know are kept with conservative guesses and marked unverified.
test("unknown account models are kept with conservative limits and marked unverified; known ones are unchanged", async () => {
 const { chatGPTModelUnverified } = await import("../src/agent/chatgpt-bridge.ts");
 const { toModelDto } = await import("../src/server/model-catalog.ts");
 const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
 ipc({ channel: "lh:chatgpt", kind: "state", stamp: { epoch: 3, authorityRevision: 4, revision: 9 }, status: status("C"), invalidate: "all" });
 const refresh = refreshChatGPTModels([model as never]);
 reply(pending.at(-1), { epoch: 3, authorityRevision: 4, revision: 10, status: status("C"), accountId: "C", models: [{ id: model.id, name: "Known" }, { id: "gpt-9-nova", name: "GPT-9 Nova" }] });
 await refresh;
 const [known, unknown] = chatGPTModels();
 assert.equal(known?.id, model.id); assert.equal(known?.contextWindow, model.contextWindow); assert.equal(chatGPTModelUnverified(model.id), false);
 assert.equal(toModelDto(known!).unverified, undefined);
 assert.ok(unknown);
 assert.equal(unknown.id, "gpt-9-nova"); assert.equal(unknown.name, "GPT-9 Nova"); assert.equal(unknown.provider, "chatgpt"); assert.equal(unknown.api, "openai-responses");
 assert.equal(unknown.contextWindow, 128_000); assert.equal(unknown.maxTokens, 32_000);
 assert.deepEqual(unknown.input, ["text"]);
 assert.deepEqual(getSupportedThinkingLevels(unknown), ["low", "medium", "high"]);
 assert.deepEqual(unknown.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
 assert.equal(chatGPTModelUnverified("gpt-9-nova"), true);
 assert.equal(toModelDto(unknown).unverified, true);
});
test("failures on an unverified model say its limits are guessed; verified failures and cancellations do not", async () => {
 const { chatGPTFailureMessage } = await import("../src/agent/chatgpt-stream.ts");
 assert.match(chatGPTFailureMessage("400 bad request", "gpt-9-nova", false), /new to LearnHarness.*guessed/);
 assert.doesNotMatch(chatGPTFailureMessage("400 bad request", model.id, false), /guessed/);
 assert.doesNotMatch(chatGPTFailureMessage("aborted", "gpt-9-nova", true), /guessed/);
});
