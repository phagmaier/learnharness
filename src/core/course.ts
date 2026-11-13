/**
 * Course rules (fork plan 04): unit-list validation and edits, the
 * prerequisite closure, the handoff topic rule, and the readable texts
 * (handoffs, change lines, progress.md). Pure and browser-safe.
 *
 * Edit rules (decision 5): a unit that has started (in progress or
 * completed) can be renamed, re-goaled, reordered and given different
 * prerequisites, but never dropped or merged. Units that haven't started
 * can change freely. A unit builds only on earlier units, so the
 * prerequisite graph has no cycles.
 */
import type {
	AnswerEvidence,
	CourseChange,
	CourseRecord,
	CourseUnit,
	HandoffTopic,
	UnitHandoff,
} from "./contracts/course.ts";
import type { LhMessage } from "./native-messages.ts";

// ─── names and numbers ──────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "20 Nov 2026", in local time. */
export function courseDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** A readable unit id from a title or key: "Linear maps" → "linear-maps". */
export function unitSlug(text: string): string {
	const slug = text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
	return slug.length > 0 ? slug : "unit";
}

/** `base`, or `base-2`, `base-3`… when taken. */
export function uniqueUnitId(base: string, taken: ReadonlySet<string>): string {
	const slug = unitSlug(base);
	if (!taken.has(slug)) return slug;
	for (let n = 2; ; n++) if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`;
}

export function hasStarted(unit: Pick<CourseUnit, "status">): boolean {
	return unit.status !== "not-started";
}

function label(units: readonly CourseUnit[], index: number): string {
	return `unit ${index + 1} (${units[index]!.title.trim() || "untitled"})`;
}

function capital(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

// ─── validation ─────────────────────────────────────────────────────────────

/** Problems with a unit list, in reading order; empty when it is valid. */
export function unitListProblems(units: readonly CourseUnit[]): string[] {
	if (units.length === 0) return ["A course needs at least one unit."];
	const problems: string[] = [];
	const position = new Map<string, number>();
	units.forEach((unit, index) => {
		if (position.has(unit.id)) problems.push(`Two units share the id "${unit.id}".`);
		position.set(unit.id, index);
	});
	units.forEach((unit, index) => {
		if (!unit.title.trim()) problems.push(`Unit ${index + 1} needs a title.`);
		if (!unit.goal.trim()) problems.push(`${capital(label(units, index))} needs a goal.`);
		for (const prerequisite of unit.prerequisites) {
			const at = position.get(prerequisite);
			if (at === undefined) problems.push(`${capital(label(units, index))} builds on an unknown unit: "${prerequisite}".`);
			else if (at >= index) {
				problems.push(at === index
					? `${capital(label(units, index))} can't build on itself.`
					: `${capital(label(units, index))} builds on ${label(units, at)}, which comes after it. A unit can only build on earlier units.`);
			}
		}
	});
	return problems;
}

/** Started units must survive an edit (decision 5). */
function droppedStartedProblems(before: readonly CourseUnit[], after: readonly CourseUnit[], verb: string): string[] {
	const kept = new Set(after.map((unit) => unit.id));
	return before.flatMap((unit, index) => hasStarted(unit) && !kept.has(unit.id)
		? [`${capital(label(before, index))} has started, so it can't be ${verb}.`]
		: []);
}

export type UnitsOutcome = { ok: true; units: CourseUnit[] } | { ok: false; problems: string[] };

/** One unit as the learner's editor sends it: an existing unit by id, or
 *  a new one without. */
export interface UnitDraft {
	id?: string;
	title: string;
	goal: string;
	startingPoint?: string;
	prerequisites: string[];
}

/**
 * Apply the learner's edited list. Existing units keep their status,
 * session and handoff; new units start as not started. Prerequisites name
 * unit ids, or for new units their `new:<index>` placeholder.
 */
export function applyUnitEdit(before: readonly CourseUnit[], drafts: readonly UnitDraft[]): UnitsOutcome {
	const existing = new Map(before.map((unit) => [unit.id, unit]));
	const taken = new Set(before.map((unit) => unit.id));
	const ids = drafts.map((draft, index) => {
		if (draft.id && existing.has(draft.id)) return draft.id;
		const id = uniqueUnitId(draft.title || `unit-${index + 1}`, taken);
		taken.add(id);
		return id;
	});
	const resolve = (ref: string) => ref.startsWith("new:") ? ids[Number(ref.slice(4))] ?? ref : ref;
	const units = drafts.map((draft, index): CourseUnit => {
		const base = existing.get(ids[index]!);
		const startingPoint = draft.startingPoint?.trim();
		const { startingPoint: _old, ...rest } = base ?? { status: "not-started" as const, id: ids[index]! };
		return {
			...rest,
			id: ids[index]!,
			title: draft.title.trim(),
			goal: draft.goal.trim(),
			...(startingPoint ? { startingPoint } : {}),
			prerequisites: [...new Set(draft.prerequisites.map(resolve))],
			status: base?.status ?? "not-started",
		};
	});
	const problems = [...droppedStartedProblems(before, units, "removed"), ...unitListProblems(units)];
	return problems.length > 0 ? { ok: false, problems } : { ok: true, units };
}

