"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeftIcon, DownloadIcon, FileCodeIcon, NotebookPenIcon, PlusIcon, RefreshCwIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { Toggle } from "@/components/settings/controls";
import { InvertDiscIcon } from "@/components/artifacts/invert-disc";
import { HostDialog } from "@/components/host-dialog";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { formatUsd, prettyModel } from "@/components/usage-format";
import { cn } from "@/lib/utils";
import type { NoteEntry } from "@/src/core";

/**
 * The notes page of one Teach session (fork plan 03 item 4): the note list
 * and "New note" on the left, the selected note on the right in a sandboxed
 * frame. Plain notes never run scripts; interactive notes run theirs, and no
 * note shares the app's origin. Notes are written in the background; the
 * page refetches on notes-changed.
 */

export type NoteView = NoteEntry & { costUsd?: number | null };

/** Remembered on this device (agent-selected key). */
export const NOTES_INVERTED_KEY = "lh:notes-inverted";

export const NEW_NOTE_PLACEHOLDER = "Optional: a focus, a topic, or an emphasis (e.g. “I struggle with eigenvectors”, “only diagonalization”, “lots of diagrams”)";
export const INTERACTIVE_LABEL = "Interactive (widgets with scripts)";
export const EMPTY_NOTES = "No notes yet. Write one from this session at any time.";
export const DELETE_NOTE_QUESTION = "Delete this note? This can't be undone.";

/** The frame's sandbox: popups open outside it; only interactive notes run scripts. Never allow-same-origin. */
export function noteFrameSandbox(interactive: boolean): string {
	return interactive ? "allow-scripts allow-popups allow-popups-to-escape-sandbox" : "allow-popups allow-popups-to-escape-sandbox";
}

