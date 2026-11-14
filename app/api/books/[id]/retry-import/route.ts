import { isBookRefusal, retryBookImport } from "@/src/server";

/**
 * POST → { book }: reconvert a failed import from the stored original
 * (fork plan 05). 409 when the import hasn't failed.
 */
type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Params) {
	const { id } = await ctx.params;
	const result = retryBookImport(id);
	if (isBookRefusal(result)) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ book: result.book });
}
