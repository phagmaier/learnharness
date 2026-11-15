"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { BookIcon } from "lucide-react";
import { MenuShell } from "@/components/menu-shell";
import { bookPickerEntries, type BookPickerEntry, type LibraryBook } from "@/components/book-view";

/**
 * The composers' "Book" control (fork plan 05, item 4; decision 5): one
 * library book chosen when a Teach session or a course starts. In Course
 * mode the chosen book also takes "Follow its structure" (the default) or
 * "Reference only". Home and the /chat/new draft both carry it, hidden in
 * Practice mode (human, 2026-11-14).
 */

export interface ComposerBook {
	bookId: string;
	title: string;
}

export type ComposerBookMode = "follow" | "reference";

/** What the session's creation carries for the chosen book, if any. */
export function composerBookBody(mode: "teach" | "practice" | "course", book: ComposerBook | null, bookMode: ComposerBookMode): { book: { bookId: string; mode?: ComposerBookMode } } | Record<string, never> {
	if (!book || mode === "practice") return {};
	return { book: mode === "course" ? { bookId: book.bookId, mode: bookMode } : { bookId: book.bookId } };
}

const PILL = "flex min-w-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors disabled:cursor-default disabled:opacity-60";

/** The pure menu body: the books to choose from, or why there are none. */
export function BookPickerMenuBody({ entries, error, onPick }: {
	entries: BookPickerEntry[] | null;
	error: string | null;
	onPick: (entry: BookPickerEntry) => void;
}) {
	if (error) return <p role="alert" data-testid="book-picker-error" className="px-2.5 py-1.5 text-destructive">{error}</p>;
	if (entries === null) return <p role="status" className="px-2.5 py-1.5 text-muted-foreground">Loading books…</p>;
	if (entries.length === 0) {
		return (
			<p data-testid="book-picker-empty" className="px-2.5 py-1.5 text-muted-foreground">
				No books ready yet. Import one in <Link href="/books" className="underline underline-offset-2 hover:text-foreground">Books</Link>.
			</p>
		);
	}
	return (
		<>
			{entries.map((entry) => (
				<button
					key={entry.id}
					type="button"
					data-testid="book-picker-option"
					data-book={entry.id}
					disabled={entry.unavailable !== undefined}
					onClick={() => onPick(entry)}
					className="flex flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition-colors enabled:hover:bg-accent disabled:cursor-default"
				>
					<span className={`max-w-full truncate ${entry.unavailable ? "text-muted-foreground" : "text-foreground"}`}>{entry.title}</span>
					<span className="max-w-full truncate text-[11px] text-muted-foreground">{entry.unavailable ?? entry.facts}</span>
				</button>
			))}
		</>
	);
}

/** "Follow its structure" | "Reference only", the home mode switch's look. */
export function BookModeSwitch({ value, onChange, disabled }: { value: ComposerBookMode; onChange: (mode: ComposerBookMode) => void; disabled?: boolean }) {
	return (
		<div className="flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5" data-testid="book-mode" role="radiogroup" aria-label="How the course uses the book">
			{(["follow", "reference"] as const).map((option) => (
				<button
					key={option}
					type="button"
					role="radio"
					aria-checked={value === option}
					data-testid={`book-mode-${option}`}
					disabled={disabled}
					onClick={() => onChange(option)}
					className={
						"rounded-sm px-2 py-0.5 font-ui text-[11px] transition-colors " +
						(value === option ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")
					}
				>
					{option === "follow" ? "Follow its structure" : "Reference only"}
				</button>
			))}
		</div>
	);
}

/** The control: the pill (dashed "Book" until one is chosen), Course
 *  mode's switch, and Clear. The library is read each time the menu opens;
 *  the server checks the book again when the session is created. */
export function BookPickerControl({ book, onChange, mode, bookMode, onModeChange, disabled }: {
	book: ComposerBook | null;
	onChange: (book: ComposerBook | null) => void;
	mode: "teach" | "course";
	bookMode: ComposerBookMode;
	onModeChange: (mode: ComposerBookMode) => void;
	disabled?: boolean;
}) {
	const anchorRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [entries, setEntries] = useState<BookPickerEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(async () => {
		try {
			const response = await fetch("/api/books", { cache: "no-store" });
			const body = await response.json().catch(() => null) as { books?: LibraryBook[]; error?: string } | null;
			if (!response.ok || !body?.books) { setError(body?.error ?? "The library couldn't be read."); return; }
			setError(null);
			setEntries(bookPickerEntries(body.books));
		} catch {
			setError("The library couldn't be read.");
		}
	}, []);
	return (
		<div className="flex min-w-0 items-center gap-1.5">
			<button
				ref={anchorRef}
				type="button"
				data-testid="book-picker"
				disabled={disabled}
				aria-haspopup="menu"
				aria-expanded={open}
				title={book?.title}
				onClick={() => { setOpen(true); setEntries(null); setError(null); void load(); }}
				className={PILL + " " + (book
					? "border-border bg-card text-foreground hover:bg-accent"
					: "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground")}
			>
				<BookIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
				<span data-testid="book-picker-label" className="min-w-0 max-w-[16rem] truncate">{book ? book.title : "Book"}</span>
			</button>
			{book && mode === "course" && <BookModeSwitch value={bookMode} onChange={onModeChange} disabled={disabled} />}
			{book && (
				<button
					type="button"
					data-testid="book-picker-clear"
					disabled={disabled}
					onClick={() => onChange(null)}
					className="shrink-0 cursor-pointer rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Clear
				</button>
			)}
			{open && (
				<MenuShell
					anchorRef={anchorRef}
					testid="book-picker-menu"
					preferredSide="up"
					align="left"
					onClose={() => { setOpen(false); return "closed"; }}
					menuClass="flex w-72 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					<BookPickerMenuBody
						entries={entries}
						error={error}
						onPick={(entry) => { onChange({ bookId: entry.id, title: entry.title }); setOpen(false); }}
					/>
				</MenuShell>
			)}
		</div>
	);
}
