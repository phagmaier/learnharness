import { fuzzyScore, type ChatListItem, type CourseSummary } from "@/src/core";

/**
 * The session list's entries (fork plan 04 item 3): standalone sessions and
 * course groups, ordered by most recent activity. A course groups its setup
 * session and its units, every unit in course order; a unit that hasn't
 * started has no session and opens the overview at that unit. The course
 * record decides membership, so a setup session whose course was never
 * created stays a standalone row, and "Practice this unit" sessions are
 * never members.
 *
 * Pure (render-test seam); the sidebar owns fetching, menus and the walk.
 */

export type SessionKindFilter = "teach" | "all" | "practice";

export type CourseRow =
	| { kind: "setup"; key: string; href: string; chat: ChatListItem | null }
	| { kind: "unit"; key: string; href: string; number: number; unit: CourseSummary["units"][number]; chat: ChatListItem | null };

export type SessionListEntry =
	| { kind: "chat"; key: string; href: string; chat: ChatListItem }
	| { kind: "course"; key: string; href: string; course: CourseSummary; rows: CourseRow[]; collapsed: boolean; activity: string };

export function courseHref(courseId: string, unitId?: string): string {
	return `/course/${encodeURIComponent(courseId)}${unitId ? `#unit-${unitId}` : ""}`;
}

/** The course's Notes tab (fork plan 04 item 8), with a unit selected. */
export function courseNotesHref(courseId: string, unitId?: string): string {
	return `/course/${encodeURIComponent(courseId)}/notes${unitId ? `?unit=${encodeURIComponent(unitId)}` : ""}`;
}

/** "Practice this unit": the practice draft with the unit attached. */
export function unitPracticeHref(courseId: string, unitId: string): string {
	return `/chat/new?mode=practice&course=${encodeURIComponent(courseId)}&unit=${encodeURIComponent(unitId)}`;
}

/** Ids of the sessions every course groups. */
export function courseMemberIds(courses: readonly CourseSummary[]): Set<string> {
	const ids = new Set<string>();
	for (const course of courses) {
		ids.add(course.setupChatId);
		for (const unit of course.units) if (unit.chatId) ids.add(unit.chatId);
	}
	return ids;
}

function groupRows(course: CourseSummary, chatsById: ReadonlyMap<string, ChatListItem>): CourseRow[] {
	return [
		{ kind: "setup", key: `${course.id}:setup`, href: `/chat/${encodeURIComponent(course.setupChatId)}`, chat: chatsById.get(course.setupChatId) ?? null },
		...course.units.map((unit, index): CourseRow => {
			const chat = unit.chatId ? chatsById.get(unit.chatId) ?? null : null;
			return {
				kind: "unit", key: `${course.id}:${unit.id}`, number: index + 1, unit, chat,
				href: unit.chatId && unit.status !== "not-started" ? `/chat/${encodeURIComponent(unit.chatId)}` : courseHref(course.id, unit.id),
			};
		}),
	];
}

export function sessionListEntries({
	chats,
	courses,
	filter,
	query,
	collapsed,
}: {
	chats: readonly ChatListItem[];
	courses: readonly CourseSummary[];
	filter: SessionKindFilter;
	query: string;
	collapsed: ReadonlySet<string>;
}): SessionListEntry[] {
	const members = courseMemberIds(courses);
	const chatsById = new Map(chats.map((chat) => [chat.id, chat]));
	const standalone = chats.filter((chat) => !members.has(chat.id) && (filter === "all" || (chat.kind ?? "teach") === filter));
	const groups = filter === "practice" ? [] : courses.map((course) => {
		const rows = groupRows(course, chatsById);
		const activity = rows.reduce((latest, row) => row.chat && row.chat.updatedAt > latest ? row.chat.updatedAt : latest, course.updatedAt);
		return { course, rows, activity };
	});
	const q = query.trim();
	if (!q) {
		const entries: Array<SessionListEntry & { at: string }> = [
			...standalone.map((chat) => ({ kind: "chat" as const, key: chat.id, href: `/chat/${encodeURIComponent(chat.id)}`, chat, at: chat.updatedAt })),
			...groups.map(({ course, rows, activity }) => ({
				kind: "course" as const, key: course.id, href: courseHref(course.id), course, rows, activity,
				collapsed: collapsed.has(course.id), at: activity,
			})),
		];
		return entries.sort((a, b) => b.at.localeCompare(a.at)).map(({ at: _at, ...entry }) => entry as SessionListEntry);
	}
	const scored: Array<{ entry: SessionListEntry; score: number }> = [];
	for (const chat of standalone) {
		const score = fuzzyScore(q, chat.title);
		if (score !== null) scored.push({ score, entry: { kind: "chat", key: chat.id, href: `/chat/${encodeURIComponent(chat.id)}`, chat } });
	}
	for (const { course, rows, activity } of groups) {
		const header = fuzzyScore(q, course.title);
		const unitScores = rows.map((row) => row.kind === "unit" ? fuzzyScore(q, row.unit.title) : null);
		const matching = rows.filter((_, i) => unitScores[i] !== null);
		const best = Math.max(header ?? -Infinity, ...unitScores.map((score) => score ?? -Infinity));
		if (best === -Infinity) continue;
		// While searching, groups open; a title match shows every row.
		scored.push({ score: best, entry: { kind: "course", key: course.id, href: courseHref(course.id), course, activity, collapsed: false, rows: header !== null ? rows : matching } });
	}
	return scored.sort((a, b) => b.score - a.score).map((item) => item.entry);
}

/** Every openable row in display order (the search walk's targets). */
export function walkTargets(entries: readonly SessionListEntry[]): Array<{ key: string; href: string }> {
	return entries.flatMap((entry) => entry.kind === "chat"
		? [{ key: entry.key, href: entry.href }]
		: [{ key: entry.key, href: entry.href }, ...(entry.collapsed ? [] : entry.rows.map((row) => ({ key: row.key, href: row.href })))]);
}

/** "3/8" beside a course's title. */
export function courseCount(course: Pick<CourseSummary, "completedCount" | "units">): string {
	return `${course.completedCount}/${course.units.length}`;
}

const COLLAPSED_KEY = "lh:collapsed-courses";

export function readCollapsedCourses(): Set<string> {
	try {
		const raw = globalThis.localStorage?.getItem(COLLAPSED_KEY);
		const ids: unknown = raw ? JSON.parse(raw) : [];
		return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
	} catch {
		return new Set();
	}
}

export function writeCollapsedCourses(ids: ReadonlySet<string>): void {
	try { globalThis.localStorage?.setItem(COLLAPSED_KEY, JSON.stringify([...ids])); }
	catch { /* a convenience only */ }
}
