/**
 * POST { instruction?, interactive? } → 202 { note }: rewrite a note from
 * the session as it is now (fork plan 03 item 3). A ready note keeps its
 * current version until the new one succeeds; a failed or stopped note is
 * tried again in place. 409 while the note is being written.
 */
import { isNotesUnreadable, regenerateNote } from "@/src/server";

export async function POST(request: Request, ctx: { params: Promise<{ id: string; noteId: string }> }): Promise<Response> {
	const { id, noteId } = await ctx.params;
	const body = (await request.json().catch(() => null)) as { instruction?: unknown; interactive?: unknown } | null;
	if (!body || typeof body !== "object") return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
	try {
		const result = regenerateNote(id, noteId, body);
		if (!result.ok) {
			const { ok: _ok, status, ...payload } = result;
			return Response.json(payload, { status });
		}
		return Response.json({ note: result.note }, { status: 202 });
	} catch (error) {
		if (isNotesUnreadable(error)) return Response.json({ error: error.message }, { status: 409 });
		throw error;
	}
}
