import type { JobUsage } from "./jobs.ts";

/**
 * Study notes (fork plan 03): on-demand HTML notes written from a session.
 * Each owner (a standalone session today; a course unit in phase 1) keeps
 * one index file plus one final, self-contained HTML file per note.
 */

/** The notes index format this build writes and understands. */
export const CURRENT_NOTES_VERSION = 1;

export type NoteStatus = "writing" | "ready" | "failed";

/** A rewrite in progress, or one that failed (the current version stays). */
export interface NoteRewrite {
	instruction: string;
	interactive: boolean;
	startedAt: string;
	/** Set when the rewrite failed or was interrupted; the old file is kept. */
	error?: string;
}

export interface NoteEntry {
	id: string;
	/** The note's title; empty until the first version is written. */
	title: string;
	/** The learner's optional instruction ("" for the default note). */
	instruction: string;
	/** Scripts allowed (the learner asked for an interactive note). */
	interactive: boolean;
	status: NoteStatus;
	createdAt: string;
	updatedAt: string;
	/** The latest generation's provider-qualified model and usage. */
	model?: string;
	usage?: JobUsage;
	/** Why a note has no version yet (failed, stopped, or interrupted). */
	error?: string;
	/** The learner stopped the first version (status "failed"). */
	stopped?: true;
	regenerating?: NoteRewrite;
}

export interface NotesIndex {
	/** Absent reads as 1; a newer stamp is refused. */
	version?: number;
	notes: NoteEntry[];
}
