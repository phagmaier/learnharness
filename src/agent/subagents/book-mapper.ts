import { normalizeContext, type Tool, type TranscriptContext, type Usage } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { estimateContextTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { Type } from "typebox";
import {
	BOOK_CHARS_PER_TOKEN,
	digestLineText,
	labelForTitle,
	pathOf,
	structureDigest,
	type ModelHeading,
	type StructureDigest,
} from "../../core/book.ts";
import type { BookBlock, BookNode } from "../../core/contracts/book.ts";
import { modelsNotConfigured } from "../../core/settings.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

/**
 * The book map writer (fork plan 05 item 2), on the bookMapper role (Cheap
 * slot). Leaves are batched in book order into calls of at most about 12k
 * tokens of text, one `submit_summaries` call each; parents are then
 * summarized bottom-up from their children's summaries, one level at a
 * time. A section longer than one batch is read in consecutive windows,
 * each later window given the summary so far. The caller persists each
 * finished call before the writer goes on, so Stop or a failure keeps what
 * is done and a later run continues with the rest.
 *
 * The optional contents pass (decision 9) is here too: one
 * `submit_structure` call over a digest of candidate heading lines.
 *
 * The prompts are the plan's approved text (the contents pass's prompt was
 * approved by the human during implementation), fixed here like the other
 * background workers' prompts (src/agent/prompts/README.md); they are not
 * Settings → Prompts segments.
 */

/** Fix attempts after the first submission (the plan's "up to 3 fixes"). */
export const BOOK_MAP_FIX_ATTEMPTS = 3;
export const BOOK_SUMMARY_LIMIT = 200;
export const BOOK_TERMS_LIMIT = 6;
/** Characters of one key term (agent-selected). */
export const BOOK_TERM_LIMIT = 60;
/** Characters of an untitled section's title. */
export const BOOK_TITLE_LIMIT = 60;
/** Text per call, in estimated tokens. */
export const BOOK_BATCH_TOKENS = 12_000;
/** Sections per call (agent-selected), so the answer stays within a Cheap
 *  model's output limit even when the sections are short. */
export const BOOK_BATCH_SECTIONS = 40;
/** The contents pass: label and title limits (agent-selected). */
export const BOOK_LABEL_LIMIT = 40;
export const BOOK_HEADING_LIMIT = 150;
export const BOOK_LEVEL_LIMIT = 6;

export const BOOK_MAP_SECTIONS_PROMPT = `You write the map of a book that a learner studies with a tutor. For each section you receive, write one line saying what the section does in the book's argument or exposition (not a paraphrase of its first sentence), and up to six key terms exactly as the book uses them. For a section marked "untitled", also give a short title naming its content. Use only the text given. Call \`submit_summaries\` once, with every section id given.`;

export const BOOK_MAP_PARTS_PROMPT = `You write the map of a book that a learner studies with a tutor. You receive the summaries of a part's subsections. Write one line saying what the part as a whole does, and up to six key terms. Use only the text given. Call \`submit_summaries\` once, with every section id given.`;

export const BOOK_STRUCTURE_PROMPT = `You find the contents of a book that a learner studies with a tutor. The book's own contents couldn't be found reliably, so you receive its candidate heading lines: short lines, lines in larger type, and lines that look like chapter or section numbers, each with its block id and page.

Pick the lines that are real headings of the book's parts, chapters and sections, in book order. Give each its level (1 for the top level) and its label as citations would show it ("Chapter 2", "IV.A", "1.3"). Leave out running heads, captions, figure and table labels, and lines of body text. Use only the lines given. Call \`submit_structure\` once.`;

const SUMMARIES_DESCRIPTION = `Submit one entry per section id given: a one-line summary of at most ${BOOK_SUMMARY_LIMIT} characters, up to ${BOOK_TERMS_LIMIT} key terms, and, only for a section marked untitled, a title of at most ${BOOK_TITLE_LIMIT} characters.`;
const STRUCTURE_DESCRIPTION = "Submit the book's headings in book order: each line's block id, its level (1 for the top level) and its label.";

const SUMMARIES_TOOL = {
	name: "submit_summaries",
	description: SUMMARIES_DESCRIPTION,
	parameters: Type.Object({
		summaries: Type.Array(Type.Object({
			id: Type.String({ description: "The section's id, as given." }),
			summary: Type.String({ description: `One line, at most ${BOOK_SUMMARY_LIMIT} characters: what the section does in the book.` }),
			terms: Type.Optional(Type.Array(Type.String(), { description: `Up to ${BOOK_TERMS_LIMIT} key terms, exactly as the book uses them.` })),
			title: Type.Optional(Type.String({ description: `Only for a section marked untitled: a short title naming its content, at most ${BOOK_TITLE_LIMIT} characters.` })),
		})),
	}),
} satisfies Tool;

const STRUCTURE_TOOL = {
	name: "submit_structure",
	description: STRUCTURE_DESCRIPTION,
	parameters: Type.Object({
		headings: Type.Array(Type.Object({
			block: Type.Number({ description: "The line's block id, as given in brackets." }),
			level: Type.Number({ description: "1 for the top level, 2 inside it, and so on." }),
			label: Type.String({ description: "The label citations show: \"Chapter 2\", \"IV.A\", \"1.3\"." }),
			title: Type.Optional(Type.String({ description: "The heading's title, when it differs from the line." })),
		})),
	}),
} satisfies Tool;

export class BookMapperError extends Error {}

const REQUEST_TOO_SMALL = "This model's context or output limit is too small for the book writer's request and answer. Choose a model with a larger context or output limit.";

/** What the writer adds to one node. */
export interface WrittenSummary {
	summary: string;
	terms: string[];
	/** Only for an untitled (app-made) part. */
	title?: string;
}

/** One section as the writer reads it. */
interface MapItem {
	node: BookNode;
	untitled: boolean;
	/** A leaf's own text, or a part's subsection summaries (one per line). */
	text: string;
	/** The node's ancestors, for orientation; "" at the top level. */
	within: string;
}

/** A complete initial native request, including the schema carried by the system message. */
function requestContext(systemPrompt: string, prompt: string, tool: Tool): TranscriptContext {
	return normalizeContext({ systemPrompt, tools: [tool], messages: [{ role: "user", content: prompt, timestamp: 0 }] });
}

/** Full-sized legal answers, with slack for JSON/tokenizer differences and the tool name. */
function answerTokens(value: object): number {
	return Math.max(256, Math.ceil(estimateTextTokens(JSON.stringify(value)) * 1.25) + 128);
}

function summaryAnswerTokens(items: readonly MapItem[]): number {
	return answerTokens({ summaries: items.map((item) => ({
		id: item.node.id,
		summary: "s".repeat(BOOK_SUMMARY_LIMIT),
		terms: Array.from({ length: BOOK_TERMS_LIMIT }, () => "t".repeat(BOOK_TERM_LIMIT)),
		...(item.untitled ? { title: "h".repeat(BOOK_TITLE_LIMIT) } : {}),
	})) });
}

/** Retries carry the actual failed answer and validation feedback: never send a
 *  request which the provider would silently reduce to an unusable answer. */
function answerEngine(engine: PiEngine, output: number): PiEngine {
	return {
		...engine,
		streamFn: (model, context, options) => {
			if (clampMaxTokensToContext(model, context, Math.min(model.maxTokens, options?.maxTokens ?? model.maxTokens)) < output) {
				throw new BookMapperError(REQUEST_TOO_SMALL);
			}
			return engine.streamFn(model, context, options);
		},
	};
}
const oneLine = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
const attribute = (value: string) => value.replace(/"/g, "'");
const quote = (text: string) => `“${text.slice(0, 60)}${text.length > 60 ? "…" : ""}”`;

/** An app-made part has no title until the writer names it. */
const isUntitled = (node: BookNode) => node.kind === "app-part" && !node.title;

function childrenOf(nodes: readonly BookNode[]): Map<string, BookNode[]> {
	const children = new Map<string, BookNode[]>();
	for (const node of nodes) {
		if (!node.parentId) continue;
		const list = children.get(node.parentId) ?? [];
		list.push(node);
		children.set(node.parentId, list);
	}
	return children;
}

function display(node: BookNode): string {
	if (!node.title) return node.label;
	if (node.title === node.label || node.title.startsWith(node.label)) return node.title;
	return `${node.label} ${node.title}`;
}

function withinOf(nodes: readonly BookNode[], node: BookNode): string {
	const path = pathOf(nodes, node).split(" › ");
	return path.slice(0, -1).join(" › ");
}

/** A part's input: one line per subsection, with its summary and terms. */
function partText(children: readonly BookNode[]): string {
	return children.map((child) => {
		const terms = child.terms && child.terms.length > 0 ? ` (terms: ${child.terms.join(", ")})` : "";
		return `- [${child.id}] ${display(child)}${child.summary ? ` — ${child.summary}` : ""}${terms}`;
	}).join("\n");
}

function sectionTag(item: MapItem, text: string): string {
	const attributes = [`id="${item.node.id}"`, `label="${attribute(item.node.label)}"`];
	if (item.untitled) attributes.push("untitled");
	else if (item.node.title) attributes.push(`title="${attribute(item.node.title)}"`);
	if (item.within) attributes.push(`within="${attribute(item.within)}"`);
	return `<section ${attributes.join(" ")}>\n${text}\n</section>`;
}

/** Split a text into windows of at most `budget` characters, filled in
 *  order: whole lines where they fit, a longer line word by word. */
export function textWindows(text: string, budget: number): string[] {
	if (text.length <= budget) return [text];
	const windows: string[] = [];
	let current = "";
	const close = () => {
		if (current.trim()) windows.push(current.trim());
		current = "";
	};
	const add = (piece: string, separator: string) => {
		if (current && current.length + separator.length + piece.length > budget) close();
		current = current ? `${current}${separator}${piece}` : piece;
	};
	for (const line of text.split("\n")) {
		if (line.length <= budget) { add(line, "\n"); continue; }
		let separator = "\n";
		for (const word of line.split(" ")) {
			// A word longer than a window (no spaces at all) is cut.
			for (let at = 0; at < word.length; at += budget) {
				add(word.slice(at, at + budget), separator);
				separator = " ";
			}
		}
	}
	close();
	return windows;
}

function fillSummaries(raw: Record<string, unknown>): { id: string; summary: string; terms: string[]; title: string }[] {
	const entries = Array.isArray(raw.summaries) ? raw.summaries : [];
	return entries.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const item = entry as Record<string, unknown>;
		return [{
			id: oneLine(item.id),
			summary: oneLine(item.summary),
			terms: Array.isArray(item.terms) ? item.terms.map(oneLine).filter(Boolean) : [],
			title: oneLine(item.title),
		}];
	});
}

