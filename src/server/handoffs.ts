/**
 * The handoff writer's lifecycle (fork plan 04 item 6). Completing a unit
 * stores the computed part of its handoff at once with the writer
 * "writing"; the writer then adds the model-written observations in the
 * background. Stop aborts it, and a writer left "writing" by a closed app
 * reads as interrupted. A failure, Stop, or interruption keeps the computed
 * part; "Try again" restarts the writer for the same handoff.
 *
 * Requests use the handoffWriter role (Strong slot), run with purpose
 * "user" because the learner completed the unit (no background consent on
 * subscriptions), and share the worker-request pool. A running writer shows
 * in Background agents as "Handoff · <unit title>".
 *
 * A writer belongs to one handoff, identified by its writtenAt: a result
 * that arrives after the unit was reopened and completed again (a new
 * handoff) is dropped rather than written into the wrong one.
 */
import type { CourseRecord, HandoffWriterState, JobUsage, UnitHandoff } from "../core/contracts.ts";
import type { AnswerEvidence } from "../core/contracts/course.ts";
import { emit } from "../core/events.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { writeHandoff } from "../agent/subagents/handoff-writer.ts";
import { courseStore } from "../store/courses.ts";
import { INTERRUPTED_MESSAGE, STOPPED_MESSAGE } from "./notes.ts";
import { stores } from "./stores.ts";

/** Test seams: engine construction and the writer itself. */
export const handoffServiceSeams = {
	buildEngine: piEngineForSpec as (...args: Parameters<typeof piEngineForSpec>) => PiEngine,
	write: writeHandoff,
};

interface RunningHandoff {
	courseId: string;
	unitId: string;
	chatId: string;
	unitTitle: string;
	/** The handoff this writer belongs to. */
	writtenAt: string;
	controller: AbortController;
	startedAt: string;
	usage?: JobUsage;
	model?: string;
}

interface HandoffsGlobal { __lhRunningHandoffs?: Map<string, RunningHandoff> }
function running(): Map<string, RunningHandoff> {
	const global = globalThis as typeof globalThis & HandoffsGlobal;
	return global.__lhRunningHandoffs ??= new Map();
}
const key = (courseId: string, unitId: string) => `${courseId}:${unitId}`;

/** The handoff writer's engine: role override → Strong slot, purpose "user". */
export function handoffWriterEngine(): PiEngine | undefined {
	const settings = stores.settingsStore.readSettings();
	const spec = resolveRoleSpec("handoffWriter", settings);
	if (!spec) return undefined;
	return handoffServiceSeams.buildEngine(spec, false, undefined, () => stores.settingsStore.readSettings()?.models?.strong?.cacheRetention);
}

export function isHandoffWriterRunning(courseId: string, unitId: string): boolean {
	return running().has(key(courseId, unitId));
}

/** Write the writer's outcome into its own handoff, if the unit still
 *  holds it. Evidence-style write: the course's updatedAt is unchanged, so
 *  an open "Edit units" draft stays valid. */
function settle(courseId: string, unitId: string, writtenAt: string, change: (handoff: UnitHandoff) => UnitHandoff): void {
	courseStore.update(courseId, (current) => ({
		...current,
		units: current.units.map((unit) => unit.id === unitId && unit.handoff?.writtenAt === writtenAt
			? { ...unit, handoff: change(unit.handoff) }
			: unit),
	}), { touch: false });
}

function failedState(entry: Pick<RunningHandoff, "model" | "usage">, error: string, stopped: boolean): HandoffWriterState {
	return {
		status: "failed", error,
		...(stopped ? { stopped: true as const } : {}),
		...(entry.model ? { model: entry.model } : {}),
		...(entry.usage ? { usage: entry.usage } : {}),
	};
}

/**
 * Start the writer for a completed unit whose handoff reads "writing".
 * Registers it synchronously, so a read in the same tick never takes it for
 * an interrupted one.
 */
