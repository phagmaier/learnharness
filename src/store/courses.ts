/**
 * CourseStore — courses on disk (fork plan 04). One folder per course:
 *
 *   courses/<courseId>/course.json   the record ({ version: 1, … })
 *   courses/<courseId>/progress.md   regenerated on every write; never read
 *   courses/<courseId>/notes/<chatId>/  a unit session's notes (phase-0 index)
 *
 * Sync fs like the chat and notes stores, so each read-modify-write is one
 * uninterrupted step. course.json is replaced by temp file and rename, never
 * in place. A record that is damaged or stamped newer than this build is
 * refused (CourseUnreadableError) and never rewritten. Fields and evidence
 * types this build doesn't know survive a rewrite, because every update
 * spreads the parsed record.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { CURRENT_COURSE_VERSION, type CourseRecord } from "../core/contracts.ts";
import { progressMarkdown, unitListProblems } from "../core/course.ts";
import { emit } from "../core/events.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const RECORD = "course.json";
const PROGRESS = "progress.md";

export class CourseUnreadableError extends Error {}

function safeId(id: string, what: string): string {
	if (!SAFE_ID.test(id)) throw new Error(`Invalid ${what} id: ${id}`);
	return id;
}

export function newCourseId(): string {
	return `course_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export function courseDir(courseId: string): string {
	return path.join(/* turbopackIgnore: true */ PATHS.courses, safeId(courseId, "course"));
}

/** A unit session's notes folder inside its course. */
export function courseNotesDir(courseId: string, chatId: string): string {
	return path.join(/* turbopackIgnore: true */ courseDir(courseId), "notes", safeId(chatId, "chat"));
}

function recordFile(courseId: string): string {
	return path.join(/* turbopackIgnore: true */ courseDir(courseId), RECORD);
}

