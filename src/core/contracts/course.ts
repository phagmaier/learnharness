/**
 * Courses (fork plan 04, course phase 1): a course is an ordered list of
 * units, each taught in its own session. One record per course lives at
 * data/courses/<courseId>/course.json beside a regenerated progress.md and
 * the unit sessions' notes folders.
 *
 * The record decides membership; a chat's optional `course` field is a
 * back-pointer that makes the session self-describing (which agent, which
 * notes folder) and lets the app adopt a session created just before a
 * crash.
 */
import type { JobUsage } from "./jobs.ts";

/** The course record format this build writes and understands. */
export const CURRENT_COURSE_VERSION = 1;

export type UnitStatus = "not-started" | "in-progress" | "completed";
/** Confirmed after the teacher's goal_reached signal; early before it. */
export type UnitCompletion = "confirmed" | "early";

/** Computed from the unit's graded checks (decision 2), never by a model. */
export type HandoffTopicStatus = "solid" | "shaky" | "unchecked" | "not-reached";

export interface HandoffTopic {
	nodeId: string;
	title: string;
	status: HandoffTopicStatus;
	/** Why: "last check right at 90% confidence", "" when nothing applies. */
	reason: string;
}

/** The handoff writer's judgment of a topic the checks left unchecked. */
export interface HandoffJudgment {
	nodeId: string;
	status: "solid" | "shaky";
	reason: string;
}

/** What the handoff writer adds, labeled as model-written. */
export interface HandoffObservations {
	judged: HandoffJudgment[];
	alsoShaky: string[];
	misconceptionsRepaired: string[];
	carriedForward: string[];
}

export interface HandoffWriterState {
	status: "writing" | "ready" | "failed";
	error?: string;
	/** The learner stopped the writer (status "failed"). */
	stopped?: true;
	model?: string;
	usage?: JobUsage;
}

/** A short briefing for later units' agents, rewritten on each completion. */
export interface UnitHandoff {
	writtenAt: string;
	completion: UnitCompletion;
	topics: HandoffTopic[];
	observations?: HandoffObservations;
	writer: HandoffWriterState;
}

export interface CourseUnit {
	/** Stable, readable slug ("linear-maps"); agents name units by it. */
	id: string;
	title: string;
	goal: string;
	/** The setup probe's read on this unit (one or two lines). */
	startingPoint?: string;
	/** Ids of earlier units this one builds on directly. */
	prerequisites: string[];
	status: UnitStatus;
	chatId?: string;
	goalReachedAt?: string;
	completion?: UnitCompletion;
	completedAt?: string;
	handoff?: UnitHandoff;
}

/** One change to the unit list. `after: null` means at the start. */
export type CourseChange =
	| { type: "insert"; after: string | null; title: string; goal: string; prerequisites: string[] }
	| { type: "drop"; unit: string }
	| { type: "move"; unit: string; after: string | null }
	| { type: "merge"; units: string[]; title: string; goal: string };

export type ProposalStatus = "pending" | "accepted" | "rejected" | "outdated";

/** A teacher's proposed course revision, decided by the learner. */
export interface CourseProposal {
	id: string;
	chatId: string;
	unitId: string;
	toolCallId: string;
	at: string;
	reason: string;
	changes: CourseChange[];
	status: ProposalStatus;
	decidedAt?: string;
	/** Why an outdated proposal no longer applies. */
	outdatedReason?: string;
}

// ─── Evidence (phase 3 reads it; phase 1 only records) ──────────────────────

export type AnswerPhase = "setup" | "probe" | "teach";
export type AnswerResult = "right" | "wrong" | "dontKnow" | "skipped" | "ungraded";

interface EvidenceBase {
	/** Stable: `<chatId>:<toolCallId>` for answers, a lifecycle id otherwise. */
	id: string;
	at: string;
}

export interface AnswerEvidence extends EvidenceBase {
	type: "answer";
	unitId?: string;
	chatId: string;
	phase: AnswerPhase;
	tool: string;
	questionType?: "predict" | "check";
	nodeId?: string;
	/** The node's title when the answer was given. */
	nodeTitle?: string;
	result: AnswerResult;
	confidence?: number;
}

export interface UnitStartedEvidence extends EvidenceBase { type: "unit-started"; unitId: string; chatId: string }
export interface GoalReachedEvidence extends EvidenceBase { type: "goal-reached"; unitId: string; chatId: string; summary: string }
export interface UnitCompletedEvidence extends EvidenceBase { type: "unit-completed"; unitId: string; completion: UnitCompletion }
export interface UnitReopenedEvidence extends EvidenceBase { type: "unit-reopened"; unitId: string }

export interface RevisionEvidence extends EvidenceBase {
	type: "revision";
	source: "teacher" | "learner";
	decision: "accepted" | "rejected";
	proposalId?: string;
	/** One line per change. */
	changes: string[];
}

export interface PracticeEvidence extends EvidenceBase {
	type: "practice";
	practiceChatId: string;
	unitId: string;
	problemCallId: string;
	outcome: string;
	rung?: number;
	missClass?: string;
	targets?: string[];
}

/** Evidence events this build writes. A record may hold types a newer build
 *  wrote; they are kept on rewrite and otherwise ignored. */
export type CourseEvidence =
	| AnswerEvidence
	| UnitStartedEvidence
	| GoalReachedEvidence
	| UnitCompletedEvidence
	| UnitReopenedEvidence
	| RevisionEvidence
	| PracticeEvidence;

export interface CourseRecord {
	/** Absent reads as 1; a newer stamp is refused. */
	version?: number;
	id: string;
	title: string;
	goal: string;
	createdAt: string;
	updatedAt: string;
	setupChatId: string;
	/** The graph source folder holding the units' sessions. */
	sourceFolderId?: string;
	/** In suggested order. */
	units: CourseUnit[];
	proposals: CourseProposal[];
	evidence: CourseEvidence[];
}

/** The chat record's back-pointer into a course. */
export type ChatCourseLink =
	| { role: "setup"; courseId?: string }
	| { role: "unit"; courseId: string; unitId: string }
	| { role: "practice"; courseId: string; unitId: string };

/** The unit-start marker's model-facing text. */
export function unitStartText(number: number, title: string): string {
	return `[Unit start] The learner opened unit ${number}, ${title}. Begin the unit's probe.`;
}

/** The sidebar's view of a course. */
export interface CourseSummary {
	id: string;
	title: string;
	createdAt: string;
	/** The course's most recent activity (record or member session). */
	updatedAt: string;
	setupChatId: string;
	completedCount: number;
	units: Array<{ id: string; title: string; status: UnitStatus; chatId?: string }>;
}

/** What a course session's page knows about its course (fork plan 04). */
export type SessionCourseView =
	| {
		role: "setup";
		/** Set once the setup session's course exists. */
		courseId: string | null;
	}
	| {
		role: "unit";
		courseId: string;
		courseTitle: string;
		unitId: string;
		/** The unit's position in the course, from 1. */
		number: number;
		unitTitle: string;
		status: UnitStatus;
		goalReachedAt?: string;
	};
