"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
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
 *
 * A course's Notes tab (fork plan 04 item 8) is the same workspace with the
 * notes grouped under unit headings and a unit picker in "New note".
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

/** The instruction box and its Interactive checkbox, without buttons (the
 *  notes page's form, and the completion dialog's "Generate a note"). */
export function NoteRequestFields({
	instruction,
	interactive,
	disabled = false,
	onInstruction,
	onInteractive,
}: {
	instruction: string;
	interactive: boolean;
	disabled?: boolean;
	onInstruction: (value: string) => void;
	onInteractive: (value: boolean) => void;
}) {
	return (
		<>
			<textarea
				data-testid="note-instruction"
				value={instruction}
				disabled={disabled}
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
					disabled={disabled}
					onChange={(event) => onInteractive(event.target.checked)}
					className="size-3.5 accent-primary"
				/>
				{INTERACTIVE_LABEL}
			</label>
		</>
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
			<NoteRequestFields instruction={instruction} interactive={interactive} onInstruction={onInstruction} onInteractive={onInteractive} />
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

/** One section of the note list: one session's notes. A course's Notes
 *  tab has one per started unit, headed "<n>. <title>" (fork plan 04
 *  item 8); a session's notes page has a single unheaded one. */
export interface NotesGroup {
	chatId: string;
	heading?: string;
	notes: NoteView[];
	/** This session's notes index can't be read. */
	error?: string | null;
}

/** Course Notes tab wording (agent-selected, plan 04 item 8). */
export const UNIT_PICKER_LABEL = "Unit";
export const UNIT_NO_NOTES = "No notes yet";
export const UNIT_EMPTY_NOTES = "No notes for this unit yet.";
export const COURSE_NO_UNITS = "No unit has started yet.";

/** The selection: a session (a course's unit) and, within it, a note.
 *  A missing or unknown note falls back to the session's newest. */
export interface NotesSelection { chatId: string | null; noteId: string | null }

/** Where the page opens: the requested session's newest note, else the
 *  newest note anywhere, else the last session listed. */
export function initialNotesSelection(groups: readonly NotesGroup[], chatId?: string | null): NotesSelection {
	const requested = chatId ? groups.find((group) => group.chatId === chatId) : undefined;
	if (requested) return { chatId: requested.chatId, noteId: sortNotes(requested.notes)[0]?.id ?? null };
	let newest: { chatId: string; note: NoteView } | null = null;
	for (const group of groups) {
		const top = sortNotes(group.notes)[0];
		if (top && (!newest || top.createdAt > newest.note.createdAt)) newest = { chatId: group.chatId, note: top };
	}
	if (newest) return { chatId: newest.chatId, noteId: newest.note.id };
	return { chatId: groups.at(-1)?.chatId ?? null, noteId: null };
}

/** The selected session and note as currently listed. */
export function resolveNotesSelection(groups: readonly NotesGroup[], selection: NotesSelection): { group: NotesGroup | null; note: NoteView | null } {
	const group = groups.find((candidate) => candidate.chatId === selection.chatId)
		?? groups.find((candidate) => candidate.chatId === initialNotesSelection(groups).chatId)
		?? null;
	if (!group) return { group: null, note: null };
	const sorted = sortNotes(group.notes);
	return { group, note: sorted.find((note) => note.id === selection.noteId) ?? sorted[0] ?? null };
}

const api = (chatId: string) => `/api/chats/${encodeURIComponent(chatId)}/notes`;

/** The unit picker of a course's "New note" form. */
export function NoteUnitPicker({ groups, value, disabled, onChange }: {
	groups: readonly NotesGroup[];
	value: string;
	disabled?: boolean;
	onChange: (chatId: string) => void;
}) {
	return (
		<label className="flex items-center gap-2 text-xs text-muted-foreground">
			<span className="shrink-0">{UNIT_PICKER_LABEL}</span>
			<select
				data-testid="note-unit"
				value={value}
				disabled={disabled}
				onChange={(event) => onChange(event.target.value)}
				className="lh-input min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-muted-foreground"
			>
				{groups.map((group) => <option key={group.chatId} value={group.chatId}>{group.heading ?? group.chatId}</option>)}
			</select>
		</label>
	);
}

/** The note list: one session's rows, or a course's rows under unit
 *  headings in course order (a heading selects its unit). */
export function NoteGroupsList({ groups, selection, onSelect }: {
	groups: readonly NotesGroup[];
	selection: { chatId: string | null; noteId: string | null };
	onSelect: (selection: NotesSelection) => void;
}) {
	return (
		<>
			{groups.map((group) => {
				const rows = sortNotes(group.notes).map((note) => (
					<NoteListRow
						key={note.id}
						note={note}
						selected={group.chatId === selection.chatId && note.id === selection.noteId}
						onSelect={() => onSelect({ chatId: group.chatId, noteId: note.id })}
					/>
				));
				if (group.heading === undefined) {
					return (
						<div key={group.chatId}>
							{group.error && <p role="alert" className="px-2 py-1 text-xs text-error">{group.error}</p>}
							{rows}
						</div>
					);
				}
				const current = group.chatId === selection.chatId;
				return (
					<section key={group.chatId} data-testid="notes-unit-group" data-chat-id={group.chatId} className="mb-2">
						<button
							type="button"
							data-testid="notes-unit"
							aria-current={current ? "true" : undefined}
							onClick={() => onSelect({ chatId: group.chatId, noteId: null })}
							className={cn(
								"w-full truncate rounded-md px-2.5 py-1.5 text-left font-ui text-[11px] uppercase tracking-wider transition-colors hover:bg-accent",
								current ? "text-foreground" : "text-muted-foreground",
							)}
						>
							{group.heading}
						</button>
						{group.error && <p role="alert" className="px-2.5 py-1 text-xs text-error">{group.error}</p>}
						{rows.length > 0 ? rows : !group.error && <p data-testid="notes-unit-empty" className="px-2.5 pb-1 text-xs text-muted-foreground/80">{UNIT_NO_NOTES}</p>}
					</section>
				);
			})}
		</>
	);
}

/**
 * The notes workspace both notes pages share: the list and "New note" on
 * the left, the selected note on the right. A course's Notes tab adds unit
 * headings and a unit picker; every action goes to the note's own session
 * (/api/chats/:chatId/notes…). `load` refetches the groups; the page
 * refetches on notes-changed for a listed session, and (for a course) on
 * courses-changed.
 */
export function NotesWorkspace({
	topBar,
	initialGroups,
	initialError = null,
	initialChatId = null,
	load,
	courseId,
}: {
	topBar: ReactNode;
	initialGroups: NotesGroup[];
	initialError?: string | null;
	/** The session (unit) selected on arrival. */
	initialChatId?: string | null;
	load: () => Promise<NotesGroup[] | { error: string } | null>;
	/** A course's Notes tab: also refetch when the course changes. */
	courseId?: string;
}) {
	const [groups, setGroups] = useState<NotesGroup[]>(initialGroups);
	const [loadError, setLoadError] = useState<string | null>(initialError);
	const grouped = groups.some((group) => group.heading !== undefined);
	const [selection, setSelection] = useState<NotesSelection>(() => initialNotesSelection(initialGroups, initialChatId));
	const { group: selectedGroup, note: selected } = resolveNotesSelection(groups, selection);
	const selectedChatId = selectedGroup?.chatId ?? null;

	const [composing, setComposing] = useState(false);
	const [draft, setDraft] = useState({ instruction: "", interactive: false, chatId: "" });
	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [rewrite, setRewrite] = useState<{ instruction: string; interactive: boolean } | null>(null);
	const [rewriteBusy, setRewriteBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<{ chatId: string; note: NoteView } | null>(null);
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
			const result = await load();
			if (!result) return;
			if ("error" in result) {
				setLoadError(result.error);
				return;
			}
			setGroups(result);
			setLoadError(null);
		} catch { /* offline: the next event or resync refetches */ }
	}, [load]);
	useServerEvent("notes-changed", (payload) => {
		if (groups.some((group) => group.chatId === payload.chatId)) void refresh();
	});
	useServerEvent("courses-changed", (payload) => {
		if (courseId && payload.courseId === courseId) void refresh();
	});
	useServerResync(() => void refresh());

	// A different note selected closes the per-note forms.
	useEffect(() => {
		setRewrite(null);
		setActionError(null);
	}, [selected?.id]);

	const addNote = (chatId: string, note: NoteView) => setGroups((current) => current.map((group) => group.chatId === chatId && !group.notes.some((n) => n.id === note.id)
		? { ...group, notes: [...group.notes, note] }
		: group));
	const dropNote = (chatId: string, noteId: string) => setGroups((current) => current.map((group) => group.chatId === chatId
		? { ...group, notes: group.notes.filter((note) => note.id !== noteId) }
		: group));

	const openComposer = () => {
		setDraft((current) => ({ ...current, chatId: selectedChatId ?? groups[0]?.chatId ?? "" }));
		setComposing(true);
	};

	const createNote = async () => {
		const chatId = draft.chatId || selectedChatId;
		if (!chatId) return;
		setCreating(true);
		setCreateError(null);
		try {
			const response = await fetch(api(chatId), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ instruction: draft.instruction, interactive: draft.interactive }),
			});
			if (!response.ok) {
				setCreateError(await errorOf(response));
				return;
			}
			const { note } = (await response.json()) as { note: NoteView };
			addNote(chatId, note);
			setSelection({ chatId, noteId: note.id });
			setComposing(false);
			setDraft({ instruction: "", interactive: false, chatId: "" });
			void refresh();
		} catch {
			setCreateError("Couldn't reach the app. Try again.");
		} finally {
			setCreating(false);
		}
	};

	const regenerate = async (chatId: string, note: NoteView, request: { instruction: string; interactive: boolean }) => {
		setRewriteBusy(true);
		setActionError(null);
		try {
			const response = await fetch(`${api(chatId)}/${encodeURIComponent(note.id)}/regenerate`, {
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

	const stop = async (chatId: string, note: NoteView) => {
		await fetch(`${api(chatId)}/${encodeURIComponent(note.id)}/stop`, { method: "POST" }).catch(() => undefined);
		void refresh();
	};

	const confirmDelete = async () => {
		if (!deleting) return;
		const { chatId, note: target } = deleting;
		setDeleting(null);
		setActionError(null);
		const response = await fetch(`${api(chatId)}/${encodeURIComponent(target.id)}`, { method: "DELETE" }).catch(() => null);
		if (!response || (!response.ok && response.status !== 404)) {
			setActionError(response ? await errorOf(response) : "Couldn't reach the app. Try again.");
			return;
		}
		dropNote(chatId, target.id);
		void refresh();
	};

	const exportConversation = async () => {
		if (!selectedChatId) return;
		setExporting(true);
		setActionError(null);
		try {
			const response = await fetch(`/api/chats/${encodeURIComponent(selectedChatId)}/export.html`, { cache: "no-store" });
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

	const emptyText = !grouped ? EMPTY_NOTES : selectedGroup ? UNIT_EMPTY_NOTES : COURSE_NO_UNITS;

	return (
		<div className="flex h-dvh">
			<div className="flex min-w-0 flex-1 flex-col">
				{topBar}

				<div className="flex min-h-0 flex-1">
					<aside data-testid="notes-list" className="flex w-80 shrink-0 flex-col border-r border-border">
						<div className="border-b border-border/60 p-3">
							{composing ? (
								<div className="flex flex-col gap-2">
									{grouped && (
										<NoteUnitPicker
											groups={groups}
											value={draft.chatId || selectedChatId || ""}
											disabled={creating}
											onChange={(chatId) => setDraft((d) => ({ ...d, chatId }))}
										/>
									)}
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
								</div>
							) : (
								<button
									type="button"
									data-testid="note-new"
									onClick={openComposer}
									disabled={groups.length === 0}
									className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
								>
									<PlusIcon className="size-3.5" aria-hidden />
									New note
								</button>
							)}
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto p-2">
							{loadError && <p role="alert" className="px-2 py-1 text-xs text-error">{loadError}</p>}
							<NoteGroupsList
								groups={groups}
								selection={{ chatId: selectedChatId, noteId: selected?.id ?? null }}
								onSelect={setSelection}
							/>
						</div>
						<div className="border-t border-border/60 p-3">
							<button
								type="button"
								data-testid="notes-export"
								onClick={() => void exportConversation()}
								disabled={exporting || !selectedChatId}
								className="flex w-full items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
							>
								<FileCodeIcon className="size-3.5" aria-hidden />
								{exporting ? "Exporting…" : "Export conversation (HTML)"}
							</button>
						</div>
					</aside>

					<section data-testid="note-pane" className="flex min-w-0 flex-1 flex-col">
						{actionError && <p role="alert" className="border-b border-border/60 px-4 py-2 text-xs text-error">{actionError}</p>}
						{!selected || !selectedChatId ? (
							<div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
								<NotebookPenIcon className="size-5" aria-hidden />
								<p data-testid="notes-empty">{emptyText}</p>
							</div>
						) : (
							<NotePane
								chatId={selectedChatId}
								note={selected}
								inverted={inverted}
								onInverted={toggleInverted}
								rewrite={rewrite}
								rewriteBusy={rewriteBusy}
								onRewriteOpen={() => setRewrite({ instruction: selected.instruction, interactive: selected.interactive })}
								onRewriteChange={setRewrite}
								onRewriteSubmit={(request) => void regenerate(selectedChatId, selected, request)}
								onRetry={() => void regenerate(selectedChatId, selected, { instruction: selected.instruction, interactive: selected.interactive })}
								onStop={() => void stop(selectedChatId, selected)}
								onDelete={() => setDeleting({ chatId: selectedChatId, note: selected })}
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
				{deleting?.note.title && <p className="mt-1.5 font-mono text-sm text-foreground">{deleting.note.title}</p>}
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

/** The notes page of one Teach session. */
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
	const load = useCallback(async (): Promise<NotesGroup[] | { error: string }> => {
		const response = await fetch(api(chatId), { cache: "no-store" });
		if (!response.ok) return { error: await errorOf(response) };
		const body = (await response.json()) as { notes: NoteView[] };
		return [{ chatId, notes: body.notes }];
	}, [chatId]);
	return (
		<NotesWorkspace
			load={load}
			initialGroups={[{ chatId, notes: initialNotes }]}
			initialError={initialError}
			topBar={
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
			}
		/>
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
			<div className="flex flex-wrap items-center gap-1 border-b border-border/60 px-3 py-1.5">
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
