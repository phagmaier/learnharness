/**
 * Courses (fork plan 04): the service behind the course routes and the
 * course hooks in the turn handler.
 *
 * Membership lives in the course record; each member session carries a
 * back-pointer (`course` on its chat record). Writes go record-last where a
 * crash could otherwise orphan data: a unit's session is created (with its
 * back-pointer) before the course records it, and the setup session is
 * linked after the course exists. Reads adopt what a crash left half-done.
 */
import type { ChatCourseLink, ChatRecord, ChatSummary, CourseRecord, CourseSummary, CourseUnit, SessionCourseView } from "../core/contracts.ts";
import { applyUnitEdit, draftProblems, latestProposalCallId, uniqueUnitId, unitCourseContext, unitEditSummary, unitSessionView, type UnitDraft } from "../core/course.ts";
import { newUnitStartMessage } from "../core/native-messages.ts";
import { applyOrganizationAction, placementOf } from "../core/source-organization.ts";
import { courseStore, CourseUnreadableError, newCourseId } from "../store/courses.ts";
import { stampSessionModel } from "./chats.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

export { CourseUnreadableError } from "../store/courses.ts";

export type CourseRefusal = { ok: false; status: number; error: string; problems?: string[] };

const TURN_RUNNING = "A turn is running in this session — try again when it finishes";

function refusal(status: number, error: string, problems?: string[]): CourseRefusal {
	return { ok: false, status, error, ...(problems ? { problems } : {}) };
}

/** Read a course, mapping an unreadable record to a refusal. */
export function readCourse(courseId: string): CourseRecord | CourseRefusal {
	try {
		const record = courseStore.get(courseId);
		return record ? adoptUnitSessions(record) : refusal(404, "Unknown course");
	} catch (error) {
		if (error instanceof CourseUnreadableError) return refusal(409, error.message);
		if (error instanceof Error && error.message.startsWith("Invalid course id")) return refusal(404, "Unknown course");
		throw error;
	}
}

function isRefusal<T>(value: T | CourseRefusal): value is CourseRefusal {
	return typeof value === "object" && value !== null && (value as CourseRefusal).ok === false;
}
export { isRefusal as isCourseRefusal };

// ─── setup sessions ─────────────────────────────────────────────────────────

/** The course a setup session created, adopting a link a crash left
 *  unwritten (the course names its setup session). */
export function setupCourseId(record: ChatRecord): string | undefined {
	if (record.course?.role !== "setup") return undefined;
	if (record.course.courseId) return record.course.courseId;
	const created = courseStore.list().courses.find((course) => course.setupChatId === record.id);
	if (!created) return undefined;
	stores.chatStore.setCourseLink(record.id, { role: "setup", courseId: created.id });
	return created.id;
}

/** One unit as the setup card sends it. Prerequisites name other keys. */
interface DraftUnit { key: string; title: string; goal: string; startingPoint?: string; prerequisites: string[] }

function readDraftUnits(raw: unknown): DraftUnit[] | null {
	if (!Array.isArray(raw)) return null;
	const units: DraftUnit[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") return null;
		const unit = entry as Record<string, unknown>;
		if (typeof unit.key !== "string" || typeof unit.title !== "string" || typeof unit.goal !== "string") return null;
		if (unit.startingPoint !== undefined && typeof unit.startingPoint !== "string") return null;
		if (!Array.isArray(unit.prerequisites) || !unit.prerequisites.every((id) => typeof id === "string")) return null;
		units.push({ key: unit.key, title: unit.title, goal: unit.goal, startingPoint: unit.startingPoint as string | undefined, prerequisites: unit.prerequisites as string[] });
	}
	return units;
}

/** Turn the card's units into course units: ids are readable slugs of
 *  the (possibly edited) titles, made unique; the card's keys only name
 *  prerequisites. */
