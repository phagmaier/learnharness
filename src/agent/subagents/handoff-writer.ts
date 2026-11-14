import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ChatRecord } from "../../core/contracts/chat.ts";
import { COMPACTED_HISTORY_HEADER } from "../../core/contracts/chat.ts";
import type { AnswerEvidence, HandoffObservations, HandoffTopic, UnitCompletion } from "../../core/contracts/course.ts";
import { accumulateJobUsage, piUsageToStep, type JobUsage } from "../../core/contracts/jobs.ts";
import { activeCompactionOf, keptIndexFor } from "../../core/compaction.ts";
import { noteSource } from "../../core/document/note-source.ts";
import type { PiEngine } from "../models.ts";
import { contextProblem } from "./note-writer.ts";
import { runSubmitAgent } from "./submit-agent.ts";

/**
 * The handoff writer (fork plan 04 item 6): one submit_handoff call adds
 * the model-written part of a completed unit's handoff. The app has
 * already rated each plan topic from the unit's graded checks; the writer
 * only judges topics no graded check covered, adds other shaky items,
 * misconceptions repaired, and what to carry forward. Problems go back to
 * the model for up to three fixes.
 *
 * The prompt is the plan's approved text, fixed here like the other
 * background workers' prompts (src/agent/prompts/README.md); it is not a
 * Settings → Prompts segment.
 */

/** Fix attempts after the first submission (the plan's "up to 3 fixes"). */
export const HANDOFF_FIX_ATTEMPTS = 3;
/** Each model-written item is one line of at most this many characters. */
export const HANDOFF_LINE_LIMIT = 200;

export const HANDOFF_SYSTEM_PROMPT = `You write the handoff for one completed unit of a learner's course. Tutors of his later units read it before probing and teaching. It is a briefing, not a log: short, specific, one line per item.

The app has already rated each plan topic from his graded checks. Add only what the transcript shows:
- for topics with no graded check (free-recall or other ungraded answers only): solid or shaky, with a one-line reason;
- anything else that looked shaky, with the reason; you may add topics the checks rated solid when the transcript shows a real gap;
- misconceptions he showed that the unit repaired, and how;
- what to carry forward: open questions, his requests, topics deferred.

Use only what the transcript shows. Never call solid what the checks rate shaky. Leave a list empty when there's nothing to add. Call \`submit_handoff\` once.`;

const SUBMIT_DESCRIPTION = `Submit the handoff's model-written part. Each item is one line of at most ${HANDOFF_LINE_LIMIT} characters. Leave a list empty when there's nothing to add.`;

const STATUS_WORDS: Record<HandoffTopic["status"], string> = {
	solid: "solid",
	shaky: "shaky",
	unchecked: "no graded check",
	"not-reached": "not reached",
};

const RESULT_WORDS: Record<Exclude<AnswerEvidence["result"], "ungraded">, string> = {
	right: "right",
	wrong: "wrong",
	dontKnow: "answered “don't know”",
	skipped: "skipped",
};

/** One answer on a topic, as the writer reads it. */
function answerLine(answer: AnswerEvidence): string {
	const kind = answer.questionType ?? "question";
	if (answer.result === "ungraded") return `${kind}, ${answer.tool === "explain" ? "free recall" : `${answer.tool} answer`}, ungraded`;
	return `${kind} ${RESULT_WORDS[answer.result]}${answer.confidence !== undefined ? ` at ${answer.confidence}% confidence` : ""}`;
}

export interface HandoffWriterInput {
	courseTitle: string;
	courseGoal: string;
	unitNumber: number;
	unitTitle: string;
	unitGoal: string;
	completion: UnitCompletion;
	topics: readonly HandoffTopic[];
	/** The unit session's teaching answers (the topic table's checks). */
	answers: readonly AnswerEvidence[];
}

/** The computed topic table with each topic's answers, and the topics the
 *  writer may judge. */
