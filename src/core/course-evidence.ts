/**
 * Course evidence from session records (fork plan 04, item 5). Pure: the
 * course service hands in a linked session's transcript and appends the
 * events its record lacks.
 *
 * - Answers: every answered quiz, probe, recall, explain and plugin
 *   question becomes an `answer` event. `ask_user_question` answers are
 *   not evidence. Free-recall and plugin answers carry no stored verdict,
 *   so they read as "ungraded" (decision 3).
 * - Practice: every concluded problem of a "Practice this unit" session
 *   becomes a `practice` event, keyed by the problem's call.
 *
 * Ids are stable (`<chatId>:<toolCallId>`), so reading the same transcript
 * again yields the same events. Events come out in transcript order, which
 * the handoff topic rule relies on ("the latest check").
 */
import type { AnswerEvidence, AnswerPhase, AnswerResult, PracticeEvidence } from "./contracts/course.ts";
import {
	PRACTICE_CONCLUDE_TOOL,
	pluginQuestionResultMatches,
	practiceProblemForCall,
	problemForConclude,
	type LhMessage,
} from "./native-messages.ts";
import {
	readPluginQuestionAnswer,
	readPluginQuestionCancellation,
	readPluginQuestionMessageAnnotation,
	type PluginQuestionAnnotationRead,
	type PluginQuestionOccurrence,
	type PluginQuestionSnapshot,
} from "./plugin-questions.ts";
import type { QuestionAnswerData } from "./question-core.ts";

/** Native question tools whose answers are evidence. */
const EVIDENCE_TOOLS = new Set(["probe", "recall", "quiz", "explain"]);
/** The prober's tools; the teacher's are quiz and explain. */
const PROBE_TOOLS = new Set(["probe", "recall"]);
/** Multiple-choice tools: the app grades them. */
const GRADED_TOOLS = new Set(["probe", "quiz"]);

/** Where a session sits in its course. */
export interface EvidenceSession {
	chatId: string;
	/** Absent for the setup session. */
	unitId?: string;
	/** The setup session: every answer's phase is "setup". */
	setup?: boolean;
}

type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments?: unknown };
type ResultMessage = Extract<LhMessage, { role: "toolResult" }>;

