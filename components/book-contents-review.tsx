"use client";

import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { sameBookContents, type BookCandidate, type BookConfidence, type BookFormat, type BookNode, type BookStructureMethod } from "@/src/core";
import { HostDialog } from "@/components/host-dialog";
import { useServerResync } from "@/components/server-events";
import { prettyModel } from "@/components/usage-format";
import { contentsRows, methodChoiceLine, nodeLabel, nodeTitle, pagesText, runLabel, type BookPageBook } from "@/components/book-view";
import { cn } from "@/lib/utils";

/**
 * "Check the contents" (fork plan 05, decision 9). In review, the found
 * contents show under "We're not sure these contents are right." with the
 * reasons, and "Looks right" / "Not right". "Not right" lists the other
 * methods with what each found; each opens its contents to view, and "Use
 * these" accepts it. Last comes the optional model pass, which asks before
 * running and whose result joins the methods for the same review. A ready
 * book reaches the same alternatives from its "Not right" until a course
 * or session uses it.
 *
 * The found contents shown, and what "Looks right" accepts, are the book's
 * current map. A method is an alternative when its contents differ from the
 * map: a new model pass replaces the model candidate without changing its
 * method.
 */

const BUTTON = "rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent disabled:opacity-50";
const PRIMARY = "rounded-md border border-primary/50 bg-primary/10 px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-primary/20 disabled:opacity-50";

/** The contents as a tree: labels, titles and pages; numbered paragraphs
 *  folded into one line per run. */
export function ContentsTree({ nodes }: { nodes: readonly BookNode[] }) {
	const rows = contentsRows(nodes);
	return (
		<ol data-testid="contents-tree" className="space-y-0.5">
			{rows.map((row) => {
				const indent = { paddingLeft: `${row.depth * 1.25}rem` };
				if (row.kind === "run") {
					const pages = pagesText(row.nodes[0]!.pages && row.nodes.at(-1)!.pages ? { from: row.nodes[0]!.pages.from, to: row.nodes.at(-1)!.pages!.to } : undefined);
					return (
						<li key={row.key} data-testid="contents-run" style={indent} className="flex items-baseline gap-3 py-0.5">
							<span className="min-w-0 flex-1 font-ui text-[11px] text-muted-foreground">
								{runLabel(row.nodes)} · {row.nodes.length === 1 ? "1 numbered paragraph" : `${row.nodes.length.toLocaleString("en-US")} numbered paragraphs`}
							</span>
							{pages && <span className="shrink-0 font-ui text-[11px] text-muted-foreground">{pages}</span>}
						</li>
					);
				}
				const label = nodeLabel(row.node);
				const pages = pagesText(row.node.pages);
				return (
					<li key={row.node.id} data-testid="contents-node" style={indent} className="flex items-baseline gap-3 py-0.5">
						<span className="min-w-0 flex-1 font-prose text-sm">
							{label && <span className="mr-2 font-ui text-[11px] text-muted-foreground">{label}</span>}
							{nodeTitle(row.node)}
						</span>
						{pages && <span className="shrink-0 font-ui text-[11px] text-muted-foreground">{pages}</span>}
					</li>
				);
			})}
		</ol>
	);
}

export interface ContentsEstimate {
	tokens: number;
	model: { provider: string; id: string } | null;
}

/** "Find the contents with the model (about 6k tokens on cheap-model)" */
export function modelPassLabel(estimate: ContentsEstimate | null): string {
	if (!estimate?.model) return "Find the contents with the model";
	return `Find the contents with the model (about ${Math.max(1, Math.round(estimate.tokens / 1000))}k tokens on ${prettyModel(estimate.model.id)})`;
}

