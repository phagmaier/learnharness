/**
 * GET → every unit's notes that have a version, as one .zip with a folder
 * per unit ("<n>-<unit-slug>/"), named "<course-title-slug>-notes.zip"
 * (fork plan 04 item 8). 409 when the course record or a unit's notes
 * index can't be read (the error names the unit).
 */
import { courseNotesArchive, isCourseRefusal, isNotesUnreadable, readCourse } from "@/src/server";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const course = readCourse(id);
	if (isCourseRefusal(course)) return Response.json({ error: course.error }, { status: course.status });
	try {
		const archive = courseNotesArchive(course);
		return new Response(new Uint8Array(archive.zip), {
			headers: {
				"content-type": "application/zip",
				"content-disposition": `attachment; filename="${archive.filename}"`,
				"cache-control": "no-store",
			},
		});
	} catch (error) {
		if (isNotesUnreadable(error)) return Response.json({ error: error.message }, { status: 409 });
		throw error;
	}
}
