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
import type { ChatCourseLink, ChatRecord, ChatSummary, CourseChange, CourseEvidence, CourseProposal, CourseRecord, CourseSummary, CourseUnit, SessionCourseView, UnitHandoff } from "../core/contracts.ts";
import { applyCourseChanges, applyUnitEdit, courseChangeLine, draftProblems, latestProposalCallId, proposalRevisionId, REPLACED_PROPOSAL_REASON, sessionHandoffTopics, uniqueUnitId, unitCompletionOf, unitCourseContext, unitEditSummary, unitPracticeContext, unitSessionView, type UnitDraft } from "../core/course.ts";
import { sessionAnswerEvidence, sessionPracticeEvidence } from "../core/course-evidence.ts";
import { newUnitPracticeMessage, newUnitStartMessage, type GraphContextPick, type LhMarkerMessage } from "../core/native-messages.ts";
import { modelsNotConfigured } from "../core/settings.ts";
import type { ChatDeleteMode, ChatDeletionStats } from "../core/graph-deletion.ts";
import { applyOrganizationAction, folderIsEmpty, placementOf } from "../core/source-organization.ts";
import { abortExtraction } from "../agent/subagents/extraction.ts";
import { courseStore, CourseUnreadableError, newCourseId } from "../store/courses.ts";
import { extractionRunningIn, purgeChatSessions, runningWorkBlocker, stampSessionModel, windDownExtractions } from "./chats.ts";
import { graphRevision } from "./graph.ts";
import { handoffWriterEngine, isHandoffWriterRunning, settleInterruptedHandoffs, startHandoffWriter, stopCourseHandoffWriters, stopHandoffWriter } from "./handoffs.ts";
import { createNote } from "./notes.ts";
import { sourceDirectory } from "./source-organization.ts";
import { effectiveSettings, stores } from "./stores.ts";
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
		return record ? settleInterruptedHandoffs(adoptUnitSessions(record)) : refusal(404, "Unknown course");
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
		// Fork plan 05: the book chosen when the setup started, with its mode.
		...(record.book ? { book: { bookId: record.book.bookId, mode: record.book.mode ?? "follow" } } : {}),
		units, proposals: [], evidence: [],
	};
	courseStore.create(course);
	stores.chatStore.setCourseLink(setupChatId, { role: "setup", courseId: course.id });
	// The setup probe's answers: the session closes now, so no later
	// settlement would bring them in.
	syncCourseEvidence(course.id, { chatId: setupChatId });
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

// ─── completing and reopening (item 6) ──────────────────────────────────────

export const COMPLETE_WORK_RUNNING = "Wait for the running work to finish, then complete the unit.";

function findUnit(course: CourseRecord, unitId: string): CourseUnit | CourseRefusal {
	return course.units.find((candidate) => candidate.id === unitId) ?? refusal(404, "Unknown unit");
}

/** The order of this unit's lifecycle events of one type, for stable ids. */
function lifecycleId(course: CourseRecord, type: "unit-completed" | "unit-reopened", chatId: string): string {
	const prefix = `${type}:${chatId}:`;
	return `${prefix}${course.evidence.filter((event) => event.id.startsWith(prefix)).length + 1}`;
}

/** The completion dialog's optional note (phase 0's request). */
function readNoteOffer(raw: unknown): { instruction: string; interactive: boolean } | null {
	if (!raw || typeof raw !== "object") return null;
	const note = raw as Record<string, unknown>;
	return { instruction: typeof note.instruction === "string" ? note.instruction : "", interactive: note.interactive === true };
}

/**
 * Complete a unit (the learner's "Complete unit"): confirmed after the
 * teacher's goal_reached signal, early before it. Refused while a turn or a
 * background job runs in the unit's session, as deletion is; note writers
 * don't block. Syncs the session's evidence, stores the handoff's computed
 * topics at once, and starts the handoff writer (failed at once when its
 * engine can't be built, so the computed part still lands). The
 * optional note offer starts phase 0's note writer for the session.
 */
