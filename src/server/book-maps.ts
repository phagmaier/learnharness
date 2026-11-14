/**
 * The book map writer's lifecycle (fork plan 05 item 2), and the optional
 * contents pass's. Both are learner-started model writers on the
 * bookMapper role (Cheap slot): requests run with purpose "user" (the
 * learner imported the book, or asked for the pass), so subscriptions need
 * no background consent, and they share the worker-request pool.
 *
 * The map writer starts once a book's contents are accepted (src/server/
 * books.ts). Each finished batch is written to map.json at once, so Stop, a
 * failure or a closed app keeps finished summaries, and Try again continues
 * with the rest. A writer left "writing" by a closed app reads as failed
 * ("Interrupted.") on the next read. Background agents lists a running map
 * writer as "Book map · <title>" ("<done> of <total> sections") and the
 * contents pass as "Book contents · <title>", each with Stop.
 *
 * A writer belongs to one map: switching the contents or deleting the book
 * discards it, and a discarded writer never writes again.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { modelCandidate, type StructureDigest } from "../core/book.ts";
import type { BookBlock, BookMapWriterState, BookNode, BookRecord, BookWriterState, JobUsage } from "../core/contracts.ts";
import { accumulateJobUsage, piUsageToStep } from "../core/contracts/jobs.ts";
import { emit } from "../core/events.ts";
import { modelsNotConfigured } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { BookMapperError, findBookStructure, writeBookMap, type WrittenSummary } from "../agent/subagents/book-mapper.ts";
import { bookStore } from "../store/books.ts";
import { STOPPED_MESSAGE } from "./notes.ts";
import { stores } from "./stores.ts";

/** The plan's wording for a writer the app closed on. */
export const BOOK_WRITER_INTERRUPTED = "Interrupted.";
export const BOOK_CONTENTS_CHANGED = "The book's contents changed while its map was written.";

/** Test seams: engine construction and the writers themselves. */
export const bookMapServiceSeams = {
	buildEngine: piEngineForSpec as (...args: Parameters<typeof piEngineForSpec>) => PiEngine,
	writeMap: writeBookMap,
	findStructure: findBookStructure,
};

export type BookWriterKind = "map" | "contents";

interface RunningBookWriter {
	bookId: string;
	kind: BookWriterKind;
	bookTitle: string;
	controller: AbortController;
	startedAt: string;
	/** This run's usage (the activity row's cost). */
	usage?: JobUsage;
	model?: string;
	done: number;
	total: number;
}

interface BookWritersGlobal { __lhRunningBookWriters?: Map<string, RunningBookWriter> }
function running(): Map<string, RunningBookWriter> {
	const global = globalThis as typeof globalThis & BookWritersGlobal;
	return global.__lhRunningBookWriters ??= new Map();
}
const key = (bookId: string, kind: BookWriterKind) => `${bookId}:${kind}`;
const current = (entry: RunningBookWriter) => running().get(key(entry.bookId, entry.kind)) === entry;
const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

export function isBookWriterRunning(bookId: string, kind: BookWriterKind): boolean {
	return running().has(key(bookId, kind));
}

/** The bookMapper engine: role override → Cheap slot, purpose "user". */
export function bookMapperEngine(): PiEngine | undefined {
	const settings = stores.settingsStore.readSettings();
	const spec = resolveRoleSpec("bookMapper", settings);
	if (!spec) return undefined;
	return bookMapServiceSeams.buildEngine(spec, false, undefined, () => stores.settingsStore.readSettings()?.models?.cheap?.cacheRetention);
}

/** The model the bookMapper role resolves to, for "about <n>k tokens on <model>". */
export function bookMapperModel(): { provider: string; id: string } | null {
	const spec = resolveRoleSpec("bookMapper", stores.settingsStore.readSettings());
	return spec ? { provider: spec.provider, id: spec.id } : null;
}

