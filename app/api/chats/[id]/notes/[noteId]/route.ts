/**
 * One note (fork plan 03 item 3).
 *
 * GET    → the note's final HTML page, for the notes page's sandboxed frame;
 *          ?download=1 makes it an attachment named after the note. Served
 *          with the document sandbox policy either way.
 * DELETE → removes the note and its file (a running writer stops first).
 */
import { deleteNote, documentResponse, documentSlug, getChat, getNote, isNotesUnreadable, readNoteHtml } from "@/src/server";

type Context = { params: Promise<{ id: string; noteId: string }> };

export async function GET(request: Request, ctx: Context): Promise<Response> {
	const { id, noteId } = await ctx.params;
	if (!getChat(id)) return Response.json({ error: "Unknown chat" }, { status: 404 });
	try {
		const note = getNote(id, noteId);
		const html = note ? readNoteHtml(id, noteId) : null;
		if (!note || html === null) return Response.json({ error: "Unknown note" }, { status: 404 });
		const download = new URL(request.url).searchParams.get("download") === "1";
		return documentResponse(html, `${documentSlug(note.title || "note")}.html`, download);
	} catch (error) {
		if (isNotesUnreadable(error)) return Response.json({ error: error.message }, { status: 409 });
		throw error;
	}
}

export async function DELETE(_request: Request, ctx: Context): Promise<Response> {
	const { id, noteId } = await ctx.params;
	if (!getChat(id)) return Response.json({ error: "Unknown chat" }, { status: 404 });
	try {
		if (!deleteNote(id, noteId)) return Response.json({ error: "Unknown note" }, { status: 404 });
		return Response.json({ ok: true });
	} catch (error) {
		if (isNotesUnreadable(error)) return Response.json({ error: error.message }, { status: 409 });
		throw error;
	}
}
