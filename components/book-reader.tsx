"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, SearchIcon, XIcon } from "lucide-react";
import type { BookBlock, BookNode, BookSearchHit, BookSearchResult } from "@/src/core";
import {
	blockEndPage,
	blockSegments,
	blockStartPage,
	contentsRows,
	marginLabels,
	nodeLabel,
	nodeTitle,
	runLabel,
} from "@/components/book-view";
import { cn } from "@/lib/utils";

/**
 * The book reader (fork plan 05, item 3; item 5 adds quotes and the side
 * panel): the contents on the left, each entry with its summary in muted
 * text once written, and the stored text on the right in windows loaded as
 * the learner scrolls, with section labels in the left margin and page
 * numbers in the right. A search box over the book replaces the contents
 * with its matches; opening one scrolls to it and marks the words. The
 * reader follows the app's theme in the notes typography (Source Sans 3
 * body, CMU Serif headings).
 */

interface TextWindow { from: number; to: number; total: number; blocks: BookBlock[] }
interface Highlight { block: number; start: number; end: number }

const HEADING_CLASS: Record<1 | 2 | 3, string> = {
	1: "mt-10 mb-3 text-2xl",
	2: "mt-8 mb-2 text-xl",
	3: "mt-6 mb-2 text-lg",
};

/** One block of the text, with its margin labels. */
export function ReaderBlock({ block, node, startPage, highlight }: {
	block: BookBlock;
	/** The section starting at this block, labeled in the left margin. */
	node?: BookNode | undefined;
	/** The page shown in the right margin at the block's first line. */
	startPage?: string | undefined;
	highlight?: { start: number; end: number } | undefined;
}) {
	const label = node && !block.text.startsWith(node.label) ? node.label : null;
	const segments = blockSegments(block, highlight);
	const content = segments.map((segment, i) => segment.kind === "page"
		? <span key={i} data-testid="reader-page-break" aria-label={`Page ${segment.page}`} className="absolute right-0 w-12 select-none font-ui text-[10px] text-muted-foreground">p. {segment.page}</span>
		: segment.mark
			? <mark key={i} data-testid="reader-mark" className="rounded-[2px] bg-primary/20 text-foreground">{segment.text}</mark>
			: <Fragment key={i}>{segment.text}</Fragment>);
	return (
		<div data-block={block.id} data-testid="reader-block" className="relative pl-20 pr-14">
			{label && <span data-testid="reader-label" className="absolute left-0 top-[0.35em] w-16 select-none truncate text-right font-ui text-[11px] text-muted-foreground" title={label}>{label}</span>}
			{startPage !== undefined && <span data-testid="reader-page" className="absolute right-0 top-[0.35em] w-12 select-none font-ui text-[10px] text-muted-foreground">p. {startPage}</span>}
			{block.kind === "heading"
				? <h2 className={cn("font-title leading-snug tracking-tight", HEADING_CLASS[block.level ?? 1])}>{content}</h2>
				: <p className="my-3 font-prose text-(length:--lh-prose-size) leading-relaxed">{content}</p>}
		</div>
	);
}

/** The text of a window, with page numbers where a page starts. */
export function ReaderText({ blocks, labels, highlight }: { blocks: readonly BookBlock[]; labels: ReadonlyMap<number, BookNode>; highlight: Highlight | null }) {
	return (
		<>
			{blocks.map((block, i) => {
				const start = blockStartPage(block);
				const previous = i > 0 ? blockEndPage(blocks[i - 1]!) : undefined;
				return (
					<ReaderBlock
						key={block.id}
						block={block}
						node={labels.get(block.id)}
						startPage={start !== undefined && start !== previous ? start : undefined}
						highlight={highlight?.block === block.id ? highlight : undefined}
					/>
				);
			})}
		</>
	);
}

/** The contents list: sections always shown, numbered paragraphs under a
 *  section folded into runs that open on click. Paragraphs outside any
 *  section (a book of numbered paragraphs only) are listed open. */