function unitsFromDrafts(drafts: readonly DraftUnit[]): CourseUnit[] {
	const taken = new Set<string>();
	const idOfKey = new Map<string, string>();
	const ids = drafts.map((draft) => {
		const id = uniqueUnitId(draft.title || draft.key, taken);
		taken.add(id);
		if (!idOfKey.has(draft.key)) idOfKey.set(draft.key, id);
		return id;
	});
	return drafts.map((draft, index) => {
		const startingPoint = draft.startingPoint?.trim();
		return {
			id: ids[index]!,
			title: draft.title.trim(),
			goal: draft.goal.trim(),
			...(startingPoint ? { startingPoint } : {}),
			prerequisites: [...new Set(draft.prerequisites.map((key) => idOfKey.get(key) ?? key))],
			status: "not-started",
		};
	});
}

/**
 * Create a course from a setup session's proposal, as the learner edited
 * it. Refused while a turn runs in the setup session, for a replaced
 * proposal, and once the course exists. Starts unit 1.
 */
export function createCourseFromSetup(body: unknown): { ok: true; courseId: string; chatId: string | null } | CourseRefusal {
	const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
	const setupChatId = typeof input.setupChatId === "string" ? input.setupChatId : "";
	const toolCallId = typeof input.toolCallId === "string" ? input.toolCallId : "";
	const title = typeof input.title === "string" ? input.title.trim() : "";
	const goal = typeof input.goal === "string" ? input.goal.trim() : "";
	const drafts = readDraftUnits(input.units);
	if (!setupChatId || !toolCallId || !drafts) return refusal(400, "Invalid course");
	let record: ChatRecord | null;
	try { record = stores.chatStore.getChat(setupChatId); }
	catch { return refusal(404, "Unknown chat"); }
	if (!record) return refusal(404, "Unknown chat");
	if (record.course?.role !== "setup") return refusal(400, "This session isn't a course setup.");
	if (setupCourseId(record)) return refusal(409, "This course has already been created.");
	if (isTurnRunning(setupChatId)) return refusal(409, TURN_RUNNING);
	if (latestProposalCallId(record.messages) !== toolCallId) return refusal(409, "This proposal was replaced. Create the course from the latest one.");
	// Validate keys before remapping them: duplicate keys and unknown
	// references must not accidentally resolve to a generated title slug.
	const problems = draftProblems({ title, goal, units: drafts.map((draft) => ({ ...draft, startingPoint: draft.startingPoint ?? "" })) });
	if (problems.length > 0) return refusal(400, problems[0]!, problems);
	const units = unitsFromDrafts(drafts);

	const now = new Date().toISOString();
	const course: CourseRecord = {
		id: newCourseId(), title, goal, createdAt: now, updatedAt: now, setupChatId,
		units, proposals: [], evidence: [],
	};
	courseStore.create(course);
	stores.chatStore.setCourseLink(setupChatId, { role: "setup", courseId: course.id });
	const started = startUnit(course.id, units[0]!.id);
	return { ok: true, courseId: course.id, chatId: started.ok ? started.chatId : null };
}

// ─── the course list and edits ──────────────────────────────────────────────

/** The sidebar's courses, plus ids of course folders that can't be read. */
export function listCourseSummaries(): { courses: CourseSummary[]; unreadable: string[] } {
	const { courses, unreadable } = courseStore.list();
	const chats = courses.some((course) => course.units.some((unit) => unit.status === "not-started")) ? stores.chatStore.listChats() : [];
	return {
		unreadable,
		courses: courses.map((course) => adoptUnitSessions(course, chats)).map((course) => ({
			id: course.id,
			title: course.title,
			createdAt: course.createdAt,
			updatedAt: course.updatedAt,
			setupChatId: course.setupChatId,
			completedCount: course.units.filter((unit) => unit.status === "completed").length,
			units: course.units.map((unit) => ({ id: unit.id, title: unit.title, status: unit.status, ...(unit.chatId ? { chatId: unit.chatId } : {}) })),
		})),
	};
}

/** Rename a course; the sessions keep their titles. */
export function renameCourse(courseId: string, rawTitle: unknown): CourseRecord | CourseRefusal {
	return updateCourse(courseId, { title: rawTitle });
}

