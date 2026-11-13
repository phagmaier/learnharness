/**
 * HTML conversation export (plan 03 item 2): GET /api/chats/:id/export.html
 * → the whole Teach session as one self-contained page, built fresh and
 * downloaded (never stored). 404 unknown chat; Practice sessions have no
 * HTML export (they keep the Markdown export).
 */
import { conversationExportHtml, documentResponse, documentSlug, getChat } from "@/src/server";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const record = getChat(id);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	if (record.kind === "practice") {
		return Response.json({ error: "Practice sessions have no HTML export." }, { status: 400 });
	}
	return documentResponse(await conversationExportHtml(record), `${documentSlug(record.title)}.html`, true);
}
