import { deleteCourse, isCourseRefusal, readCourse, updateCourse } from "@/src/server";

/**
 * One course (fork plan 04).
 *
 * GET → { course }: the record. 404 unknown; 409 a damaged record or one
 *       saved by a newer build.
 * PUT { title } → rename. PUT { units } → "Edit units": the whole edited
 *       list (existing units by id; new ones without, building on other
 *       new ones by `new:<index>`). 400 with `problems` when the edit breaks
 *       a rule (a started unit can't be removed; units build only on
 *       earlier units). An optional expectedUpdatedAt refuses stale edits
 *       with 409. A combined title/units write validates both before saving.
 * DELETE ?mode=preserve-graph|delete-nodes → { ok, mode, chatIds, stats,
 *       graphRevision }: the course, its setup and unit sessions, and their
 *       notes (item 9); mode is the session deletion's, applied to each
 *       session. 409 while one of its sessions runs a turn or a background
 *       job (the error names it); 503 while their extraction winds down;
 *       500 when session or course files couldn't be removed (the course
 *       record stays, and Delete again finishes). Linked practice sessions
 *       are kept.
 */
type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Params) {
	const { id } = await ctx.params;
	const course = readCourse(id);
	if (isCourseRefusal(course)) return Response.json({ error: course.error }, { status: course.status });
	return Response.json({ course });
}

export async function PUT(req: Request, ctx: Params) {
	const { id } = await ctx.params;
	const body = (await req.json().catch(() => null)) as { title?: unknown; units?: unknown; expectedUpdatedAt?: unknown } | null;
	if (!body || typeof body !== "object" || (body.title === undefined && body.units === undefined)) {
		return Response.json({ error: "Body must carry a title or units" }, { status: 400 });
	}
	const result = updateCourse(id, body);
	if (isCourseRefusal(result)) {
		return Response.json({ error: result.error, ...(result.problems ? { problems: result.problems } : {}) }, { status: result.status });
	}
	return Response.json({ course: result });
}

export async function DELETE(req: Request, ctx: Params) {
	const { id } = await ctx.params;
	const mode = new URL(req.url).searchParams.get("mode");
	if (mode !== "preserve-graph" && mode !== "delete-nodes") {
		return Response.json({ error: 'mode is required and must be "preserve-graph" or "delete-nodes"', code: "bad_mode" }, { status: 400 });
	}
	const outcome = await deleteCourse(id, mode);
	if (!outcome.ok) {
		return Response.json({
			error: outcome.error,
			...("code" in outcome && outcome.code ? { code: outcome.code } : {}),
			...("chatId" in outcome && outcome.chatId ? { chatId: outcome.chatId } : {}),
		}, { status: outcome.status });
	}
	return Response.json(outcome);
}
