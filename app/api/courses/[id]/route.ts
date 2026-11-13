import { editCourseUnits, isCourseRefusal, readCourse, renameCourse } from "@/src/server";

/**
 * One course (fork plan 04).
 *
 * GET → { course }: the record. 404 unknown; 409 a damaged record or one
 *       saved by a newer build.
 * PUT { title } → rename. PUT { units } → "Edit units": the whole edited
 *       list (existing units by id; new ones without, building on other
 *       new ones by `new:<index>`). 400 with `problems` when the edit breaks
 *       a rule (a started unit can't be removed; units build only on
 *       earlier units).
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
	const body = (await req.json().catch(() => null)) as { title?: unknown; units?: unknown } | null;
	if (!body || typeof body !== "object" || (body.title === undefined && body.units === undefined)) {
		return Response.json({ error: "Body must carry a title or units" }, { status: 400 });
	}
	let result = body.title !== undefined ? renameCourse(id, body.title) : readCourse(id);
	if (!isCourseRefusal(result) && body.units !== undefined) result = editCourseUnits(id, body.units);
	if (isCourseRefusal(result)) {
		return Response.json({ error: result.error, ...(result.problems ? { problems: result.problems } : {}) }, { status: result.status });
	}
	return Response.json({ course: result });
}