export function handoffTopicTable(topics: readonly HandoffTopic[], answers: readonly AnswerEvidence[]): string {
	if (topics.length === 0) return "Plan topics: none were recorded.";
	const lines = ["Plan topics, as the app rated them from the graded checks:"];
	for (const topic of topics) {
		const reason = topic.reason && topic.reason !== STATUS_WORDS[topic.status] ? ` (${topic.reason})` : "";
		lines.push(`- ${topic.title} (id ${topic.nodeId}): ${STATUS_WORDS[topic.status]}${reason}`);
		const mine = answers.filter((answer) => answer.nodeId === topic.nodeId && answer.phase === "teach");
		if (mine.length > 0) lines.push(`  Answers, oldest first: ${mine.map(answerLine).join("; ")}`);
	}
	const judgeable = topics.filter((topic) => topic.status === "unchecked").map((topic) => topic.nodeId);
	lines.push("", `Topics you may judge in \`judged\` (no graded check): ${judgeable.length > 0 ? judgeable.join(", ") : "none"}`);
	return lines.join("\n");
}

export function handoffUserMessage(input: HandoffWriterInput, sessionText: string): string {
	return [
		`Course: ${input.courseTitle}\nCourse goal: ${input.courseGoal}`,
		`Unit ${input.unitNumber}: ${input.unitTitle}\nUnit goal: ${input.unitGoal}\nCompleted: ${input.completion === "confirmed" ? "after the teacher marked the goal reached" : "early, before the teacher marked the goal reached"}`,
		handoffTopicTable(input.topics, input.answers),
		`<session>\n${sessionText}\n</session>`,
	].join("\n\n");
}

/**
 * The session as the writer reads it: phase 0's note source. A session
 * too long for the model's window reads as its compaction summary plus the
 * text after the cut (agent-selected); one that still doesn't fit is
 * refused with the note writer's message.
 */
export function handoffSessionText(record: ChatRecord, engine: PiEngine, build: (text: string) => string): { prompt: string } | { problem: string } {
	const full = build(noteSource(record).text);
	const problem = contextProblem(engine, HANDOFF_SYSTEM_PROMPT, full);
	if (!problem) return { prompt: full };
	const marker = activeCompactionOf(record.messages);
	const kept = marker ? keptIndexFor(record.messages, marker) : -1;
	if (!marker || kept < 0) return { problem };
	const content = typeof marker.content === "string" ? marker.content : "";
	const summary = (content.startsWith(COMPACTED_HISTORY_HEADER) ? content.slice(COMPACTED_HISTORY_HEADER.length) : content).trim();
	const tail = noteSource({ ...record, messages: record.messages.slice(kept) }).text;
	const shortened = build(`[Summary of the session's earlier part]\n${summary}\n\n[The session from there on]\n${tail}`);
	const still = contextProblem(engine, HANDOFF_SYSTEM_PROMPT, shortened);
	return still ? { problem: still } : { prompt: shortened };
}

type Submitted = HandoffObservations;

function oneLine(value: unknown): string {
	return String(value ?? "").replace(/\s+/g, " ").trim();
}

function lines(value: unknown): string[] {
	return Array.isArray(value) ? value.map(oneLine).filter((line) => line.length > 0) : [];
}

/** Weak-model tolerance: absent lists read as empty, whitespace collapses to
 *  one line, and empty items drop. */
export function fillHandoff(raw: Record<string, unknown>): Submitted {
	const judged = Array.isArray(raw.judged) ? raw.judged : [];
	return {
		judged: judged.flatMap((entry) => {
			if (!entry || typeof entry !== "object") return [];
			const item = entry as Record<string, unknown>;
			const status = item.status === "solid" || item.status === "shaky" ? item.status : null;
			return status ? [{ nodeId: oneLine(item.nodeId), status, reason: oneLine(item.reason) }] : [];
		}),
		alsoShaky: lines(raw.alsoShaky),
		misconceptionsRepaired: lines(raw.misconceptionsRepaired),
		carriedForward: lines(raw.carriedForward),
	};
}