function damaged(): CourseUnreadableError {
	return new CourseUnreadableError("This course's record is damaged and can't be read.");
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const optionalStrings = (value: Record<string, unknown>, keys: string[]) => keys.every((key) => value[key] === undefined || typeof value[key] === "string");

/** Check the fields this build reads, without stripping unknown fields or
 * evidence types. An embedded id must never redirect a subsequent write. */
function readableRecord(value: CourseRecord, courseId: string): boolean {
	if (value.id !== courseId || ![value.title, value.goal, value.createdAt, value.updatedAt, value.setupChatId].every((field) => typeof field === "string")) return false;
	if (!SAFE_ID.test(value.setupChatId) || !optionalStrings(value as unknown as Record<string, unknown>, ["sourceFolderId"])) return false;
	if (!Array.isArray(value.units) || !Array.isArray(value.proposals) || !Array.isArray(value.evidence)) return false;
	if (!value.units.every((unit) => object(unit)
		&& typeof unit.id === "string" && SAFE_ID.test(unit.id)
		&& typeof unit.title === "string" && typeof unit.goal === "string"
		&& strings(unit.prerequisites) && ["not-started", "in-progress", "completed"].includes(unit.status)
		&& optionalStrings(unit, ["startingPoint", "chatId", "goalReachedAt", "completion", "completedAt"])
		&& (unit.chatId === undefined || SAFE_ID.test(unit.chatId))
		&& (unit.handoff === undefined || readableHandoff(unit.handoff)))) return false;
	if (unitListProblems(value.units).length > 0) return false;
	if (!value.proposals.every((proposal) => object(proposal) && typeof proposal.reason === "string"
		&& typeof proposal.status === "string" && Array.isArray(proposal.changes)
		&& proposal.changes.every((change) => object(change) && typeof change.type === "string"
			&& (change.type !== "merge" || strings(change.units))))) return false;
	return value.evidence.every((event) => object(event) && typeof event.type === "string" && typeof event.id === "string" && typeof event.at === "string");
}

function readableHandoff(value: unknown): boolean {
	if (!object(value) || typeof value.writtenAt !== "string" || !Array.isArray(value.topics) || !object(value.writer) || typeof value.writer.status !== "string") return false;
	if (!value.topics.every((topic) => object(topic) && ["nodeId", "title", "status", "reason"].every((key) => typeof topic[key] === "string"))) return false;
	const observations = value.observations;
	return observations === undefined || (object(observations)
		&& ["alsoShaky", "misconceptionsRepaired", "carriedForward"].every((key) => strings(observations[key]))
		&& Array.isArray(observations.judged) && observations.judged.every((entry) => object(entry)
			&& ["nodeId", "status", "reason"].every((key) => typeof entry[key] === "string")));
}

/** The record, null when the course doesn't exist. Throws
 *  CourseUnreadableError for a damaged or newer record. */
function get(courseId: string): CourseRecord | null {
	let text: string;
	try {
		text = fs.readFileSync(/* turbopackIgnore: true */ recordFile(courseId), "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let parsed: CourseRecord;
	try {
		parsed = JSON.parse(text) as CourseRecord;
	} catch {
		throw damaged();
	}
	if (typeof parsed !== "object" || parsed === null) throw damaged();
	const version = parsed.version === undefined ? 1 : parsed.version;
	if (typeof version === "number" && version > CURRENT_COURSE_VERSION) {
		throw new CourseUnreadableError("This course was saved by a newer version of the app.");
	}
	if (version !== CURRENT_COURSE_VERSION || !readableRecord(parsed, courseId)) {
		throw damaged();
	}
	return parsed;
}

function write(record: CourseRecord): CourseRecord {
	const stamped = { ...record, version: CURRENT_COURSE_VERSION };
	const dir = courseDir(record.id);
	fs.mkdirSync(dir, { recursive: true });
	writeFileAtomicSync(recordFile(record.id), JSON.stringify(stamped, null, "\t"));
	// The progress file is a convenience copy: its failure never undoes or
	// fails the record write it follows.
	try {
		writeFileAtomicSync(path.join(/* turbopackIgnore: true */ dir, PROGRESS), progressMarkdown(stamped));
	} catch (error) {
		console.warn(`[courses] could not write progress.md for ${record.id}:`, error);
	}
	emit("courses-changed", { courseId: record.id });
	return stamped;
}

function create(record: CourseRecord): CourseRecord {
	safeId(record.id, "course");
	if (fs.existsSync(recordFile(record.id))) throw new Error(`Course already exists: ${record.id}`);
	return write(record);
}

/** Every readable course, plus the ids of folders whose record can't be read. */
function list(): { courses: CourseRecord[]; unreadable: string[] } {
	let names: string[];
	try {
		names = fs.readdirSync(/* turbopackIgnore: true */ PATHS.courses);
	} catch {
		return { courses: [], unreadable: [] };
	}
	const courses: CourseRecord[] = [];
	const unreadable: string[] = [];
	for (const name of names) {
		if (!SAFE_ID.test(name)) continue;
		try {
			const record = get(name);
			if (record) courses.push(record);
		} catch (error) {
			if (!(error instanceof CourseUnreadableError)) console.error(`[courses] could not read ${name}:`, error);
			unreadable.push(name);
		}
	}
	courses.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	return { courses, unreadable };
}

/** Read-modify-write: `change` gets the stored record (unknown fields
 *  included) and returns the next one; updatedAt is stamped here unless
 *  `touch` is false (evidence bookkeeping, which must not make an open
 *  "Edit units" draft stale). Null when the course doesn't exist. */
function update(courseId: string, change: (record: CourseRecord) => CourseRecord, options: { touch?: boolean } = {}): CourseRecord | null {
	const record = get(courseId);
	if (!record) return null;
	const next = change(record);
	return write({ ...next, id: record.id, updatedAt: options.touch === false ? record.updatedAt : new Date().toISOString() });
}

/** Remove the course's whole folder (record, progress.md, notes). */
function remove(courseId: string): boolean {
	const dir = courseDir(courseId);
	if (!fs.existsSync(dir)) return false;
	fs.rmSync(dir, { recursive: true, force: true });
	emit("courses-changed", { courseId });
	return true;
}

export const courseStore = { create, get, list, update, remove };
export type CourseStore = typeof courseStore;
