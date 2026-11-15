"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { BookIcon, UploadIcon } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { bookFactsLine, bookStateLine, type BookStateTone, type LibraryBook } from "@/components/book-view";
import { cn } from "@/lib/utils";

/**
 * The Books library (fork plan 05, item 3): "Import book" and every book,
 * newest first, each row with its facts and state, opening the book page.
 * A failed import or map writer offers Try again on its row. Open views
 * refetch on books-changed.
 */

const ACTION = "rounded-md border px-2.5 py-1 font-ui text-[11px] uppercase tracking-wider transition-colors hover:bg-accent disabled:opacity-50";
export const BOOK_FILE_TYPES = ".pdf,.epub,.txt,.text,.md,.markdown";

const TONE: Record<BookStateTone, string> = {
	busy: "text-primary",
	attention: "text-primary",
	done: "text-muted-foreground",
	failed: "text-destructive",
};

/** The retry route behind a row's Try again. */
export function retryUrl(bookId: string, retry: "import" | "map"): string {
	return `/api/books/${encodeURIComponent(bookId)}/${retry === "import" ? "retry-import" : "map-writer"}`;
}

/** One library row; Try again sits beside a failure. */
export function BookRow({ book, retrying = false, retryError = null, onRetry }: {
	book: LibraryBook;
	retrying?: boolean;
	retryError?: string | null;
	onRetry?: () => void;
}) {
	const state = bookStateLine(book);
	return (
		<li data-testid="book-row" data-book={book.id} className="relative rounded-xl border bg-card/60 transition-colors hover:bg-accent/40">
			<div className="flex items-start gap-3 p-4">
				<BookIcon className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
				<div className="min-w-0 flex-1 wrap-anywhere">
					{/* The whole row opens the book; Try again stays its own button. */}
					<Link href={`/books/${encodeURIComponent(book.id)}`} data-testid="book-open" className="font-prose text-(length:--lh-prose-size) font-medium after:absolute after:inset-0 after:content-['']">
						{book.title}
					</Link>
					<p data-testid="book-facts" className="mt-0.5 font-ui text-[11px] text-muted-foreground">{bookFactsLine(book)}</p>
				</div>
				<div className="relative flex shrink-0 flex-col items-end gap-1.5 text-right">
					<span data-testid="book-state" data-tone={state.tone} className={cn("max-w-[18rem] font-ui text-[11px]", TONE[state.tone])}>{state.text}</span>
					{state.retry && onRetry && (
						<button type="button" data-testid="book-retry" className={ACTION} disabled={retrying} onClick={onRetry}>
							{retrying ? "Trying again…" : "Try again"}
						</button>
					)}
					{retryError && <span role="alert" className="max-w-[18rem] text-xs text-destructive">{retryError}</span>}
				</div>
			</div>
		</li>
	);
}

/** A refusal from the import route, with the duplicate's title linked. */
export function ImportError({ error, existing }: { error: string; existing?: { id: string; title: string } }) {
	const prefix = "This book is already in your library: ";
	if (existing && error.startsWith(prefix)) {
		return (
			<p role="alert" data-testid="book-import-error" className="text-sm text-destructive">
				{prefix}
				<Link href={`/books/${encodeURIComponent(existing.id)}`} className="underline underline-offset-2">{existing.title}</Link>.
			</p>
		);
	}
	return <p role="alert" data-testid="book-import-error" className="text-sm text-destructive">{error}</p>;
}

export function LibraryList({ books, unreadable, retrying, retryErrors, onRetry }: {
	books: LibraryBook[];
	unreadable: number;
	retrying?: string | null;
	retryErrors?: Record<string, string>;
	onRetry?: (book: LibraryBook) => void;
}) {
	return (
		<>
			{books.length === 0 ? (
				<p data-testid="books-empty" className="font-prose text-sm text-muted-foreground">No books yet. Import a PDF, EPUB, text or Markdown file.</p>
			) : (
				<ul className="space-y-2" data-testid="books-list">
					{books.map((book) => (
						<BookRow
							key={book.id}
							book={book}
							retrying={retrying === book.id}
							retryError={retryErrors?.[book.id] ?? null}
							{...(onRetry ? { onRetry: () => onRetry(book) } : {})}
						/>
					))}
				</ul>
			)}
			{unreadable > 0 && (
				<p data-testid="books-unreadable" className="mt-4 font-ui text-[11px] text-muted-foreground">
					{unreadable === 1 ? "1 book in the library can't be read." : `${unreadable} books in the library can't be read.`}
				</p>
			)}
		</>
	);
}

