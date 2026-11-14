"use client";

import { useCallback, useState } from "react";
import { courseProgressLine, type CourseRecord, type UnitStatus } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { TopBar } from "@/components/top-bar";
import { CourseTabs } from "@/components/course-overview";
import { NotesWorkspace, type NotesGroup, type NoteView } from "@/components/notes-page";

/**
 * A course's Notes tab (fork plan 04 item 8): the phase-0 notes page with
 * every started unit's notes under its heading, in course order. "New
 * note" picks the unit, defaulting to the selected one: the unit the
 * learner arrived for (a unit's Notes chip) or last selected here. The
 * right pane, its toolbar and "Export conversation (HTML)" act on the
 * selected unit's session.
 */

/** One started unit's notes, as GET /api/courses/:id/notes lists them. */
export interface CourseNotesUnitView {
	unitId: string;
	number: number;
	title: string;
	chatId: string;
	notes: NoteView[];
	error?: string;
}

/** The unit's heading in the list and the picker: "<n>. <title>". */
export function courseNotesGroups(units: readonly CourseNotesUnitView[]): NotesGroup[] {
	return units.map((unit) => ({ chatId: unit.chatId, heading: `${unit.number}. ${unit.title}`, notes: unit.notes, error: unit.error ?? null }));
}

export function CourseNotesPage({
	course,
	initialUnits,
	initialUnitId = null,
	initialError = null,
}: {
	course: { id: string; title: string; units: ReadonlyArray<{ status: UnitStatus }> };
	initialUnits: CourseNotesUnitView[];
	/** The unit selected on arrival (?unit=). */
	initialUnitId?: string | null;
	initialError?: string | null;
}) {
	const courseId = course.id;
	// The top bar's title and progress stay live, as on the overview.
	const [header, setHeader] = useState(course);
	const refreshHeader = useCallback(async () => {
		try {
			const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}`, { cache: "no-store" });
			const body = (await response.json().catch(() => null)) as { course?: CourseRecord } | null;
			if (body?.course) setHeader(body.course);
		} catch { /* offline: keep the last header */ }
	}, [courseId]);
	useServerEvent("courses-changed", (payload) => { if (payload.courseId === courseId) void refreshHeader(); });
	useServerResync(() => void refreshHeader());
	const load = useCallback(async (): Promise<NotesGroup[] | { error: string }> => {
		const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/notes`, { cache: "no-store" });
		const body = (await response.json().catch(() => null)) as { units?: CourseNotesUnitView[]; error?: string } | null;
		if (!response.ok || !body?.units) return { error: body?.error ?? `Request failed (${response.status})` };
		return courseNotesGroups(body.units);
	}, [courseId]);
	const initialChatId = initialUnits.find((unit) => unit.unitId === initialUnitId)?.chatId ?? null;
	return (
		<NotesWorkspace
			courseId={courseId}
			load={load}
			initialGroups={courseNotesGroups(initialUnits)}
			initialError={initialError}
			initialChatId={initialChatId}
			topBar={
				<TopBar>
					<div className="flex min-w-0 flex-1 flex-col justify-center sm:flex-row sm:items-baseline sm:justify-start sm:gap-3">
						<span data-testid="course-title" className="min-w-0 shrink truncate font-title text-3xl tracking-tight">{header.title}</span>
						<span data-testid="course-progress" className="truncate font-ui text-[10px] uppercase tracking-wide text-muted-foreground sm:shrink-0 sm:text-xs">{courseProgressLine(header.units)}</span>
					</div>
					<CourseTabs courseId={courseId} active="notes" />
				</TopBar>
			}
		/>
	);
}
