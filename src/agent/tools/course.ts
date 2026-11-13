import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, serverExecute } from "../tool-execute.ts";
import { unitListProblems } from "../../core/course.ts";
import type { CourseUnit } from "../../core/contracts.ts";
import { GOAL_REACHED_DESCRIPTION, PROPOSE_COURSE_DESCRIPTION } from "../course-prompts.ts";

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
