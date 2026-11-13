/**
 * Study notes of one Teach session (fork plan 03 item 3).
 *
 * GET  → { notes }: every note, oldest first, with its latest
 *        generation's costUsd (a note the closed app left writing reads as
 *        interrupted).
 * POST { instruction?, interactive? } → 202 { note }: a new note, listed
 *        at once as writing and written in the background. Progress
 *        arrives as notes-changed events.
 *
 * 404 unknown chat; 400 a Practice or course setup session; 409 an index this build can't
 * read; 503 no Strong model configured.
 */
import { createNote, getChat, isNotesUnreadable, listNotesWithCost, SETUP_NO_NOTES } from "@/src/server";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const record = getChat(id);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	if (record.kind === "practice") return Response.json({ error: "Practice sessions have no notes." }, { status: 400 });
	if (record.course?.role === "setup") return Response.json({ error: SETUP_NO_NOTES }, { status: 400 });
	try {
		return Response.json({ notes: listNotesWithCost(id) });
	} catch (error) {
		if (isNotesUnreadable(error)) return Response.json({ error: error.message }, { status: 409 });
		throw error;
	}
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const body = (await request.json().catch(() => null)) as { instruction?: unknown; interactive?: unknown } | null;
	if (!body || typeof body !== "object") return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
	try {
		const result = createNote(id, body);
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
