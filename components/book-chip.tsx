"use client";

import Link from "next/link";
import { BookIcon } from "lucide-react";
import type { SessionBookView } from "@/src/core";

/**
 * The top bar's book chip (fork plan 05, item 4): a session or course with
 * a book shows its title and opens the book. Item 5 opens the reader panel
 * beside the chat instead; until then the chip opens the book's full page.
 */
export function BookChip({ book }: { book: SessionBookView }) {
	return (
		<Link
			href={`/books/${encodeURIComponent(book.bookId)}`}
			data-testid="book-chip"
			data-book={book.bookId}
			title={book.title}
			aria-label={`Book: ${book.title}`}
			className="flex min-w-0 max-w-[14rem] shrink items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
		>
			<BookIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
			<span className="min-w-0 truncate">{book.title}</span>
		</Link>
	);
}
