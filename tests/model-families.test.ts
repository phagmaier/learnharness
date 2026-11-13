/**
 * Default model-picker view (fork, 2026-11-12; docs/fork/plans/01-small-fixes.md
 * §5a): the newest model of each family per provider, everything else under
 * "Show all models". Expected lists are the human-approved plan's table.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { defaultVisibleModels } from "../src/core/model-families.ts";

type Entry = { provider: string; id: string; unverified?: true };
const entries = (provider: string, ids: string[]): Entry[] => ids.map((id) => ({ provider, id }));
const visibleIds = (models: Entry[], options?: Parameters<typeof defaultVisibleModels>[1]) =>
	models.filter((m) => defaultVisibleModels(models, options).has(m)).map((m) => m.id).sort();

const ANTHROPIC = ["claude-fable-5", "claude-fable-5-1", "claude-fable-5-2", "claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-haiku-5-5",
	"claude-opus-4-5", "claude-opus-4-5-20251101", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5",
	"claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-sonnet-4-6", "claude-sonnet-5", "claude-sonnet-5-5"];
const CODEX = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra"];

test("Anthropic shows the newest Opus, Sonnet, Haiku and Fable", () => {
	assert.deepEqual(visibleIds(entries("anthropic", ANTHROPIC)), ["claude-fable-5-2", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
});

test("the OpenAI subscription catalog shows the newest Astra, Luna, Sol and Terra", () => {
	assert.deepEqual(visibleIds(entries("chatgpt", CODEX)), ["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra"]);
});

test("distinct older families stay visible; dated snapshots lose to the undated id of the same version", () => {
	const models = entries("openai", ["gpt-4o", "gpt-4o-2024-08-06", "gpt-4o-mini", "o3", "o3-pro", "gpt-5.4-mini", "gpt-5.5", "gpt-5.5-pro", "gpt-6-sol", "gpt-6.1-sol"]);
	assert.deepEqual(visibleIds(models), ["gpt-4o", "gpt-4o-mini", "gpt-5.4-mini", "gpt-5.5", "gpt-5.5-pro", "gpt-6.1-sol", "o3", "o3-pro"]);
});

test("a dated snapshot is shown when it is its family's only member", () => {
	assert.deepEqual(visibleIds(entries("anthropic", ["claude-haiku-4-5-20251001"])), ["claude-haiku-4-5-20251001"]);
});

test("multi-part versions compare numerically, not as text", () => {
	assert.deepEqual(visibleIds(entries("x", ["model-5.9", "model-5.10"])), ["model-5.10"]);
});

test("ids without a version number are always shown", () => {
	assert.deepEqual(visibleIds(entries("openai", ["chat-latest", "gpt-daybreak-red-latest", "gpt-6-sol"])), ["chat-latest", "gpt-6-sol", "gpt-daybreak-red-latest"]);
});

test("families are per provider: the same family on two providers keeps a newest member each", () => {
	const models = [...entries("openai", ["gpt-6-sol", "gpt-6.1-sol"]), ...entries("chatgpt", ["gpt-6-sol"])];
	assert.deepEqual(models.filter((m) => defaultVisibleModels(models).has(m)).map((m) => `${m.provider}/${m.id}`).sort(), ["chatgpt/gpt-6-sol", "openai/gpt-6.1-sol"]);
});

test("unverified models are never in the default view", () => {
	const models: Entry[] = [{ provider: "chatgpt", id: "gpt-6.1-sol" }, { provider: "chatgpt", id: "gpt-7-nova", unverified: true }];
	assert.deepEqual(visibleIds(models), ["gpt-6.1-sol"]);
});

test("alias-only providers show just their unversioned aliases", () => {
	const models = entries("claude-code", ["fable", "opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5"]);
	assert.deepEqual(visibleIds(models, { aliasOnlyProviders: new Set(["claude-code"]) }), ["fable", "haiku", "opus", "sonnet"]);
});
