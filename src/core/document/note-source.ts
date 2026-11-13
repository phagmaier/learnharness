import type { ChatRecord, ShowImageDetails, SideChatThread } from "../contracts/chat.ts";
import { isSubagentFailure, type DemoResult, type SteerDetails, type VisualResult } from "../contracts/jobs.ts";
import type { LhMessage } from "../native-messages.ts";
import { sessionMarkdown } from "../session-markdown.ts";
import { figureImageSrc, learnerImageSrc } from "./figures.ts";

/**
 * What the note writer reads (fork plan 03 item 3): the session as the
 * Markdown export's text, with `[Figure F1]`, `[Image I1]` and
 * `[Interactive demo: title]` placeholders where those appeared and each
 * side-question thread after the message it was asked about; the figures
 * it may place by id; and the plan's node titles.
 */

export interface NoteFigure {
	/** F1, F2… for figures; I1, I2… for images the teacher showed. */
	id: string;
	kind: "figure" | "image";
	/** The visual's brief, or the image's caption. */
	description: string;
	/** The ready-to-embed image (data URI). */
	src: string;
	alt: string;
}

export interface NoteSource {
	text: string;
	figures: NoteFigure[];
	planTitles: string[];
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function threadText(thread: SideChatThread): string | null {
	const messages = thread.messages.filter((message) => message.text.trim());
	if (messages.length === 0) return null;
	const first = messages.find((message) => message.role === "user");
	const passage = oneLine(first?.quotes?.[0] ?? thread.anchor.blockText);
	const lines = [`### Side question`, `> ${passage}`];
	for (const message of messages) {
		lines.push(`**${message.role === "user" ? "Learner" : "Answer"}:** ${message.text.trim()}`);
	}
	return lines.join("\n\n");
}

export function noteSource(record: ChatRecord): NoteSource {
	const briefs = new Map<string, string>();
	for (const message of record.messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "visual") continue;
			const brief = (block.arguments as { brief?: unknown } | undefined)?.brief;
			if (typeof brief === "string" && brief.trim()) briefs.set(block.id, oneLine(brief));
		}
	}
	const threads = new Map<string, SideChatThread[]>();
	for (const thread of record.sideChats ?? []) {
		threads.set(thread.anchor.messageId, [...(threads.get(thread.anchor.messageId) ?? []), thread]);
	}
	const figures: NoteFigure[] = [];
	let figureCount = 0;
	let imageCount = 0;

	const placeholder = (message: LhMessage, block: string | null): string | null => {
		if (message.role === "custom" && message.customType === "subagent-steer") {
			const details = message.details as SteerDetails | undefined;
			if (details?.kind === "visual" && !isSubagentFailure("visual", details.result)) {
				const result = details.result as VisualResult;
				const id = `F${++figureCount}`;
				const image = result.image?.snapshotId ? record.imageSnapshots?.[result.image.snapshotId] : undefined;
				figures.push({ id, kind: "figure", description: briefs.get(details.toolCallId) ?? "A figure from the session", src: figureImageSrc(result.svg, image), alt: "Figure" });
				return `[Figure ${id}]`;
			}
			if (details?.kind === "demo" && !isSubagentFailure("demo", details.result)) {
				return `[Interactive demo: ${oneLine((details.result as DemoResult).title)}]`;
			}
			return block;
		}
		if (message.role === "toolResult" && message.toolName === "show_image" && !message.isError) {
			const shown = message.details as ShowImageDetails | undefined;
			const image = shown?.snapshotId ? record.imageSnapshots?.[shown.snapshotId] : undefined;
			if (!shown || !image) return null;
			const id = `I${++imageCount}`;
			const caption = oneLine(shown.caption ?? "");
			figures.push({ id, kind: "image", description: caption || "An image the teacher showed", src: learnerImageSrc(image), alt: caption || "Image" });
			return `[Image ${id}]`;
		}
		return block;
	};

	const text = sessionMarkdown(record.messages, {
		anchors: false,
		render: (message, block) => {
			const own = placeholder(message, block);
			const side = (threads.get(message.id) ?? []).map(threadText).filter((t): t is string => t !== null);
			if (side.length === 0) return own;
			return [own, ...side].filter((part): part is string => part !== null).join("\n\n");
		},
	});

	return {
		text,
		figures,
		planTitles: (record.tree?.nodes ?? []).map((node) => node.title),
	};
}