/**
 * Apply a change list in order, then check the result. Drops and merges
 * of started units are refused; dependants of a dropped unit inherit its
 * prerequisites; a merged unit takes the place of the earliest unit it
 * replaces.
 */
export function applyCourseChanges(before: readonly CourseUnit[], changes: readonly CourseChange[]): UnitsOutcome {
	let units = before.map((unit) => ({ ...unit, prerequisites: [...unit.prerequisites] }));
	const problems: string[] = [];
	const find = (id: string) => units.findIndex((unit) => unit.id === id);
	const unknown = (id: string) => `There is no unit "${id}" in the course.`;
	const taken = () => new Set([...before.map((unit) => unit.id), ...units.map((unit) => unit.id)]);
	const replacePrerequisite = (gone: readonly string[], substitute: readonly string[]) => {
		units = units.map((unit) => unit.prerequisites.some((id) => gone.includes(id))
			? { ...unit, prerequisites: [...new Set(unit.prerequisites.flatMap((id) => gone.includes(id) ? substitute : [id]))].filter((id) => id !== unit.id) }
			: unit);
	};
	const insertAt = (after: string | null): number | null => {
		if (after === null) return 0;
		const index = find(after);
		return index === -1 ? null : index + 1;
	};

	changes.forEach((change, changeIndex) => {
		const step = changes.length > 1 ? `Change ${changeIndex + 1}: ` : "";
		switch (change.type) {
			case "insert": {
				const at = insertAt(change.after);
				if (at === null) { problems.push(step + unknown(change.after!)); return; }
				const unit: CourseUnit = {
					id: uniqueUnitId(change.title || "unit", taken()),
					title: change.title.trim(),
					goal: change.goal.trim(),
					prerequisites: [...new Set(change.prerequisites)],
					status: "not-started",
				};
				units.splice(at, 0, unit);
				return;
			}
			case "drop": {
				const index = find(change.unit);
				if (index === -1) { problems.push(step + unknown(change.unit)); return; }
				const unit = units[index]!;
				if (hasStarted(unit)) { problems.push(`${step}${capital(label(units, index))} has started, so it can't be dropped.`); return; }
				units.splice(index, 1);
				replacePrerequisite([unit.id], unit.prerequisites);
				return;
			}
			case "move": {
				const index = find(change.unit);
				if (index === -1) { problems.push(step + unknown(change.unit)); return; }
				if (change.after === change.unit) { problems.push(`${step}A unit can't move after itself.`); return; }
				const [unit] = units.splice(index, 1);
				const at = insertAt(change.after);
				if (at === null) { units.splice(index, 0, unit!); problems.push(step + unknown(change.after!)); return; }
				units.splice(at, 0, unit!);
				return;
			}
			case "merge": {
				const ids = [...new Set(change.units)];
				if (ids.length < 2) { problems.push(`${step}A merge needs at least two units.`); return; }
				const indices = ids.map(find);
				const missing = ids.filter((_, i) => indices[i] === -1);
				if (missing.length > 0) { problems.push(step + missing.map(unknown).join(" ")); return; }
				const started = indices.filter((index) => hasStarted(units[index]!));
				if (started.length > 0) {
					problems.push(...started.map((index) => `${step}${capital(label(units, index))} has started, so it can't be merged.`));
					return;
				}
				const merged = indices.map((index) => units[index]!);
				const first = Math.min(...indices);
				const startingPoints = merged.map((unit) => unit.startingPoint?.trim()).filter((text): text is string => !!text);
				const unit: CourseUnit = {
					id: uniqueUnitId(change.title || "unit", taken()),
					title: change.title.trim(),
					goal: change.goal.trim(),
					...(startingPoints.length > 0 ? { startingPoint: [...new Set(startingPoints)].join("\n") } : {}),
					prerequisites: [...new Set(merged.flatMap((m) => m.prerequisites))].filter((id) => !ids.includes(id)),
					status: "not-started",
				};
				units = units.filter((candidate) => !ids.includes(candidate.id));
				units.splice(first, 0, unit);
				replacePrerequisite(ids, [unit.id]);
				return;
			}
		}
	});
	if (problems.length > 0) return { ok: false, problems };
	const after = [...droppedStartedProblems(before, units, "dropped or merged"), ...unitListProblems(units)];
	return after.length > 0 ? { ok: false, problems: after } : { ok: true, units };
}

