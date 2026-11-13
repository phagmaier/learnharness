import { renderDocumentFile } from "../agent/document/render.ts";
import type { ChatRecord } from "../core/contracts.ts";
import { conversationDocument } from "../core/document/conversation.ts";

/**
 * Notes and conversation exports as HTTP responses (plan 03). The files are
 * final pages with model-written content, so they are always served as
 * downloads or into sandboxed frames, with a sandboxing CSP: even opened by
 * URL, a file cannot act as the app's origin.
 */

/** Served with every document: an opaque origin; scripts only inside it.
 *  Links open as ordinary pages (popups escape the sandbox), so a web link
 *  from a plain note still runs its site's scripts in the new tab. */
export const DOCUMENT_RESPONSE_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox";

/** Filename-safe title, as the Markdown export names its files. */
export function documentSlug(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "session";
}

/** The whole teaching session as one self-contained HTML file, built fresh. */
export async function conversationExportHtml(record: ChatRecord): Promise<string> {
	const document = conversationDocument(record);
	const file = await renderDocumentFile({
		title: document.title,
		subtitle: document.subtitle,
		body: document.body,
		...(document.appScript ? { appScript: document.appScript } : {}),
	});
	return file.html;
}

export function documentResponse(html: string, filename: string, download: boolean): Response {
	return new Response(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": DOCUMENT_RESPONSE_CSP,
			"x-content-type-options": "nosniff",
			"cache-control": "no-store",
			...(download ? { "content-disposition": `attachment; filename="${filename}"` } : {}),
		},
	});
}