/** The review's pure body, exported for render tests. */
export function ContentsReviewBody({
	format,
	mode,
	current,
	currentNodes,
	confidence,
	candidates,
	loaded,
	loadError,
	choosing,
	selected,
	estimate,
	estimateError,
	modelPass,
	busy,
	error,
	onLooksRight,
	onNotRight,
	onSelect,
	onUse,
	onBack,
	onFindWithModel,
	onRetryLoad,
}: {
	format: BookFormat;
	/** review: the import awaits a decision. switch: a ready book's "Not right". */
	mode: "review" | "switch";
	current: BookStructureMethod | undefined;
	/** The contents in use (the map's nodes); null when there's no map. */
	currentNodes: readonly BookNode[] | null;
	confidence: BookConfidence | undefined;
	candidates: readonly BookCandidate[];
	/** The candidates have been read at least once. */
	loaded: boolean;
	/** Why the latest read of the candidates failed. */
	loadError: string | null;
	/** "Not right" was pressed: the other methods are listed. */
	choosing: boolean;
	selected: BookStructureMethod | null;
	estimate: ContentsEstimate | null;
	estimateError: string | null;
	modelPass: BookPageBook["structureWriter"];
	busy: boolean;
	error: string | null;
	onLooksRight: () => void;
	onNotRight: () => void;
	onSelect: (method: BookStructureMethod) => void;
	onUse: (method: BookStructureMethod) => void;
	onBack: () => void;
	onFindWithModel: () => void;
	onRetryLoad: () => void;
}) {
	// The server's rule for "Use these": the same method with the same
	// contents changes nothing; anything else is a switch.
	const inUse = (candidate: BookCandidate) => candidate.method === current && currentNodes !== null && sameBookContents(candidate.nodes, currentNodes);
	const others = candidates.filter((candidate) => !inUse(candidate));
	const choice = choosing ? others.find((candidate) => candidate.method === selected) : undefined;
	const viewing = choice ?? (!choosing && current && currentNodes ? { method: current, nodes: currentNodes } : undefined);
	const finding = modelPass?.status === "writing";
	return (
		<div data-testid="contents-review" className="space-y-5">
			{loadError && (
				<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
					<p role="alert" data-testid="contents-load-error" className="text-sm text-destructive">{loadError}</p>
					<button type="button" data-testid="contents-load-retry" className={BUTTON} onClick={onRetryLoad}>Try again</button>
				</div>
			)}
			{mode === "review" && (
				<section data-testid="contents-unsure" className="rounded-xl border border-primary/40 bg-primary/5 p-4">
					<h2 className="font-prose text-(length:--lh-prose-size) font-medium">We&apos;re not sure these contents are right.</h2>
					{confidence && confidence.reasons.length > 0 && (
						<ul data-testid="contents-reasons" className="mt-1.5 list-disc space-y-0.5 pl-5 font-prose text-sm text-muted-foreground">
							{confidence.reasons.map((reason) => <li key={reason}>{reason}</li>)}
						</ul>
					)}
					{!choosing && (
						<div className="mt-3 flex flex-wrap gap-2">
							<button type="button" data-testid="contents-looks-right" className={PRIMARY} disabled={busy || !currentNodes} onClick={onLooksRight}>Looks right</button>
							<button type="button" data-testid="contents-not-right" className={BUTTON} disabled={busy} onClick={onNotRight}>Not right</button>
						</div>
					)}
				</section>
			)}
			{choosing && (
				<section data-testid="contents-methods">
					<div className="mb-2 flex items-baseline gap-2">
						<h2 className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">Other ways to find the contents</h2>
						<div className="flex-1" />
						<button type="button" data-testid="contents-back" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" disabled={busy} onClick={onBack}>
							{mode === "review" ? "Back to the found contents" : "Cancel"}
						</button>
					</div>
					{loaded && others.length === 0 && <p className="font-prose text-sm text-muted-foreground">The import found no other contents.</p>}
					<div role="radiogroup" aria-label="Contents methods" className="space-y-1">
						{others.map((candidate) => (
							<button
								key={candidate.method}
								type="button"
								role="radio"
								aria-checked={selected === candidate.method}
								data-testid="contents-method"
								data-method={candidate.method}
								disabled={busy}
								onClick={() => onSelect(candidate.method)}
								className={cn(
									"flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left font-prose text-sm transition-colors hover:bg-accent",
									selected === candidate.method ? "border-primary/60 bg-primary/5" : "border-border/60",
								)}
							>
								<span aria-hidden className={cn("size-2.5 shrink-0 rounded-full border", selected === candidate.method ? "border-primary bg-primary" : "border-muted-foreground/60")} />
								{methodChoiceLine(format, candidate)}
							</button>
						))}
					</div>
					<div className="mt-3 rounded-lg border border-dashed border-border/80 px-3 py-2">
						{finding ? (
							<p role="status" data-testid="contents-finding" className="font-prose text-sm text-muted-foreground">Finding the contents… You can stop it in Background agents.</p>
						) : (
							<button type="button" data-testid="contents-find-with-model" className="text-left font-prose text-sm underline-offset-2 hover:underline disabled:opacity-50 disabled:no-underline" disabled={busy || !estimate?.model} onClick={onFindWithModel}>
								{modelPassLabel(estimate)}
							</button>
						)}
						{!finding && estimateError && <p className="mt-1 text-xs text-muted-foreground">{estimateError}</p>}
						{!finding && modelPass?.status === "failed" && modelPass.error && (
							<p role="alert" data-testid="contents-model-error" className="mt-1 text-xs text-destructive">The model pass ended: {modelPass.error}</p>
						)}
					</div>
				</section>
			)}
			{error && <p role="alert" data-testid="contents-error" className="text-sm text-destructive">{error}</p>}
			{viewing && (
				<section data-testid="contents-viewing" data-method={viewing.method}>
					{choice && (
						<div className="mb-3 flex items-center gap-2">
							<h3 className="min-w-0 flex-1 font-prose text-sm font-medium">{methodChoiceLine(format, choice)}</h3>
							<button type="button" data-testid="contents-use" className={PRIMARY} disabled={busy} onClick={() => onUse(choice.method)}>Use these</button>
						</div>
					)}
					<ContentsTree nodes={viewing.nodes} />
				</section>
			)}
		</div>
	);
}

