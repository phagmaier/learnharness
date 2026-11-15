import { deleteBook, isBookRefusal, readBook, renameBook } from "@/src/server";

/**
 * One library book (fork plan 05).
 *
 * GET → { book, map, usedBy }: the record's view, its current map (null
 *       until the import finishes), and the courses and sessions using it
 *       (left out with ?users=0, which skips reading every session).
 *       404 unknown; 409 a damaged record or one saved by a newer build.
 * PUT { title?, author? } → { book }: rename. An empty author clears it.
 * DELETE → { ok }: delete the book's copy and map, stopping a running
 *       import or writer first. 409 with `usedBy` while any course or
 *       session uses it.
 */
type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Params) {
	const { id } = await ctx.params;
	const result = readBook(id, { users: new URL(req.url).searchParams.get("users") !== "0" });
	if (isBookRefusal(result)) return Response.json({ error: result.error }, { status: result.status });
	return Response.json(result);
}

export async function PUT(req: Request, ctx: Params) {
	const { id } = await ctx.params;
	const body = (await req.json().catch(() => null)) as { title?: unknown; author?: unknown } | null;
	if (!body || typeof body !== "object") return Response.json({ error: "Invalid body" }, { status: 400 });
	const result = renameBook(id, body);
	if (isBookRefusal(result)) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ book: result });
}

export async function DELETE(_req: Request, ctx: Params) {
	const { id } = await ctx.params;
	const result = deleteBook(id);
	if (isBookRefusal(result)) return Response.json({ error: result.error, ...(result.usedBy ? { usedBy: result.usedBy } : {}) }, { status: result.status });
	return Response.json({ ok: true });
}
