import { BooksLibrary } from "@/components/books-library";
import { listBooks } from "@/src/server";

export const dynamic = "force-dynamic";

/** The Books library (fork plan 05 item 3). */
export default function BooksPage() {
	const { books, unreadable } = listBooks();
	return <BooksLibrary initialBooks={books} initialUnreadable={unreadable.length} />;
}
