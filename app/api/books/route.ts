import { importBook, isBookRefusal, listBooks, MAX_BOOK_BYTES } from "@/src/server";
import { FormBodyLimitError, readBoundedFormData } from "@/lib/bounded-form-data.ts";

/**
 * The books library (fork plan 05).
 *
 * GET → { books, unreadable }: every readable book, newest first, with its
 *       import and map writer states (and conversion progress while one runs).
 * POST multipart { file } → { book }: import one book. Refusals that need no
 *       conversion answer at once and create nothing: 400 an unsupported,
 *       unreadable, protected or empty file, or one over 3,000 pages; 413 over
 *       100 MB; 409 a file already in the library (with `existing`). Otherwise
 *       the book is created as "importing" and converted in the background.
 */
export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(listBooks());
}

export async function POST(request: Request) {
	let form: FormData;
	try {
		form = await readBoundedFormData(request, MAX_BOOK_BYTES + 1024 * 1024);
	} catch (error) {
		const oversized = error instanceof FormBodyLimitError;
		return Response.json({ error: oversized ? "Too big. Max 100 MB." : "Could not read the upload. It may be incomplete; please choose the file again." }, { status: oversized ? 413 : 400 });
	}
	const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
	if (files.length !== 1) return Response.json({ error: "Choose one file." }, { status: 400 });
	const file = files[0]!;
	const result = await importBook(file.name, new Uint8Array(await file.arrayBuffer()));
	if (isBookRefusal(result)) return Response.json({ error: result.error, ...(result.existing ? { existing: result.existing } : {}) }, { status: result.status });
	return Response.json({ book: result.book });
}