/** Newest first. */
export function sortNotes(notes: readonly NoteView[]): NoteView[] {
	return [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function firstLine(text: string): string {
	return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

function noteDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

type RowStatus = "writing" | "failed" | "stopped" | "rewriting" | null;

export function noteRowStatus(note: NoteView): RowStatus {
	if (note.status === "writing") return "writing";
	if (note.status === "failed") return note.stopped ? "stopped" : "failed";
	if (note.regenerating && note.regenerating.error === undefined) return "rewriting";
	return null;
}

const STATUS_LABEL: Record<Exclude<RowStatus, null>, string> = {
	writing: "Writing…",
	failed: "Failed",
	stopped: "Stopped",
	rewriting: "Rewriting…",
};

export function NoteListRow({ note, selected, onSelect }: { note: NoteView; selected: boolean; onSelect: () => void }) {
	const status = noteRowStatus(note);
	return (
		<button
			type="button"
			data-testid="note-row"
			data-note-id={note.id}
			data-status={status ?? "ready"}
			aria-current={selected ? "true" : undefined}
			onClick={onSelect}
			className={cn(
				"flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent",
				selected && "bg-accent",
			)}
		>
			<span className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate font-prose text-sm font-semibold text-foreground">
					{note.title || (note.status === "writing" ? "Writing note…" : "Untitled note")}
				</span>
				{note.interactive && (
					<span data-testid="note-interactive-tag" className="shrink-0 rounded border border-border px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
						Interactive
					</span>
				)}
			</span>
			<span className="truncate text-xs text-muted-foreground">{firstLine(note.instruction) || "Default note"}</span>
			<span className="flex items-center gap-2 text-xs text-muted-foreground/80">
				<span suppressHydrationWarning>{noteDate(note.createdAt)}</span>
				{status && (
					<span data-testid="note-status" className={cn(status === "failed" ? "text-error" : "text-muted-foreground")}>
						{STATUS_LABEL[status]}
					</span>
				)}
			</span>
		</button>
	);
}

/** The instruction box with its Interactive checkbox (new notes and Regenerate…). */
export function NoteRequestForm({
	instruction,
	interactive,
	busy,
	submitLabel,
	error,
	onInstruction,
	onInteractive,
	onSubmit,
	onCancel,
}: {
	instruction: string;
	interactive: boolean;
	busy: boolean;
	submitLabel: string;
	error?: string | null;
	onInstruction: (value: string) => void;
	onInteractive: (value: boolean) => void;
	onSubmit: () => void;
	onCancel: () => void;
}) {
	return (
		<form
			data-testid="note-request-form"
			className="flex flex-col gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (!busy) onSubmit();
			}}
		>
			<textarea
				data-testid="note-instruction"
				value={instruction}
				onChange={(event) => onInstruction(event.target.value)}
				placeholder={NEW_NOTE_PLACEHOLDER}
				rows={3}
				className="lh-input w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-sm outline-none focus:border-muted-foreground"
			/>
			<label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
				<input
					type="checkbox"
					data-testid="note-interactive"
					checked={interactive}
					onChange={(event) => onInteractive(event.target.checked)}
					className="size-3.5 accent-primary"
				/>
				{INTERACTIVE_LABEL}
			</label>
			{error && <p role="alert" className="text-xs text-error">{error}</p>}
			<div className="flex gap-2">
				<button
					type="submit"
					data-testid="note-submit"
					disabled={busy}
					className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
				>
					{submitLabel}
				</button>
				<button type="button" onClick={onCancel} className="rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
					Cancel
				</button>
			</div>
		</form>
	);
}

export function NoteFrame({ chatId, note, inverted }: { chatId: string; note: NoteView; inverted: boolean }) {
	return (
		<iframe
			key={`${note.id}:${note.updatedAt}`}
			data-testid="note-frame"
			title={note.title || "Note"}
			src={`/api/chats/${encodeURIComponent(chatId)}/notes/${encodeURIComponent(note.id)}?v=${encodeURIComponent(note.updatedAt)}`}
			sandbox={noteFrameSandbox(note.interactive)}
			className="block h-full w-full border-0 bg-white"
			style={inverted ? { filter: "invert(1) hue-rotate(180deg)" } : undefined}
		/>
	);
}

function ToolbarButton({ onClick, children, testId, danger }: { onClick: () => void; children: ReactNode; testId: string; danger?: boolean }) {
	return (
		<button
			type="button"
			data-testid={testId}
			onClick={onClick}
			className={cn(
				"flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-accent",
				danger ? "text-muted-foreground hover:text-error" : "text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

async function errorOf(response: Response): Promise<string> {
	const body = (await response.json().catch(() => null)) as { error?: string } | null;
	return body?.error ?? `Request failed (${response.status})`;
}

export function NotesPage({
	chatId,
	title,
	initialNotes,
	initialError = null,
}: {
	chatId: string;
	title: string;
	initialNotes: NoteView[];
	initialError?: string | null;
}) {
	const [notes, setNotes] = useState<NoteView[]>(initialNotes);
	const [loadError, setLoadError] = useState<string | null>(initialError);
	const sorted = useMemo(() => sortNotes(notes), [notes]);
	const [selectedId, setSelectedId] = useState<string | null>(sorted[0]?.id ?? null);
	const selected = sorted.find((note) => note.id === selectedId) ?? sorted[0] ?? null;

	const [composing, setComposing] = useState(false);
	const [draft, setDraft] = useState({ instruction: "", interactive: false });
	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [rewrite, setRewrite] = useState<{ instruction: string; interactive: boolean } | null>(null);
	const [rewriteBusy, setRewriteBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<NoteView | null>(null);
	const [exporting, setExporting] = useState(false);
	const [inverted, setInverted] = useState(false);

	useEffect(() => {
		try {
			setInverted(window.localStorage.getItem(NOTES_INVERTED_KEY) === "1");
		} catch { /* storage unavailable: start light */ }
	}, []);
	const toggleInverted = (next: boolean) => {
		setInverted(next);
		try {
			window.localStorage.setItem(NOTES_INVERTED_KEY, next ? "1" : "0");
		} catch { /* storage unavailable: this visit only */ }
	};

	const refresh = useCallback(async () => {
		try {
			const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/notes`, { cache: "no-store" });
			if (!response.ok) {
				setLoadError(await errorOf(response));
				return;
			}
			const body = (await response.json()) as { notes: NoteView[] };
			setNotes(body.notes);
			setLoadError(null);
		} catch { /* offline: the next event or resync refetches */ }
	}, [chatId]);
	useServerEvent("notes-changed", (payload) => {
		if (payload.chatId === chatId) void refresh();
	});
	useServerResync(() => void refresh());

	// A different note selected closes the per-note forms.
	useEffect(() => {
		setRewrite(null);
		setActionError(null);
	}, [selected?.id]);

	const createNote = async () => {
		setCreating(true);
		setCreateError(null);
		try {
			const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/notes`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(draft),
			});
			if (!response.ok) {
				setCreateError(await errorOf(response));
				return;
			}
			const { note } = (await response.json()) as { note: NoteView };
			setNotes((current) => (current.some((n) => n.id === note.id) ? current : [...current, note]));
			setSelectedId(note.id);
			setComposing(false);
			setDraft({ instruction: "", interactive: false });
			void refresh();
		} catch {
			setCreateError("Couldn't reach the app. Try again.");
		} finally {
			setCreating(false);
		}
	};

	const regenerate = async (note: NoteView, request: { instruction: string; interactive: boolean }) => {
		setRewriteBusy(true);
		setActionError(null);
		try {
			const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/notes/${encodeURIComponent(note.id)}/regenerate`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(request),
			});
			if (!response.ok) {
				setActionError(await errorOf(response));
				return;
			}
			setRewrite(null);
			void refresh();
		} catch {
			setActionError("Couldn't reach the app. Try again.");
		} finally {
			setRewriteBusy(false);
		}
	};

	const stop = async (note: NoteView) => {
		await fetch(`/api/chats/${encodeURIComponent(chatId)}/notes/${encodeURIComponent(note.id)}/stop`, { method: "POST" }).catch(() => undefined);
		void refresh();
	};

	const confirmDelete = async () => {
		if (!deleting) return;
		const target = deleting;
		setDeleting(null);
		const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/notes/${encodeURIComponent(target.id)}`, { method: "DELETE" }).catch(() => null);
		if (response && !response.ok && response.status !== 404) setActionError(await errorOf(response));
		setNotes((current) => current.filter((note) => note.id !== target.id));
		void refresh();
	};

	const exportConversation = async () => {
		setExporting(true);
		setActionError(null);
		try {
			const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/export.html`, { cache: "no-store" });
			if (!response.ok) {
				setActionError(await errorOf(response));
				return;
			}
			const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "conversation.html";
			const url = URL.createObjectURL(await response.blob());
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = name;
			anchor.click();
			URL.revokeObjectURL(url);
		} catch {
			setActionError("Couldn't reach the app. Try again.");
		} finally {
			setExporting(false);
		}
	};

	return (
		<div className="flex h-dvh">
			<div className="flex min-w-0 flex-1 flex-col">
				<TopBar>
					<span className="min-w-0 shrink truncate font-title text-3xl tracking-tight">{title}</span>
					<span className="shrink-0 font-ui text-sm uppercase tracking-wide text-muted-foreground" aria-hidden="true">› Notes</span>
					<div className="min-w-4 flex-1" aria-hidden="true" />
					<Link
						href={`/chat/${encodeURIComponent(chatId)}`}
						data-testid="notes-back"
						className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground"
					>
						<ArrowLeftIcon className="size-3.5" aria-hidden />
						Back to chat
					</Link>
				</TopBar>

				<div className="flex min-h-0 flex-1">
					<aside data-testid="notes-list" className="flex w-80 shrink-0 flex-col border-r border-border">
						<div className="border-b border-border/60 p-3">
							{composing ? (
								<NoteRequestForm
									instruction={draft.instruction}
									interactive={draft.interactive}
									busy={creating}
									submitLabel="Write note"
									error={createError}
									onInstruction={(instruction) => setDraft((d) => ({ ...d, instruction }))}
									onInteractive={(interactive) => setDraft((d) => ({ ...d, interactive }))}
									onSubmit={() => void createNote()}
									onCancel={() => { setComposing(false); setCreateError(null); }}
								/>
							) : (
								<button
									type="button"
									data-testid="note-new"
									onClick={() => setComposing(true)}
									className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
								>
									<PlusIcon className="size-3.5" aria-hidden />
									New note
								</button>
							)}
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto p-2">
							{loadError && <p role="alert" className="px-2 py-1 text-xs text-error">{loadError}</p>}
							{sorted.map((note) => (
								<NoteListRow key={note.id} note={note} selected={note.id === selected?.id} onSelect={() => setSelectedId(note.id)} />
							))}
						</div>
						<div className="border-t border-border/60 p-3">
							<button
								type="button"
								data-testid="notes-export"
								onClick={() => void exportConversation()}
								disabled={exporting}
								className="flex w-full items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
							>
								<FileCodeIcon className="size-3.5" aria-hidden />
								{exporting ? "Exporting…" : "Export conversation (HTML)"}
							</button>
						</div>
					</aside>

					<section data-testid="note-pane" className="flex min-w-0 flex-1 flex-col">
						{actionError && <p role="alert" className="border-b border-border/60 px-4 py-2 text-xs text-error">{actionError}</p>}
						{!selected ? (
							<div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
								<NotebookPenIcon className="size-5" aria-hidden />
								<p data-testid="notes-empty">{EMPTY_NOTES}</p>
							</div>
						) : (
							<NotePane
								chatId={chatId}
								note={selected}
								inverted={inverted}
								onInverted={toggleInverted}
								rewrite={rewrite}
								rewriteBusy={rewriteBusy}
								onRewriteOpen={() => setRewrite({ instruction: selected.instruction, interactive: selected.interactive })}
								onRewriteChange={setRewrite}
								onRewriteSubmit={(request) => void regenerate(selected, request)}
								onRetry={() => void regenerate(selected, { instruction: selected.instruction, interactive: selected.interactive })}
								onStop={() => void stop(selected)}
								onDelete={() => setDeleting(selected)}
							/>
						)}
					</section>
				</div>
			</div>
			<HostDialog
				open={deleting !== null}
				onClose={() => { setDeleting(null); return "closed"; }}
				backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}
				frame={<div role="dialog" aria-modal="true" aria-label="Delete note" data-testid="delete-note-dialog" className="w-[26rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl" />}
			>
				<h2 className="text-sm font-semibold text-destructive">{DELETE_NOTE_QUESTION}</h2>
				{deleting?.title && <p className="mt-1.5 font-mono text-sm text-foreground">{deleting.title}</p>}
				<div className="mt-4 flex justify-end gap-2">
					<button type="button" data-testid="delete-note-cancel" onClick={() => setDeleting(null)} className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
						Cancel
					</button>
					<button type="button" data-testid="delete-note-confirm" onClick={() => void confirmDelete()} className="rounded-lg border border-destructive/60 px-3 py-1.5 text-sm text-destructive transition-colors hover:bg-destructive hover:text-white">
						Delete
					</button>
				</div>
			</HostDialog>
		</div>
	);
}

export function NotePane({
	chatId,
	note,
	inverted,
	onInverted,
	rewrite,
	rewriteBusy,
	onRewriteOpen,
	onRewriteChange,
	onRewriteSubmit,
	onRetry,
	onStop,
	onDelete,
}: {
	chatId: string;
	note: NoteView;
	inverted: boolean;
	onInverted: (next: boolean) => void;
	rewrite: { instruction: string; interactive: boolean } | null;
	rewriteBusy: boolean;
	onRewriteOpen: () => void;
	onRewriteChange: (next: { instruction: string; interactive: boolean } | null) => void;
	onRewriteSubmit: (request: { instruction: string; interactive: boolean }) => void;
	onRetry: () => void;
	onStop: () => void;
	onDelete: () => void;
}) {
	if (note.status === "writing") {
		return (
			<div data-testid="note-writing" className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
				<p>Writing note…</p>
				<ToolbarButton testId="note-stop" onClick={onStop}><SquareIcon className="size-3" aria-hidden />Stop</ToolbarButton>
			</div>
		);
	}
	if (note.status === "failed") {
		return (
			<div data-testid="note-failed" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm">
				<p className={note.stopped ? "text-muted-foreground" : "text-error"}>{note.stopped ? "Stopped." : note.error ?? "The note couldn't be written."}</p>
				<div className="flex gap-2">
					<ToolbarButton testId="note-retry" onClick={onRetry}><RefreshCwIcon className="size-3.5" aria-hidden />Try again</ToolbarButton>
					<ToolbarButton testId="note-delete" onClick={onDelete} danger><Trash2Icon className="size-3.5" aria-hidden />Delete</ToolbarButton>
				</div>
			</div>
		);
	}
	const rewriting = note.regenerating && note.regenerating.error === undefined;
	const info = [
		note.instruction ? `“${firstLine(note.instruction)}”` : "Default note",
		note.model ? prettyModel(note.model, true) : null,
		typeof note.costUsd === "number" ? formatUsd(note.costUsd) : null,
	].filter(Boolean).join(" · ");
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-1 border-b border-border/60 px-3 py-1.5">
				<Toggle checked={inverted} onChange={onInverted} label="Invert note colors" title="Invert colors" discIcon={<InvertDiscIcon className="size-3" />} />
				<div className="flex-1" />
				<a
					href={`/api/chats/${encodeURIComponent(chatId)}/notes/${encodeURIComponent(note.id)}?download=1`}
					download
					data-testid="note-download"
					className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<DownloadIcon className="size-3.5" aria-hidden />Download
				</a>
				{!rewriting && <ToolbarButton testId="note-regenerate" onClick={onRewriteOpen}><RefreshCwIcon className="size-3.5" aria-hidden />Regenerate…</ToolbarButton>}
				<ToolbarButton testId="note-delete" onClick={onDelete} danger><Trash2Icon className="size-3.5" aria-hidden />Delete…</ToolbarButton>
			</div>
			<p data-testid="note-info" className="truncate border-b border-border/60 px-4 py-1.5 text-xs text-muted-foreground">{info}</p>
			{rewriting && (
				<div data-testid="note-rewriting" className="flex items-center gap-3 border-b border-border/60 px-4 py-1.5 text-xs text-muted-foreground">
					<span>Rewriting…</span>
					<ToolbarButton testId="note-stop" onClick={onStop}><SquareIcon className="size-3" aria-hidden />Stop</ToolbarButton>
				</div>
			)}
			{note.regenerating?.error && (
				<p data-testid="note-rewrite-error" role="alert" className="border-b border-border/60 px-4 py-1.5 text-xs text-error">
					The rewrite failed: {note.regenerating.error} The current version is kept.
				</p>
			)}
			{rewrite && (
				<div className="border-b border-border/60 px-4 py-3">
					<NoteRequestForm
						instruction={rewrite.instruction}
						interactive={rewrite.interactive}
						busy={rewriteBusy}
						submitLabel="Regenerate"
						onInstruction={(instruction) => onRewriteChange({ ...rewrite, instruction })}
						onInteractive={(interactive) => onRewriteChange({ ...rewrite, interactive })}
						onSubmit={() => onRewriteSubmit(rewrite)}
						onCancel={() => onRewriteChange(null)}
					/>
				</div>
			)}
			<div className="min-h-0 flex-1">
				<NoteFrame chatId={chatId} note={note} inverted={inverted} />
			</div>
		</div>
	);
}
