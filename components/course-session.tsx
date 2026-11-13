"use client";

import Link from "next/link";
import { FlagIcon, GraduationCapIcon } from "lucide-react";
import type { ArtifactPartProps, SessionCourseView } from "@/src/core";

/**
 * Course chrome inside a session (fork plan 04).
 *
 * - The closed band replaces the composer once a setup session's course
 *   exists, or while a unit is completed: the session stays readable and
 *   side questions still work, but the conversation is closed.
 * - A unit session's top bar shows "<course title> › <n>. <unit title>",
 *   linking to the course overview, in place of the session title.
 * - The transcript marks the unit's opening and the teacher's goal signal
 *   with quiet lines.
 */
export function CourseClosedBand({ view }: { view: SessionCourseView }) {
	const message = view.role === "setup"
		? view.courseId ? "This course has been created." : null
		: view.status === "completed" ? "This unit is completed. Reopen it to continue." : null;
	if (!message || !view.courseId) return null;
	return (
		<div data-testid="course-closed-band" className="flex items-center justify-between gap-3 px-4 py-3">
			<p className="text-sm text-muted-foreground">{message}</p>
			<Link
				href={`/course/${encodeURIComponent(view.courseId)}`}
				className="shrink-0 rounded-md border px-3 py-1.5 font-ui text-xs uppercase tracking-wider text-foreground transition-colors hover:bg-accent"
			>
				Open course
			</Link>
		</div>
	);
}

/** Whether the session takes no new main input. */
export function courseSessionClosed(view: SessionCourseView | null | undefined): boolean {
	if (!view) return false;
	return view.role === "setup" ? view.courseId !== null : view.status === "completed";
}

/** The unit session's title: the course and the unit, linking to the
 *  course overview. Renaming happens in the course view. */
export function UnitBreadcrumb({ view }: { view: Extract<SessionCourseView, { role: "unit" }> }) {
	return (
		<Link
			href={`/course/${encodeURIComponent(view.courseId)}`}
			data-testid="unit-breadcrumb"
			data-plugin-chrome-title
			title="Open the course"
			className="lh-no-drag -mx-1.5 flex min-w-4 shrink items-baseline gap-2 truncate rounded-md px-1.5 font-title text-3xl tracking-tight transition-colors hover:bg-accent"
		>
			<span className="min-w-0 shrink truncate text-muted-foreground">{view.courseTitle}</span>
			<span aria-hidden="true" className="shrink-0 text-muted-foreground">›</span>
			<span className="min-w-0 shrink-[0.5] truncate">{view.number}. {view.unitTitle}</span>
		</Link>
	);
}

const QUIET_LINE = "my-4 flex items-center justify-center gap-1.5 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground";

/** The unit-start marker's transcript line. */
export function UnitStartedLine({ data }: { data: unknown }) {
	const number = data && typeof data === "object" && typeof (data as { number?: unknown }).number === "number" ? (data as { number: number }).number : null;
	if (number === null) return null;
	return (
		<div data-testid="unit-started-line" className={QUIET_LINE}>
			<GraduationCapIcon className="size-3" aria-hidden />
			Unit {number} started
		</div>
	);
}

/** The teacher's goal_reached call: a quiet line with its summary, once
 *  recorded. A refused or running call renders nothing here. */
export function GoalReachedLine({ part }: ArtifactPartProps) {
	const output = part.output as { ok?: unknown } | undefined;
	if (part.state !== "output-available" || output?.ok !== true) return null;
	const summary = part.input && typeof part.input === "object" && typeof (part.input as { summary?: unknown }).summary === "string"
		? (part.input as { summary: string }).summary : "";
	return (
		<div data-testid="goal-reached-line" className="my-4 flex flex-col items-center gap-1 text-center">
			<span className={QUIET_LINE.replace("my-4 ", "")}>
				<FlagIcon className="size-3" aria-hidden />
				Goal reached
			</span>
			{summary && <p className="max-w-prose font-prose text-sm text-muted-foreground">{summary}</p>}
		</div>
	);
}
