import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, serverExecute } from "../tool-execute.ts";
import { unitListProblems } from "../../core/course.ts";
import type { CourseUnit } from "../../core/contracts.ts";
import { PROPOSE_COURSE_DESCRIPTION } from "../course-prompts.ts";

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
