/**
 * GET → every note of the session that has a version, as one .zip of HTML
 * files named after the notes (fork plan 03; the delete dialog's "Download
 * notes"). The archive is named "<session-title-slug>-notes.zip".
 */
import { isNotesUnreadable, notesArchive } from "@/src/server";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	try {
		const archive = notesArchive(id);
		if ("ok" in archive) return Response.json({ error: archive.error }, { status: archive.status });
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
