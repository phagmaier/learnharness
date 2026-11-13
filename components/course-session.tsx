"use client";

import Link from "next/link";
import type { SessionCourseView } from "@/src/core";

/**
 * Course chrome inside a session (fork plan 04). The closed band replaces
 * the composer once a setup session's course exists: the session stays
 * readable and side questions still work, but the conversation is over.
 */
export function CourseClosedBand({ view }: { view: SessionCourseView }) {
	if (view.role !== "setup" || !view.courseId) return null;
	return (
		<div data-testid="course-closed-band" className="flex items-center justify-between gap-3 px-4 py-3">
			<p className="text-sm text-muted-foreground">This course has been created.</p>
			<Link
				href={`/course/${view.courseId}`}
				className="shrink-0 rounded-md border px-3 py-1.5 font-ui text-xs uppercase tracking-wider text-foreground transition-colors hover:bg-accent"
			>
				Open course
			</Link>
		</div>
	);
}
