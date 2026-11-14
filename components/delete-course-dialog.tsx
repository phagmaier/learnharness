"use client";

import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { HostDialog } from "@/components/host-dialog";
import type { CourseNotesUnitView } from "@/components/course-notes";
import type { ChatDeleteMode, CourseSummary } from "@/src/core";

/** The graph-traces checkbox copy (fork plan 04 item 9): the session
 *  dialog's, adapted to "these sessions". */
export const COURSE_TRACES_COPY = {
	title: "Also remove their graph traces",
	body: "These sessions’ topics, links, and events leave the graph too. Topics other sessions or imported notes also cover survive; topics only these sessions created are removed entirely.",
};

/** The dialog's line (plan 04 item 9): "This deletes the course, its setup
 *  session, its <n> unit sessions, and their <m> notes." A count of zero
 *  leaves its part out. */
export function courseDeletionLine(unitSessions: number, notes: number): string {
	const parts = ["the course", "its setup session"];
	if (unitSessions > 0) parts.push(`its ${unitSessions} ${unitSessions === 1 ? "unit session" : "unit sessions"}`);
	if (notes > 0) parts.push(`their ${notes} ${notes === 1 ? "note" : "notes"}`);
	const list = parts.length === 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
	return `This deletes ${list}.`;
}

/** The unit sessions a course has, from the sidebar's summary. */
export function unitSessionCount(course: Pick<CourseSummary, "units">): number {
	return course.units.filter((unit) => unit.chatId).length;
}

/**
 * Course deletion (fork plan 04 item 9), mirroring the session deletion
 * dialog: the red title, the course name, what goes with it, the unchecked
 * graph-traces checkbox, and "Download notes" (the course archive) beside
 * Cancel and Delete. A refusal (a running turn or job, named; extraction
 * winding down; a session that couldn't be removed) shows the server's
 * line with Try again, which is Delete pressed again.
 */
type DeleteCourseDialogProps = {
	/** The course up for deletion; null = closed. */
	course: CourseSummary | null;
	onClose: () => void;
	/** Success path: the sidebar owns navigation and list patching. */
	onDeleted: (courseId: string, chatIds: string[], mode: ChatDeleteMode, graphRevision: number) => void;
};

export function DeleteCourseDialog({ course, ...callbacks }: DeleteCourseDialogProps) {
	return course ? <OpenDeleteCourseDialog key={course.id} course={course} {...callbacks} /> : null;
}

function OpenDeleteCourseDialog({
	course,
	onClose,
	onDeleted,
}: Omit<DeleteCourseDialogProps, "course"> & { course: CourseSummary }) {
	const [traces, setTraces] = useState(false);
	const [busy, setBusy] = useState(false);
	const [noteCount, setNoteCount] = useState<number | null>(null);
	const [notesError, setNotesError] = useState<string | null>(null);
	const [notesAttempt, setNotesAttempt] = useState(0);
	const [failure, setFailure] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		void (async () => {
			try {
				const res = await fetch(`/api/courses/${encodeURIComponent(course.id)}/notes`, { cache: "no-store" });
				const body = (await res.json().catch(() => null)) as { units?: CourseNotesUnitView[]; error?: string } | null;
				if (!live) return;
				if (!res.ok || !body?.units) {
					setNotesError(body?.error ?? `Reading notes failed (${res.status})`);
					return;
				}
				const errors = body.units.flatMap((unit) => unit.error !== undefined ? [`Unit ${unit.number} (${unit.title}): ${unit.error}`] : []);
				if (errors.length > 0) {
					setNotesError(errors.join("\n"));
					return;
				}
				setNoteCount(body.units.reduce((sum, unit) => sum + unit.notes.length, 0));
			} catch {
				if (live) setNotesError("Reading notes failed — network error.");
			}
		})();
		return () => { live = false; };
	}, [course.id, notesAttempt]);

	const run = async () => {
		if (busy || noteCount === null || notesError !== null) return;
		const mode: ChatDeleteMode = traces ? "delete-nodes" : "preserve-graph";
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch(`/api/courses/${encodeURIComponent(course.id)}?mode=${mode}`, { method: "DELETE" });
			const body = (await res.json().catch(() => ({}))) as { error?: string; chatIds?: string[]; graphRevision?: number };
			if (!res.ok) {
				setFailure(body.error ?? `Delete failed (${res.status})`);
				setBusy(false);
				return;
			}
			onDeleted(course.id, body.chatIds ?? [], mode, body.graphRevision ?? 0);
		} catch {
			setFailure("Delete failed — network error. Try again.");
			setBusy(false);
		}
	};

	return <DeleteCourseBody
		course={course}
		unitSessions={unitSessionCount(course)}
		noteCount={noteCount}
		notesError={notesError}
		onRetryNotes={() => {
			setNoteCount(null);
			setNotesError(null);
			setNotesAttempt((attempt) => attempt + 1);
		}}
		traces={traces}
		busy={busy}
		failure={failure}
		onTraces={setTraces}
		onClose={onClose}
		onRun={() => void run()}
		renderFrame={(frame) => <HostDialog open frame={frame} onClose={() => {
			if (busy) return "blocked";
			onClose(); return "closed";
		}} backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}>{frame.props.children}</HostDialog>}
	/>;
}

