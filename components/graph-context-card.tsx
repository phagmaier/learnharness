"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { UnitPracticeDetails } from "@/src/core";

/**
 * The graph-context card (owner, 2026-10-04): the session's map pick —
 * message[0] of a session started with propositions picked from the
 * graph. Scaffolding, not a turn: minimal, muted, collapsed by default;
 * expand reveals the picked propositions (name — statement) and the
 * reasoning chains among them (premises → conclusion lines). The model
 * reads the same content through the marker's own text (toLlmMessages);
 * this card is the learner's face of it. A "Practice this unit" session's
 * card reads "Unit context" and shows the unit's goal, topics and shaky
 * items above its propositions (fork plan 04 item 8).
 */

/** The graph-context marker's details (native-messages.ts). A "Practice
 *  this unit" session's marker also carries its unit (fork plan 04 item 8). */
export interface GraphContextData {
	propositions: { id: string; name: string; statement: string }[];
	chains: string[];
	unit?: UnitPracticeDetails;
}

export function GraphContextCard({ data }: { data: GraphContextData }) {
	const [open, setOpen] = useState(false);
	const { propositions = [], chains = [], unit } = data ?? {};
	const noun = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	const counts = [
		...(unit ? [`Unit ${unit.number}: ${unit.unitTitle}`] : []),
		...(propositions.length > 0 || !unit ? [noun(propositions.length, "proposition", "propositions")] : []),
		...(chains.length > 0 ? [noun(chains.length, "chain", "chains")] : []),
	];
	return (
		<div data-testid="graph-context-card" className="my-1">
			<button
				type="button"
				data-testid="graph-context-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<span className="font-medium">{unit ? "Unit context" : "Graph context"}</span>
				<span className="min-w-0 flex-1 truncate">{counts.join(" · ")}</span>
			</button>
			{open && (
				<div data-testid="graph-context-body" className="mt-1 space-y-1 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
					{unit && (
						<div data-testid="graph-context-unit" className="space-y-1 pb-1 leading-relaxed text-muted-foreground">
							<div><span className="font-medium text-foreground/80">{unit.courseTitle}</span> — unit {unit.number}: {unit.unitTitle}</div>
							<div>Goal: {unit.goal}</div>
							<div>Topics: {unit.topics.length > 0 ? unit.topics.join("; ") : "none recorded"}</div>
							<div>{unit.shaky.length > 0 ? "Shaky:" : "Shaky: none recorded"}</div>
							{unit.shaky.map((item, i) => <div key={i} className="pl-3">– {item}</div>)}
						</div>
					)}
					{propositions.map((p) => (
						<div key={p.id} data-testid={`graph-context-prop-${p.id}`} className="leading-relaxed">
							<span className="font-medium text-foreground/80">{p.name}</span>
							<span className="text-muted-foreground"> — {p.statement}</span>
						</div>
					))}
					{chains.length > 0 && (
						<div className="pt-1">
							{chains.map((c, i) => (
								<div key={i} className="font-mono text-[11px] text-muted-foreground">
									{c}
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
