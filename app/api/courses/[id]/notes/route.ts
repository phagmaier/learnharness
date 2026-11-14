import { courseNotes, isCourseRefusal, readCourse } from "@/src/server";

/**
 * A course's notes (fork plan 04 item 8): the course Notes tab's list.
 *
 * GET → { units }: each started unit in course order (unitId, number,
 *       title, chatId) with its notes, oldest first, each with its latest
 *       generation's costUsd. A unit whose notes index can't be read
 *       carries `error` and no notes. Notes are written and changed
 *       through the unit session's routes (/api/chats/:chatId/notes…).
 *       404 unknown course; 409 a course record this build can't read.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const course = readCourse(id);
	if (isCourseRefusal(course)) return Response.json({ error: course.error }, { status: course.status });
	return Response.json({ units: courseNotes(course) });
}
