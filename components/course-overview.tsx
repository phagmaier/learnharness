"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PencilIcon } from "lucide-react";
import {
	courseDraftRows,
	courseProgressLine,
	draftProblems,
	prerequisiteWarning,
	proposalView,
	unitDraftsFromRows,
	type CourseRecord,
	type CourseUnit,
	type UnitDraftRow,
} from "@/src/core";
import { TopBar } from "@/components/top-bar";
import { UnitListEditor } from "@/components/course-unit-editor";
import { Button } from "@/components/ui/button";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { HostDialog } from "@/components/host-dialog";
import { HandoffDisclosure } from "@/components/course-handoff";
import { CourseChangesCard, decideProposal, type ProposalDecision } from "@/components/course-changes-card";
import { unitPracticeHref } from "@/components/session-list";
import { cn } from "@/lib/utils";

/**
 * The course overview (fork plan 04 item 3): the goal, pending course
 * changes (item 7: the teachers' proposals, with Accept and Reject), and
 * the unit list with each unit's status, prerequisites, goal, starting
 * point and actions. A completed unit adds "Practice this unit" (item 8),
 * "Reopen unit" and its handoff disclosure (item 6). "Edit units" turns the list into the setup card's
 * editor, where started units can't be removed. The title renames on
 * click. Open views refetch on courses-changed.
 */

export const UNIT_STATUS_LABEL: Record<CourseUnit["status"], string> = {
	"not-started": "Not started",
	"in-progress": "In progress",
	completed: "Completed",
};

const ACTION = "rounded-md border px-2.5 py-1 font-ui text-[11px] uppercase tracking-wider transition-colors hover:bg-accent disabled:opacity-50";

/** The Overview | Notes tabs. */
export function CourseTabs({ courseId, active }: { courseId: string; active: "overview" | "notes" }) {
	const tab = (id: "overview" | "notes", label: string, href: string) => (
		<Link
			href={href}
			data-testid={`course-tab-${id}`}
			aria-current={active === id ? "page" : undefined}
			className={cn(
				"rounded-sm px-2.5 py-0.5 text-[11px] uppercase tracking-wider transition-colors",
				active === id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
			)}
		>
			{label}
		</Link>
	);
	return (
		<nav className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5" aria-label="Course views">
			{tab("overview", "Overview", `/course/${encodeURIComponent(courseId)}`)}
			{tab("notes", "Notes", `/course/${encodeURIComponent(courseId)}/notes`)}
		</nav>
	);
}

/** One unit on the overview, with the actions its status allows. */
export function UnitCard({
	unit,
	courseId,
	number,
	numberOf,
	starting = false,
	onStart,
	reopening = false,
	onReopen,
	extra,
}: {
	unit: CourseUnit;
	/** For "Practice this unit" (item 8). */
	courseId: string;
	number: number;
	numberOf: ReadonlyMap<string, number>;
	starting?: boolean;
	onStart?: () => void;
	reopening?: boolean;
	/** "Reopen unit", for a completed unit (item 6). */
	onReopen?: () => void;
	/** Disclosures below the card (the handoff; later items' practice). */
	extra?: ReactNode;
}) {
	const buildsOn = unit.prerequisites.map((id) => numberOf.get(id)).filter((n): n is number => n !== undefined);
	return (
		<li
			id={`unit-${unit.id}`}
			data-testid="course-unit"
			data-status={unit.status}
			className="scroll-mt-4 rounded-xl border bg-card/60 p-4 target:ring-2 target:ring-ring/60"
		>
			<div className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 sm:flex sm:items-start sm:gap-3">
				<span className="w-5 shrink-0 pt-0.5 text-right font-ui text-sm text-muted-foreground">{number}</span>
				<div className="min-w-0 flex-1 wrap-anywhere">
					<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
						<h3 className="font-prose text-(length:--lh-prose-size) font-medium">{unit.title}</h3>
						<span data-testid="unit-status" className={cn(
							"font-ui text-[10px] uppercase tracking-wider",
							unit.status === "in-progress" ? "text-primary" : "text-muted-foreground",
						)}>{UNIT_STATUS_LABEL[unit.status]}</span>
						{buildsOn.length > 0 && <span className="font-ui text-[11px] text-muted-foreground">Builds on {buildsOn.join(", ")}</span>}
					</div>
					<p className="mt-0.5 font-prose text-sm">{unit.goal}</p>
					{unit.startingPoint && <p className="mt-0.5 font-prose text-sm text-muted-foreground">{unit.startingPoint}</p>}
				</div>
				<div className="col-start-2 flex shrink-0 flex-wrap gap-1.5 sm:justify-end">
					{unit.status === "not-started" && (
						<button type="button" data-testid="unit-start" className={ACTION} disabled={starting || !onStart} onClick={onStart}>
							{starting ? "Starting…" : "Start unit"}
						</button>
					)}
					{unit.status !== "not-started" && unit.chatId && (
						<Link href={`/chat/${encodeURIComponent(unit.chatId)}`} data-testid="unit-open" className={ACTION}>Open</Link>
					)}
					{unit.status === "completed" && unit.chatId && (
						<Link href={unitPracticeHref(courseId, unit.id)} data-testid="unit-practice" className={ACTION}>Practice this unit</Link>
					)}
					{unit.status === "completed" && onReopen && (
						<button type="button" data-testid="unit-reopen" className={ACTION} disabled={reopening} onClick={onReopen}>
							{reopening ? "Reopening…" : "Reopen unit"}
						</button>
					)}
				</div>
			</div>
			{extra}
		</li>
	);
}

