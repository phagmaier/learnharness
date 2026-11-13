import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { Chat } from "../components/chat.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import type { LhMessage } from "../src/core/native-messages.ts";

it("development SSR renders Chat and its pending dock with sealed React refs", () => {
	const messages: LhMessage[] = [{
		id: "question", role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: 1,
		stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		content: [{ type: "text", text: "An arrow represents a vector." }, { type: "toolCall", id: "q", name: "explain", arguments: { question: "Describe this vector.", correctAnswer: "It has direction and length." } }],
	} as LhMessage];
	const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
	const html = renderToStaticMarkup(<AppRouterContext.Provider value={router}><PathnameContext.Provider value="/chat/ssr"><InteractionLayersProvider><ServerEventsProvider><Chat chatId="ssr" title="SSR lesson" initialMessages={messages} /></ServerEventsProvider></InteractionLayersProvider></PathnameContext.Provider></AppRouterContext.Provider>);
	assert.ok(html.includes("SSR lesson"));
	assert.ok(html.includes("An arrow represents a vector."));
	assert.ok(html.includes("Describe this vector."));
});