type Submitted = ReturnType<typeof fillSummaries>;

/** Problems with a submission, as the model reads them; empty when valid. */
export function summaryProblems(submitted: Submitted, expected: readonly { id: string; untitled: boolean }[]): string[] {
	const problems: string[] = [];
	const wanted = new Map(expected.map((item) => [item.id, item]));
	const ids = expected.map((item) => item.id).join(", ");
	const seen = new Set<string>();
	for (const entry of submitted) {
		const item = wanted.get(entry.id);
		if (!item) { problems.push(`There is no section "${entry.id}" here. Give exactly these ids: ${ids}.`); continue; }
		if (seen.has(entry.id)) { problems.push(`Section ${entry.id} is given twice. Give each section once.`); continue; }
		seen.add(entry.id);
		if (!entry.summary) problems.push(`Section ${entry.id} needs a summary.`);
		else if (entry.summary.length > BOOK_SUMMARY_LIMIT) problems.push(`The summary of ${entry.id} is longer than ${BOOK_SUMMARY_LIMIT} characters; shorten it: ${quote(entry.summary)}`);
		if (entry.terms.length > BOOK_TERMS_LIMIT) problems.push(`Section ${entry.id} has ${entry.terms.length} terms; give at most ${BOOK_TERMS_LIMIT}.`);
		for (const term of entry.terms) if (term.length > BOOK_TERM_LIMIT) problems.push(`A term of ${entry.id} is longer than ${BOOK_TERM_LIMIT} characters; shorten it: ${quote(term)}`);
		if (item.untitled && !entry.title) problems.push(`Section ${entry.id} is untitled: give it a short title.`);
		else if (item.untitled && entry.title.length > BOOK_TITLE_LIMIT) problems.push(`The title of ${entry.id} is longer than ${BOOK_TITLE_LIMIT} characters; shorten it: ${quote(entry.title)}`);
	}
	const missing = expected.filter((item) => !seen.has(item.id)).map((item) => item.id);
	if (missing.length > 0) problems.push(`Missing ${missing.length === 1 ? "section" : "sections"}: ${missing.join(", ")}. Give every section id given.`);
	return problems;
}