// ─── prerequisites ──────────────────────────────────────────────────────────

/** The unit's direct and indirect prerequisites, in course order. */
export function transitivePrerequisites(units: readonly CourseUnit[], unitId: string): CourseUnit[] {
	const byId = new Map(units.map((unit) => [unit.id, unit]));
	const seen = new Set<string>();
	const visit = (id: string) => {
		for (const prerequisite of byId.get(id)?.prerequisites ?? []) {
			if (seen.has(prerequisite) || prerequisite === unitId) continue;
			seen.add(prerequisite);
			visit(prerequisite);
		}
	};
	visit(unitId);
	return units.filter((unit) => seen.has(unit.id));
}

/** Direct prerequisites that aren't completed yet, in course order. */
export function unfinishedPrerequisites(units: readonly CourseUnit[], unitId: string): CourseUnit[] {
	const unit = units.find((candidate) => candidate.id === unitId);
	if (!unit) return [];
	return units.filter((candidate) => unit.prerequisites.includes(candidate.id) && candidate.status !== "completed");
}

// ─── the handoff topic rule (decision 2) ────────────────────────────────────

/** A check right at this confidence or more is solid. */
export const SOLID_CONFIDENCE = 70;

const REASON_FREE_RECALL = "free-recall answers only";
const REASON_UNGRADED = "ungraded answers only";
const REASON_NO_CHECK = "no graded check";
const REASON_NOT_REACHED = "not reached";

/**
 * Rate each plan node from the unit's "check" answers only. The latest
 * graded check decides: right at ≥ 70% confidence is solid; wrong, don't
 * know, or right below 70% is shaky. A reached node without a graded check
 * is unchecked (the handoff writer judges it); an unreached node is
 * carried forward.
 */
export function handoffTopics(
	nodes: ReadonlyArray<{ id: string; title: string }>,
	reached: ReadonlySet<string>,
	answers: readonly AnswerEvidence[],
): HandoffTopic[] {
	return nodes.map((node) => {
		const mine = answers.filter((answer) => answer.nodeId === node.id && answer.phase === "teach");
		const checks = mine.filter((answer) => answer.questionType === "check"
			&& (answer.result === "right" || answer.result === "wrong" || answer.result === "dontKnow"));
		const latest = checks.at(-1);
		if (latest) {
			if (latest.result === "wrong") return topic(node, "shaky", "last check wrong");
			if (latest.result === "dontKnow") return topic(node, "shaky", "last check answered “don't know”");
			if (latest.confidence === undefined) return topic(node, "shaky", "last check right, with no confidence recorded");
			const reason = `last check right at ${latest.confidence}% confidence`;
			return topic(node, latest.confidence >= SOLID_CONFIDENCE ? "solid" : "shaky", reason);
		}
		if (!reached.has(node.id) && mine.length === 0) return topic(node, "not-reached", REASON_NOT_REACHED);
		const ungraded = mine.filter((answer) => answer.result === "ungraded");
		if (ungraded.length === 0) return topic(node, "unchecked", REASON_NO_CHECK);
		return topic(node, "unchecked", ungraded.every((answer) => answer.tool === "explain") ? REASON_FREE_RECALL : REASON_UNGRADED);
	});
}

function topic(node: { id: string; title: string }, status: HandoffTopic["status"], reason: string): HandoffTopic {
	return { nodeId: node.id, title: node.title, status, reason };
}

/** What a model-judged topic was judged from, for its label. */
function judgedFrom(topicReason: string | undefined): string {
	if (topicReason === REASON_FREE_RECALL) return "free-recall answers";
	if (topicReason === REASON_UNGRADED) return "ungraded answers";
	return "the transcript";
}

// ─── texts ──────────────────────────────────────────────────────────────────

