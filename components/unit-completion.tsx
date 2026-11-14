"use client";

import { useEffect, useRef, useState, type Ref } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDownIcon, FlagIcon } from "lucide-react";
import { nextUnitOffer, prerequisiteWarning, type CourseRecord, type SessionCourseView } from "@/src/core";
import { HostDialog } from "@/components/host-dialog";
import { MenuShell } from "@/components/menu-shell";
import { NoteRequestFields } from "@/components/notes-page";
import { UnitStartWarning } from "@/components/course-overview";

/**
 * Completing a unit from its session (fork plan 04 item 6).
 *
 * - Before the teacher's goal_reached signal, the top bar has a quiet
 *   "Unit" menu with "Complete unit early…"; after it, a "Complete unit"
 *   button that stays until the unit is completed.
 * - The dialog asks "Complete this unit?", says when the finish is early,
 *   and offers "Generate a note" (with phase 0's instruction box) and
 *   "Export full conversation", both off by default.
 * - Once completed it offers the first unit that hasn't started (with the
 *   prerequisite warning when needed) and "Back to course".
 */

type UnitView = Extract<SessionCourseView, { role: "unit" }>;

export const COMPLETE_TITLE = "Complete this unit?";
export const EARLY_FINISH = "The teacher hasn't marked the goal as reached. This is recorded as an early finish.";
export const NOTE_OFFER = "Generate a note";
export const EXPORT_OFFER = "Export full conversation";
export const COMPLETED_LINE = "Unit completed.";

export interface CompletionForm {
	note: boolean;
	instruction: string;
	interactive: boolean;
	exportConversation: boolean;
}

export const EMPTY_FORM: CompletionForm = { note: false, instruction: "", interactive: false, exportConversation: false };

export type CompletionOutcome =
	| { ok: true; course: CourseRecord; noteError?: string; exportError?: string }
	| { ok: false; error: string };

const UNREACHABLE = "Couldn't reach the app. Try again.";

async function errorOf(response: Response): Promise<string> {
	const body = (await response.json().catch(() => null)) as { error?: string } | null;
	return body?.error ?? `Something went wrong (${response.status}).`;
}

/** Save a downloaded response under the route's filename. */
function saveDownload(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = name;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}

/**
 * Confirm the completion, then run the checked offers: the note through
 * phase 0's service (sent with the completion), and the export as a
 * download of the session's export.html. An unchecked offer sends and
 * downloads nothing.
 */
export async function runUnitCompletion(
	target: { courseId: string; unitId: string; chatId: string },
	form: CompletionForm,
	deps: { fetch: typeof fetch; download: (blob: Blob, name: string) => void } = { fetch: (...args) => fetch(...args), download: saveDownload },
): Promise<CompletionOutcome> {
	let response: Response;
	try {
		response = await deps.fetch(`/api/courses/${encodeURIComponent(target.courseId)}/units/${encodeURIComponent(target.unitId)}/complete`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(form.note ? { note: { instruction: form.instruction, interactive: form.interactive } } : {}),
		});
	} catch {
		return { ok: false, error: UNREACHABLE };
	}
	if (!response.ok) return { ok: false, error: await errorOf(response) };
	const body = (await response.json()) as { course: CourseRecord; noteError?: string };
	const outcome: CompletionOutcome = { ok: true, course: body.course, ...(body.noteError ? { noteError: body.noteError } : {}) };
	if (!form.exportConversation) return outcome;
	try {
		const exported = await deps.fetch(`/api/chats/${encodeURIComponent(target.chatId)}/export.html`, { cache: "no-store" });
		if (!exported.ok) return { ...outcome, exportError: await errorOf(exported) };
		const name = /filename="([^"]+)"/.exec(exported.headers.get("content-disposition") ?? "")?.[1] ?? "conversation.html";
		deps.download(await exported.blob(), name);
	} catch {
		return { ...outcome, exportError: UNREACHABLE };
	}
	return outcome;
}

const BUTTON = "rounded-lg px-3 py-1.5 text-sm transition-colors disabled:opacity-50";

