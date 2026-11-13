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
import { progressMarkdown } from "../core/course.ts";
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
	const version = parsed.version ?? 1;
	if (typeof version !== "number" || version > CURRENT_COURSE_VERSION) {
		throw new CourseUnreadableError("This course was saved by a newer version of the app.");
	}
	if (typeof parsed.id !== "string" || !Array.isArray(parsed.units) || !Array.isArray(parsed.proposals) || !Array.isArray(parsed.evidence)) {
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
 *  included) and returns the next one; updatedAt is stamped here. Null
 *  when the course doesn't exist. */
function update(courseId: string, change: (record: CourseRecord) => CourseRecord): CourseRecord | null {
	const record = get(courseId);
	if (!record) return null;
	const next = change(record);
	return write({ ...next, id: record.id, updatedAt: new Date().toISOString() });
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
