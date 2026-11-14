import { isCourseRefusal, reopenUnit } from "@/src/server";

/** POST /api/courses/:id/units/:unitId/reopen — "Reopen unit" (fork plan
 *  04 item 6): a completed unit goes back to in progress; its handoff stays
 *  until the next completion. 200 { course }; 409 when it isn't completed. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string; unitId: string }> }) {
	const { id, unitId } = await ctx.params;
	const course = reopenUnit(id, unitId);
	if (isCourseRefusal(course)) return Response.json({ error: course.error }, { status: course.status });
	return Response.json({ course });
}
