import { notFound } from "next/navigation";
import { BookPage } from "@/components/book-page";
import { isBookRefusal, readBook } from "@/src/server";

export const dynamic = "force-dynamic";

/** A library book's page and full-page reader (fork plan 05 item 3). */
export default async function BookRoute({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const book = readBook(id);
	if (isBookRefusal(book)) {
		if (book.status === 404) notFound();
		return (
			<div className="flex h-dvh items-center justify-center p-8">
				<p role="alert" className="max-w-md text-center text-sm text-muted-foreground">{book.error}</p>
			</div>
		);
	}
	return <BookPage key={book.book.id} initial={{ ...book, usedBy: book.usedBy ?? [] }} />;
}