function readUnitDrafts(raw: unknown): UnitDraft[] | null {
	if (!Array.isArray(raw)) return null;
	const drafts: UnitDraft[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") return null;
		const draft = entry as Record<string, unknown>;
		if ((draft.id !== undefined && typeof draft.id !== "string") || typeof draft.title !== "string" || typeof draft.goal !== "string") return null;
		if (draft.startingPoint !== undefined && typeof draft.startingPoint !== "string") return null;
		if (!Array.isArray(draft.prerequisites) || !draft.prerequisites.every((id) => typeof id === "string")) return null;
		drafts.push({
			...(draft.id ? { id: draft.id as string } : {}), title: draft.title, goal: draft.goal,
			...(draft.startingPoint !== undefined ? { startingPoint: draft.startingPoint as string } : {}),
			prerequisites: draft.prerequisites as string[],
		});
	}
	return drafts;
}

/**
 * The learner's "Edit units" (decision 5): started units may be renamed,
 * re-goaled, reordered and re-pointed but not removed; others change
 * freely. A real change records a learner revision.
 */
export function editCourseUnits(courseId: string, rawUnits: unknown): CourseRecord | CourseRefusal {
	return updateCourse(courseId, { units: rawUnits });
}

/** Validate the whole request before committing a rename and/or unit edit. */
export function updateCourse(courseId: string, input: { title?: unknown; units?: unknown; expectedUpdatedAt?: unknown }): CourseRecord | CourseRefusal {
	const title = input.title === undefined ? undefined : typeof input.title === "string" ? input.title.trim() : "";
	if (title === "") return refusal(400, "The course needs a title.");
	const drafts = input.units === undefined ? undefined : readUnitDrafts(input.units);
	if (drafts === null) return refusal(400, "Invalid unit list");
	const course = readCourse(courseId);
	if (isRefusal(course)) return course;
	if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== course.updatedAt) {
		return refusal(409, "This course changed while you were editing. Cancel and reopen Edit units to load the latest version.");
	}
	const outcome = drafts ? applyUnitEdit(course.units, drafts) : { ok: true as const, units: course.units };
	if (!outcome.ok) return refusal(400, outcome.problems[0]!, outcome.problems);
	const changes = unitEditSummary(course.units, outcome.units);
	if (changes.length === 0 && (title === undefined || title === course.title)) return course;
	const at = new Date().toISOString();
	return courseStore.update(courseId, (current) => ({
		...current,
		title: title ?? current.title,
		units: outcome.units,
		evidence: changes.length === 0 ? current.evidence : [...current.evidence, { type: "revision", id: `revision:learner:${crypto.randomUUID()}`, at, source: "learner", decision: "accepted", changes }],
	})) ?? refusal(404, "Unknown course");
}

// ─── units ──────────────────────────────────────────────────────────────────

/** The unit session's title: "<course title> · <n>. <unit title>". */
export function unitSessionTitle(course: Pick<CourseRecord, "title">, number: number, unit: Pick<CourseUnit, "title">): string {
	return `${course.title} · ${number}. ${unit.title}`;
}

/** Finish an interrupted start before publishing membership. Existing
 * transcripts and model choices survive; only an empty chat needs a seed. */
function prepareUnitSession(chat: ChatRecord, course: CourseRecord, unit: CourseUnit): void {
	if (chat.messages.length > 0) return;
	if (!chat.settings?.model) stampSessionModel(chat.id);
	stores.chatStore.saveMessages(chat.id, [newUnitStartMessage({ courseId: course.id, unitId: unit.id, number: course.units.indexOf(unit) + 1, title: unit.title })]);
}

/** Recover a chat created before the course write. Never replace an
 * already-published session or delete a transcript during recovery. */