export function completeUnit(courseId: string, unitId: string, input: { note?: unknown } = {}): { ok: true; course: CourseRecord; noteError?: string } | CourseRefusal {
	const read = readCourse(courseId);
	if (isRefusal(read)) return read;
	const unit = findUnit(read, unitId);
	if (isRefusal(unit)) return unit;
	if (unit.status === "completed") return refusal(409, "This unit is already completed.");
	if (unit.status !== "in-progress" || !unit.chatId) return refusal(409, "This unit hasn't started yet.");
	const chatId = unit.chatId;
	if (runningWorkBlocker(chatId)) return refusal(409, COMPLETE_WORK_RUNNING);
	const chat = readChat(chatId);
	if (!chat) return refusal(409, "This unit's session can't be read.");

	const synced = syncCourseEvidence(courseId, { chatId });
	if (isRefusal(synced)) return synced;
	let engine: ReturnType<typeof handoffWriterEngine>;
	let writer: UnitHandoff["writer"] = { status: "failed", error: modelsNotConfigured(["strong"]).error };
	try {
		engine = handoffWriterEngine();
		if (engine) writer = { status: "writing" };
	} catch (error) {
		// A disconnected provider can leave a saved model unavailable.
		writer = { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
	const at = new Date().toISOString();
	const completion = unitCompletionOf(unit);
	const handoff: UnitHandoff = {
		writtenAt: at, completion,
		topics: sessionHandoffTopics(chat, unitId, synced.evidence),
		writer,
	};
	const course = courseStore.update(courseId, (current) => ({
		...current,
		units: current.units.map((candidate) => candidate.id === unitId
			? { ...candidate, status: "completed", completion, completedAt: at, handoff }
			: candidate),
		evidence: [...current.evidence, { type: "unit-completed", id: lifecycleId(current, "unit-completed", chatId), at, unitId, completion }],
	}));
	if (!course) return refusal(404, "Unknown course");
	if (engine) startHandoffWriter(course, unitId, engine);

	const note = readNoteOffer(input.note);
	if (!note) return { ok: true, course };
	try {
		const created = createNote(chatId, note);
		return created.ok ? { ok: true, course } : { ok: true, course, noteError: created.error };
	} catch (error) {
		// Completion is already saved; an optional note must not turn it
		// into a failed request or prevent the conversation export.
		return { ok: true, course, noteError: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Reopen a completed unit: back to in progress, the goal signal cleared,
 * and a unit-reopened event. The old handoff stays (later units keep
 * reading it) until the next completion rewrites it; a writer still
 * running is stopped first.
 */
export function reopenUnit(courseId: string, unitId: string): CourseRecord | CourseRefusal {
	const read = readCourse(courseId);
	if (isRefusal(read)) return read;
	const unit = findUnit(read, unitId);
	if (isRefusal(unit)) return unit;
	if (unit.status !== "completed" || !unit.chatId) return refusal(409, "This unit isn't completed.");
	const chatId = unit.chatId;
	stopHandoffWriter(courseId, unitId);
	const at = new Date().toISOString();
	return courseStore.update(courseId, (current) => ({
		...current,
		units: current.units.map((candidate) => {
			if (candidate.id !== unitId) return candidate;
			const { goalReachedAt: _signal, completion: _completion, completedAt: _completed, ...rest } = candidate;
			return { ...rest, status: "in-progress" };
		}),
		evidence: [...current.evidence, { type: "unit-reopened", id: lifecycleId(current, "unit-reopened", chatId), at, unitId }],
	})) ?? refusal(404, "Unknown course");
}

/** "Try again" on a handoff whose writer failed, was stopped, or was
 *  interrupted: the same handoff, written again. */
export function retryHandoffWriter(courseId: string, unitId: string): CourseRecord | CourseRefusal {
	const read = readCourse(courseId);
	if (isRefusal(read)) return read;
	const unit = findUnit(read, unitId);
	if (isRefusal(unit)) return unit;
	const handoff = unit.handoff;
	if (unit.status !== "completed" || !handoff) return refusal(409, "This unit isn't completed.");
	if (handoff.writer.status === "writing" || isHandoffWriterRunning(courseId, unitId)) return refusal(409, "The teacher observations are being written.");
	if (handoff.writer.status === "ready") return refusal(409, "The teacher observations are already written.");
	const engine = handoffWriterEngine();
	if (!engine) return refusal(503, modelsNotConfigured(["strong"]).error);
	const course = courseStore.update(courseId, (current) => ({
		...current,
		units: current.units.map((candidate) => candidate.id === unitId && candidate.handoff?.writtenAt === handoff.writtenAt
			? { ...candidate, handoff: { ...candidate.handoff, writer: { status: "writing" } } }
			: candidate),
	}), { touch: false });
	if (!course) return refusal(404, "Unknown course");
	startHandoffWriter(course, unitId, engine);
	return course;
}

// ─── "Practice this unit" (item 8) ──────────────────────────────────────────

/** A unit the practice draft can attach: one that has started. */
function practicableUnit(courseId: string, unitId: string): { course: CourseRecord; unit: CourseUnit; number: number } | CourseRefusal {
	const course = readCourse(courseId);
	if (isRefusal(course)) return course;
	const index = course.units.findIndex((candidate) => candidate.id === unitId);
	const unit = course.units[index];
	if (!unit) return refusal(404, "Unknown unit");
	if (unit.status === "not-started" || !unit.chatId) return refusal(409, "This unit hasn't started yet.");
	return { course, unit, number: index + 1 };
}

/** What the practice draft shows of an attached unit; null when the
 *  course or unit can't be attached (the draft then opens plain). */
export function unitPracticeAttachment(courseId: string, unitId: string): { courseId: string; unitId: string; number: number; title: string } | null {
	const found = practicableUnit(courseId, unitId);
	return isRefusal(found) ? null : { courseId: found.course.id, unitId: found.unit.id, number: found.number, title: found.unit.title };
}

/**
 * Start a "Practice this unit" session's context (decision 4): its course
 * back-pointer and its message 0, the unit's practice context. The unit's
 * graph propositions are those whose provenance names its session, read
 * as the graph is now (never waiting for extraction) and left out with the
 * graph off.
 */
export function unitPracticeStart(courseId: string, unitId: string): { ok: true; link: ChatCourseLink; message: LhMarkerMessage } | CourseRefusal {
	const found = practicableUnit(courseId, unitId);
	if (isRefusal(found)) return found;
	const chatId = found.unit.chatId!;
	const propositions: GraphContextPick[] = effectiveSettings().graph.enabled
		? stores.graphStore.readNodes()
			.filter((node) => node.provenance.some((point) => point.chatId === chatId))
			.map((node) => ({ id: node.id, name: node.name, statement: node.statement }))
		: [];
	const context = unitPracticeContext(found.course, found.unit.id, propositions)!;
	return {
		ok: true,
		link: { role: "practice", courseId: found.course.id, unitId: found.unit.id },
		message: newUnitPracticeMessage(context.text, context.unit, propositions),
	};
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
 * (composed fresh from the record), the goal_reached hook, and the
 * propose_course_changes hook. Undefined outside a unit session.
 */
export function unitTurnCourse(record: ChatRecord): {
	context: string;
	recordGoalReached: (summary: string, toolCallId: string) => string | null;
	proposeCourseChanges: (proposal: { reason: string; changes: CourseChange[] }, toolCallId: string) => ProposalOutcome;
} | undefined {
	const membership = unitMembership(record);
	if (!membership || isRefusal(membership)) return undefined;
	const { course, unit } = membership;
	return {
		context: unitCourseContext(course, unit.id),
		recordGoalReached: (summary, toolCallId) => recordGoalReached(course.id, unit.id, record.id, toolCallId, summary),
		proposeCourseChanges: (proposal, toolCallId) => recordCourseProposal(course.id, unit.id, record.id, toolCallId, proposal),
	};
}

// ─── course revisions (item 7) ──────────────────────────────────────────────

export type ProposalOutcome = { ok: true; proposalId: string } | { ok: false; problems: string[] } | { ok: false; refused: string };

/**
 * Store a unit teacher's proposal as pending, after validating it against
 * the current course and decision 5 (refusals go back to the model). The
 * unit's earlier pending proposal is replaced: it becomes outdated (human,
 * 2026-11-13). toolCallId is the canonical transcript id, not the provider's
 * raw id (which can be reused). The same call recorded twice keeps its first proposal.
 * Leaves updatedAt alone: the units don't change until the learner accepts.
 */
export function recordCourseProposal(courseId: string, unitId: string, chatId: string, toolCallId: string, input: { reason: string; changes: CourseChange[] }): ProposalOutcome {
	const refused = (problem: string): ProposalOutcome => ({ ok: false, refused: `The proposal couldn't be recorded: ${problem}` });
	const course = readCourse(courseId);
	if (isRefusal(course)) return refused(course.error);
	const unit = course.units.find((candidate) => candidate.id === unitId);
	if (!unit || unit.chatId !== chatId) return refused("this session is no longer a unit of the course.");
	if (unit.status === "completed") return refused("this unit is already completed.");
	const existing = course.proposals.find((proposal) => proposal.chatId === chatId && proposal.toolCallId === toolCallId);
	if (existing) return { ok: true, proposalId: existing.id };
	const outcome = applyCourseChanges(course.units, input.changes);
	if (!outcome.ok) return { ok: false, problems: outcome.problems };
	const at = new Date().toISOString();
	const proposal: CourseProposal = {
		id: `proposal_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		chatId, unitId, toolCallId, at, reason: input.reason, changes: input.changes, status: "pending",
	};
	const stored = courseStore.update(courseId, (current) => ({
		...current,
		proposals: [
			...current.proposals.map((earlier) => earlier.unitId === unitId && earlier.status === "pending"
				? { ...earlier, status: "outdated" as const, decidedAt: at, outdatedReason: REPLACED_PROPOSAL_REASON }
				: earlier),
			proposal,
		],
	}), { touch: false });
	return stored ? { ok: true, proposalId: proposal.id } : refused("the course no longer exists.");
}

/**
 * The learner's Accept or Reject on a pending proposal. Accepting
 * revalidates against the current course: a proposal that no longer
 * applies becomes outdated with the reason, and nothing changes. Each
 * decision records a revision event, its change lines numbered against the
 * units it was decided on. Only an accepted proposal changes the units, so
 * only it stamps updatedAt (an open "Edit units" draft is then stale).
 */
export function decideCourseProposal(courseId: string, proposalId: string, decision: unknown): CourseRecord | CourseRefusal {
	if (decision !== "accept" && decision !== "reject") return refusal(400, "The decision must be \"accept\" or \"reject\".");
	const course = readCourse(courseId);
	if (isRefusal(course)) return course;
	const proposal = course.proposals.find((candidate) => candidate.id === proposalId);
	if (!proposal) return refusal(404, "Unknown proposal");
	if (proposal.status !== "pending") return refusal(409, "This proposal has already been decided.");
	const at = new Date().toISOString();
	const outcome = decision === "accept" ? applyCourseChanges(course.units, proposal.changes) : null;
	const settle = (current: CourseRecord, patch: Partial<CourseProposal>): CourseProposal[] =>
		current.proposals.map((candidate) => candidate.id === proposalId ? { ...candidate, ...patch, decidedAt: at } : candidate);
	if (outcome && !outcome.ok) {
		return courseStore.update(courseId, (current) => ({
			...current, proposals: settle(current, { status: "outdated", outdatedReason: outcome.problems.join(" ") }),
		}), { touch: false }) ?? refusal(404, "Unknown course");
	}
	const revision: CourseEvidence = {
		type: "revision", id: proposalRevisionId(proposalId), at, source: "teacher",
		decision: outcome ? "accepted" : "rejected", proposalId,
		changes: proposal.changes.map((change) => courseChangeLine(change, course.units)),
	};
	return courseStore.update(courseId, (current) => ({
		...current,
		...(outcome ? { units: outcome.units } : {}),
		proposals: settle(current, { status: outcome ? "accepted" : "rejected" }),
		evidence: current.evidence.some((event) => event.id === revision.id) ? current.evidence : [...current.evidence, revision],
	}), { touch: outcome !== null }) ?? refusal(404, "Unknown course");
}

// ─── evidence (item 5) ──────────────────────────────────────────────────────

/** A course session's evidence, or null when the chat isn't one of the
 *  course's: its setup session, the session a unit records, or a
 *  "Practice this unit" session linked to one of its units. */
function sessionEvidence(course: CourseRecord, chat: ChatRecord): CourseEvidence[] | null {
	const messages = chat.messages;
	if (chat.id === course.setupChatId) return sessionAnswerEvidence(messages, { chatId: chat.id, setup: true });
	const unit = course.units.find((candidate) => candidate.chatId === chat.id);
	if (unit) return sessionAnswerEvidence(messages, { chatId: chat.id, unitId: unit.id });
	const link = chat.course;
	if (chat.kind === "practice" && link?.role === "practice" && link.courseId === course.id && course.units.some((candidate) => candidate.id === link.unitId)) {
		return sessionPracticeEvidence(messages, { chatId: chat.id, unitId: link.unitId });
	}
	return null;
}

function readChat(chatId: string): ChatRecord | null {
	try { return stores.chatStore.getChat(chatId); }
	catch { return null; }
}

/**
 * Append the evidence a course's sessions hold and its record lacks: the
 * setup session, each unit's recorded session, and the linked "Practice
 * this unit" sessions. `chatId` limits the read to that one session (a
 * turn's settlement). Ids are stable, so repeating it adds nothing, and
 * nothing is ever removed: a deleted practice session's events stay.
 * Writes only when something is new, and leaves updatedAt alone.
 */
export function syncCourseEvidence(courseId: string, only?: { chatId: string }): CourseRecord | CourseRefusal {
	const course = readCourse(courseId);
	if (isRefusal(course)) return course;
	let chats: ChatRecord[];
	if (only) {
		const chat = readChat(only.chatId);
		chats = chat ? [chat] : [];
	} else {
		const ids = new Set([course.setupChatId, ...course.units.flatMap((unit) => unit.chatId ? [unit.chatId] : [])]);
		for (const summary of stores.chatStore.listChats()) {
			if (summary.course?.role === "practice" && summary.course.courseId === courseId) ids.add(summary.id);
		}
		chats = [...ids].map(readChat).filter((chat): chat is ChatRecord => chat !== null);
	}
	const known = new Set(course.evidence.map((event) => event.id));
	const fresh = chats.flatMap((chat) => sessionEvidence(course, chat) ?? []).filter((event) => !known.has(event.id));
	if (fresh.length === 0) return course;
	return courseStore.update(courseId, (current) => {
		const stored = new Set(current.evidence.map((event) => event.id));
		return { ...current, evidence: [...current.evidence, ...fresh.filter((event) => !stored.has(event.id))] };
	}, { touch: false }) ?? refusal(404, "Unknown course");
}

/** The settlement hook: sync the course a setup, unit, or linked practice
 *  session belongs to, from that session only. A setup session without a
 *  course has nothing to sync (creation syncs it, then closes it). Never
 *  throws; a failure is logged and the next sync catches up. */
export function syncSessionEvidence(record: Pick<ChatRecord, "id" | "course">): void {
	try {
		const courseId = record.course?.courseId;
		if (!courseId) return;
		const synced = syncCourseEvidence(courseId, { chatId: record.id });
		if (isRefusal(synced) && synced.status !== 404) console.warn(`[course ${courseId}] evidence sync for ${record.id} refused: ${synced.error}`);
	} catch (error) {
		console.error(`[chat ${record.id}] course evidence sync failed:`, error);
	}
}

// ─── course deletion (item 9) ───────────────────────────────────────────────

export type CourseDeleteRefusal = CourseRefusal & { code?: "turn_in_flight" | "jobs_running" | "extraction_winding_down"; chatId?: string };
export type CourseDeleteOutcome = { ok: true; mode: ChatDeleteMode; chatIds: string[]; stats: ChatDeletionStats; graphRevision: number } | CourseDeleteRefusal;

const DELETE_WINDING_DOWN = "An extraction in this course is still winding down — try again in a moment";

/** Every member named by the course, setup first and then units in order,
 *  with the name a refusal uses. Missing records still identify graph
 *  contributions and client pages to remove on a successful retry. Linked
 *  "Practice this unit" sessions aren't the course's and stay. */
function courseSessions(course: CourseRecord): Array<{ chatId: string; name: string }> {
	return [{ chatId: course.setupChatId, name: "the setup session" }, ...course.units.flatMap((unit, index) =>
		unit.chatId ? [{ chatId: unit.chatId, name: `unit ${index + 1} (${unit.title})` }] : [])];
}

/** The first session with a running turn or background job, named. */
function courseWorkBlocker(sessions: ReadonlyArray<{ chatId: string; name: string }>): CourseDeleteRefusal | null {
	for (const session of sessions) {
		const blocker = runningWorkBlocker(session.chatId);
		if (!blocker) continue;
		const error = blocker.code === "turn_in_flight"
			? `A turn is running in ${session.name} — try again when it finishes`
			: `Background jobs are still running in ${session.name} — try again when they finish`;
		return { ok: false, status: 409, code: blocker.code, chatId: session.chatId, error };
	}
	return null;
}

/** Remove the course's graph folder when nothing is left in it: no source,
 *  including a deleted session whose traces the graph kept, and no
 *  subfolder. Presentation only: a failure is logged and never fails the
 *  deletion. */
function removeCourseSourceFolder(course: CourseRecord): void {
	try {
		const state = stores.sourceOrganizationStore.read();
		const sources = new Set(sourceDirectory.read().sources.map((source) => source.id));
		let next = state;
		for (const id of new Set([course.sourceFolderId, `folder_${course.id}`])) {
			if (!id || !next.folders.some((folder) => folder.id === id) || !folderIsEmpty(next, id, sources)) continue;
			next = {
				...next,
				folders: next.folders.filter((folder) => folder.id !== id),
				placements: Object.fromEntries(Object.entries(next.placements).filter(([, placement]) => placement.folderId !== id)),
			};
		}
		if (next !== state) stores.sourceOrganizationStore.write(next);
	} catch (error) {
		console.error(`[course ${course.id}] removing the course's graph folder failed:`, error);
	}
}

/**
 * Delete a course (the learner's "Delete course…"), mirroring session
 * deletion: refused while any of its sessions has a running turn or
 * background job, naming the session; then their extraction is wound down.
 * The rest runs without an await: the gates again, the handoff writers
 * stopped, every session deleted through the session purge (setup first,
 * then the units; note writers stop with their notes), the graph folder if
 * it's empty, and the course folder (record, progress.md, notes) last. A
 * failure part-way keeps the course, whose missing sessions count as
 * already deleted, so Delete again finishes.
 */
export async function deleteCourse(courseId: string, mode: ChatDeleteMode): Promise<CourseDeleteOutcome> {
	const course = readCourse(courseId);
	if (isRefusal(course)) return course;
	const sessions = courseSessions(course);
	const blocker = courseWorkBlocker(sessions);
	if (blocker) return blocker;
	if (!(await windDownExtractions(sessions.map((session) => session.chatId)))) {
		return { ...refusal(503, DELETE_WINDING_DOWN), code: "extraction_winding_down" };
	}

	// No await from here on. Reread: a unit may have started meanwhile.
	const current = readCourse(courseId);
	if (isRefusal(current)) return current;
	const doomed = courseSessions(current);
	const lateBlocker = courseWorkBlocker(doomed);
	if (lateBlocker) return lateBlocker;
	const chatIds = doomed.map((session) => session.chatId);
	if (extractionRunningIn(chatIds)) {
		for (const chatId of chatIds) abortExtraction(chatId);
		return { ...refusal(503, DELETE_WINDING_DOWN), code: "extraction_winding_down" };
	}
	stopCourseHandoffWriters(courseId);
	let stats: ChatDeletionStats;
	try {
		({ stats } = purgeChatSessions(chatIds, mode));
		removeCourseSourceFolder(current);
		courseStore.remove(courseId);
	} catch (error) {
		console.error(`[course ${courseId}] deleting the course failed:`, error);
		return refusal(500, "Some of this course's sessions couldn't be deleted. Try again.");
	}
	return { ok: true, mode, chatIds, stats, graphRevision: graphRevision() };
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
