import { createCourseFromSetup } from "@/src/server";

/**
 * POST /api/courses — create a course from a setup session's proposal, as
 * the learner edited it (fork plan 04):
 *   { setupChatId, toolCallId, title, goal, units: [{ key, title, goal, startingPoint?, prerequisites: key[] }] }
 * Answers 201 { courseId, chatId } with unit 1 started (chatId is null if
 * that start failed). 400 with `problems` for an invalid list; 409 while a
 * turn runs in the setup session, for a replaced proposal, or once the
 * course exists.
 */
export async function POST(req: Request) {
	const body = await req.json().catch(() => null);
	const outcome = createCourseFromSetup(body);
	if (!outcome.ok) return Response.json({ error: outcome.error, ...(outcome.problems ? { problems: outcome.problems } : {}) }, { status: outcome.status });
	return Response.json({ courseId: outcome.courseId, chatId: outcome.chatId }, { status: 201 });
}