export interface WriteBookMapInput {
	bookId: string;
	bookTitle: string;
	author?: string;
	/** The current map; nodes that already have a summary are skipped. */
	nodes: readonly BookNode[];
	blocks: readonly BookBlock[];
	engine: PiEngine | undefined;
	signal?: AbortSignal;
	/** After each model call, with its provider-qualified model. */
	onStep?: (usage: Usage, model: string) => void;
	/** After each finished call: persist these before the writer goes on.
	 *  Throwing stops the writer. */
	onSummaries: (written: ReadonlyMap<string, WrittenSummary>) => void;
}

const NEVER_SUBMITTED = "The map writer stopped without producing summaries it could save.";
const aborted = () => Object.assign(new Error("aborted"), { name: "AbortError" });

/** Summarize what's left of a book's map. Resolves when every node has a summary. */
export async function writeBookMap(input: WriteBookMapInput): Promise<void> {
	const engine = input.engine;
	if (!engine) throw new BookMapperError(modelsNotConfigured(["cheap"]).error);
	const nodes = input.nodes.map((node) => ({ ...node }));
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const children = childrenOf(nodes);
	const header = `Book: ${input.bookTitle}${input.author ? ` by ${input.author}` : ""}`;
	const hasSummary = (node: BookNode) => Boolean(node.summary);

	const call = async (items: readonly MapItem[], systemPrompt: string, prompt: string): Promise<Map<string, WrittenSummary>> => {
		if (input.signal?.aborted) throw aborted();
		const expected = items.map((item) => ({ id: item.node.id, untitled: item.untitled }));
		const submitted = await runSubmitAgent<Submitted>({
			role: "bookMapper",
			toolName: SUMMARIES_TOOL.name,
			toolDescription: SUMMARIES_TOOL.description,
			parameters: SUMMARIES_TOOL.parameters,
			fill: fillSummaries,
			systemPrompt,
			prompt,
			engine: answerEngine(engine, summaryAnswerTokens(items)),
			signal: input.signal,
			onStep: (usage, model) => input.onStep?.(usage, model),
			neverSubmitted: NEVER_SUBMITTED,
			validate: (value) => {
				const problems = summaryProblems(value, expected);
				return problems.length > 0 ? `Fix these problems and call submit_summaries again:\n${problems.map((p) => `- ${p}`).join("\n")}` : null;
			},
			maxTurns: 1 + BOOK_MAP_FIX_ATTEMPTS,
			chatId: input.bookId,
		});
		const untitled = new Set(items.filter((item) => item.untitled).map((item) => item.node.id));
		return new Map(submitted.map((entry) => [entry.id, {
			summary: entry.summary,
			terms: entry.terms,
			...(untitled.has(entry.id) ? { title: entry.title } : {}),
		}]));
	};

	const store = (written: ReadonlyMap<string, WrittenSummary>) => {
		if (input.signal?.aborted) throw aborted();
		input.onSummaries(written);
		for (const [id, entry] of written) {
			const node = byId.get(id);
			if (!node) continue;
			node.summary = entry.summary;
			if (entry.terms.length > 0) node.terms = entry.terms;
			if (entry.title) node.title = entry.title;
		}
	};

	const promptFor = (items: readonly MapItem[]) => `${header}\n\n${items.map((item) => sectionTag(item, item.text)).join("\n\n")}`;
	const fits = (items: readonly MapItem[], systemPrompt: string, prompt = promptFor(items)) =>
		clampMaxTokensToContext(engine.model, requestContext(systemPrompt, prompt, SUMMARIES_TOOL), engine.model.maxTokens) >= summaryAnswerTokens(items);
	const textCeiling = BOOK_BATCH_TOKENS * BOOK_CHARS_PER_TOKEN;

	/** Reserve the largest legal previous answer before choosing any windows,
	 *  so later windows remain usable even when the summary grows. */
	const runWindows = async (item: MapItem, systemPrompt: string) => {
		const before = (index: number, count: number, sofar?: WrittenSummary) => sofar
			? `This section is long, so you read it in ${count} parts. This is part ${index + 1}.\nYour summary of the earlier parts: ${sofar.summary}${sofar.terms.length > 0 ? `\nTerms so far: ${sofar.terms.join(", ")}` : ""}${sofar.title ? `\nTitle so far: ${sofar.title}` : ""}\nWrite the ${item.untitled ? "summary, terms and title" : "summary and terms"} of the whole section so far.`
			: `This section is long, so you read it in ${count} parts. This is part 1.`;
		const prompt = (text: string, introduction: string) => `${header}\n\n${introduction}\n\n${sectionTag(item, text)}`;
		const largestPrior: WrittenSummary = {
			summary: "s".repeat(BOOK_SUMMARY_LIMIT),
			terms: Array.from({ length: BOOK_TERMS_LIMIT }, () => "t".repeat(BOOK_TERM_LIMIT)),
			...(item.untitled ? { title: "h".repeat(BOOK_TITLE_LIMIT) } : {}),
		};
		const introduction = before(item.text.length, item.text.length, largestPrior);
		let low = 0;
		let high = Math.min(textCeiling, item.text.length);
		while (low < high) {
			const size = Math.ceil((low + high) / 2);
			if (fits([item], systemPrompt, prompt(item.text.slice(0, size), introduction))) low = size;
			else high = size - 1;
		}
		if (low < Math.min(256, item.text.length) || low === 0) {
			throw new BookMapperError(REQUEST_TOO_SMALL);
		}
		const windows = textWindows(item.text, low);
		let sofar: WrittenSummary | undefined;
		for (const [index, window] of windows.entries()) {
			sofar = (await call([item], systemPrompt, prompt(window, before(index, windows.length, sofar)))).get(item.node.id);
		}
		if (sofar) store(new Map([[item.node.id, sofar]]));
	};

	/** Greedy, ordered batches sized against their complete request and answer. */
	const runItems = async (items: readonly MapItem[], systemPrompt: string) => {
		let batch: MapItem[] = [];
		let chars = 0;
		const flush = async () => {
			if (batch.length > 0) store(await call(batch, systemPrompt, promptFor(batch)));
			batch = [];
			chars = 0;
		};
		for (const item of items) {
			if (batch.length > 0 && (batch.length === BOOK_BATCH_SECTIONS || chars + item.text.length > textCeiling || !fits([...batch, item], systemPrompt))) await flush();
			if (item.text.length > textCeiling || !fits([item], systemPrompt)) {
				await runWindows(item, systemPrompt);
			} else {
				batch.push(item);
				chars += item.text.length;
			}
		}
		await flush();
	};

	// Leaves, in book order.
	const leaves: MapItem[] = nodes
		.filter((node) => !children.has(node.id) && !hasSummary(node))
		.map((node) => ({
			node,
			untitled: isUntitled(node),
			text: input.blocks.slice(node.firstBlock, node.lastBlock + 1).map((block) => block.text).join("\n\n"),
			within: withinOf(nodes, node),
		}));
	await runItems(leaves, BOOK_MAP_SECTIONS_PROMPT);

	// Parents, deepest level first, each from its children's summaries.
	const deepest = Math.max(0, ...nodes.map((node) => node.level));
	for (let level = deepest; level >= 1; level--) {
		const parents: MapItem[] = nodes
			.filter((node) => node.level === level && children.has(node.id) && !hasSummary(node))
			.map((node) => ({ node, untitled: isUntitled(node), text: partText(children.get(node.id)!), within: withinOf(nodes, node) }));
		await runItems(parents, BOOK_MAP_PARTS_PROMPT);
	}
}

