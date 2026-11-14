import { acceptBookContents, bookContents, isBookRefusal } from "@/src/server";

/**
 * A book's contents (fork plan 05, "Check the contents").
 *
 * GET → { current, candidates }: every structure the import found, each with
 *       its confidence, description and nodes. 409 while importing or after
 *       a failed import.
 * PUT { method? } → { book }: without a method, accept the shown contents
 *       ("Looks right"); with one, switch to that candidate and accept it
 *       ("Use these"). 400 for a method the import didn't find.
 */
type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Params) {
	const { id } = await ctx.params;
	const result = bookContents(id);
	if (isBookRefusal(result)) return Response.json({ error: result.error }, { status: result.status });
	return Response.json(result);
}

export async function PUT(req: Request, ctx: Params) {
	const { id } = await ctx.params;
	const body = (await req.json().catch(() => ({}))) as { method?: unknown } | null;
	const result = acceptBookContents(id, body && typeof body === "object" ? body.method : undefined);
	if (isBookRefusal(result)) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ book: result });
}
