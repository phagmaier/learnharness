"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EllipsisIcon } from "lucide-react";
import type { BookMap } from "@/src/core";
import { TopBar } from "@/components/top-bar";
import { MenuShell } from "@/components/menu-shell";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { BookReader } from "@/components/book-reader";
import { ContentsReview } from "@/components/book-contents-review";
import { DeleteBookDialog } from "@/components/delete-book-dialog";
import { retryUrl } from "@/components/books-library";
import {
	BOOK_FORMAT_LABEL,
	bookSizeLine,
	bookStateLine,
	contentsSourceLine,
	mapUsageLine,
	type BookPageBook,
	type BookUserView,
} from "@/components/book-view";
import { cn } from "@/lib/utils";

/**
 * A book's page, /books/<id> (fork plan 05, item 3): the header with the
 * title (click to rename), the author (click to edit), the format and
 * size, "Divided by the app" for app-made parts, the map's state and
 * usage, where the contents came from with "Not right" (until a course or
 * session uses the book), and "Used by". Below it, by the import's state:
 * "Importing…", the failure with Try again, "Check the contents", or the
 * reader. The header's menu holds "Delete book…". Open views refetch on
 * books-changed.
 */

const ACTION = "rounded-md border px-2.5 py-1 font-ui text-[11px] uppercase tracking-wider transition-colors hover:bg-accent disabled:opacity-50";

export interface BookPageData {
	book: BookPageBook;
	map: BookMap | null;
	usedBy: BookUserView[];
}

/** The facts under the title, exported for render tests. */
export function BookFacts({ book, usedBy, retrying = false, retryError = null, onRetry, onNotRight, authorEditor }: {
	book: BookPageBook;
	usedBy: readonly BookUserView[];
	retrying?: boolean;
	retryError?: string | null;
	onRetry?: () => void;
	/** Present while the contents may still change. */
	onNotRight?: (() => void) | undefined;
	/** The author slot (its click-to-edit control). */
	authorEditor?: React.ReactNode;
}) {
	const state = bookStateLine(book);
	const showMapState = book.import.status === "ready";
	const usage = showMapState ? mapUsageLine(book.mapWriter, book.mapCostUsd) : null;
	const size = bookSizeLine(book);
	return (
		<div data-testid="book-facts" className="space-y-1.5 font-ui text-[11px] text-muted-foreground">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				{authorEditor ?? (book.author ? <span data-testid="book-author" className="font-prose text-sm text-foreground">{book.author}</span> : null)}
				<span data-testid="book-format">{BOOK_FORMAT_LABEL[book.format]}</span>
				{size && <span>· {size}</span>}
			</div>
			{showMapState && (
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span data-testid="book-map-state" className={cn(state.tone === "failed" ? "text-destructive" : state.tone === "busy" ? "text-primary" : "")}>{state.text}</span>
					{usage && <span data-testid="book-map-usage">· {usage}</span>}
					{state.retry && onRetry && (
						<button type="button" data-testid="book-map-retry" className={ACTION} disabled={retrying} onClick={onRetry}>{retrying ? "Trying again…" : "Try again"}</button>
					)}
					{retryError && <span role="alert" className="text-destructive">{retryError}</span>}
				</div>
			)}
			{book.import.notice && <p data-testid="book-notice">{book.import.notice}</p>}
			{showMapState && book.structure && book.contentsAccepted && (
				<div className="flex flex-wrap items-center gap-x-2">
					<span data-testid="book-contents-source">{contentsSourceLine(book.format, book.structure)}</span>
					{onNotRight && <span aria-hidden>·</span>}
					{onNotRight && (
						<button type="button" data-testid="book-not-right" onClick={onNotRight} className="underline-offset-2 hover:text-foreground hover:underline">Not right</button>
					)}
				</div>
			)}
			{usedBy.length > 0 && (
				<p data-testid="book-used-by">
					Used by:{" "}
					{usedBy.map((user, i) => (
						<span key={`${user.kind}:${user.id}`}>
							{i > 0 && ", "}
							{user.href
								? <Link href={user.href} className="text-foreground underline-offset-2 hover:underline">{user.title}</Link>
								: <span className="text-foreground">{user.title}</span>}
						</span>
					))}
				</p>
			)}
		</div>
	);
}

