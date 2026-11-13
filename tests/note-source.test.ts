import assert from "node:assert/strict";
import { it } from "node:test";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import { noteSource } from "../src/core/document/note-source.ts";

it("preserves side-thread order, shown-image identity, plan titles and modern learner thinking", () => {
	const record = {
		messages: [
			{ id: "lesson", role: "assistant", content: [{ type: "text", text: "A vector has direction." }] },
			{ id: "shown", role: "toolResult", toolName: "show_image", toolCallId: "image", details: { snapshotId: "photo", caption: "  Two\n arrows  " }, content: [] },
			{ id: "answer", role: "toolResult", toolName: "ask_user_question", toolCallId: "ask", details: {
				questionText: "What next?", answers: [{ index: 1, value: "vectors", label: "Vectors" }],
				thinking: "Compare their lengths.", readingThinking: "The arrows have the same direction.", note: "OLD THINKING",
			}, content: [] },
			{ id: "next", role: "assistant", content: [{ type: "text", text: "Now consider maps." }] },
		],
		imageSnapshots: { photo: { mimeType: "image/png", data: "cGhvdG8=", width: 1, height: 1 } },
		tree: { nodes: [{ id: "v", title: "Vectors" }, { id: "m", title: "Maps" }], edges: [] },
		sideChats: [{ anchor: { messageId: "lesson", blockText: "Fallback passage" }, messages: [
			{ role: "user", quotes: ["  A vector\n has direction.  "], text: "Why this direction?" },
			{ role: "assistant", text: "The arrow points along the vector." },
		] }],
	} as unknown as ChatRecord;
	const source = noteSource(record);
	const expected = [
		"A vector has direction.", "### Side question", "> A vector has direction.",
		"**Learner:** Why this direction?", "**Answer:** The arrow points along the vector.",
		"[Image I1]", "The learner chose: Vectors", "Compare their lengths.",
		"The arrows have the same direction.", "Now consider maps.",
	];
	let cursor = -1;
	for (const text of expected) {
		const position = source.text.indexOf(text, cursor + 1);
		assert.ok(position > cursor, `missing or out of order: ${text}`);
		cursor = position;
	}
	assert.ok(!source.text.includes("Fallback passage"));
	assert.ok(!source.text.includes("OLD THINKING"));
	assert.ok(!source.text.includes("[object Object]"));
	assert.deepEqual(source.planTitles, ["Vectors", "Maps"]);
	assert.deepEqual(source.figures, [{ id: "I1", kind: "image", description: "Two arrows", src: "data:image/png;base64,cGhvdG8=", alt: "Two arrows" }]);
});
