/**
 * POST → stop a note's running writer (fork plan 03 item 3). A new note
 * settles as stopped; a stopped rewrite keeps the current version. 409 when
 * nothing is running for the note.
 */
import { stopNote } from "@/src/server";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string; noteId: string }> }): Promise<Response> {
	const { id, noteId } = await ctx.params;
	if (!stopNote(id, noteId)) return Response.json({ ok: false, reason: "not_running" }, { status: 409 });
	return Response.json({ ok: true });
}
