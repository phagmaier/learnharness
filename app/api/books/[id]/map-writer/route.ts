import { isBookRefusal, retryBookMapWriter } from "@/src/server";

/**
 * POST → { book }: "Try again" for a book's map writer (fork plan 05
 * item 2). It continues with the sections not yet summarized. 409 while
 * the contents await review, while the writer runs, or when the map is
 * written or not needed; 503 with no Cheap model configured.
 */
type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Params) {
	const { id } = await ctx.params;
	const result = retryBookMapWriter(id);
	if (isBookRefusal(result)) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ book: result });
}