/** The dialog before confirming (pure; exported for render tests). */
export function CompleteUnitForm({
	view,
	form,
	busy,
	error,
	cancelRef,
	onChange,
	onCancel,
	onConfirm,
}: {
	view: Pick<UnitView, "number" | "unitTitle" | "goalReachedAt">;
	form: CompletionForm;
	busy: boolean;
	error?: string | null;
	cancelRef?: Ref<HTMLButtonElement>;
	onChange: (next: CompletionForm) => void;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	return (
		<>
			<h2 className="text-sm font-semibold text-foreground">{COMPLETE_TITLE}</h2>
			<p data-testid="complete-unit-name" className="mt-1.5 font-prose text-sm text-foreground">{view.number}. {view.unitTitle}</p>
			{!view.goalReachedAt && <p data-testid="complete-early" className="mt-2 text-sm text-muted-foreground">{EARLY_FINISH}</p>}
			<div className="mt-4 space-y-2">
				<label className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground">
					<input type="checkbox" data-testid="complete-note" checked={form.note} disabled={busy} onChange={(e) => onChange({ ...form, note: e.target.checked })} className="size-4 shrink-0 accent-primary" />
					{NOTE_OFFER}
				</label>
				{form.note && (
					<div data-testid="complete-note-box" className="flex flex-col gap-2 pl-6.5">
						<NoteRequestFields
							instruction={form.instruction}
							interactive={form.interactive}
							disabled={busy}
							onInstruction={(instruction) => onChange({ ...form, instruction })}
							onInteractive={(interactive) => onChange({ ...form, interactive })}
						/>
					</div>
				)}
				<label className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground">
					<input type="checkbox" data-testid="complete-export" checked={form.exportConversation} disabled={busy} onChange={(e) => onChange({ ...form, exportConversation: e.target.checked })} className="size-4 shrink-0 accent-primary" />
					{EXPORT_OFFER}
				</label>
			</div>
			{error && <p role="alert" data-testid="complete-error" className="mt-3 text-sm text-destructive">{error}</p>}
			<div className="mt-5 flex justify-end gap-2">
				<button type="button" ref={cancelRef} data-testid="complete-cancel" onClick={onCancel} disabled={busy} className={`${BUTTON} text-muted-foreground hover:bg-accent hover:text-foreground`}>
					Cancel
				</button>
				<button type="button" data-testid="complete-confirm" onClick={onConfirm} disabled={busy} className={`${BUTTON} border border-primary/60 text-primary hover:bg-primary/10`}>
					{busy ? "Completing…" : "Complete unit"}
				</button>
			</div>
		</>
	);
}

/** The dialog after confirming (pure; exported for render tests). */
export function UnitCompletedBody({
	courseId,
	next,
	noteError,
	exportError,
	starting,
	startError,
	onOpenNext,
}: {
	courseId: string;
	next: { number: number; title: string } | null;
	noteError?: string;
	exportError?: string;
	starting: boolean;
	startError?: string | null;
	onOpenNext: () => void;
}) {
	return (
		<>
			<h2 data-testid="complete-done" className="text-sm font-semibold text-foreground">{COMPLETED_LINE}</h2>
			{noteError && <p role="alert" className="mt-2 text-sm text-destructive">The note couldn't be started: {noteError}</p>}
			{exportError && <p role="alert" className="mt-2 text-sm text-destructive">The conversation couldn't be exported: {exportError}</p>}
			{startError && <p role="alert" className="mt-2 text-sm text-destructive">{startError}</p>}
			<div className="mt-5 flex flex-wrap justify-end gap-2">
				<Link href={`/course/${encodeURIComponent(courseId)}`} data-testid="complete-back" className={`${BUTTON} text-muted-foreground hover:bg-accent hover:text-foreground`}>
					Back to course
				</Link>
				{next && (
					<button type="button" data-testid="complete-open-next" onClick={onOpenNext} disabled={starting} className={`${BUTTON} border border-primary/60 text-primary hover:bg-primary/10`}>
						{starting ? "Starting…" : `Open next unit: ${next.number}. ${next.title}`}
					</button>
				)}
			</div>
		</>
	);
}

type Stage =
	| { kind: "form"; form: CompletionForm; busy: boolean; error: string | null }
	| { kind: "done"; course: CourseRecord; noteError?: string; exportError?: string; starting: boolean; startError: string | null }
	| { kind: "warning"; course: CourseRecord; noteError?: string; exportError?: string; text: string };

/** The top bar's trigger (pure; exported for render tests): nothing once
 *  the unit is completed, "Complete unit" after the goal signal, and the
 *  quiet "Unit" menu before it. */
export function UnitCompletionTrigger({
	view,
	menuOpen,
	triggerRef,
	onToggleMenu,
	onOpen,
}: {
	view: Pick<UnitView, "status" | "goalReachedAt">;
	menuOpen: boolean;
	triggerRef?: Ref<HTMLButtonElement>;
	onToggleMenu: () => void;
	onOpen: () => void;
}) {
	if (view.status === "completed") return null;
	if (view.goalReachedAt) {
		return (
			<button type="button" data-testid="unit-complete" onClick={onOpen} className={PRIMARY_CHIP}>
				<FlagIcon className="size-3.5" aria-hidden />
				Complete unit
			</button>
		);
	}
	return (
		<button ref={triggerRef} type="button" data-testid="unit-menu-trigger" aria-haspopup="menu" aria-expanded={menuOpen} onClick={onToggleMenu} className={QUIET_CHIP}>
			Unit
			<ChevronDownIcon className="size-3" aria-hidden />
		</button>
	);
}

const QUIET_CHIP = "lh-no-drag flex shrink-0 items-center gap-1 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground";
const PRIMARY_CHIP = "lh-no-drag flex shrink-0 items-center gap-1.5 rounded-full border border-primary/60 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-primary transition-colors hover:bg-primary/10";

/**
 * The unit's completion control in its top bar, and the dialog. It stays
 * mounted once the unit is completed so the dialog's "Unit completed."
 * step survives the page's live update; only the trigger hides.
 */
export function UnitCompletion({ view, chatId }: { view: UnitView; chatId: string }) {
	const router = useRouter();
	const [menuOpen, setMenuOpen] = useState(false);
	const [stage, setStage] = useState<Stage | null>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!menuOpen) return;
		const dismiss = (event: PointerEvent) => {
			const target = event.target as Element | null;
			if (trigger.current?.contains(target) || target?.closest?.('[data-testid="unit-menu"]')) return;
			setMenuOpen(false);
		};
		document.addEventListener("pointerdown", dismiss);
		return () => document.removeEventListener("pointerdown", dismiss);
	}, [menuOpen]);

	const open = () => { setMenuOpen(false); setStage({ kind: "form", form: EMPTY_FORM, busy: false, error: null }); };
	const close = () => setStage(null);

	const confirm = async (form: CompletionForm) => {
		setStage({ kind: "form", form, busy: true, error: null });
		const outcome = await runUnitCompletion({ courseId: view.courseId, unitId: view.unitId, chatId }, form);
		if (!outcome.ok) { setStage({ kind: "form", form, busy: false, error: outcome.error }); return; }
		setStage({ kind: "done", course: outcome.course, noteError: outcome.noteError, exportError: outcome.exportError, starting: false, startError: null });
	};

	const start = async (course: CourseRecord, unitId: string, carry: { noteError?: string; exportError?: string }) => {
		setStage({ kind: "done", course, ...carry, starting: true, startError: null });
		try {
			const response = await fetch(`/api/courses/${encodeURIComponent(course.id)}/units/${encodeURIComponent(unitId)}/start`, { method: "POST" });
			const body = (await response.json().catch(() => ({}))) as { chatId?: string; error?: string };
			if (body.chatId) { setStage(null); router.push(`/chat/${encodeURIComponent(body.chatId)}`); return; }
			setStage({ kind: "done", course, ...carry, starting: false, startError: body.error ?? "Couldn't start the unit." });
		} catch {
			setStage({ kind: "done", course, ...carry, starting: false, startError: UNREACHABLE });
		}
	};

	const openNext = (course: CourseRecord, carry: { noteError?: string; exportError?: string }) => {
		const next = nextUnitOffer(course.units);
		if (!next) return;
		const warning = prerequisiteWarning(course.units, next.unit.id);
		if (warning) setStage({ kind: "warning", course, ...carry, text: warning });
		else void start(course, next.unit.id, carry);
	};

	const busy = stage?.kind === "form" ? stage.busy : stage?.kind === "done" ? stage.starting : false;
	const completed = view.status === "completed";

	return (
		<>
			<UnitCompletionTrigger view={view} menuOpen={menuOpen} triggerRef={trigger} onToggleMenu={() => setMenuOpen((value) => !value)} onOpen={open} />
			{menuOpen && !completed && (
				<MenuShell anchorRef={trigger} testid="unit-menu" preferredSide="down" align="right" onClose={(reason) => { setMenuOpen(false); if (reason === "escape") trigger.current?.focus(); return "closed"; }}
					menuClass="lh-no-drag w-56 rounded-xl border border-border bg-popover p-1 shadow-lg">
					<div role="menu" aria-label="Unit">
						<button type="button" role="menuitem" data-testid="unit-complete-early" onClick={open}
							className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
							Complete unit early…
						</button>
					</div>
				</MenuShell>
			)}
			<HostDialog
				open={stage !== null}
				onClose={() => { if (busy) return "blocked"; close(); return "closed"; }}
				initialFocusRef={cancelRef}
				backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}
				frame={<div role="dialog" aria-modal="true" aria-label="Complete unit" data-testid="complete-unit-dialog" className="w-[30rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl" />}
			>
				{stage?.kind === "form" && (
					<CompleteUnitForm
						view={view}
						form={stage.form}
						busy={stage.busy}
						error={stage.error}
						cancelRef={cancelRef}
						onChange={(form) => setStage({ ...stage, form, error: null })}
						onCancel={close}
						onConfirm={() => void confirm(stage.form)}
					/>
				)}
				{stage?.kind === "done" && (() => {
					const next = nextUnitOffer(stage.course.units);
					return (
						<UnitCompletedBody
							courseId={stage.course.id}
							next={next ? { number: next.number, title: next.unit.title } : null}
							noteError={stage.noteError}
							exportError={stage.exportError}
							starting={stage.starting}
							startError={stage.startError}
							onOpenNext={() => openNext(stage.course, { noteError: stage.noteError, exportError: stage.exportError })}
						/>
					);
				})()}
				{stage?.kind === "warning" && (
					<UnitStartWarning
						text={stage.text}
						cancelRef={cancelRef}
						onCancel={() => setStage({ kind: "done", course: stage.course, noteError: stage.noteError, exportError: stage.exportError, starting: false, startError: null })}
						onConfirm={() => {
							const next = nextUnitOffer(stage.course.units);
							if (next) void start(stage.course, next.unit.id, { noteError: stage.noteError, exportError: stage.exportError });
						}}
					/>
				)}
			</HostDialog>
		</>
	);
}
