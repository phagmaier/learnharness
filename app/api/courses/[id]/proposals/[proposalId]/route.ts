import { decideCourseProposal, isCourseRefusal } from "@/src/server";

/** POST /api/courses/:id/proposals/:proposalId { decision: "accept" |
 *  "reject" } — the learner's decision on a teacher's proposed course
 *  changes (fork plan 04 item 7). 200 { course }: accepted, rejected, or,
 *  when the changes no longer apply to the current course, outdated with
 *  the reason and nothing changed. 409 once it has been decided. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; proposalId: string }> }) {
	const { id, proposalId } = await ctx.params;
	const body = (await req.json().catch(() => null)) as { decision?: unknown } | null;
	const course = decideCourseProposal(id, proposalId, body?.decision);
	if (isCourseRefusal(course)) return Response.json({ error: course.error }, { status: course.status });
	return Response.json({ course });
}