/** The stateful page: live record, rename, start, and the editor. */
export function CourseOverview({ initialCourse }: { initialCourse: CourseRecord }) {
	const router = useRouter();
	const [course, setCourse] = useState(initialCourse);
	const [error, setError] = useState<string | null>(null);
	const [starting, setStarting] = useState<string | null>(null);
	const [renaming, setRenaming] = useState(false);
	const [titleDraft, setTitleDraft] = useState("");
	const [editRows, setEditRows] = useState<UnitDraftRow[] | null>(null);
	const editVersion = useRef<string | null>(null);
	const [editProblems, setEditProblems] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);
	const counter = useRef(0);
	const [reopening, setReopening] = useState<string | null>(null);
	const [retrying, setRetrying] = useState<string | null>(null);
	const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});
	// Proposals decided in this view stay, showing how they ended (an
	// accept can find a proposal outdated), until the page is left.
	const [decidedHere, setDecidedHere] = useState<ReadonlySet<string>>(() => new Set());
	const titleRef = useRef<HTMLInputElement>(null);
	const courseId = course.id;

	const refresh = useCallback(async () => {
		try {
			const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}`, { cache: "no-store" });
			const body = (await response.json().catch(() => ({}))) as { course?: CourseRecord; error?: string };
			if (body.course) setCourse(body.course);
			else if (!response.ok) setError(body.error ?? "Couldn't read the course.");
		} catch { /* offline: keep the last record */ }
	}, [courseId]);
	useServerEvent("courses-changed", (payload) => { if (payload.courseId === courseId) void refresh(); });
	useServerResync(() => void refresh());
	useEffect(() => { if (renaming) { titleRef.current?.focus(); titleRef.current?.select(); } }, [renaming]);

	const numberOf = useMemo(() => new Map(course.units.map((unit, index) => [unit.id, index + 1])), [course.units]);

	const commitRename = async () => {
		setRenaming(false);
		setError(null);
		const title = titleDraft.trim();
		if (!title || title === course.title) return;
		const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}`, {
			method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
		}).catch(() => null);
		const body = response ? ((await response.json().catch(() => ({}))) as { course?: CourseRecord; error?: string }) : null;
		if (body?.course) setCourse(body.course);
		else {
			setError(body?.error ?? "Couldn't reach the app. Try again.");
			setRenaming(true);
		}
	};

	// Starting a unit whose prerequisites aren't all completed asks first.
	const [confirming, setConfirming] = useState<{ unit: CourseUnit; warning: string } | null>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const requestStart = (unit: CourseUnit) => {
		const warning = prerequisiteWarning(course.units, unit.id);
		if (warning) setConfirming({ unit, warning });
		else void start(unit);
	};

	const start = async (unit: CourseUnit) => {
		setStarting(unit.id);
		setError(null);
		try {
			const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/units/${encodeURIComponent(unit.id)}/start`, { method: "POST" });
			const body = (await response.json().catch(() => ({}))) as { chatId?: string; error?: string };
			if (body.chatId) { router.push(`/chat/${encodeURIComponent(body.chatId)}`); return; }
			setError(body.error ?? "Couldn't start the unit.");
		} catch {
			setError("Couldn't reach the app. Try again.");
		}
		setStarting(null);
	};

	/** POST a unit action; the returned course replaces the local one. */
	const unitAction = async (unit: CourseUnit, action: "reopen" | "handoff"): Promise<string | null> => {
		try {
			const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/units/${encodeURIComponent(unit.id)}/${action}`, { method: "POST" });
			const body = (await response.json().catch(() => ({}))) as { course?: CourseRecord; error?: string };
			if (body.course) { setCourse(body.course); return null; }
			return body.error ?? "Something went wrong. Try again.";
		} catch {
			return "Couldn't reach the app. Try again.";
		}
	};

	const reopen = async (unit: CourseUnit) => {
		setReopening(unit.id);
		setError(null);
		const failure = await unitAction(unit, "reopen");
		if (failure) setError(failure);
		setReopening(null);
	};

	const retryHandoff = async (unit: CourseUnit) => {
		setRetrying(unit.id);
		setRetryErrors(({ [unit.id]: _old, ...rest }) => rest);
		const failure = await unitAction(unit, "handoff");
		if (failure) setRetryErrors((current) => ({ ...current, [unit.id]: failure }));
		setRetrying(null);
	};

	const save = async () => {
		if (!editRows) return;
		setSaving(true);
		setEditProblems([]);
		try {
			const units = unitDraftsFromRows(editRows, new Set(course.units.map((unit) => unit.id)));
			const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}`, {
				method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ units, expectedUpdatedAt: editVersion.current }),
			});
			const body = (await response.json().catch(() => ({}))) as { course?: CourseRecord; error?: string; problems?: string[] };
			if (body.course) { setCourse(body.course); setEditRows(null); }
			else {
				setEditProblems(body.problems ?? [body.error ?? "Couldn't save the changes."]);
				// The live event may have been missed. Keep the draft, but make
				// Cancel → Edit units reopen the latest saved course.
				if (response.status === 409) await refresh();
			}
		} catch {
			setEditProblems(["Couldn't reach the app. Try again."]);
		} finally {
			setSaving(false);
		}
	};

	const decide = async (proposalId: string, decision: ProposalDecision): Promise<string | null> => {
		const result = await decideProposal(courseId, proposalId, decision);
		if ("error" in result) return result.error;
		setDecidedHere((current) => new Set([...current, proposalId]));
		setCourse(result.course);
		return null;
	};
	const shownProposals = course.proposals.filter((proposal) => proposal.status === "pending" || decidedHere.has(proposal.id));

	const localProblems = editRows ? draftProblems({ title: course.title, goal: course.goal, units: editRows }) : [];

	return (
		<div className="flex h-dvh">
			<div className="flex min-w-0 flex-1 flex-col">
				<TopBar drag={!renaming}>
					<div className="flex min-w-0 flex-1 flex-col justify-center sm:flex-row sm:items-baseline sm:justify-start sm:gap-3">
					{renaming ? (
						<input
							ref={titleRef}
							aria-label="Rename course"
							value={titleDraft}
							onChange={(e) => setTitleDraft(e.target.value)}
							onBlur={() => void commitRename()}
							onKeyDown={(e) => {
								if (e.key === "Enter") e.currentTarget.blur();
								if (e.key === "Escape") { e.stopPropagation(); setRenaming(false); }
							}}
							className="lh-input min-w-0 flex-1 border-0 border-b border-border bg-transparent font-title text-3xl tracking-tight outline-none"
						/>
					) : (
						<button
							type="button"
							data-testid="course-title"
							title="Rename course"
							onClick={() => { setTitleDraft(course.title); setRenaming(true); }}
							className="min-w-0 shrink truncate text-left font-title text-3xl tracking-tight"
						>
							{course.title}
						</button>
					)}
					<span data-testid="course-progress" className="truncate font-ui text-[10px] uppercase tracking-wide text-muted-foreground sm:shrink-0 sm:text-xs">{courseProgressLine(course.units)}</span>
					</div>
					<CourseTabs courseId={courseId} active="overview" />
				</TopBar>
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="mx-auto w-full max-w-[46rem] px-4 py-8">
						{error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
						<section>
							<h2 className="mb-1 font-ui text-[11px] uppercase tracking-wider text-muted-foreground">Goal</h2>
							<p data-testid="course-goal" className="font-prose text-(length:--lh-prose-size)">{course.goal}</p>
						</section>
						{shownProposals.length > 0 && (
							<section className="mt-8" data-testid="course-pending-changes">
								<h2 className="mb-2 font-ui text-[11px] uppercase tracking-wider text-muted-foreground">Pending course changes</h2>
								<div className="space-y-2">
									{shownProposals.map((proposal) => (
										<CourseChangesCard key={proposal.id} proposal={proposalView(course, proposal)} onDecide={(decision) => decide(proposal.id, decision)} />
									))}
								</div>
							</section>
						)}
						<section className="mt-8">
							<div className="mb-2 flex items-center gap-2">
								<h2 className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">Units</h2>
								<div className="flex-1" />
								{!editRows && (
									<button type="button" data-testid="units-edit" className={cn(ACTION, "flex items-center gap-1.5")} onClick={() => { editVersion.current = course.updatedAt; setEditRows(courseDraftRows(course.units)); setEditProblems([]); }}>
										<PencilIcon className="size-3" aria-hidden />
										Edit units
									</button>
								)}
							</div>
							{editRows ? (
								<div data-testid="units-editor">
									<UnitListEditor units={editRows} onChange={setEditRows} newKey={() => `new-${Date.now().toString(36)}-${counter.current++}`} disabled={saving} />
									<div className="mt-3 flex flex-wrap items-end justify-end gap-3 border-t pt-3">
										{(localProblems.length > 0 || editProblems.length > 0) && (
											<ul role="alert" className="min-w-0 flex-1 space-y-0.5 text-xs text-destructive">
												{[...new Set([...editProblems, ...localProblems])].map((problem) => <li key={problem}>{problem}</li>)}
											</ul>
										)}
										<Button type="button" variant="ghost" size="sm" onClick={() => { setEditRows(null); setEditProblems([]); }} disabled={saving}>Cancel</Button>
										<Button type="button" size="sm" onClick={() => void save()} disabled={saving || localProblems.length > 0}>
											{saving ? "Saving…" : "Save changes"}
										</Button>
									</div>
								</div>
							) : (
								<ol className="space-y-2" data-testid="course-units">
									{course.units.map((unit, index) => (
										<UnitCard
											key={unit.id}
											unit={unit}
											courseId={courseId}
											number={index + 1}
											numberOf={numberOf}
											starting={starting === unit.id}
											onStart={() => requestStart(unit)}
											reopening={reopening === unit.id}
											onReopen={() => void reopen(unit)}
											extra={unit.status === "completed" && unit.handoff ? (
												<HandoffDisclosure
													unit={unit}
													handoff={unit.handoff}
													retrying={retrying === unit.id}
													retryError={retryErrors[unit.id] ?? null}
													onRetry={() => void retryHandoff(unit)}
												/>
											) : undefined}
										/>
									))}
								</ol>
							)}
						</section>
					</div>
				</div>
			</div>
			<HostDialog
				open={confirming !== null}
				onClose={() => { setConfirming(null); return "closed"; }}
				initialFocusRef={cancelRef}
				backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}
				frame={<div role="dialog" aria-modal="true" aria-label="Start unit" data-testid="unit-start-dialog" className="w-[26rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl" />}
			>
				{confirming && (
					<UnitStartWarning
						text={confirming.warning}
						cancelRef={cancelRef}
						onCancel={() => setConfirming(null)}
						onConfirm={() => { const unit = confirming.unit; setConfirming(null); void start(unit); }}
					/>
				)}
			</HostDialog>
		</div>
	);
}

/** The prerequisite warning before starting a unit whose prerequisites
 *  aren't all completed (the dialog's body). */
export function UnitStartWarning({ text, cancelRef, onCancel, onConfirm }: {
	text: string;
	cancelRef?: Ref<HTMLButtonElement>;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	return (
		<>
			<p data-testid="unit-start-warning" className="font-prose text-sm leading-relaxed text-foreground">{text}</p>
			<div className="mt-4 flex justify-end gap-2">
				<button type="button" ref={cancelRef} data-testid="unit-start-cancel" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
					Cancel
				</button>
				<button type="button" data-testid="unit-start-confirm" onClick={onConfirm} className="rounded-lg border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-accent">
					Start anyway
				</button>
			</div>
		</>
	);
}