/** Click-to-edit text for the title and the author. */
function InlineEdit({ value, placeholder, label, className, inputClassName, testid, onCommit, onEditingChange }: {
	value: string;
	placeholder?: string;
	label: string;
	className: string;
	inputClassName: string;
	testid: string;
	onCommit: (next: string) => Promise<boolean>;
	/** The title's editing turns the top bar's window drag off, as the
	 *  course title does: the drag band would eat the click that leaves it. */
	onEditingChange?: (editing: boolean) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(value);
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => { if (editing) { ref.current?.focus(); ref.current?.select(); } }, [editing]);
	useEffect(() => { onEditingChange?.(editing); }, [editing, onEditingChange]);
	if (!editing) {
		return (
			<button type="button" data-testid={testid} title={label} onClick={() => { setDraft(value); setEditing(true); }} className={className}>
				{value || <span className="text-muted-foreground">{placeholder}</span>}
			</button>
		);
	}
	const commit = async () => {
		const next = draft.replace(/\s+/g, " ").trim();
		if (next === value) { setEditing(false); return; }
		setEditing(false);
		if (!(await onCommit(next))) setEditing(true);
	};
	return (
		<input
			ref={ref}
			aria-label={label}
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={() => void commit()}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") { e.stopPropagation(); setEditing(false); }
			}}
			className={inputClassName}
		/>
	);
}