/** The model pass's confirmation (it asks first, decision 9). */
export function ModelPassConfirm({ estimate, cancelRef, onCancel, onRun }: { estimate: ContentsEstimate; cancelRef?: Ref<HTMLButtonElement>; onCancel: () => void; onRun: () => void }) {
	const tokens = Math.max(1, Math.round(estimate.tokens / 1000));
	return (
		<>
			<h2 className="text-sm font-semibold">Find the contents with the model?</h2>
			<p data-testid="model-pass-line" className="mt-2 font-prose text-sm leading-relaxed text-muted-foreground">
				{prettyModel(estimate.model?.id ?? "")} reads about {tokens}k tokens of the book&apos;s likely heading lines, never the whole book. You check what it finds before anything changes.
			</p>
			<div className="mt-4 flex justify-end gap-2">
				<button type="button" ref={cancelRef} data-testid="model-pass-cancel" onClick={onCancel} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">Cancel</button>
				<button type="button" data-testid="model-pass-run" onClick={onRun} className="rounded-sm border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent">Find the contents</button>
			</div>
		</>
	);
}

/** The stateful review: candidates, the estimate, accepting and switching. */
export function ContentsReview({ book, currentNodes, mode, onDone, onCancel }: {
	book: BookPageBook;
	/** The book's current map's nodes; null when there's no map. */
	currentNodes: readonly BookNode[] | null;
	mode: "review" | "switch";
	/** The contents were accepted (the page refetches). */
	onDone: () => void;
	/** "Cancel" on a ready book's alternatives. */
	onCancel?: () => void;
}) {
	const [candidates, setCandidates] = useState<BookCandidate[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	// Bumped on reconnect: the server may have changed while the events were
	// missed, so the candidates and the estimate are read again.
	const [resyncs, setResyncs] = useState(0);
	useServerResync(() => setResyncs((n) => n + 1));
	const loadSeq = useRef(0);
	const [choosing, setChoosing] = useState(mode === "switch");
	const [selected, setSelected] = useState<BookStructureMethod | null>(null);
	const [estimate, setEstimate] = useState<ContentsEstimate | null>(null);
	const [estimateError, setEstimateError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const bookId = book.id;
	const pass = book.structureWriter?.status;

	const load = useCallback(async () => {
		// Only the latest read lands: an earlier one may answer last.
		const seq = ++loadSeq.current;
		try {
			const response = await fetch(`/api/books/${encodeURIComponent(bookId)}/contents`, { cache: "no-store" });
			const body = (await response.json().catch(() => ({}))) as { candidates?: BookCandidate[]; error?: string };
			if (seq !== loadSeq.current) return;
			if (body.candidates) { setCandidates(body.candidates); setLoaded(true); setLoadError(null); }
			else setLoadError(body.error ?? "Couldn't read the contents.");
		} catch {
			if (seq === loadSeq.current) setLoadError("Couldn't reach the app. Try again.");
		}
	}, [bookId]);
	// The candidates change when the model pass finishes; reload then.
	useEffect(() => { void load(); }, [load, pass, resyncs]);
	useEffect(() => { if (pass === "ready") setSelected("model"); }, [pass]);

	useEffect(() => {
		if (!choosing) return;
		let live = true;
		void (async () => {
			try {
				const response = await fetch(`/api/books/${encodeURIComponent(bookId)}/structure-writer`, { cache: "no-store" });
				const body = (await response.json().catch(() => ({}))) as { tokens?: number; model?: ContentsEstimate["model"]; error?: string };
				if (!live) return;
				if (typeof body.tokens === "number") {
					setEstimate({ tokens: body.tokens, model: body.model ?? null });
					setEstimateError(body.model ? null : "No model configured — set up your models first");
				} else setEstimateError(body.error ?? null);
			} catch { if (live) setEstimateError("Couldn't reach the app. Try again."); }
		})();
		return () => { live = false; };
	}, [bookId, choosing, resyncs]);

	const accept = async (method?: BookStructureMethod) => {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(`/api/books/${encodeURIComponent(bookId)}/contents`, {
				method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(method ? { method } : {}),
			});
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			if (response.ok) { onDone(); return; }
			setError(body.error ?? "Couldn't accept the contents.");
		} catch {
			setError("Couldn't reach the app. Try again.");
		} finally {
			setBusy(false);
		}
	};

	const runModelPass = async () => {
		setConfirming(false);
		setError(null);
		try {
			const response = await fetch(`/api/books/${encodeURIComponent(bookId)}/structure-writer`, { method: "POST" });
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			if (!response.ok) setError(body.error ?? "Couldn't start the model pass.");
		} catch {
			setError("Couldn't reach the app. Try again.");
		}
	};

	return (
		<>
			<ContentsReviewBody
				format={book.format}
				mode={mode}
				current={book.structure}
				currentNodes={currentNodes}
				confidence={book.confidence}
				candidates={candidates}
				loaded={loaded}
				loadError={loadError}
				choosing={choosing}
				selected={selected}
				estimate={estimate}
				estimateError={estimateError}
				modelPass={book.structureWriter}
				busy={busy}
				error={error}
				onLooksRight={() => void accept()}
				onNotRight={() => { setChoosing(true); setSelected(null); }}
				onSelect={setSelected}
				onUse={(method) => void accept(method)}
				onBack={() => { if (mode === "switch") onCancel?.(); else { setChoosing(false); setSelected(null); } }}
				onFindWithModel={() => setConfirming(true)}
				onRetryLoad={() => void load()}
			/>
			<HostDialog
				open={confirming && estimate !== null}
				onClose={() => { setConfirming(false); return "closed"; }}
				initialFocusRef={cancelRef}
				backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}
				frame={<div role="dialog" aria-modal="true" aria-label="Find the contents with the model" data-testid="model-pass-dialog" className="w-[28rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl" />}
			>
				{estimate && <ModelPassConfirm estimate={estimate} cancelRef={cancelRef} onCancel={() => setConfirming(false)} onRun={() => void runModelPass()} />}
			</HostDialog>
		</>
	);
}
