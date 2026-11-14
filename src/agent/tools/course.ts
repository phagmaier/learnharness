import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, serverExecute } from "../tool-execute.ts";
import { courseChangesFromFields, unitListProblems } from "../../core/course.ts";
import type { CourseChange, CourseUnit } from "../../core/contracts.ts";
import { GOAL_REACHED_DESCRIPTION, PROPOSE_COURSE_CHANGES_DESCRIPTION, PROPOSE_COURSE_DESCRIPTION } from "../course-prompts.ts";

/**
 * propose_course (fork plan 04): the setup agent's seam tool. Server-side
 * and non-terminating: it validates the unit list with the course rules
 * and returns problems for the model to fix. The proposal itself is the
 * call's input; the chat renders the latest successful call as the
 * learner's editable card, and older ones read-only as replaced.
 */

const KEY = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

export const proposeCourseInput = Type.Object({
	title: Type.String({ minLength: 1, description: "The course's short title." }),
	goal: Type.String({ minLength: 1, description: "What the learner will understand or be able to do at the end, in one or two sentences." }),
	units: Type.Array(
		Type.Object({
			key: Type.String({ pattern: KEY, description: "A short lowercase slug for this unit, unique in the list, e.g. \"linear-maps\"." }),
			title: Type.String({ minLength: 1, description: "The unit's short title." }),
			goal: Type.String({ minLength: 1, description: "The unit's goal in one or two sentences." }),
			prerequisites: Type.Array(Type.String(), { description: "Keys of earlier units this unit builds on directly; [] for none." }),
			startingPoint: Type.String({ minLength: 1, description: "One or two lines on what the probe found that bears on this unit, or \"new\"." }),
		}),
		{ minItems: 1, description: "The units in suggested order." },
	),
});

export type ProposeCourseInput = Static<typeof proposeCourseInput>;

/** The result the model reads after a valid proposal. */
export const PROPOSE_COURSE_ACK_TEXT = "The learner sees the proposal as an editable card and creates the course from it.";

/** Problems with a proposal, as the model reads them; empty when valid. */
export function proposalProblems(input: ProposeCourseInput): string[] {
	const problems: string[] = [];
	if (!input.title.trim()) problems.push("The course needs a title.");
	if (!input.goal.trim()) problems.push("The course needs a goal.");
	const seen = new Set<string>();
	for (const unit of input.units) {
		if (seen.has(unit.key)) problems.push(`Two units share the key "${unit.key}". Keys must be unique.`);
		seen.add(unit.key);
	}
	if (problems.some((problem) => problem.startsWith("Two units"))) return problems;
	const units: CourseUnit[] = input.units.map((unit) => ({
		id: unit.key, title: unit.title, goal: unit.goal, prerequisites: unit.prerequisites, status: "not-started",
	}));
	return [...problems, ...unitListProblems(units).map((problem) => problem.replace(/unknown unit: /, "unknown unit key: "))];
}

export function proposeCourseTool(): AgentTool<typeof proposeCourseInput> {
	return {
		name: "propose_course",
		label: "propose_course",
		description: PROPOSE_COURSE_DESCRIPTION,
		parameters: proposeCourseInput,
		execute: async (toolCallId, input, signal) => {
			const problems = proposalProblems(input);
			if (problems.length > 0) return invalidInputResult("propose_course", problems);
			return serverExecute("propose_course", proposeCourseInput, () => ({ text: PROPOSE_COURSE_ACK_TEXT, details: { ok: true } }))(toolCallId, input, signal);
		},
	};
}

// ─── goal_reached (item 4) ──────────────────────────────────────────────────

export const goalReachedInput = Type.Object({
	summary: Type.String({ minLength: 1, description: "One line: what the learner can now do that the unit's goal asked for." }),
});

/** The result the model reads once the signal is recorded. */
export const GOAL_REACHED_ACK_TEXT = "Recorded. The learner can complete the unit whenever he's ready; the conversation continues.";

/** The unit teacher's signal that the unit's goal is reached. Records the
 *  signal through the server's hook (null on success, else the refusal the
 *  model reads); non-terminating and repeatable. */