function adoptUnitSessions(course: CourseRecord, summaries?: readonly ChatSummary[]): CourseRecord {
	const waiting = course.units.filter((unit) => unit.status === "not-started");
	if (waiting.length === 0) return course;
	const chats = summaries ?? stores.chatStore.listChats();
	const adopted = new Map<string, ChatRecord>();
	for (const unit of waiting) {
		const candidate = chats.filter((chat) => chat.course?.role === "unit" && chat.course.courseId === course.id && chat.course.unitId === unit.id)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
		const chat = candidate && stores.chatStore.getChat(candidate.id);
		if (!chat) continue;
		prepareUnitSession(chat, course, unit);
		adopted.set(unit.id, chat);
	}
	if (adopted.size === 0) return course;
	let sourceFolderId = course.sourceFolderId;
	for (const chat of adopted.values()) sourceFolderId = placeUnitSource({ ...course, sourceFolderId }, chat.id) ?? sourceFolderId;
	return courseStore.update(course.id, (current) => ({
		...current,
		...(sourceFolderId ? { sourceFolderId } : {}),
		units: current.units.map((unit) => adopted.has(unit.id) ? { ...unit, status: "in-progress", chatId: adopted.get(unit.id)!.id } : unit),
		evidence: [...current.evidence, ...[...adopted].flatMap(([unitId, chat]) => current.evidence.some((event) => event.id === `unit-started:${chat.id}`) ? []
			: [{ type: "unit-started" as const, id: `unit-started:${chat.id}`, at: chat.createdAt, unitId, chatId: chat.id }])],
	})) ?? course;
}

/**
 * Place a unit session's graph source in the course's folder, created at
 * the first start (named after the course) and reused after; recreated if
 * the learner removed it. A source the learner already placed stays where
 * it is. Presentation only: a failure is logged and never blocks the start.
 * Returns the course's folder id.
 */
function placeUnitSource(course: CourseRecord, chatId: string): string | undefined {
	try {
		const state = stores.sourceOrganizationStore.read();
		// A stable identity survives a crash after organization is saved but
		// before sourceFolderId reaches course.json. Never infer ownership
		// from a session's placement: the learner may have moved it.
		const recoveryFolderId = `folder_${course.id}`;
		let folderId = [course.sourceFolderId, recoveryFolderId].find((id) => id && state.folders.some((folder) => folder.id === id));
		if (placementOf(state, chatId)) return folderId ?? course.sourceFolderId;
		let next = state;
		if (!folderId) {
			const folder = { id: recoveryFolderId, createdAt: new Date().toISOString() };
			next = applyOrganizationAction(next, { action: "create-folder", name: course.title, parentId: null }, new Set(), folder);
			folderId = folder.id;
		}
		next = applyOrganizationAction(next, { action: "move", kind: "source", id: chatId, parentId: folderId }, new Set([chatId]), { id: "", createdAt: "" });
		stores.sourceOrganizationStore.write(next);
		return folderId;
	} catch (error) {
		console.error(`[course ${course.id}] placing ${chatId} in the course's graph folder failed:`, error);
		return course.sourceFolderId;
	}
}

/**
 * Start a unit: create its session (back-pointer first, then the unit-start
 * marker as message 0), then record it in the course with a unit-started
 * event. Refused for a unit that has already started.
 */
export function startUnit(courseId: string, unitId: string): { ok: true; chatId: string } | CourseRefusal {
	const course = readCourse(courseId);
	if (isRefusal(course)) return course;
	const index = course.units.findIndex((unit) => unit.id === unitId);
	if (index === -1) return refusal(404, "Unknown unit");
	const unit = course.units[index]!;
	if (unit.status !== "not-started") return refusal(409, "This unit has already started.");
	const link: ChatCourseLink = { role: "unit", courseId, unitId };
	const chat = stores.chatStore.createChat(unitSessionTitle(course, index + 1, unit), undefined, link);
	prepareUnitSession(chat, course, unit);
	const sourceFolderId = placeUnitSource(course, chat.id);
	const at = new Date().toISOString();
	courseStore.update(courseId, (current) => ({
		...current,
		...(sourceFolderId ? { sourceFolderId } : {}),
		units: current.units.map((candidate) => candidate.id === unitId ? { ...candidate, status: "in-progress", chatId: chat.id } : candidate),
		evidence: [...current.evidence, { type: "unit-started", id: `unit-started:${chat.id}`, at, unitId, chatId: chat.id }],
	}));
	return { ok: true, chatId: chat.id };
}

