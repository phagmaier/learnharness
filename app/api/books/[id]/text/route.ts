import { bookTextWindowOf } from "@/src/server";

/**
 * GET → { from, to, total, blocks }: a window of a book's stored text for
 * the reader (fork plan 05 item 3). `around=<nodeId>` and `at=<block>` (a
 * search match) start a few blocks above a section or block and always
 * hold it, `from=<block>` reads forward, `before=<block>` backward; none
 * reads from the start. `from`/`to` are inclusive block indexes. 409
 * while the import hasn't produced text; 404 an unknown book or section.
 */
type Params = { params: Promise<{ id: string }> };

const blockIndex = (value: string | null): number | undefined | null => {
	if (value === null) return undefined;
	return /^[0-9]{1,9}$/.test(value) ? Number(value) : null;
};

export async function GET(req: Request, ctx: Params) {
	const { id } = await ctx.params;
	const query = new URL(req.url).searchParams;
	const at = blockIndex(query.get("at"));
	const from = blockIndex(query.get("from"));
	const before = blockIndex(query.get("before"));
	if (at === null || from === null || before === null) return Response.json({ error: "Invalid block" }, { status: 400 });
	const around = query.get("around") ?? undefined;
	const result = bookTextWindowOf(id, {
		...(around !== undefined ? { around } : {}),
		...(at !== undefined ? { at } : {}),
		...(from !== undefined ? { from } : {}),
		...(before !== undefined ? { before } : {}),
	});
	if ("ok" in result) return Response.json({ error: result.error }, { status: result.status });
	return Response.json(result);
}