// ─── the contents pass ──────────────────────────────────────────────────────

function fillStructure(raw: Record<string, unknown>): { block: number; level: number; label: string; title: string }[] {
	const entries = Array.isArray(raw.headings) ? raw.headings : [];
	return entries.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const item = entry as Record<string, unknown>;
		return [{ block: Number(item.block), level: Number(item.level), label: oneLine(item.label), title: oneLine(item.title) }];
	});
}

/** Fill titles from the lines and labels from the titles, then list the
 *  problems as the model reads them. */
export function structureProblems(submitted: ReturnType<typeof fillStructure>, digest: StructureDigest): { headings: ModelHeading[]; problems: string[] } {
	const lines = new Map(digest.lines.map((line) => [line.block, line]));
	const problems: string[] = [];
	const headings: ModelHeading[] = [];
	let previous: ModelHeading | undefined;
	for (const entry of submitted) {
		const line = lines.get(entry.block);
		if (!Number.isInteger(entry.block) || !line) { problems.push(`Block ${entry.block} isn't one of the lines given.`); continue; }
		if (previous && entry.block === previous.block) { problems.push(`Block ${entry.block} is given twice. Give each heading once.`); continue; }
		if (previous && entry.block < previous.block) problems.push(`The headings must be in book order: block ${entry.block} comes after block ${previous.block}.`);
		if (!Number.isInteger(entry.level) || entry.level < 1 || entry.level > BOOK_LEVEL_LIMIT) problems.push(`The level of block ${entry.block} must be a whole number from 1 to ${BOOK_LEVEL_LIMIT}.`);
		else if (!previous && entry.level !== 1) problems.push(`The first heading (block ${entry.block}) must be level 1.`);
		else if (previous && entry.level > previous.level + 1) problems.push(`Block ${entry.block} goes from level ${previous.level} to level ${entry.level}; go one level deeper at a time.`);
		const title = entry.title || line.text.replace(/…$/, "");
		const label = entry.label || labelForTitle(title);
		if (title.length > BOOK_HEADING_LIMIT) problems.push(`The title of block ${entry.block} is longer than ${BOOK_HEADING_LIMIT} characters; shorten it: ${quote(title)}`);
		if (label.length > BOOK_LABEL_LIMIT) problems.push(`The label of block ${entry.block} is longer than ${BOOK_LABEL_LIMIT} characters; shorten it: ${quote(label)}`);
		const heading = { block: entry.block, level: entry.level, label, title };
		headings.push(heading);
		previous = heading;
	}
	return { headings, problems };
}

