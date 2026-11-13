"use client";

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import {
	canMoveDraftUnit,
	moveDraftUnit,
	removeDraftUnit,
	togglePrerequisite,
	type UnitDraftRow,
} from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The unit-list editor (fork plan 04): the setup proposal card and the
 * course overview's "Edit units" share it. Each unit has its title, goal,
 * starting point, and the earlier units it builds on as checkboxes; units
 * move up or down (never past a unit they build on), are added, and are
 * removed unless they have started. The rules live in core
 * (src/core/course.ts); this is the presentation.
 */

// Rings, not borders: the app's unlayered `* { border-color }` rule wins
// over every border-color utility.
export const EDITOR_FIELD = "lh-input w-full resize-none rounded-md bg-transparent px-2 py-1 outline-none ring-1 ring-inset ring-border/50 transition-shadow hover:ring-border focus:ring-ring field-sizing-content";
const FIELD = EDITOR_FIELD;

export function UnitListEditor({
	units,
	onChange,
	newKey,
	disabled = false,
}: {
	units: UnitDraftRow[];
	onChange: (units: UnitDraftRow[]) => void;
	/** A fresh key for an added unit. */
	newKey: () => string;
	disabled?: boolean;
}) {
	const update = (index: number, change: Partial<UnitDraftRow>) =>
		onChange(units.map((row, i) => (i === index ? { ...row, ...change } : row)));
	return (
		<div>
			<ol className="space-y-2" data-testid="unit-editor">
				{units.map((row, index) => {
					const earlier = units.slice(0, index);
					return (
						<li key={row.key} data-testid="unit-editor-row" className="rounded-lg border bg-background/60 p-2">
							<div className="flex items-start gap-1.5">
								<span className="w-6 shrink-0 pt-1.5 text-right font-ui text-xs text-muted-foreground">{index + 1}</span>
								<div className="min-w-0 flex-1 space-y-1">
									<input
										aria-label={`Unit ${index + 1} title`}
										placeholder="Unit title"
										value={row.title}
										disabled={disabled}
										onChange={(e) => update(index, { title: e.target.value })}
										className={cn(FIELD, "font-medium")}
									/>
									<textarea
										aria-label={`Unit ${index + 1} goal`}
										placeholder="Goal"
										rows={1}
										value={row.goal}
										disabled={disabled}
										onChange={(e) => update(index, { goal: e.target.value })}
										className={cn(FIELD, "text-sm")}
									/>
									<label className="block">
										<span className="px-2 font-ui text-[10px] uppercase tracking-wider text-muted-foreground">Starting point</span>
										<textarea
											aria-label={`Unit ${index + 1} starting point`}
											rows={1}
											value={row.startingPoint}
											disabled={disabled}
											onChange={(e) => update(index, { startingPoint: e.target.value })}
											className={cn(FIELD, "text-sm text-muted-foreground")}
										/>
									</label>
									{earlier.length > 0 && (
										<fieldset className="px-2 pt-0.5">
											<legend className="mb-1 font-ui text-[10px] uppercase tracking-wider text-muted-foreground">Builds on</legend>
											<div className="flex flex-wrap gap-x-3 gap-y-1">
												{earlier.map((other, otherIndex) => (
													<label key={other.key} className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
														<input
															type="checkbox"
															checked={row.prerequisites.includes(other.key)}
															disabled={disabled}
															onChange={() => onChange(togglePrerequisite(units, index, other.key))}
															className="accent-primary"
														/>
														<span className="max-w-48 truncate">{otherIndex + 1}. {other.title || "Untitled"}</span>
													</label>
												))}
											</div>
										</fieldset>
									)}
								</div>
								<div className="flex shrink-0 flex-col gap-0.5">
									<IconButton label="Move unit up" disabled={disabled || !canMoveDraftUnit(units, index, -1)} onClick={() => onChange(moveDraftUnit(units, index, -1))}>
										<ArrowUpIcon />
									</IconButton>
									<IconButton label="Move unit down" disabled={disabled || !canMoveDraftUnit(units, index, 1)} onClick={() => onChange(moveDraftUnit(units, index, 1))}>
										<ArrowDownIcon />
									</IconButton>
									<IconButton label={row.locked ? "This unit has started and can't be removed" : "Remove unit"} disabled={disabled || row.locked === true || units.length <= 1} onClick={() => onChange(removeDraftUnit(units, index))}>
										<XIcon />
									</IconButton>
								</div>
							</div>
						</li>
					);
				})}
			</ol>
			<button
				type="button"
				disabled={disabled}
				onClick={() => onChange([...units, { key: newKey(), title: "", goal: "", startingPoint: "", prerequisites: [] }])}
				className="mt-2 flex items-center gap-1.5 rounded-md px-2 py-1 font-ui text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
			>
				<PlusIcon className="size-3" />
				Add unit
			</button>
		</div>
	);
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-3.5"
		>
			{children}
		</button>
	);
}

/** The same list, read-only: a replaced or already-created proposal. */
export function UnitListView({ units }: { units: readonly UnitDraftRow[] }) {
	const numberOf = new Map(units.map((row, index) => [row.key, index + 1]));
	return (
		<ol className="divide-y" data-testid="unit-list-view">
			{units.map((row, index) => {
				const buildsOn = row.prerequisites.map((key) => numberOf.get(key)).filter((n): n is number => n !== undefined);
				return (
					<li key={row.key} className="flex gap-2 py-2">
						<span className="w-6 shrink-0 text-right font-ui text-xs leading-6 text-muted-foreground">{index + 1}</span>
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-baseline gap-x-2">
								<span className="font-prose font-medium">{row.title}</span>
								{buildsOn.length > 0 && <span className="font-ui text-[11px] text-muted-foreground">Builds on {buildsOn.join(", ")}</span>}
							</div>
							<p className="font-prose text-sm">{row.goal}</p>
							{row.startingPoint && <p className="font-prose text-sm text-muted-foreground">{row.startingPoint}</p>}
						</div>
					</li>
				);
			})}
		</ol>
	);
}