export function BookPage({ initial }: { initial: BookPageData }) {
	const router = useRouter();
	const [data, setData] = useState(initial);
	const [error, setError] = useState<string | null>(null);
	const [switching, setSwitching] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [retrying, setRetrying] = useState(false);
	const [retryError, setRetryError] = useState<string | null>(null);
	const [titleEditing, setTitleEditing] = useState(false);
	const menuRef = useRef<HTMLButtonElement>(null);
	// The deletion's own event must not refetch a book that's gone. Only the
	// delete request (and its success) holds refreshes off: while the dialog
	// merely stands open, renames and progress still land, and a refused or
	// failed delete catches up on what it held off.
	const deletingRef = useRef(false);
	const { book, map, usedBy } = data;
	const bookId = book.id;

	/** Refetch the book; `users` also rescans who uses it, which only a
	 *  session or course change can alter. */
	const refresh = useCallback(async (users = true) => {
		if (deletingRef.current) return;
		try {
			const response = await fetch(`/api/books/${encodeURIComponent(bookId)}${users ? "" : "?users=0"}`, { cache: "no-store" });
			const body = (await response.json().catch(() => ({}))) as Partial<BookPageData> & { error?: string };
			if (body.book) {
				const { book: next, map: nextMap = null, usedBy: nextUsers } = body;
				setData((current) => ({ book: next, map: nextMap, usedBy: nextUsers ?? current.usedBy }));
			} else if (response.status === 404) router.push("/books");
		} catch { /* offline: keep the last view */ }
	}, [bookId, router]);
	useServerEvent("books-changed", (payload) => { if (payload.bookId === bookId) void refresh(false); });
	useServerEvent("chats-changed", () => void refresh());
	useServerEvent("courses-changed", () => void refresh());
	useServerResync(() => void refresh());

	const rename = async (input: { title?: string; author?: string }): Promise<boolean> => {
		setError(null);
		if (input.title !== undefined && !input.title) { setError("The title can't be empty."); return false; }
		try {
			const response = await fetch(`/api/books/${encodeURIComponent(bookId)}`, {
				method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
			});
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			if (!response.ok) { setError(body.error ?? "Couldn't rename the book."); return false; }
			await refresh();
			return true;
		} catch {
			setError("Couldn't reach the app. Try again.");
			return false;
		}
	};

	const retry = async (kind: "import" | "map") => {
		setRetrying(true);
		setRetryError(null);
		try {
			const response = await fetch(retryUrl(bookId, kind), { method: "POST" });
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			if (!response.ok) setRetryError(body.error ?? "Couldn't try again.");
		} catch {
			setRetryError("Couldn't reach the app. Try again.");
		}
		setRetrying(false);
		void refresh();
	};

	const status = book.import.status;
	const canSwitch = status === "ready" && usedBy.length === 0;
	const showReader = status === "ready" && !switching && map;

	return (
		<div className="flex h-dvh min-w-0 flex-1 flex-col">
			<TopBar drag={!titleEditing}>
				<InlineEdit
					value={book.title}
					onEditingChange={setTitleEditing}
					label="Rename book"
					testid="book-title"
					className="min-w-0 shrink truncate text-left font-title text-3xl tracking-tight"
					inputClassName="lh-input min-w-0 flex-1 border-0 border-b border-border bg-transparent font-title text-3xl tracking-tight outline-none"
					onCommit={(title) => rename({ title })}
				/>
				<div className="flex-1" />
				<Link href="/books" className="shrink-0 font-ui text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground">Books</Link>
				<button ref={menuRef} type="button" aria-label="Book menu" data-testid="book-menu" onClick={() => setMenuOpen(true)} className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
					<EllipsisIcon className="size-4" aria-hidden />
				</button>
			</TopBar>
			<div className="shrink-0 border-b border-border/60 px-4 py-3">
				<BookFacts
					book={book}
					usedBy={usedBy}
					retrying={retrying}
					retryError={retryError}
					onRetry={() => void retry("map")}
					onNotRight={canSwitch && !switching ? () => setSwitching(true) : undefined}
					authorEditor={(
						<InlineEdit
							value={book.author ?? ""}
							placeholder="Add author"
							label="Edit author"
							testid="book-author"
							className="text-left font-prose text-sm text-foreground"
							inputClassName="lh-input w-64 border-0 border-b border-border bg-transparent text-sm outline-none"
							onCommit={(author) => rename({ author })}
						/>
					)}
				/>
				{error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
			</div>
			{showReader ? (
				<BookReader key={`${bookId}:${book.structure}`} bookId={bookId} nodes={map.nodes} />
			) : (
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="mx-auto w-full max-w-[46rem] px-4 py-8">
						{status === "importing" && <p role="status" data-testid="book-importing" className="font-prose text-sm text-muted-foreground">{bookStateLine(book).text}</p>}
						{status === "failed" && (
							<div data-testid="book-failed" className="space-y-3">
								<p role="alert" className="font-prose text-(length:--lh-prose-size) text-destructive">{book.import.error ?? "The import failed. Try again."}</p>
								{book.retryable !== false && (
									<button type="button" data-testid="book-import-retry" className={ACTION} disabled={retrying} onClick={() => void retry("import")}>{retrying ? "Trying again…" : "Try again"}</button>
								)}
								{retryError && <p role="alert" className="text-xs text-destructive">{retryError}</p>}
							</div>
						)}
						{(status === "review" || (status === "ready" && switching)) && (
							<ContentsReview
								book={book}
								currentNodes={map?.nodes ?? null}
								mode={status === "review" ? "review" : "switch"}
								onDone={() => { setSwitching(false); void refresh(); }}
								onCancel={() => setSwitching(false)}
							/>
						)}
						{status === "ready" && !switching && !map && <p role="alert" className="text-sm text-destructive">This book&apos;s contents can&apos;t be read.</p>}
					</div>
				</div>
			)}
			{menuOpen && (
				<MenuShell
					onClose={() => { setMenuOpen(false); return "closed"; }}
					anchorRef={menuRef}
					testid="book-context-menu"
					preferredSide="down"
					menuClass="flex w-52 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					<button
						type="button"
						data-testid="book-delete"
						onClick={() => { setMenuOpen(false); setDeleting(true); }}
						className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
					>
						Delete book…
					</button>
				</MenuShell>
			)}
			<DeleteBookDialog
				book={deleting ? { id: bookId, title: book.title } : null}
				onClose={() => setDeleting(false)}
				onDeletingChange={(active) => { deletingRef.current = active; if (!active) void refresh(); }}
				onDeleted={() => { setDeleting(false); router.push("/books"); }}
			/>
		</div>
	);
}
