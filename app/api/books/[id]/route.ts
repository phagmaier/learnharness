import { isBookRefusal, readBook, renameBook } from "@/src/server";

/**
 * One library book (fork plan 05).
 *
 * GET → { book, map }: the record's view and its current map (null until
 *       the import finishes). 404 unknown; 409 a damaged record or one saved
 *       by a newer build.
 * PUT { title?, author? } → { book }: rename. An empty author clears it.
 */
type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Params) {
	const { id } = await ctx.params;
	const result = readBook(id);
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