/** The contents pass's user message: the digest, in book order. */
function structurePrompt(input: { bookTitle: string; author?: string; blocks: number; digest: StructureDigest }): string {
	const omitted = input.digest.omitted > 0 ? ` ${input.digest.omitted.toLocaleString("en-US")} more candidate lines were left out to keep this list short.` : "";
	return [
		`Book: ${input.bookTitle}${input.author ? ` by ${input.author}` : ""}`,
		`The text has ${input.blocks.toLocaleString("en-US")} blocks. These are its candidate heading lines, in book order, each as [block id] (page, larger type) text.${omitted}`,
		input.digest.lines.map(digestLineText).join("\n"),
	].join("\n\n");
}

export interface PreparedStructurePass {
	digest: StructureDigest;
	prompt: string;
	tokens: number;
}

function structureAnswerTokens(digest: StructureDigest): number {
	return answerTokens({ headings: digest.lines.map((line) => ({
		block: line.block,
		level: BOOK_LEVEL_LIMIT,
		label: "l".repeat(BOOK_LABEL_LIMIT),
		title: "h".repeat(BOOK_HEADING_LIMIT),
	})) });
}

/** The same selected digest, prompt and estimate for preview and execution.
 *  Reuse core's strong-first/even sampling, retaining the original page metadata. */