function register(record: BookRecord, kind: BookWriterKind, done = 0, total = 0): RunningBookWriter {
	const entry: RunningBookWriter = {
		bookId: record.id, kind, bookTitle: record.title,
		controller: new AbortController(), startedAt: new Date().toISOString(), done, total,
	};
	running().set(key(record.id, kind), entry);
	emit("activity-changed", {});
	return entry;
}

function release(entry: RunningBookWriter): void {
	if (current(entry)) running().delete(key(entry.bookId, entry.kind));
	emit("activity-changed", {});
}

/** Track a step: this run's usage, and the map's own total, which carries
 *  over a Try again on the same model (agent-selected). */
function stepper(entry: RunningBookWriter, previous: JobUsage | undefined) {
	let total: JobUsage | undefined;
	let first = true;
	return {
		step(usage: Usage, model: string) {
			if (first) total = previous?.model === model ? previous : undefined;
			first = false;
			const step = piUsageToStep(usage);
			entry.usage = accumulateJobUsage(entry.usage, model, step);
			entry.model = model;
			total = accumulateJobUsage(total, model, step);
			emit("activity-changed", {});
		},
		get total() { return total ?? previous; },
	};
}

const sameStructure = (a: readonly BookNode[], b: readonly BookNode[]) => a.length === b.length
	&& a.every((node, i) => node.id === b[i]!.id && node.firstBlock === b[i]!.firstBlock && node.lastBlock === b[i]!.lastBlock && node.parentId === b[i]!.parentId);

function failedMap(state: BookMapWriterState, error: string, stopped: boolean, usage: JobUsage | undefined): BookMapWriterState {
	const { stopped: _stopped, error: _error, ...rest } = state;
	return {
		...rest,
		status: "failed",
		error,
		...(stopped ? { stopped: true as const } : {}),
		...(usage ? { model: usage.model, usage } : {}),
	};
}

/**
 * Start (or continue) the map writer of a book whose contents are
 * accepted. A short book, a finished map, or a running writer is left
 * alone. With no engine the writer fails at once with the reason. Returns
 * the record as it now stands. Registers synchronously, so a read in the
 * same tick never takes the writer for an interrupted one.
 */
