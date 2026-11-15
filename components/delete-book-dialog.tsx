"use client";

import { useEffect, useRef, useState, type ReactElement, type ReactNode, type Ref } from "react";
import Link from "next/link";
import { HostDialog } from "@/components/host-dialog";
import type { BookUserView } from "@/components/book-view";

/**
 * Deleting a book (fork plan 05, decision 8). Opening reads who uses the
 * book now. While anything does, the dialog refuses and lists them, linking
 * each one that can be opened ("This book is used by: <course>, <session>.
 * Delete them first, or keep the book."). Otherwise "Delete book?" says what goes: the book's
 * copy and its map. A refusal that arrives on Delete (something started
 * using it meanwhile) switches to the same list.
 */

export const DELETE_BOOK_LINE = "This deletes the book's copy and its map. Your sessions and courses are not affected.";

/** The refusal's line, with each user linked. */
export function BookUsersLine({ users }: { users: readonly BookUserView[] }) {
	return (
		<p data-testid="delete-book-used" className="mt-2 font-prose text-sm leading-relaxed text-foreground">
			This book is used by:{" "}
			{users.map((user, i) => (
				<span key={`${user.kind}:${user.id}`}>
					{i > 0 && ", "}
					{user.href
						? <Link href={user.href} data-testid="delete-book-user" data-kind={user.kind} className="underline underline-offset-2 hover:text-primary">{user.title}</Link>
						: <span data-testid="delete-book-user" data-kind={user.kind}>{user.title}</span>}
				</span>
			))}
			. Delete them first, or keep the book.
		</p>
	);
}

/** The dialog's pure body, exported for render tests. */
export function DeleteBookBody({ title, users, busy, failure, cancelRef, onClose, onDelete }: {
	title: string;
	/** Null while reading who uses the book. */
	users: readonly BookUserView[] | null;
	busy: boolean;
	failure: string | null;
	cancelRef?: Ref<HTMLButtonElement>;
	onClose: () => void;
	onDelete: () => void;
}) {
	const used = users !== null && users.length > 0;
	return (
		<>
			<h2 className="text-sm font-semibold text-destructive">{used ? "This book can't be deleted yet" : "Delete book?"}</h2>
			<div className="mt-1.5">
				<code data-testid="delete-book-title" className="font-mono text-sm text-foreground">{title}</code>
			</div>
			{users === null && <p role="status" className="mt-2 text-sm text-muted-foreground">Checking what uses this book…</p>}
			{used && <BookUsersLine users={users} />}
			{users !== null && !used && <p data-testid="delete-book-line" className="mt-2 text-sm text-muted-foreground">{DELETE_BOOK_LINE}</p>}
			{failure && <p role="alert" data-testid="delete-book-failure" className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs text-foreground">{failure}</p>}
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					ref={cancelRef}
					data-testid="delete-book-cancel"
					onClick={onClose}
					disabled={busy}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
				>
					{used ? "Keep the book" : "Cancel"}
				</button>
				{!used && (
					<button
						type="button"
						data-testid="delete-book-confirm"
						onClick={onDelete}
						disabled={busy || users === null}
						className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
					>
						{busy ? "Deleting…" : "Delete"}
					</button>
				)}
			</div>
		</>
	);
}

interface DeleteBookDialogProps {
	onClose: () => void;
	/** True when the delete request starts; false when it ends without
	 *  deleting (refused or failed). A success calls onDeleted instead. */
	onDeletingChange?: (deleting: boolean) => void;
	onDeleted: () => void;
}

export function DeleteBookDialog({ book, ...props }: DeleteBookDialogProps & {
	/** The book up for deletion; null = closed. */
	book: { id: string; title: string } | null;
}) {
	return book ? <OpenDeleteBookDialog key={book.id} book={book} {...props} /> : null;
}

function OpenDeleteBookDialog({ book, onClose, onDeletingChange, onDeleted }: DeleteBookDialogProps & { book: { id: string; title: string } }) {
	const [users, setUsers] = useState<BookUserView[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		let live = true;
		void (async () => {
			try {
				const response = await fetch(`/api/books/${encodeURIComponent(book.id)}`, { cache: "no-store" });
				const body = (await response.json().catch(() => ({}))) as { usedBy?: BookUserView[]; error?: string };
				if (!live) return;
				if (body.usedBy) setUsers(body.usedBy);
				else { setUsers([]); setFailure(body.error ?? `Couldn't read the book (${response.status}).`); }
			} catch {
				if (live) { setUsers([]); setFailure("Couldn't reach the app. Try again."); }
			}
		})();
		return () => { live = false; };
	}, [book.id]);

	const remove = async () => {
		setBusy(true);
		setFailure(null);
		onDeletingChange?.(true);
		try {
			const response = await fetch(`/api/books/${encodeURIComponent(book.id)}`, { method: "DELETE" });
			const body = (await response.json().catch(() => ({}))) as { error?: string; usedBy?: BookUserView[] };
			if (response.ok) { onDeleted(); return; }
			if (body.usedBy) setUsers(body.usedBy);
			else setFailure(body.error ?? `Delete failed (${response.status}). Try again.`);
		} catch {
			setFailure("Delete failed — network error. Try again.");
		}
		setBusy(false);
		onDeletingChange?.(false);
	};

	const frame: ReactElement<{ children: ReactNode }> = (
		<div role="dialog" aria-modal="true" aria-label="Delete book" data-testid="delete-book-dialog" className="w-[30rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl" />
	);
	return (
		<HostDialog
			open
			frame={frame}
			initialFocusRef={cancelRef}
			onClose={() => { if (busy) return "blocked"; onClose(); return "closed"; }}
			backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}
		>
			<DeleteBookBody title={book.title} users={users} busy={busy} failure={failure} cancelRef={cancelRef} onClose={onClose} onDelete={() => void remove()} />
		</HostDialog>
	);
}
