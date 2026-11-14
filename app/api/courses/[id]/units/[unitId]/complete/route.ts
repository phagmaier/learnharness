import { completeUnit } from "@/src/server";

/**
 * POST /api/courses/:id/units/:unitId/complete — complete a unit (fork plan
 * 04 item 6): confirmed after the teacher's goal signal, early before it.
 * Body (optional): { note?: { instruction?, interactive? } }, the
 * completion dialog's "Generate a note" offer. 200 { course, noteError? };
 * 409 while a turn or background job runs in the unit, or when the unit
 * isn't in progress.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; unitId: string }> }) {
	const { id, unitId } = await ctx.params;
	const body = (await req.json().catch(() => null)) as { note?: unknown } | null;
	const outcome = completeUnit(id, unitId, { note: body && typeof body === "object" ? body.note : undefined });
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	return Response.json({ course: outcome.course, ...(outcome.noteError ? { noteError: outcome.noteError } : {}) });
}