export function goalReachedTool(record: (summary: string, toolCallId: string) => string | null): AgentTool<typeof goalReachedInput> {
	return {
		name: "goal_reached",
		label: "goal_reached",
		description: GOAL_REACHED_DESCRIPTION,
		parameters: goalReachedInput,
		execute: async (toolCallId, input) => {
			const summary = input.summary.replace(/\s+/g, " ").trim();
			if (!summary) return invalidInputResult("goal_reached", ["The summary must be one non-empty line."]);
			const refused = record(summary, toolCallId);
			if (refused) return { content: [{ type: "text", text: refused }], isError: true, details: { ok: false, error: refused } };
			return { content: [{ type: "text", text: GOAL_REACHED_ACK_TEXT }], details: { ok: true } };
		},
	};
}

// ─── propose_course_changes (item 7) ────────────────────────────────────────

/** One change, flat so every provider's schema handling reads it: `type`
 *  picks the fields that apply, checked per type in execute. */
const courseChangeInput = Type.Object({
	type: Type.Union([Type.Literal("insert"), Type.Literal("drop"), Type.Literal("move"), Type.Literal("merge")], {
		description: "insert: a new unit (after, title, goal, prerequisites). drop: remove a unit (unit). move: put a unit elsewhere (unit, after). merge: join units into one (units, title, goal).",
	}),
	unit: Type.Optional(Type.String({ description: "drop, move: the unit's id from the course context." })),
	units: Type.Optional(Type.Array(Type.String(), { description: "merge: the ids of the two or more units to merge." })),
	after: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "insert, move: the id of the unit it goes after, or null for the start of the course." })),
	title: Type.Optional(Type.String({ description: "insert, merge: the new unit's short title." })),
	goal: Type.Optional(Type.String({ description: "insert, merge: the new unit's goal in one or two sentences." })),
	prerequisites: Type.Optional(Type.Array(Type.String(), { description: "insert: ids of earlier units the new unit builds on directly; [] for none." })),
});

export const proposeCourseChangesInput = Type.Object({
	reason: Type.String({ minLength: 1, description: "Why the course should change: what this unit showed, in one or two sentences." }),
	changes: Type.Array(courseChangeInput, { minItems: 1, description: "The changes, applied in order. Name units by the ids in the course context." }),
});

export type ProposeCourseChangesInput = Static<typeof proposeCourseChangesInput>;

/** The result the model reads once the proposal is stored. */
export const PROPOSE_COURSE_CHANGES_ACK_TEXT = "The learner sees the proposal and decides.";

/** What the server's hook answers: the stored proposal's id, the rules
 *  the changes break (for the model to fix), or why nothing can be
 *  recorded. */
export type RecordCourseProposal = (proposal: { reason: string; changes: CourseChange[] }, toolCallId: string) =>
	| { ok: true; proposalId: string }
	| { ok: false; problems: string[] }
	| { ok: false; refused: string };

/** The unit teacher's course-change proposal: validated against the
 *  current course and decision 5 by the server's hook, stored as pending
 *  for the learner's card; non-terminating. */
export function proposeCourseChangesTool(record: RecordCourseProposal): AgentTool<typeof proposeCourseChangesInput> {
	return {
		name: "propose_course_changes",
		label: "propose_course_changes",
		description: PROPOSE_COURSE_CHANGES_DESCRIPTION,
		parameters: proposeCourseChangesInput,
		execute: async (toolCallId, input) => {
			const reason = input.reason.replace(/\s+/g, " ").trim();
			const parsed = courseChangesFromFields(input.changes);
			const problems = [...(reason ? [] : ["The reason must be non-empty."]), ...("problems" in parsed ? parsed.problems : [])];
			if (problems.length > 0 || "problems" in parsed) return invalidInputResult("propose_course_changes", problems);
			const stored = record({ reason, changes: parsed.changes }, toolCallId);
			if ("refused" in stored) return { content: [{ type: "text", text: stored.refused }], isError: true, details: { ok: false, error: stored.refused } };
			if (!stored.ok) return invalidInputResult("propose_course_changes", stored.problems);
			return { content: [{ type: "text", text: PROPOSE_COURSE_CHANGES_ACK_TEXT }], details: { ok: true, proposalId: stored.proposalId } };
		},
	};
}