export function startBookMapWriter(bookId: string, engine?: PiEngine): BookRecord | null {
	const record = bookStore.get(bookId);
	if (!record || record.import.status !== "ready" || !record.contentsAccepted) return record;
	if (record.mapWriter.status === "not-needed" || record.mapWriter.status === "ready" || isBookWriterRunning(bookId, "map")) return record;
	const fail = (error: string) => bookStore.update(bookId, (now) => ({ ...now, mapWriter: failedMap(now.mapWriter, error, false, now.mapWriter.usage) }));
	let map, text;
	try {
		map = bookStore.readMap(bookId);
		text = bookStore.readText(bookId);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
	if (!map || !text) return fail("This book's text can't be read.");
	const total = map.nodes.length;
	const done = map.nodes.filter((node) => node.summary).length;
	if (done === total) {
		return bookStore.update(bookId, (now) => ({ ...now, mapWriter: { status: "ready", done, total, ...(now.mapWriter.model ? { model: now.mapWriter.model } : {}), ...(now.mapWriter.usage ? { usage: now.mapWriter.usage } : {}) } }));
	}
	let resolved = engine;
	try {
		resolved ??= bookMapperEngine();
	} catch (error) {
		// A disconnected provider can leave a saved model unavailable.
		return fail(error instanceof Error ? error.message : String(error));
	}
	if (!resolved) return bookStore.update(bookId, (now) => ({ ...now, mapWriter: { ...failedMap(now.mapWriter, modelsNotConfigured(["cheap"]).error, false, now.mapWriter.usage), done, total } }));
	const entry = register(record, "map", done, total);
	const previous = record.mapWriter.usage;
	const usage = stepper(entry, previous);
	let next: BookRecord | null;
	try {
		next = bookStore.update(bookId, (now) => ({
			...now,
			mapWriter: { status: "writing", done, total, ...(previous ? { model: previous.model, usage: previous } : {}) },
		}));
	} catch (error) {
		release(entry);
		throw error;
	}
	const nodes = map.nodes;
	const signal = entry.controller.signal;
	void (async () => {
		try {
			await bookMapServiceSeams.writeMap({
				bookId, bookTitle: record.title, ...(record.author ? { author: record.author } : {}),
				nodes, blocks: text.blocks, engine: resolved, signal,
				onStep: usage.step,
				onSummaries: (written: ReadonlyMap<string, WrittenSummary>) => {
					if (signal.aborted || !current(entry)) throw abortError();
					const stored = bookStore.readMap(bookId);
					if (!stored || !sameStructure(stored.nodes, nodes)) throw new Error(BOOK_CONTENTS_CHANGED);
					const updated = stored.nodes.map((node) => {
						const summary = written.get(node.id);
						if (!summary) return node;
						return { ...node, summary: summary.summary, ...(summary.terms.length > 0 ? { terms: summary.terms } : {}), ...(summary.title ? { title: summary.title } : {}) };
					});
					bookStore.writeMap(bookId, { nodes: updated });
					entry.done = updated.filter((node) => node.summary).length;
					const totals = usage.total;
					bookStore.update(bookId, (now) => ({
						...now,
						mapWriter: { status: "writing", done: entry.done, total: updated.length, ...(totals ? { model: totals.model, usage: totals } : {}) },
					}));
					emit("activity-changed", {});
				},
			});
			if (signal.aborted) throw abortError();
			if (!current(entry)) return;
			const totals = usage.total;
			bookStore.update(bookId, (now) => ({
				...now,
				mapWriter: { status: "ready", done: entry.done, total: entry.total, ...(totals ? { model: totals.model, usage: totals } : {}) },
			}));
		} catch (error) {
			if (!current(entry)) return;
			const stopped = signal.aborted;
			const message = stopped ? STOPPED_MESSAGE : error instanceof Error ? error.message : String(error);
			if (!stopped && !(error instanceof BookMapperError)) console.error(`[books] the map writer of ${bookId} failed:`, error);
			try {
				bookStore.update(bookId, (now) => ({ ...now, mapWriter: { ...failedMap(now.mapWriter, message, stopped, usage.total), done: entry.done, total: entry.total } }));
			} catch (storeError) {
				console.error(`[books] could not record the map writer's outcome for ${bookId}:`, storeError);
			}
		} finally {
			release(entry);
		}
	})();
	return next;
}

/**
 * Start the optional contents pass over a book's candidate heading lines.
 * The caller has checked the book's state and resolved the engine. The
 * result becomes the `model` candidate (replacing an earlier one) for the
 * learner to review; nothing else changes.
 */
export function startBookContentsWriter(record: BookRecord, engine: PiEngine, input: { blocks: readonly BookBlock[]; digest: StructureDigest }): BookRecord | null {
	const { blocks, digest } = input;
	const entry = register(record, "contents");
	const usage = stepper(entry, undefined);
	let next: BookRecord | null;
	try {
		next = bookStore.update(record.id, (now) => ({ ...now, structureWriter: { status: "writing" } }));
	} catch (error) {
		release(entry);
		throw error;
	}
	const signal = entry.controller.signal;
	const settle = (state: BookWriterState) => {
		bookStore.update(record.id, (now) => ({ ...now, structureWriter: state }));
	};
	void (async () => {
		try {
			const headings = await bookMapServiceSeams.findStructure({
				bookId: record.id, bookTitle: record.title, ...(record.author ? { author: record.author } : {}),
				blocks, digest, engine, signal, onStep: usage.step,
			});
			if (signal.aborted) throw abortError();
			if (!current(entry)) return;
			const candidate = modelCandidate(blocks, headings);
			if (!candidate) throw new Error("The model's headings make no contents.");
			const stored = bookStore.readCandidates(record.id)?.candidates ?? [];
			bookStore.writeCandidates(record.id, { candidates: [...stored.filter((other) => other.method !== "model"), candidate] });
			const totals = usage.total;
			settle({ status: "ready", ...(totals ? { model: totals.model, usage: totals } : {}) });
		} catch (error) {
			if (!current(entry)) return;
			const stopped = signal.aborted;
			const message = stopped ? STOPPED_MESSAGE : error instanceof Error ? error.message : String(error);
			if (!stopped && !(error instanceof BookMapperError)) console.error(`[books] the contents pass of ${record.id} failed:`, error);
			const totals = usage.total;
			try {
				settle({ status: "failed", error: message, ...(stopped ? { stopped: true as const } : {}), ...(totals ? { model: totals.model, usage: totals } : {}) });
			} catch (storeError) {
				console.error(`[books] could not record the contents pass's outcome for ${record.id}:`, storeError);
			}
		} finally {
			release(entry);
		}
	})();
	return next;
}

/** Stop a running writer; it settles as stopped, keeping what it wrote. */
export function stopBookWriter(bookId: string, kind: BookWriterKind): boolean {
	const entry = running().get(key(bookId, kind));
	if (!entry) return false;
	entry.controller.abort();
	return true;
}

/** Abort a book's writers without letting them settle: the contents are
 *  being switched, or the book deleted. They never write again. */
export function discardBookWriters(bookId: string, kinds: readonly BookWriterKind[] = ["map", "contents"]): void {
	for (const kind of kinds) {
		const entry = running().get(key(bookId, kind));
		if (!entry) continue;
		running().delete(key(bookId, kind));
		entry.controller.abort();
	}
	emit("activity-changed", {});
}

/** A writer left "writing" by a closed app: none runs for it here. */
export function interruptedWriters(record: BookRecord): Partial<Pick<BookRecord, "mapWriter" | "structureWriter">> | null {
	const change: Partial<Pick<BookRecord, "mapWriter" | "structureWriter">> = {};
	if (record.mapWriter.status === "writing" && !isBookWriterRunning(record.id, "map")) {
		change.mapWriter = { ...record.mapWriter, status: "failed", error: BOOK_WRITER_INTERRUPTED };
	}
	if (record.structureWriter?.status === "writing" && !isBookWriterRunning(record.id, "contents")) {
		change.structureWriter = { ...record.structureWriter, status: "failed", error: BOOK_WRITER_INTERRUPTED };
	}
	return Object.keys(change).length > 0 ? change : null;
}

/** Running book writers for the activity feed. */
export interface BookWriterActivity {
	/** "<bookId>:map" or "<bookId>:contents", the abort id. */
	id: string;
	bookId: string;
	kind: BookWriterKind;
	title: string;
	createdAt: string;
	activity: string;
	usage?: JobUsage;
}

export function bookWriterActivities(): BookWriterActivity[] {
	return [...running().values()].map((entry) => ({
		id: key(entry.bookId, entry.kind),
		bookId: entry.bookId,
		kind: entry.kind,
		title: `${entry.kind === "map" ? "Book map" : "Book contents"} · ${entry.bookTitle}`,
		createdAt: entry.startedAt,
		activity: entry.kind === "map"
			? `${entry.done.toLocaleString("en-US")} of ${entry.total.toLocaleString("en-US")} sections`
			: "Finding the contents",
		...(entry.usage ? { usage: entry.usage } : {}),
	}));
}

/** The dock's Stop: id is "<bookId>:map" or "<bookId>:contents". */
export function abortBookWriterActivity(id: string): boolean {
	const separator = id.lastIndexOf(":");
	const kind = id.slice(separator + 1);
	if (separator < 1 || (kind !== "map" && kind !== "contents")) return false;
	return stopBookWriter(id.slice(0, separator), kind);
}