interface PendingCall {
	name: string;
	input: unknown;
	/** Plan node titles when the question was posed. */
	titles: ReadonlyMap<string, string>;
	plugin?: { occurrence: PluginQuestionOccurrence; annotation: PluginQuestionAnnotationRead; snapshot: PluginQuestionSnapshot };
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoAt(answeredAt: unknown, timestamp: number): string {
	if (typeof answeredAt === "string" && !Number.isNaN(Date.parse(answeredAt))) return answeredAt;
	return new Date(Number.isFinite(timestamp) ? timestamp : 0).toISOString();
}

/** The node titles a successful plan_init result carries, or null. */
function planTitles(message: ResultMessage): Map<string, string> | null {
	if (message.toolName !== "plan_init" || message.isError) return null;
	const details = message.details as { ok?: unknown; tree?: { nodes?: unknown } } | null | undefined;
	if (details?.ok !== true || !Array.isArray(details.tree?.nodes)) return null;
	const titles = new Map<string, string>();
	for (const node of details.tree.nodes as unknown[]) {
		if (record(node) && typeof node.id === "string" && typeof node.title === "string") titles.set(node.id, node.title);
	}
	return titles;
}

/** Results of this assistant's batch. A plan can execute before a later
 *  question in the same message, though its result follows that message
 *  in the transcript. Never borrow a later assistant's plan. */
function batchPlans(messages: readonly LhMessage[], assistantIndex: number): Map<string, Map<string, string>> {
	const plans = new Map<string, Map<string, string>>();
	for (let i = assistantIndex + 1; i < messages.length; i++) {
		const message = messages[i]!;
		if (message.role === "assistant") break;
		if (message.role !== "toolResult") continue;
		const titles = planTitles(message);
		if (titles) plans.set(message.toolCallId, titles);
	}
	return plans;
}

/** A stored native answer: the full QuestionAnswerData rides `details`. */
function nativeAnswer(details: unknown): QuestionAnswerData | null {
	if (!record(details) || typeof details.kind !== "string") return null;
	if (details.dismissed !== true && typeof details.answeredAt !== "string") return null;
	return details as unknown as QuestionAnswerData;
}

function nativeResult(tool: string, answer: QuestionAnswerData): AnswerResult {
	if (answer.dismissed) return "skipped";
	if (!GRADED_TOOLS.has(tool)) return "ungraded";
	if (answer.dontKnow) return "dontKnow";
	return answer.correct === true ? "right" : "wrong";
}

function nodeOf(input: unknown, titles: ReadonlyMap<string, string>): Pick<AnswerEvidence, "nodeId" | "nodeTitle"> {
	const nodeId = record(input) && typeof input.nodeId === "string" && input.nodeId.trim() ? input.nodeId : undefined;
	if (!nodeId) return {};
	const nodeTitle = titles.get(nodeId);
	return { nodeId, ...(nodeTitle !== undefined ? { nodeTitle } : {}) };
}

function questionTypeOf(value: unknown): AnswerEvidence["questionType"] {
	return value === "predict" || value === "check" ? value : undefined;
}

/** Unique within the transcript; a reused call id gets an occurrence suffix. */
function idMaker(chatId: string): (callId: string) => string {
	const seen = new Map<string, number>();
	return (callId) => {
		const count = (seen.get(callId) ?? 0) + 1;
		seen.set(callId, count);
		return count === 1 ? `${chatId}:${callId}` : `${chatId}:${callId}:${count}`;
	};
}

/**
 * The `answer` events a session's transcript holds, in transcript order.
 * The phase is "setup" in the setup session, otherwise read from the tool
 * (the prober's probe/recall, the teacher's quiz/explain) or the plugin
 * question's variant. A node's title is the one the plan had when the
 * question was asked.
 */
export function sessionAnswerEvidence(messages: readonly LhMessage[], session: EvidenceSession): AnswerEvidence[] {
	const events: AnswerEvidence[] = [];
	const nextId = idMaker(session.chatId);
	// A reused native id can name several unresolved plugin occurrences.
	// Keep them all; their saved occurrence decides which result settles one.
	const pending = new Map<string, PendingCall[]>();
	const remember = (id: string, call: PendingCall) => {
		const calls = pending.get(id) ?? [];
		// Native answers have no occurrence binding: retain their existing
		// newest-call pairing while leaving saved plugin occurrences intact.
		if (!call.plugin) {
			const previousNative = calls.findIndex((candidate) => !candidate.plugin);
			if (previousNative !== -1) calls.splice(previousNative, 1);
		}
		calls.push(call);
		pending.set(id, calls);
	};
	let titles: ReadonlyMap<string, string> = new Map();
	const phaseOf = (probing: boolean): AnswerPhase => session.setup ? "setup" : probing ? "probe" : "teach";
	const base = (at: string) => ({ type: "answer" as const, at, ...(session.unitId ? { unitId: session.unitId } : {}), chatId: session.chatId });

	for (const [messageIndex, message] of messages.entries()) {
		if (message.role === "assistant") {
			const plans = batchPlans(messages, messageIndex);
			let posedTitles = titles;
			for (const [contentIndex, block] of message.content.entries()) {
				if (block.type !== "toolCall") continue;
				const call = block as ToolCallBlock;
				if (call.name === "plan_init") posedTitles = plans.get(call.id) ?? posedTitles;
				const annotation = readPluginQuestionMessageAnnotation(message, contentIndex);
				if (annotation.status === "posed") {
					const occurrence = { messageId: message.id, contentIndex, toolCallId: call.id, toolName: call.name };
					remember(call.id, { name: call.name, input: annotation.snapshot.input, titles: posedTitles, plugin: { occurrence, annotation, snapshot: annotation.snapshot } });
				} else if (annotation.status === "absent" && EVIDENCE_TOOLS.has(call.name)) {
					remember(call.id, { name: call.name, input: call.arguments, titles: posedTitles });
				}
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		titles = planTitles(message) ?? titles;
		const calls = pending.get(message.toolCallId);
		if (!calls || message.isError) continue;
		const index = calls.findLastIndex((call) => call.name === message.toolName
			&& (!call.plugin || pluginQuestionResultMatches(message, call.plugin.occurrence, call.plugin.annotation)));
		if (index === -1) continue;
		const call = calls[index]!;

		if (call.plugin) {
			const { snapshot } = call.plugin;
			calls.splice(index, 1);
			const cancellation = readPluginQuestionCancellation(message.details, snapshot);
			const answer = cancellation ? null : readPluginQuestionAnswer(message.details, snapshot);
			// Only the learner's dismissal is a skip; a protocol cancellation
			// (an incompatible or unreadable plugin) says nothing about him.
			if (cancellation ? cancellation.reason !== "dismissed" : !answer) continue;
			const questionType = snapshot.variant === "teach" ? questionTypeOf(snapshot.input.type) : undefined;
			events.push({
				...base(isoAt(answer?.answeredAt, message.timestamp)),
				id: nextId(message.toolCallId),
				phase: phaseOf(snapshot.variant === "probe"),
				tool: call.name,
				...(questionType ? { questionType } : {}),
				...nodeOf(snapshot.input, call.titles),
				result: answer ? "ungraded" : "skipped",
			});
			continue;
		}

		const answer = nativeAnswer(message.details);
		if (!answer) continue;
		calls.splice(index, 1);
		// A dismissal's minimal record has no question type; the call has.
		const questionType = questionTypeOf(answer.questionType ?? (record(call.input) ? call.input.type : undefined));
		const confidence = !answer.dismissed && typeof answer.confidence === "number" ? answer.confidence : undefined;
		events.push({
			...base(isoAt(answer.answeredAt, message.timestamp)),
			id: nextId(message.toolCallId),
			phase: phaseOf(PROBE_TOOLS.has(call.name)),
			tool: call.name,
			...(questionType ? { questionType } : {}),
			...nodeOf(call.input, call.titles),
			result: nativeResult(call.name, answer),
			...(confidence !== undefined ? { confidence } : {}),
		});
	}
	return events;
}

/** "R0"–"R5" as 0–5; null (no hint) and anything else as absent. */
function rungNumber(value: unknown): number | undefined {
	const match = typeof value === "string" ? /^R([0-5])$/.exec(value) : null;
	return match ? Number(match[1]) : undefined;
}

function targetsOf(input: unknown): string[] | undefined {
	const target = record(input) ? input.target : undefined;
	if (!Array.isArray(target)) return undefined;
	const ids = target.filter((id): id is string => typeof id === "string" && id.length > 0);
	return ids.length > 0 ? ids : undefined;
}

/**
 * The `practice` events of a "Practice this unit" session: one per
 * concluded problem, in transcript order, from the conclude call's outcome,
 * rung and miss class plus the problem's targets. A learner's dismissal
 * counts as concluded "dismissed" from its marker on, before the deferred
 * conclude lands; both read as the same event.
 */
export function sessionPracticeEvidence(messages: readonly LhMessage[], session: { chatId: string; unitId: string }): PracticeEvidence[] {
	const events: PracticeEvidence[] = [];
	const seen = new Set<string>();
	const concludes = new Map<string, ToolCallBlock>();
	const add = (problemCallId: string, at: string, fields: Pick<PracticeEvidence, "outcome" | "rung" | "missClass" | "targets">) => {
		const id = `${session.chatId}:${problemCallId}`;
		if (seen.has(id)) return;
		seen.add(id);
		events.push({ type: "practice", id, at, practiceChatId: session.chatId, unitId: session.unitId, problemCallId, ...fields });
	};
	/** A problem's targets, native or plugin, from its pose. */
	const problemTargets = (problemCallId: string) => {
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			const contentIndex = message.content.findIndex((block) => block.type === "toolCall" && block.id === problemCallId);
			if (contentIndex === -1) continue;
			const block = message.content[contentIndex] as ToolCallBlock;
			const problem = practiceProblemForCall(messages, { messageId: message.id, contentIndex, toolCallId: block.id, toolName: block.name });
			if (problem) return targetsOf(problem.input);
		}
		return undefined;
	};

	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall" && block.name === PRACTICE_CONCLUDE_TOOL) concludes.set(block.id, block as ToolCallBlock);
			}
			continue;
		}
		if (message.role === "custom") {
			const problemCallId = message.customType === "problem-dismissed" && record(message.details) ? message.details.problemCallId : undefined;
			if (typeof problemCallId === "string") {
				const targets = problemTargets(problemCallId);
				add(problemCallId, isoAt(undefined, message.timestamp), { outcome: "dismissed", ...(targets ? { targets } : {}) });
			}
			continue;
		}
		if (message.role !== "toolResult" || message.toolName !== PRACTICE_CONCLUDE_TOOL || message.isError) continue;
		const call = concludes.get(message.toolCallId);
		if (!call) continue;
		const details = record(message.details) ? message.details : {};
		// The dismissal's synthetic conclude names its problem; a model's
		// conclude ends the newest clean pose before it.
		const problemCallId = typeof details.problemCallId === "string" ? details.problemCallId : problemForConclude(messages, call.id)?.toolCallId;
		if (!problemCallId) continue;
		const input = record(call.arguments) ? call.arguments : {};
		const outcome = typeof input.outcome === "string" ? input.outcome : typeof details.outcome === "string" ? details.outcome : undefined;
		if (!outcome) continue;
		const rung = rungNumber(input.rung);
		const missClass = typeof input.missClass === "string" ? input.missClass : undefined;
		const targets = problemTargets(problemCallId);
		add(problemCallId, isoAt(undefined, message.timestamp), {
			outcome,
			...(rung !== undefined ? { rung } : {}),
			...(missClass ? { missClass } : {}),
			...(targets ? { targets } : {}),
		});
	}
	return events;
}
