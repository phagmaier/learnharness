"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, GraduationCapIcon } from "lucide-react";
import { draftProblems, parseCourseProposal, type ArtifactPartProps, type CourseDraft } from "@/src/core";
import { UnitListEditor, UnitListView } from "@/components/course-unit-editor";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The setup session's proposal card (fork plan 04): the latest successful
 * propose_course call is the learner's editable course; older calls render
 * read-only, marked "Replaced". Edits stay on this device until the course
 * is created. "Create course" posts the edited list and opens unit 1.
 */

/** What the card needs from its session; absent outside a setup session. */
export interface CourseSetupState {
	chatId: string;
	/** The latest successful propose_course call id. */
	latestCallId: string | null;
	/** Set once the course exists. */
	courseId: string | null;
	/** A turn is running in the setup session. */
	busy: boolean;
	/** Client-side navigation (the chat's router). */
	navigate: (href: string) => void;
}

export const CourseSetupContext = createContext<CourseSetupState | null>(null);

const draftKey = (chatId: string, toolCallId: string) => `lh:course-proposal:${chatId}:${toolCallId}`;

function readStoredDraft(key: string): CourseDraft | null {
	try {
		const raw = globalThis.localStorage?.getItem(key);
		return raw ? parseCourseProposal(JSON.parse(raw)) : null;
	} catch {
		return null;
	}
}

function storeDraft(key: string, draft: CourseDraft | null): void {
	try {
		if (draft) globalThis.localStorage?.setItem(key, JSON.stringify(draft));
		else globalThis.localStorage?.removeItem(key);
	} catch {
		// Storage is a convenience; the card keeps working without it.
	}
}

export function CourseProposalCard({ part }: ArtifactPartProps) {
	const setup = useContext(CourseSetupContext);
	const proposal = useMemo(() => parseCourseProposal(part.input), [part.input]);
	if (part.state === "output-error" || (part.output as { ok?: unknown } | undefined)?.ok === false) return null;
	if (!proposal) return null;
	const settled = part.state === "output-available";
	const replaced = !!setup && settled && setup.latestCallId !== part.toolCallId;
	const created = !!setup?.courseId;
	if (!setup || !settled || replaced || created) {
		return <ReadOnlyProposal proposal={proposal} badge={replaced ? "Replaced" : created ? "Course created" : null} collapsed={replaced} />;
	}
	return <EditableProposal key={part.toolCallId} proposal={proposal} toolCallId={part.toolCallId} setup={setup} />;
}

function Header({ badge }: { badge?: string | null }) {
	return (
		<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
			<GraduationCapIcon className="size-3.5 text-primary" />
			<span>Course proposal</span>
			{badge && <span data-testid="proposal-badge" className="ml-auto rounded-sm border px-1.5 py-0.5 text-[10px] font-normal tracking-wider">{badge}</span>}
		</div>
	);
}

export function ReadOnlyProposal({ proposal, badge, collapsed }: { proposal: CourseDraft; badge: string | null; collapsed: boolean }) {
	const body = (
		<div className="px-3 pb-3">
			<p className="font-title text-lg leading-snug">{proposal.title}</p>
			<p className="mb-1 text-sm text-muted-foreground">{proposal.goal}</p>
			<UnitListView units={proposal.units} />
		</div>
	);
	if (collapsed) {
		return (
			<details data-testid="course-proposal-card" data-state="replaced" className="group my-3 overflow-hidden rounded-xl border bg-card/60">
				<summary className="flex cursor-pointer list-none items-center gap-2 p-3 transition-colors hover:bg-accent/40 [&::-webkit-details-marker]:hidden">
					<ChevronRightIcon className="size-3 shrink-0 text-muted-foreground opacity-50 transition-transform group-open:rotate-90" />
					<div className="min-w-0 flex-1"><Header badge={badge} /></div>
				</summary>
				{body}
			</details>
		);
	}
	return (
		<div data-testid="course-proposal-card" data-state={badge ? "created" : "pending"} className="my-3 rounded-xl border bg-card/60">
			<div className="p-3"><Header badge={badge} /></div>
			{body}
		</div>
	);
}