export function BooksLibrary({ initialBooks, initialUnreadable }: { initialBooks: LibraryBook[]; initialUnreadable: number }) {
	const [books, setBooks] = useState(initialBooks);
	const [unreadable, setUnreadable] = useState(initialUnreadable);
	const [uploading, setUploading] = useState(false);
	const [importError, setImportError] = useState<{ error: string; existing?: { id: string; title: string } } | null>(null);
	const [retrying, setRetrying] = useState<string | null>(null);
	const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});
	const fileRef = useRef<HTMLInputElement>(null);

	const refresh = useCallback(async () => {
		try {
			const response = await fetch("/api/books", { cache: "no-store" });
			const body = (await response.json().catch(() => null)) as { books?: LibraryBook[]; unreadable?: string[] } | null;
			if (body?.books) { setBooks(body.books); setUnreadable(body.unreadable?.length ?? 0); }
		} catch { /* offline: keep the last list */ }
	}, []);
	useServerEvent("books-changed", () => void refresh());
	useServerResync(() => void refresh());

	const upload = async (file: File) => {
		setUploading(true);
		setImportError(null);
		try {
			const form = new FormData();
			form.append("file", file);
			const response = await fetch("/api/books", { method: "POST", body: form });
			const body = (await response.json().catch(() => ({}))) as { book?: LibraryBook; error?: string; existing?: { id: string; title: string } };
			if (body.book) setBooks((current) => [body.book!, ...current.filter((book) => book.id !== body.book!.id)]);
			else setImportError({ error: body.error ?? "Couldn't import the book.", ...(body.existing ? { existing: body.existing } : {}) });
		} catch {
			setImportError({ error: "Couldn't reach the app. Try again." });
		} finally {
			setUploading(false);
			if (fileRef.current) fileRef.current.value = "";
		}
		void refresh();
	};

	const retry = async (book: LibraryBook) => {
		const kind = bookStateLine(book).retry;
		if (!kind) return;
		setRetrying(book.id);
		setRetryErrors(({ [book.id]: _old, ...rest }) => rest);
		try {
			const response = await fetch(retryUrl(book.id, kind), { method: "POST" });
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			if (!response.ok) setRetryErrors((current) => ({ ...current, [book.id]: body.error ?? "Couldn't try again." }));
		} catch {
			setRetryErrors((current) => ({ ...current, [book.id]: "Couldn't reach the app. Try again." }));
		}
		setRetrying(null);
		void refresh();
	};

	return (
		<div className="flex h-dvh min-w-0 flex-1 flex-col">
			<TopBar>
				<h1 className="min-w-0 flex-1 truncate font-title text-3xl tracking-tight">Books</h1>
				<input
					ref={fileRef}
					type="file"
					accept={BOOK_FILE_TYPES}
					className="hidden"
					data-testid="book-import-input"
					onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); }}
				/>
				<button type="button" data-testid="book-import" className={cn(ACTION, "flex items-center gap-1.5")} disabled={uploading} onClick={() => fileRef.current?.click()}>
					<UploadIcon className="size-3" aria-hidden />
					{uploading ? "Uploading…" : "Import book"}
				</button>
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-[46rem] px-4 py-8">
					{importError && <div className="mb-4"><ImportError {...importError} /></div>}
					<LibraryList books={books} unreadable={unreadable} retrying={retrying} retryErrors={retryErrors} onRetry={(book) => void retry(book)} />
				</div>
			</div>
		</div>
	);
}