export function prepareStructurePass(input: { bookTitle: string; author?: string; blocks: number; digest: StructureDigest; engine?: PiEngine }): PreparedStructurePass {
	const original = new Map(input.digest.lines.map((line) => [line.block, line]));
	const candidates: BookBlock[] = input.digest.lines.map((line) => ({
		id: line.block, kind: line.larger ? "heading" : "paragraph", level: 1, text: line.text,
		...(line.page !== undefined ? { page: 1, pageLabel: line.page } : {}),
	}));
	let cap = 8_000 * BOOK_CHARS_PER_TOKEN;
	while (true) {
		const sampled = structureDigest(candidates, cap / BOOK_CHARS_PER_TOKEN);
		const digest = {
			lines: sampled.lines.map((line) => original.get(line.block)!),
			omitted: input.digest.omitted + input.digest.lines.length - sampled.lines.length,
		};
		const prompt = structurePrompt({ ...input, digest });
		const context = requestContext(BOOK_STRUCTURE_PROMPT, prompt, STRUCTURE_TOOL);
		const output = structureAnswerTokens(digest);
		if (!input.engine || clampMaxTokensToContext(input.engine.model, context, input.engine.model.maxTokens) >= output) {
			if (input.digest.lines.length > 0 && digest.lines.length === 0) break;
			return { digest, prompt, tokens: estimateContextTokens(context).tokens + output };
		}
		if (digest.lines.length === 0) break;
		cap = Math.floor(cap * 0.8);
	}
	throw new BookMapperError(REQUEST_TOO_SMALL);
}