/** The handoff as later units' agents receive it and the overview shows it. */
export function handoffText(number: number, unit: Pick<CourseUnit, "title" | "completedAt">, handoff: UnitHandoff): string {
	const date = courseDate(unit.completedAt ?? handoff.writtenAt);
	const lines = [`Unit ${number} · ${unit.title}: completed ${date}${handoff.completion === "early" ? " (early: before the teacher marked the goal reached)" : ""}`];
	const section = (heading: string, items: string[]) => {
		if (items.length === 0) return;
		lines.push(heading, ...items.map((item) => `- ${item}`));
	};
	const of = (status: HandoffTopic["status"]) => handoff.topics.filter((entry) => entry.status === status);
	if (handoff.topics.length === 0) lines.push("No plan topics were recorded.");
	section("Solid:", of("solid").map((entry) => `${entry.title}: ${entry.reason}`));
	section("Shaky:", of("shaky").map((entry) => `${entry.title}: ${entry.reason}`));
	section("Not checked by a graded question:", of("unchecked").map((entry) => entry.title));
	section("Not reached (carried forward):", of("not-reached").map((entry) => entry.title));
	const observations = handoff.writer.status === "ready" ? handoff.observations : undefined;
	if (observations) {
		const byNode = new Map(handoff.topics.map((entry) => [entry.nodeId, entry]));
		section("Teacher observations (model-written):", [
			...observations.judged.map((judgment) => {
				const judgedTopic = byNode.get(judgment.nodeId);
				return `${judgedTopic?.title ?? judgment.nodeId} looks ${judgment.status}: ${judgment.reason} (judged from ${judgedFrom(judgedTopic?.reason)})`;
			}),
			...observations.alsoShaky.map((line) => `Also shaky: ${line}`),
			...observations.misconceptionsRepaired.map((line) => `Misconception repaired: ${line}`),
			...observations.carriedForward.map((line) => `Carry forward: ${line}`),
		]);
	}
	return lines.join("\n");
}

function joinNumbers(numbers: string[]): string {
	return numbers.length <= 1 ? numbers.join("") : `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
}

/** One readable line per proposed change, numbered against `units`. */
export function courseChangeLine(change: CourseChange, units: readonly CourseUnit[]): string {
	const number = (id: string) => {
		const index = units.findIndex((unit) => unit.id === id);
		return index === -1 ? `"${id}"` : String(index + 1);
	};
	const title = (id: string) => units.find((unit) => unit.id === id)?.title ?? id;
	switch (change.type) {
		case "insert":
			return change.after === null ? `Insert at the start: ${change.title}` : `Insert after ${number(change.after)}: ${change.title}`;
		case "drop":
			return `Drop ${number(change.unit)}: ${title(change.unit)}`;
		case "move":
			return change.after === null ? `Move ${number(change.unit)} to the start` : `Move ${number(change.unit)} after ${number(change.after)}`;
		case "merge":
			return `Merge ${joinNumbers(change.units.map(number))} into: ${change.title}`;
	}
}

function cell(text: string): string {
	return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function statusCell(unit: CourseUnit): string {
	if (unit.status === "completed") return unit.completedAt ? `Completed ${courseDate(unit.completedAt)}` : "Completed";
	return unit.status === "in-progress" ? "In progress" : "Not started";
}

/** The readable progress file, regenerated on every change and never read back. */
export function progressMarkdown(course: CourseRecord): string {
	const numberOf = new Map(course.units.map((unit, index) => [unit.id, index + 1]));
	const lines = [
		`# ${course.title}`,
		"",
		`Goal: ${course.goal}`,
		`Updated ${courseDate(course.updatedAt)}. Written by LearnHarness Fork; edits to this file are not read back.`,
		"",
		"## Units",
		"",
		"| # | Unit | Status | Builds on |",
		"|---|------|--------|-----------|",
		...course.units.map((unit, index) => {
			const buildsOn = unit.prerequisites.map((id) => numberOf.get(id)).filter((n): n is number => n !== undefined);
			return `| ${index + 1} | ${cell(unit.title)} | ${statusCell(unit)} | ${buildsOn.length > 0 ? buildsOn.join(", ") : "—"} |`;
		}),
	];
	const pending = course.proposals.filter((proposal) => proposal.status === "pending");
	if (pending.length > 0) {
		lines.push("", "## Pending course changes", "");
		for (const proposal of pending) {
			lines.push(`- ${proposal.reason.replace(/\s+/g, " ").trim()}`);
			for (const change of proposal.changes) lines.push(`  - ${courseChangeLine(change, course.units)}`);
		}
	}
	const handoffs = course.units.flatMap((unit, index) => unit.handoff ? [{ unit, index, handoff: unit.handoff }] : []);
	if (handoffs.length > 0) {
		lines.push("", "## Handoffs");
		for (const { unit, index, handoff } of handoffs) {
			lines.push("", `### ${index + 1}. ${unit.title}`, handoffText(index + 1, unit, handoff));
		}
	}
	return `${lines.join("\n")}\n`;
}

