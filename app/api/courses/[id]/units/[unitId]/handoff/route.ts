import { isCourseRefusal, retryHandoffWriter } from "@/src/server";

/** POST /api/courses/:id/units/:unitId/handoff — the handoff's "Try again"
 *  (fork plan 04 item 6): rerun the writer whose teacher observations
 *  failed, were stopped, or were interrupted. 200 { course }; 409 while it
 *  is writing or once written; 503 without a Strong model. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string; unitId: string }> }) {
	const { id, unitId } = await ctx.params;
	const course = retryHandoffWriter(id, unitId);
	if (isCourseRefusal(course)) return Response.json({ error: course.error }, { status: course.status });
	return Response.json({ course });
}