// ─── session pages ──────────────────────────────────────────────────────────

/** A unit session's course and unit. Null when the session isn't a member
 *  (no unit link, the course is gone, or another session holds the unit);
 *  a refusal when the course record can't be read. */
function unitMembership(record: ChatRecord): { course: CourseRecord; unit: CourseUnit } | CourseRefusal | null {
	if (record.course?.role !== "unit") return null;
	const { courseId, unitId } = record.course;
	const course = readCourse(courseId);
	if (isRefusal(course)) return course.status === 404 ? null : course;
	const unit = course.units.find((candidate) => candidate.id === unitId);
	if (!unit || unit.chatId !== record.id) return null;
	return { course, unit };
}

/** What a session's page shows about its course; undefined outside one. */
export function sessionCourseView(record: ChatRecord): SessionCourseView | undefined {
	if (record.course?.role === "setup") return { role: "setup", courseId: setupCourseId(record) ?? null };
	const membership = unitMembership(record);
	if (!membership || isRefusal(membership)) return undefined;
	return unitSessionView(membership.course, membership.unit.id, record.id);
}

/**
 * Record a unit teacher's goal_reached signal: the unit's goalReachedAt
 * (kept from the first signal until a reopen clears it) and a goal-reached
 * event per call. Returns null, or the refusal the model reads.
 */
export function recordGoalReached(courseId: string, unitId: string, chatId: string, toolCallId: string, summary: string): string | null {
	const course = readCourse(courseId);
	if (isRefusal(course)) return `The goal couldn't be recorded: ${course.error}`;
	const unit = course.units.find((candidate) => candidate.id === unitId);
	if (!unit || unit.chatId !== chatId) return "The goal couldn't be recorded: this session is no longer a unit of the course.";
	if (unit.status === "completed") return "The goal couldn't be recorded: this unit is already completed.";
	const at = new Date().toISOString();
	const id = `goal-reached:${chatId}:${toolCallId}`;
	courseStore.update(courseId, (current) => ({
		...current,
		units: current.units.map((candidate) => candidate.id === unitId ? { ...candidate, goalReachedAt: candidate.goalReachedAt ?? at } : candidate),
		evidence: current.evidence.some((event) => event.id === id) ? current.evidence
			: [...current.evidence, { type: "goal-reached", id, at, unitId, chatId, summary }],
	}));
	return null;
}

/**
 * A unit session's per-turn course, for the agent: the course context
 * (composed fresh from the record) and the goal_reached hook. Undefined
 * outside a unit session.
 */
export function unitTurnCourse(record: ChatRecord): { context: string; recordGoalReached: (summary: string, toolCallId: string) => string | null } | undefined {
	const membership = unitMembership(record);
	if (!membership || isRefusal(membership)) return undefined;
	const { course, unit } = membership;
	return {
		context: unitCourseContext(course, unit.id),
		recordGoalReached: (summary, toolCallId) => recordGoalReached(course.id, unit.id, record.id, toolCallId, summary),
	};
}

// ─── the turn handler's gate ────────────────────────────────────────────────

/**
 * Whether a course session takes new main input. A setup session closes
 * once its course exists, and a unit session while its unit is completed
 * or its course record can't be read. Learner input gets 409; a job
 * result's wake gets 410, which leaves the delivery pending instead of
 * retrying it.
 */
export function courseInputRefusal(record: ChatRecord, inputType: string): { status: number; error: string } | null {
	const status = inputType === "steers" ? 410 : 409;
	if (record.course?.role === "setup" && setupCourseId(record)) {
		return { status, error: "This course has been created. Continue in its units." };
	}
	const membership = unitMembership(record);
	if (membership && isRefusal(membership)) return { status, error: `This session's course can't be read: ${membership.error}` };
	if (membership?.unit.status === "completed") return { status, error: "This unit is completed. Reopen it to continue." };
	return null;
}