// ─── the unit-list editor (setup card and "Edit units") ─────────────────────

/** One row of the unit editor. `key` names the row for prerequisites; a
 *  locked row is a unit that has started, so it can't be removed. */
export interface UnitDraftRow {
	key: string;
	title: string;
	goal: string;
	startingPoint: string;
	prerequisites: string[];
	locked?: boolean;
}

export interface CourseDraft {
	title: string;
	goal: string;
	units: UnitDraftRow[];
}

/** A propose_course call's input, or null when it isn't a proposal. */
export function parseCourseProposal(raw: unknown): CourseDraft | null {
	if (!raw || typeof raw !== "object") return null;
	const input = raw as Record<string, unknown>;
	if (typeof input.title !== "string" || typeof input.goal !== "string" || !Array.isArray(input.units)) return null;
	const units: UnitDraftRow[] = [];
	for (const entry of input.units) {
		if (!entry || typeof entry !== "object") return null;
		const unit = entry as Record<string, unknown>;
		if (typeof unit.key !== "string" || typeof unit.title !== "string" || typeof unit.goal !== "string") return null;
		const prerequisites = Array.isArray(unit.prerequisites) ? unit.prerequisites.filter((id): id is string => typeof id === "string") : [];
		units.push({
			key: unit.key, title: unit.title, goal: unit.goal,
			startingPoint: typeof unit.startingPoint === "string" ? unit.startingPoint : "",
			prerequisites,
		});
	}
	return { title: input.title, goal: input.goal, units };
}

/** The editor's problems, in the same words the server uses. */
export function draftProblems(draft: CourseDraft): string[] {
	const units: CourseUnit[] = draft.units.map((row) => ({
		id: row.key, title: row.title, goal: row.goal, prerequisites: row.prerequisites, status: "not-started",
	}));
	return [
		...(draft.title.trim() ? [] : ["The course needs a title."]),
		...(draft.goal.trim() ? [] : ["The course needs a goal."]),
		...unitListProblems(units),
	];
}

/** A row may move past its neighbour unless that would put a unit before a
 *  unit it builds on. */
export function canMoveDraftUnit(units: readonly UnitDraftRow[], index: number, direction: -1 | 1): boolean {
	const other = index + direction;
	if (index < 0 || other < 0 || other >= units.length) return false;
	const [earlier, later] = direction === -1 ? [units[other]!, units[index]!] : [units[index]!, units[other]!];
	return !later.prerequisites.includes(earlier.key);
}

export function moveDraftUnit(units: readonly UnitDraftRow[], index: number, direction: -1 | 1): UnitDraftRow[] {
	if (!canMoveDraftUnit(units, index, direction)) return [...units];
	const next = [...units];
	[next[index], next[index + direction]] = [next[index + direction]!, next[index]!];
	return next;
}

/** Remove a row; rows that built on it no longer do. Locked rows stay. */
export function removeDraftUnit(units: readonly UnitDraftRow[], index: number): UnitDraftRow[] {
	const gone = units[index];
	if (!gone || gone.locked) return [...units];
	return units.filter((_, i) => i !== index).map((row) => row.prerequisites.includes(gone.key)
		? { ...row, prerequisites: row.prerequisites.filter((key) => key !== gone.key) }
		: row);
}

/** Toggle whether the row at `index` builds on the earlier row `key`. */
export function togglePrerequisite(units: readonly UnitDraftRow[], index: number, key: string): UnitDraftRow[] {
	return units.map((row, i) => i !== index ? row : {
		...row,
		prerequisites: row.prerequisites.includes(key)
			? row.prerequisites.filter((candidate) => candidate !== key)
			: units.slice(0, index).filter((earlier) => earlier.key === key || row.prerequisites.includes(earlier.key)).map((earlier) => earlier.key),
	});
}

/** The latest successful propose_course call in a setup session's record. */
export function latestProposalCallId(messages: readonly LhMessage[]): string | undefined {
	const succeeded = new Set(messages.flatMap((message) =>
		message.role === "toolResult" && message.toolName === "propose_course" && !message.isError ? [message.toolCallId] : []));
	let latest: string | undefined;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && block.name === "propose_course" && succeeded.has(block.id)) latest = block.id;
		}
	}
	return latest;
}

/** Whether a session's teaching enters the graph: practice sessions and
 *  course setup sessions (a broad survey, not a lesson) are never extracted. */
export function sessionExtracts(record: { kind?: string; course?: { role: string } }): boolean {
	return record.kind !== "practice" && record.course?.role !== "setup";
}