/** The dialog's pure body, exported for render tests; the wrapper owns
 *  state, effects and the portal. */
export function DeleteCourseBody({
	course,
	unitSessions,
	noteCount,
	notesError = null,
	onRetryNotes,
	traces,
	busy,
	failure,
	onTraces,
	onClose,
	onRun,
	renderFrame,
}: {
	course: Pick<CourseSummary, "id" | "title">;
	unitSessions: number;
	/** Null until every unit's notes can be read; > 0 offers "Download notes". */
	noteCount: number | null;
	notesError?: string | null;
	onRetryNotes?: () => void;
	traces: boolean;
	busy: boolean;
	failure: string | null;
	onTraces: (next: boolean) => void;
	onClose: () => void;
	onRun: () => void;
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
}) {
	const notesReady = noteCount !== null && notesError === null;
	const frame = (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Delete course"
			data-testid="delete-course-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold text-destructive">Delete course?</h2>
			<div className="mt-1.5">
				<code data-testid="course-name-code" className="font-mono text-sm text-foreground">
					{course.title}
				</code>
			</div>
			<p data-testid="delete-course-line" className="mt-2 text-sm text-muted-foreground">
				{courseDeletionLine(unitSessions, noteCount ?? 0)}
			</p>
			{noteCount === null && notesError === null && (
				<p role="status" className="mt-2 text-sm text-muted-foreground">Reading notes…</p>
			)}
			<label
				data-testid="delete-traces"
				className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 px-4 py-3"
			>
				<input
					type="checkbox"
					data-testid="delete-traces-checkbox"
					checked={traces}
					onChange={(e) => onTraces(e.target.checked)}
					disabled={busy}
					className="mt-0.5 size-4 shrink-0 accent-primary"
				/>
				<span className="min-w-0">
					<span className="block text-sm text-foreground">{COURSE_TRACES_COPY.title}</span>
					<span className="mt-1 block text-xs text-muted-foreground">{COURSE_TRACES_COPY.body}</span>
				</span>
			</label>
			{notesError && (
				<div
					role="alert"
					data-testid="delete-notes-failure"
					className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs"
				>
					<span className="whitespace-pre-line text-foreground">{notesError}</span>
					{onRetryNotes && (
						<button
							type="button"
							data-testid="delete-notes-retry"
							onClick={onRetryNotes}
							disabled={busy}
							className="ml-3 text-xs text-foreground underline-offset-2 hover:underline disabled:opacity-40"
						>
							Try again
						</button>
					)}
				</div>
			)}
			{failure && (
				<div
					role="alert"
					data-testid="delete-failure"
					className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs"
				>
					<span className="text-foreground">{failure}</span>
					<button
						type="button"
						data-testid="delete-retry"
						onClick={onRun}
						disabled={busy || !notesReady}
						className="ml-3 text-xs text-foreground underline-offset-2 hover:underline disabled:opacity-40"
					>
						Try again
					</button>
				</div>
			)}
			<div className="mt-4 flex justify-end gap-2">
				{notesReady && noteCount > 0 && (
					<a
						href={`/api/courses/${encodeURIComponent(course.id)}/notes/archive.zip`}
						download
						data-testid="delete-download-notes"
						className="mr-auto rounded-sm px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
					>
						Download notes
					</a>
				)}
				<button
					type="button"
					data-testid="delete-cancel"
					onClick={onClose}
					disabled={busy}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="delete-confirm"
					onClick={onRun}
					disabled={busy || !notesReady}
					className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
				>
					{busy ? "Deleting…" : "Delete"}
				</button>
			</div>
		</div>
	);
	return renderFrame ? renderFrame(frame) : frame;
}