function EditableProposal({ proposal, toolCallId, setup }: { proposal: CourseDraft; toolCallId: string; setup: CourseSetupState }) {
	const storageKey = draftKey(setup.chatId, toolCallId);
	const [draft, setDraft] = useState<CourseDraft>(proposal);
	const [restored, setRestored] = useState(false);
	const [creating, setCreating] = useState(false);
	const [serverError, setServerError] = useState<string | null>(null);
	const counter = useRef(0);
	// Restore this device's edits after mount, so the server render matches.
	useEffect(() => {
		const stored = readStoredDraft(storageKey);
		if (stored) setDraft(stored);
		setRestored(true);
	}, [storageKey]);
	const edit = (next: CourseDraft) => {
		setDraft(next);
		setServerError(null);
		storeDraft(storageKey, next);
	};
	const problems = draftProblems(draft);
	const edited = restored && JSON.stringify(draft) !== JSON.stringify(proposal);

	const create = async () => {
		if (creating || problems.length > 0 || setup.busy) return;
		setCreating(true);
		setServerError(null);
		try {
			const res = await fetch("/api/courses", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					setupChatId: setup.chatId,
					toolCallId,
					title: draft.title,
					goal: draft.goal,
					units: draft.units.map(({ key, title, goal, startingPoint, prerequisites }) => ({ key, title, goal, startingPoint, prerequisites })),
				}),
			});
			const body = await res.json().catch(() => ({})) as { courseId?: string; chatId?: string | null; error?: string };
			if (!res.ok || !body.courseId) {
				setServerError(body.error ?? "Couldn't create the course. Try again.");
				setCreating(false);
				return;
			}
			storeDraft(storageKey, null);
			setup.navigate(body.chatId ? `/chat/${body.chatId}` : `/course/${body.courseId}`);
		} catch {
			setServerError("Couldn't reach the app. Try again.");
			setCreating(false);
		}
	};

	return (
		<div data-testid="course-proposal-card" data-state="editable" className="my-3 rounded-xl border bg-card/60 p-3">
			<Header badge={edited ? "Edited" : null} />
			<div className="mt-2 space-y-1">
				<input
					aria-label="Course title"
					value={draft.title}
					onChange={(e) => edit({ ...draft, title: e.target.value })}
					className="lh-input w-full rounded-md border border-transparent bg-transparent px-2 py-0.5 font-title text-lg leading-snug outline-none transition-colors hover:border-border focus:border-ring"
				/>
				<textarea
					aria-label="Course goal"
					rows={1}
					value={draft.goal}
					onChange={(e) => edit({ ...draft, goal: e.target.value })}
					className="lh-input w-full resize-none rounded-md border border-transparent bg-transparent px-2 py-1 text-sm text-muted-foreground outline-none transition-colors field-sizing-content hover:border-border focus:border-ring"
				/>
			</div>
			<div className="mt-2">
				<UnitListEditor
					units={draft.units}
					onChange={(units) => edit({ ...draft, units })}
					newKey={() => `new-${Date.now().toString(36)}-${counter.current++}`}
					disabled={creating}
				/>
			</div>
			<div className="mt-3 flex flex-wrap items-end justify-end gap-3 border-t pt-3">
				{(problems.length > 0 || serverError) && (
					<ul role="alert" className="min-w-0 flex-1 space-y-0.5 text-xs text-destructive">
						{serverError && <li>{serverError}</li>}
						{problems.map((problem) => <li key={problem}>{problem}</li>)}
					</ul>
				)}
				<Button
					type="button"
					size="sm"
					onClick={() => void create()}
					disabled={creating || problems.length > 0 || setup.busy}
					className={cn(creating && "opacity-70")}
				>
					{creating ? "Creating…" : "Create course"}
				</Button>
			</div>
		</div>
	);
}