export function ReaderContents({ nodes, onOpen }: { nodes: readonly BookNode[]; onOpen: (node: BookNode) => void }) {
	const rows = useMemo(() => contentsRows(nodes), [nodes]);
	const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
	const entry = (node: BookNode, depth: number) => {
		const label = nodeLabel(node);
		return (
			<li key={node.id}>
				<button
					type="button"
					data-testid="reader-entry"
					data-node={node.id}
					onClick={() => onOpen(node)}
					style={{ paddingLeft: `${0.5 + depth * 0.875}rem` }}
					className="block w-full rounded-md py-1 pr-2 text-left transition-colors hover:bg-accent"
				>
					<span className="block font-prose text-sm leading-snug">
						{label && <span className="mr-1.5 font-ui text-[10px] text-muted-foreground">{label}</span>}
						{node.kind === "paragraph" ? node.label : nodeTitle(node)}
					</span>
					{node.summary && <span data-testid="reader-summary" className="mt-0.5 line-clamp-2 block font-prose text-xs leading-snug text-muted-foreground">{node.summary}</span>}
				</button>
			</li>
		);
	};
	return (
		<ol data-testid="reader-contents" className="space-y-px">
			{rows.map((row) => {
				if (row.kind === "node") return entry(row.node, row.depth);
				if (row.nodes[0]!.parentId === undefined) return row.nodes.map((node) => entry(node, row.depth));
				const expanded = open.has(row.key);
				return (
					<li key={row.key}>
						<button
							type="button"
							data-testid="reader-run"
							aria-expanded={expanded}
							onClick={() => setOpen((current) => {
								const next = new Set(current);
								if (next.has(row.key)) next.delete(row.key); else next.add(row.key);
								return next;
							})}
							style={{ paddingLeft: `${0.5 + row.depth * 0.875}rem` }}
							className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left font-ui text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")} aria-hidden />
							{runLabel(row.nodes)}
						</button>
						{expanded && <ol className="space-y-px">{row.nodes.map((node) => entry(node, row.depth + 1))}</ol>}
					</li>
				);
			})}
		</ol>
	);
}

/** The matches of a search, replacing the contents while it's active. */
export function ReaderSearchResults({ result, onOpen }: { result: BookSearchResult; onOpen: (hit: BookSearchHit) => void }) {
	return (
		<div data-testid="reader-results">
			<p data-testid="reader-results-count" className="px-2 pb-2 font-ui text-[11px] text-muted-foreground">
				{result.total === 0 ? "No matches" : result.total === 1 ? "1 match" : `${result.total.toLocaleString("en-US")} matches`}
				{result.total > result.hits.length && ` · showing the first ${result.hits.length}`}
			</p>
			<ol className="space-y-px">
				{result.hits.map((hit, i) => (
					<li key={`${hit.block}:${hit.start}:${i}`}>
						<button type="button" data-testid="reader-hit" onClick={() => onOpen(hit)} className="block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent">
							<span className="block font-ui text-[10px] text-muted-foreground">{[hit.label, hit.page !== undefined ? `p. ${hit.page}` : null].filter(Boolean).join(" · ")}</span>
							<span className="block font-prose text-xs leading-snug">
								{hit.before}<mark className="rounded-[2px] bg-primary/20 text-foreground">{hit.match}</mark>{hit.after}
							</span>
						</button>
					</li>
				))}
			</ol>
		</div>
	);
}

async function fetchJson<T>(url: string): Promise<{ ok: true; body: T } | { ok: false; error: string }> {
	try {
		const response = await fetch(url, { cache: "no-store" });
		const body = (await response.json().catch(() => ({}))) as T & { error?: string };
		return response.ok ? { ok: true, body } : { ok: false, error: body.error ?? "Couldn't read the book." };
	} catch {
		return { ok: false, error: "Couldn't reach the app. Try again." };
	}
}

