"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { handoffCompletionLine, handoffSections, NO_HANDOFF_TOPICS, type CourseUnit, type HandoffSection, type UnitHandoff } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * A completed unit's handoff on the course overview (fork plan 04 item 6):
 * the same lists, in the same words, that later units' agents read
 * (handoffSections), plus the writer's state where the model-written
 * observations go: writing, or failed with "Try again".
 */

export const HANDOFF_WRITING = "Writing the teacher observations…";
export function handoffWriterFailure(error: string | undefined): string {
	return `Teacher observations couldn't be written: ${error ?? "unknown error"}`;
}

const DOT: Record<HandoffSection["key"], string> = {
	solid: "bg-success",
	shaky: "bg-warning",
	unchecked: "bg-muted-foreground/50",
	"not-reached": "bg-muted-foreground/30",
	observations: "bg-primary/70",
};

function capital(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The handoff's body (pure; exported for render tests). */
export function HandoffView({
	unit,
	handoff,
	retrying = false,
	retryError,
	onRetry,
}: {
	unit: Pick<CourseUnit, "completedAt">;
	handoff: UnitHandoff;
	retrying?: boolean;
	retryError?: string | null;
	onRetry?: () => void;
}) {
	const sections = handoffSections(handoff);
	const writer = handoff.writer;
	return (
		<div data-testid="unit-handoff" data-writer={writer.status} className="space-y-3">
			<p data-testid="handoff-completion" className="font-ui text-[11px] text-muted-foreground">{capital(handoffCompletionLine(unit, handoff))}</p>
			{handoff.topics.length === 0 && <p className="font-prose text-sm text-muted-foreground">{NO_HANDOFF_TOPICS}</p>}
			{sections.map((section) => (
				<section key={section.key} data-testid="handoff-section" data-section={section.key}>
					<h4 className="mb-1 flex items-center gap-1.5 font-ui text-[10px] uppercase tracking-wider text-muted-foreground">
						<span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT[section.key])} />
						{section.heading.replace(/:$/, "")}
					</h4>
					<ul className="space-y-0.5 pl-3 font-prose text-sm">
						{section.items.map((item, index) => (
							<li key={index} className="relative pl-3 before:absolute before:left-0 before:top-[0.6em] before:size-1 before:rounded-full before:bg-muted-foreground/60">{item}</li>
						))}
					</ul>
				</section>
			))}
			{writer.status === "writing" && (
				<p data-testid="handoff-writer-status" className="font-ui text-[11px] text-muted-foreground">{HANDOFF_WRITING}</p>
			)}
			{writer.status === "failed" && (
				<div data-testid="handoff-writer-status" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
					<p className="min-w-0 flex-1 font-ui text-[11px] text-muted-foreground">{handoffWriterFailure(writer.error)}</p>
					{onRetry && (
						<button
							type="button"
							data-testid="handoff-retry"
							disabled={retrying}
							onClick={onRetry}
							className="shrink-0 rounded-md border px-2.5 py-1 font-ui text-[11px] uppercase tracking-wider transition-colors hover:bg-accent disabled:opacity-50"
						>
							{retrying ? "Starting…" : "Try again"}
						</button>
					)}
				</div>
			)}
			{retryError && <p role="alert" className="text-xs text-destructive">{retryError}</p>}
		</div>
	);
}

/** The "Handoff" disclosure under a completed unit's card. */
export function HandoffDisclosure({
	unit,
	handoff,
	defaultOpen = false,
	retrying,
	retryError,
	onRetry,
}: {
	unit: Pick<CourseUnit, "id" | "completedAt">;
	handoff: UnitHandoff;
	defaultOpen?: boolean;
	retrying?: boolean;
	retryError?: string | null;
	onRetry?: () => void;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const panelId = `handoff-${unit.id}`;
	return (
		<div className="mt-3 border-t border-border/60 pt-2 sm:ml-8">
			<button
				type="button"
				data-testid="handoff-toggle"
				aria-expanded={open}
				aria-controls={panelId}
				onClick={() => setOpen((value) => !value)}
				className="-ml-1 flex items-center gap-1 rounded-md px-1 py-0.5 font-ui text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden className={cn("size-3 transition-transform", open && "rotate-90")} />
				Handoff
			</button>
			{open && (
				<div id={panelId} className="mt-2 pl-1">
					<HandoffView unit={unit} handoff={handoff} retrying={retrying} retryError={retryError} onRetry={onRetry} />
				</div>
			)}
		</div>
	);
}