export function startHandoffWriter(course: CourseRecord, unitId: string, engine: PiEngine): void {
	const index = course.units.findIndex((unit) => unit.id === unitId);
	const unit = course.units[index];
	const handoff = unit?.handoff;
	if (!unit || !handoff || !unit.chatId) return;
	const chatId = unit.chatId;
	const writtenAt = handoff.writtenAt;
	const entry: RunningHandoff = {
		courseId: course.id, unitId, chatId, unitTitle: unit.title, writtenAt,
		controller: new AbortController(), startedAt: new Date().toISOString(),
	};
	running().set(key(course.id, unitId), entry);
	emit("activity-changed", {});
	const signal = entry.controller.signal;
	const answers = course.evidence.filter((event): event is AnswerEvidence => event.type === "answer" && event.chatId === chatId && event.unitId === unitId);
	void (async () => {
		try {
			const record = stores.chatStore.getChat(chatId);
			if (!record) throw new Error("The unit's session can't be read.");
			const written = await handoffServiceSeams.write({
				record, engine, signal,
				courseTitle: course.title, courseGoal: course.goal,
				unitNumber: index + 1, unitTitle: unit.title, unitGoal: unit.goal,
				completion: handoff.completion, topics: handoff.topics, answers,
				onUsage: (usage) => {
					entry.usage = usage;
					entry.model = usage.model;
					emit("activity-changed", {});
				},
			});
			if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
			settle(course.id, unitId, writtenAt, (current) => ({
				...current,
				observations: written.observations,
				writer: { status: "ready", ...(written.model ? { model: written.model } : {}), ...(written.usage ? { usage: written.usage } : {}) },
			}));
		} catch (error) {
			const stopped = signal.aborted;
			const message = stopped ? STOPPED_MESSAGE : error instanceof Error ? error.message : String(error);
			try {
				settle(course.id, unitId, writtenAt, (current) => ({ ...current, writer: failedState(entry, message, stopped) }));
			} catch (storeError) {
				console.error(`[course ${course.id}] could not record the handoff writer's outcome for ${unitId}:`, storeError);
			}
		} finally {
			// A newer writer for the same unit may have replaced this entry.
			if (running().get(key(course.id, unitId)) === entry) running().delete(key(course.id, unitId));
			emit("activity-changed", {});
		}
	})();
}

/** Stop a unit's running writer; its handoff settles as stopped. */
export function stopHandoffWriter(courseId: string, unitId: string): boolean {
	const entry = running().get(key(courseId, unitId));
	if (!entry) return false;
	entry.controller.abort();
	return true;
}

/** Stop every writer of a course (course deletion, item 9). */
export function stopCourseHandoffWriters(courseId: string): void {
	for (const entry of running().values()) if (entry.courseId === courseId) entry.controller.abort();
}

/** Settle handoffs left "writing" by a closed app: their writer isn't
 *  running in this process, so they read as interrupted. */
export function settleInterruptedHandoffs(course: CourseRecord): CourseRecord {
	const stale = course.units.filter((unit) => unit.handoff?.writer.status === "writing" && !isHandoffWriterRunning(course.id, unit.id));
	if (stale.length === 0) return course;
	const ids = new Set(stale.map((unit) => unit.id));
	return courseStore.update(course.id, (current) => ({
		...current,
		units: current.units.map((unit) => ids.has(unit.id) && unit.handoff?.writer.status === "writing" && !isHandoffWriterRunning(current.id, unit.id)
			? { ...unit, handoff: { ...unit.handoff, writer: { ...unit.handoff.writer, status: "failed", error: INTERRUPTED_MESSAGE } } }
			: unit),
	}), { touch: false }) ?? course;
}

/** Running handoff writers for the activity feed ("Handoff · <unit title>"). */
export interface HandoffWriterActivity {
	/** "<courseId>:<unitId>", the abort id. */
	id: string;
	courseId: string;
	unitId: string;
	/** The unit's session (the dock's "Open session" link). */
	chatId: string;
	title: string;
	createdAt: string;
	activity: string;
	usage?: JobUsage;
}

export function handoffWriterActivities(): HandoffWriterActivity[] {
	return [...running().values()].map((entry) => ({
		id: key(entry.courseId, entry.unitId),
		courseId: entry.courseId,
		unitId: entry.unitId,
		chatId: entry.chatId,
		title: `Handoff · ${entry.unitTitle}`,
		createdAt: entry.startedAt,
		activity: "Writing",
		...(entry.usage ? { usage: entry.usage } : {}),
	}));
}

/** The dock's Stop: id is "<courseId>:<unitId>". */
export function abortHandoffWriterActivity(id: string): boolean {
	const separator = id.lastIndexOf(":");
	if (separator < 1) return false;
	return stopHandoffWriter(id.slice(0, separator), id.slice(separator + 1));
}