/** Problems with a submission, as the model reads them; empty when valid. */
export function handoffProblems(value: Submitted, topics: readonly HandoffTopic[]): string[] {
	const problems: string[] = [];
	const byId = new Map(topics.map((topic) => [topic.nodeId, topic]));
	const judgeable = topics.filter((topic) => topic.status === "unchecked").map((topic) => topic.nodeId);
	const allowed = judgeable.length > 0 ? judgeable.join(", ") : "none";
	const seen = new Set<string>();
	for (const judgment of value.judged) {
		const topic = byId.get(judgment.nodeId);
		if (!topic) problems.push(`There is no plan topic "${judgment.nodeId}". Judge only topics with no graded check: ${allowed}.`);
		else if (topic.status !== "unchecked") {
			problems.push(`"${topic.title}" (${topic.nodeId}) was rated ${STATUS_WORDS[topic.status]} by the app, so it can't be judged. Judge only topics with no graded check: ${allowed}. Put a gap in a topic rated solid in \`alsoShaky\`.`);
		} else if (seen.has(judgment.nodeId)) problems.push(`"${topic.title}" (${topic.nodeId}) is judged twice. Judge each topic once.`);
		else if (!judgment.reason) problems.push(`The judgment of "${topic.title}" (${topic.nodeId}) needs a one-line reason.`);
		seen.add(judgment.nodeId);
	}
	const long = (text: string) => text.length > HANDOFF_LINE_LIMIT;
	const quote = (text: string) => `“${text.slice(0, 60)}…”`;
	for (const judgment of value.judged) if (long(judgment.reason)) problems.push(`The reason for ${judgment.nodeId} is longer than ${HANDOFF_LINE_LIMIT} characters; shorten it: ${quote(judgment.reason)}`);
	for (const [field, items] of [["alsoShaky", value.alsoShaky], ["misconceptionsRepaired", value.misconceptionsRepaired], ["carriedForward", value.carriedForward]] as const) {
		for (const item of items) if (long(item)) problems.push(`An item in \`${field}\` is longer than ${HANDOFF_LINE_LIMIT} characters; shorten it: ${quote(item)}`);
	}
	return problems;
}

export class HandoffWriterError extends Error {}

export interface WriteHandoffInput extends HandoffWriterInput {
	record: ChatRecord;
	engine: PiEngine | undefined;
	signal?: AbortSignal;
	/** Live usage after each model call (the activity row's cost). */
	onUsage?: (usage: JobUsage) => void;
}

export interface WrittenHandoff {
	observations: HandoffObservations;
	model?: string;
	usage?: JobUsage;
}

const NEVER_SUBMITTED = "The handoff writer stopped without producing observations it could save.";

export async function writeHandoff(input: WriteHandoffInput): Promise<WrittenHandoff> {
	if (!input.engine) throw new HandoffWriterError("No model configured — set up your models first");
	const read = handoffSessionText(input.record, input.engine, (text) => handoffUserMessage(input, text));
	if ("problem" in read) throw new HandoffWriterError(read.problem);
	let usage: JobUsage | undefined;
	let model: string | undefined;
	const line = (description: string) => Type.String({ description });
	const submitted = await runSubmitAgent<Submitted>({
		role: "handoffWriter",
		toolName: "submit_handoff",
		toolDescription: SUBMIT_DESCRIPTION,
		parameters: Type.Object({
			judged: Type.Optional(Type.Array(Type.Object({
				nodeId: Type.String({ description: "The topic's id, from the topics you may judge." }),
				status: Type.Union([Type.Literal("solid"), Type.Literal("shaky")]),
				reason: line("Why, in one line."),
			}), { description: "Only topics with no graded check: your judgment from the transcript." })),
			alsoShaky: Type.Optional(Type.Array(line("One shaky item with its reason."), { description: "Anything else that looked shaky." })),
			misconceptionsRepaired: Type.Optional(Type.Array(line("One misconception and how the unit repaired it."), { description: "Misconceptions the unit repaired." })),
			carriedForward: Type.Optional(Type.Array(line("One item to carry forward."), { description: "Open questions, the learner's requests, topics deferred." })),
		}),
		fill: fillHandoff,
		systemPrompt: HANDOFF_SYSTEM_PROMPT,
		prompt: read.prompt,
		engine: input.engine,
		signal: input.signal,
		onStep: (stepUsage: Usage, stepModel: string) => {
			model = stepModel;
			usage = accumulateJobUsage(usage, stepModel, piUsageToStep(stepUsage));
			input.onUsage?.(usage);
		},
		neverSubmitted: NEVER_SUBMITTED,
		validate: (value) => {
			const problems = handoffProblems(value, input.topics);
			return problems.length > 0 ? `Fix these problems and call submit_handoff again:\n${problems.map((p) => `- ${p}`).join("\n")}` : null;
		},
		maxTurns: 1 + HANDOFF_FIX_ATTEMPTS,
		chatId: input.record.id,
	});
	return { observations: submitted, ...(model ? { model } : {}), ...(usage ? { usage } : {}) };
}