/** The stateful reader for one book. */
export function BookReader({ bookId, nodes }: { bookId: string; nodes: readonly BookNode[] }) {
	const [win, setWin] = useState<TextWindow | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [highlight, setHighlight] = useState<Highlight | null>(null);
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<BookSearchResult | null>(null);
	const [searchError, setSearchError] = useState<string | null>(null);
	const [contentsOpen, setContentsOpen] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);
	const topRef = useRef<HTMLDivElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	const winRef = useRef<TextWindow | null>(null);
	// The latest jump: a jump's window lands only if no later jump happened.
	const jumpRef = useRef(0);
	// A jump's window is loading: the ends of the old one don't grow meanwhile.
	const replacingRef = useRef(false);
	// The window an end is loading for (one end at a time per window).
	const extendingRef = useRef<TextWindow | null>(null);
	const anchorRef = useRef<{ height: number; top: number } | null>(null);
	const targetRef = useRef<number | null>(null);
	const labels = useMemo(() => marginLabels(nodes), [nodes]);
	const base = `/api/books/${encodeURIComponent(bookId)}`;
	winRef.current = win;

	/** Open a new window: the start, or a jump outside the loaded text. A
	 *  slow answer to an earlier jump never replaces a later one's window. */
	const replace = useCallback(async (query: string, target?: number) => {
		const jump = ++jumpRef.current;
		replacingRef.current = true;
		const result = await fetchJson<TextWindow>(`${base}/text${query}`);
		if (jump !== jumpRef.current) return;
		replacingRef.current = false;
		if (!result.ok) { setError(result.error); return; }
		setError(null);
		targetRef.current = target ?? null;
		setWin(result.body);
	}, [base]);

	/** Load more text at one end of the current window. */
	const extend = useCallback(async (place: "append" | "prepend") => {
		const current = winRef.current;
		if (!current || replacingRef.current || extendingRef.current === current) return;
		extendingRef.current = current;
		const result = await fetchJson<TextWindow>(`${base}/text${place === "append" ? `?from=${current.to + 1}` : `?before=${current.from}`}`);
		if (extendingRef.current === current) extendingRef.current = null;
		// A jump (or a jump within it) moved on from this window meanwhile.
		if (winRef.current !== current) return;
		if (!result.ok) { setError(result.error); return; }
		setError(null);
		const next = result.body;
		if (next.blocks.length === 0) return;
		if (place === "append" && next.from === current.to + 1) setWin({ ...current, to: next.to, total: next.total, blocks: [...current.blocks, ...next.blocks] });
		if (place === "prepend" && next.to === current.from - 1) {
			const scroller = scrollRef.current;
			if (scroller) anchorRef.current = { height: scroller.scrollHeight, top: scroller.scrollTop };
			setWin({ ...current, from: next.from, total: next.total, blocks: [...next.blocks, ...current.blocks] });
		}
	}, [base]);

	useEffect(() => { void replace(""); }, [replace]);

	// Prepending keeps the reading position; a jump scrolls to its target.
	useLayoutEffect(() => {
		const scroller = scrollRef.current;
		if (!scroller || !win) return;
		// A pending jump wins over a prepend's anchor: it decides where to be.
		const anchor = anchorRef.current;
		anchorRef.current = null;
		const target = targetRef.current;
		if (target === null) {
			if (anchor) scroller.scrollTop = anchor.top + (scroller.scrollHeight - anchor.height);
			return;
		}
		targetRef.current = null;
		const element = scroller.querySelector<HTMLElement>(`[data-block="${target}"]`);
		if (!element) return;
		// A marked match sits a third of the way down; a section starts at the top.
		const mark = element.querySelector<HTMLElement>("mark");
		const top = scroller.getBoundingClientRect().top;
		scroller.scrollTop += mark
			? mark.getBoundingClientRect().top - top - scroller.clientHeight / 3
			: element.getBoundingClientRect().top - top - 24;
	}, [win]);

	// More text loads as either end comes near. Observing again on every new
	// window (also a jump within it) retries an end whose load it dropped.
	useEffect(() => {
		const scroller = scrollRef.current;
		if (!scroller || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver((entries) => {
			const current = winRef.current;
			if (!current) return;
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				if (entry.target === bottomRef.current && current.to < current.total - 1) void extend("append");
				if (entry.target === topRef.current && current.from > 0) void extend("prepend");
			}
		}, { root: scroller, rootMargin: "800px 0px" });
		if (topRef.current) observer.observe(topRef.current);
		if (bottomRef.current) observer.observe(bottomRef.current);
		return () => observer.disconnect();
	}, [extend, win]);

	const jump = (block: number, query: string, mark: Highlight | null) => {
		setHighlight(mark);
		setContentsOpen(false);
		const current = winRef.current;
		if (current && block >= current.from && block <= current.to) {
			// This jump is the latest: a window still loading for an earlier one is dropped.
			jumpRef.current++;
			replacingRef.current = false;
			targetRef.current = block;
			setWin({ ...current });
			return;
		}
		void replace(query, block);
	};
	const openNode = (node: BookNode) => jump(node.firstBlock, `?around=${encodeURIComponent(node.id)}`, null);
	const openHit = (hit: BookSearchHit) => jump(hit.block, `?at=${hit.block}`, { block: hit.block, start: hit.start, end: hit.end });

	// Search as the learner types, after a pause.
	useEffect(() => {
		const q = query.trim();
		if (!q) { setResults(null); setSearchError(null); return; }
		let live = true;
		const timer = setTimeout(() => {
			void fetchJson<BookSearchResult>(`${base}/search?q=${encodeURIComponent(q)}`).then((result) => {
				if (!live) return;
				if (result.ok) { setResults(result.body); setSearchError(null); }
				else setSearchError(result.error);
			});
		}, 300);
		return () => { live = false; clearTimeout(timer); };
	}, [base, query]);

	const side = (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center justify-between px-3 pt-2 md:hidden">
				<span className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">Contents</span>
				<button type="button" aria-label="Close the contents" data-testid="reader-contents-close" onClick={() => setContentsOpen(false)} className="rounded-sm p-1 text-muted-foreground hover:text-foreground">
					<XIcon className="size-4" aria-hidden />
				</button>
			</div>
			<div className="relative px-3 pb-2 pt-3">
				<SearchIcon className="pointer-events-none absolute left-5 top-1/2 mt-0.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
				<input
					type="search"
					data-testid="reader-search"
					aria-label="Search the book"
					placeholder="Search the book"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }}
					className="lh-input w-full rounded-md border border-border/70 bg-background py-1.5 pl-8 pr-7 text-sm outline-none focus:border-ring [&::-webkit-search-cancel-button]:hidden"
				/>
				{query && (
					<button type="button" aria-label="Clear the search" data-testid="reader-search-clear" onClick={() => setQuery("")} className="absolute right-4 top-1/2 mt-0.5 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground">
						<XIcon className="size-3.5" aria-hidden />
					</button>
				)}
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-1 pb-6">
				{searchError && <p role="alert" className="px-2 text-xs text-destructive">{searchError}</p>}
				{results ? <ReaderSearchResults result={results} onOpen={openHit} /> : <ReaderContents nodes={nodes} onOpen={openNode} />}
			</div>
		</div>
	);

	return (
		<div className="flex min-h-0 flex-1">
			<aside className={cn("w-72 shrink-0 flex-col border-r border-border/60 md:flex", contentsOpen ? "flex w-full md:w-72" : "hidden")} data-testid="reader-side">
				{side}
			</aside>
			<div className={cn("min-w-0 flex-1 flex-col", contentsOpen ? "hidden md:flex" : "flex")}>
				<div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 md:hidden">
					<button type="button" data-testid="reader-contents-toggle" onClick={() => setContentsOpen(true)} className="rounded-md border px-2.5 py-1 font-ui text-[11px] uppercase tracking-wider transition-colors hover:bg-accent">Contents</button>
				</div>
				<div ref={scrollRef} data-testid="reader-text" className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
					<div className="mx-auto w-full max-w-[52rem] px-4 py-8">
						{error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
						<div ref={topRef} aria-hidden className="h-px" />
						{win && win.from > 0 && <p className="pl-20 font-ui text-[11px] text-muted-foreground">…</p>}
						{win && <ReaderText blocks={win.blocks} labels={labels} highlight={highlight} />}
						{win && win.to < win.total - 1 && <p className="pl-20 font-ui text-[11px] text-muted-foreground">…</p>}
						<div ref={bottomRef} aria-hidden className="h-px" />
					</div>
				</div>
			</div>
		</div>
	);
}
