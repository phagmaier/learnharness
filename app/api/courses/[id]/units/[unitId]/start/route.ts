import { startUnit } from "@/src/server";

/** POST /api/courses/:id/units/:unitId/start — start a unit (fork plan
 *  04): its session is created and opened by its unit-start marker.
 *  201 { chatId }; 409 when the unit has already started. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string; unitId: string }> }) {
	const { id, unitId } = await ctx.params;
	const outcome = startUnit(id, unitId);
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	return Response.json({ chatId: outcome.chatId }, { status: 201 });
}
