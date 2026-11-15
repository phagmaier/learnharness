import { searchBook } from "@/src/server";

/**
 * GET ?q= → { hits, total }: search a book's text (fork plan 05 item 3),
 * case- and accent-insensitive, the query as one phrase. Hits come in book
 * order, at most 100, each with its block, section, page, stored offsets
 * and a snippet; `total` counts every match. 409 while the import hasn't
 * produced text.
 */
type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Params) {
	const { id } = await ctx.params;
	const q = new URL(req.url).searchParams.get("q") ?? "";
	if (q.length > 500) return Response.json({ error: "Search for at most 500 characters." }, { status: 400 });
	const result = searchBook(id, q);
	if ("ok" in result) return Response.json({ error: result.error }, { status: result.status });
	return Response.json(result);
}
