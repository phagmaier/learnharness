"use client";

import { createContext, useContext, useState } from "react";
import { GraduationCapIcon } from "lucide-react";
import { courseChangeLine, courseChangesFromFields, type ArtifactPartProps, type CourseChangeFields, type CourseRecord, type ProposalView } from "@/src/core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A unit teacher's proposed course changes (fork plan 04 item 7): the
 * reason, one line per change, and Accept / Reject while pending. A decided
 * card shows "Accepted", "Rejected" or "Outdated" (with the reason it no
 * longer applies). The same card renders in the unit's chat, at the
 * propose_course_changes call, and in the overview's "Pending course
 * changes".
 */

export type ProposalDecision = "accept" | "reject";

/** The learner's decision; the course after it, or the error to show. */
export async function decideProposal(courseId: string, proposalId: string, decision: ProposalDecision): Promise<{ course: CourseRecord } | { error: string }> {
	try {
		const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/proposals/${encodeURIComponent(proposalId)}`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }),
		});
		const body = (await response.json().catch(() => ({}))) as { course?: CourseRecord; error?: string };
		return body.course ? { course: body.course } : { error: body.error ?? "Something went wrong. Try again." };
	} catch {
		return { error: "Couldn't reach the app. Try again." };
	}
}

const DECIDED_LABEL: Record<Exclude<ProposalView["status"], "pending">, string> = {
	accepted: "Accepted",
	rejected: "Rejected",
	outdated: "Outdated",
};

/** The card itself. Without `onDecide` a pending card has no buttons (a
 *  read-only copy). `onDecide` answers null on success, else the error. */
export function CourseChangesCard({ proposal, onDecide, className }: {
	proposal: Pick<ProposalView, "status" | "reason" | "lines" | "outdatedReason">;
	onDecide?: (decision: ProposalDecision) => Promise<string | null>;
	className?: string;
}) {
	const [deciding, setDeciding] = useState<ProposalDecision | null>(null);
	const [error, setError] = useState<string | null>(null);
	const pending = proposal.status === "pending";
	const decidedLabel = proposal.status === "pending" ? null : DECIDED_LABEL[proposal.status];
	const decide = async (decision: ProposalDecision) => {
		if (!onDecide || deciding) return;
		setDeciding(decision);
		setError(null);
		const failure = await onDecide(decision);
		setDeciding(null);
		if (failure) setError(failure);
	};
	return (
		<div data-testid="course-changes-card" data-status={proposal.status} className={cn("rounded-xl border bg-card/60 p-3", className)}>
			<div className="flex items-center gap-2 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<GraduationCapIcon className="size-3.5 text-primary" aria-hidden />
				<span>Proposed course changes</span>
				{decidedLabel && (
					<span data-testid="course-changes-status" className="ml-auto rounded-sm border px-1.5 py-0.5 text-[10px] font-normal tracking-wider">
						{decidedLabel}
					</span>
				)}
			</div>
			<p data-testid="course-changes-reason" className="mt-2 font-prose text-sm">{proposal.reason}</p>
			{proposal.lines.length > 0 && (
				<ul data-testid="course-changes-lines" className={cn("mt-2 space-y-0.5 font-prose text-sm", !pending && "text-muted-foreground")}>
					{proposal.lines.map((line, index) => (
						<li key={index} className="relative pl-3 before:absolute before:left-0 before:top-[0.6em] before:size-1 before:rounded-full before:bg-muted-foreground/60">{line}</li>
					))}
				</ul>
			)}
			{proposal.status === "outdated" && proposal.outdatedReason && (
				<p data-testid="course-changes-outdated" className="mt-2 font-prose text-sm text-muted-foreground">{proposal.outdatedReason}</p>
			)}
			{pending && onDecide && (
				<div className="mt-3 flex flex-wrap items-end justify-end gap-3 border-t pt-3">
					{error && <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">{error}</p>}
					<Button type="button" variant="ghost" size="sm" data-testid="course-changes-reject" disabled={deciding !== null} onClick={() => void decide("reject")}>
						{deciding === "reject" ? "Rejecting…" : "Reject"}
					</Button>
					<Button type="button" size="sm" data-testid="course-changes-accept" disabled={deciding !== null} onClick={() => void decide("accept")}>
						{deciding === "accept" ? "Accepting…" : "Accept"}
					</Button>
				</div>
			)}
		</div>
	);
}

/** What the chat's card needs from its unit session; absent elsewhere. */
export interface CourseProposalsState {
	proposals: ProposalView[];
	decide: (proposalId: string, decision: ProposalDecision) => Promise<string | null>;
}

export const CourseProposalsContext = createContext<CourseProposalsState | null>(null);

/** The call's own input, read-only, for a session no longer in its course
 *  (no unit numbers to show, so ids stand in). */
function inputProposal(input: unknown): Pick<ProposalView, "status" | "reason" | "lines"> | null {
	if (!input || typeof input !== "object") return null;
	const { reason, changes } = input as { reason?: unknown; changes?: unknown };
	if (typeof reason !== "string" || !Array.isArray(changes) || !changes.every((change) => change && typeof change === "object" && typeof (change as { type?: unknown }).type === "string")) return null;
	const parsed = courseChangesFromFields(changes as CourseChangeFields[]);
	return { status: "pending", reason, lines: "changes" in parsed ? parsed.changes.map((change) => courseChangeLine(change, [])) : [] };
}

/** The propose_course_changes call in a unit's chat: its stored proposal,
 *  live from the course. A refused or running call renders nothing. */
export function ProposeCourseChangesCard({ part }: ArtifactPartProps) {
	const state = useContext(CourseProposalsContext);
	const output = part.output as { ok?: unknown; proposalId?: unknown } | undefined;
	if (part.state !== "output-available" || output?.ok !== true) return null;
	const proposal = state?.proposals.find((candidate) => candidate.id === output.proposalId);
	if (proposal && state) {
		return <CourseChangesCard className="my-3" proposal={proposal} onDecide={(decision) => state.decide(proposal.id, decision)} />;
	}
	const fallback = inputProposal(part.input);
	return fallback ? <CourseChangesCard className="my-3" proposal={fallback} /> : null;
}