export interface FindBookStructureInput {
	bookId: string;
	bookTitle: string;
	author?: string;
	blocks: readonly BookBlock[];
	digest: StructureDigest;
	engine: PiEngine | undefined;
	signal?: AbortSignal;
	onStep?: (usage: Usage, model: string) => void;
}

export const NO_HEADINGS_FOUND = "The model found no headings in this book.";

/** One submit_structure call (up to 3 fixes): the headings, validated. */
export async function findBookStructure(input: FindBookStructureInput): Promise<ModelHeading[]> {
	if (!input.engine) throw new BookMapperError(modelsNotConfigured(["cheap"]).error);
	const prepared = prepareStructurePass({ bookTitle: input.bookTitle, author: input.author, blocks: input.blocks.length, digest: input.digest, engine: input.engine });
	let accepted: ModelHeading[] = [];
	await runSubmitAgent({
		role: "bookMapper",
		toolName: STRUCTURE_TOOL.name,
		toolDescription: STRUCTURE_TOOL.description,
		parameters: STRUCTURE_TOOL.parameters,
		fill: fillStructure,
		systemPrompt: BOOK_STRUCTURE_PROMPT,
		prompt: prepared.prompt,
		engine: answerEngine(input.engine, structureAnswerTokens(prepared.digest)),
		signal: input.signal,
		onStep: (usage, model) => input.onStep?.(usage, model),
		neverSubmitted: "The contents pass stopped without producing headings it could save.",
		validate: (value) => {
			const { headings, problems } = structureProblems(value, prepared.digest);
			if (problems.length > 0) return `Fix these problems and call submit_structure again:\n${problems.map((p) => `- ${p}`).join("\n")}`;
			accepted = headings;
			return null;
		},
		maxTurns: 1 + BOOK_MAP_FIX_ATTEMPTS,
		chatId: input.bookId,
	});
	if (accepted.length === 0) throw new BookMapperError(NO_HEADINGS_FOUND);
	return accepted;
}
