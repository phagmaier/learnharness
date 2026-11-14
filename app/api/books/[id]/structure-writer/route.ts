import { bookContentsPassEstimate, isBookRefusal, runBookContentsPass } from "@/src/server";

/**
 * The optional model contents pass (fork plan 05 item 2, "Find the
 * contents with the model" on "Check the contents").
 *
 * GET  → { tokens, lines, model }: what the pass would read and cost, for
 *        "about <n>k tokens on <model>"; model is null with no Cheap model.
 * POST → { book }: run it. Its headings become the `model` candidate under
 *        GET /api/books/:id/contents, reviewed like any other. 409 before
 *        the import finishes, while a pass runs, or when no line looks like
 *        a heading; 503 with no Cheap model configured.
 */
type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Params) {
	const { id } = await ctx.params;
	const result = bookContentsPassEstimate(id);
	if (isBookRefusal(result)) return Response.json({ error: result.error }, { status: result.status });
	return Response.json(result);
}

export async function POST(_req: Request, ctx: Params) {
	const { id } = await ctx.params;
	const result = runBookContentsPass(id);
	if (isBookRefusal(result)) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ book: result });
}
