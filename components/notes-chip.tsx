"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { NotebookPenIcon } from "lucide-react";
import { useServerEvent, useServerResync } from "@/components/server-events";

/**
 * The session top bar's "Notes" chip (fork plan 03 item 4): opens the
 * session's notes page, at any phase, with the note count once notes exist.
 * A course unit's chip opens the course's Notes tab with the unit selected
 * instead (fork plan 04 item 8), passed as `href`.
 */
export function NotesChip({ chatId, count, href }: { chatId: string; count: number; href?: string }) {
	return (
		<Link
			href={href ?? `/chat/${encodeURIComponent(chatId)}/notes`}
			data-testid="notes-chip"
			aria-label={count > 0 ? `Notes (${count})` : "Notes"}
			className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground"
		>
			<NotebookPenIcon className="size-3.5 text-primary" aria-hidden />
			Notes
			{count > 0 && <span data-testid="notes-chip-count" className="tabular-nums">{count}</span>}
		</Link>
	);
}

/** The chip with its live count (refetched on notes-changed). */
export function SessionNotesChip({ chatId, href }: { chatId: string; href?: string }) {
	const [count, setCount] = useState(0);
	const refresh = useCallback(async () => {
		try {
			const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/notes`, { cache: "no-store" });
			if (!response.ok) return;
			const body = (await response.json()) as { notes?: unknown[] };
			setCount(body.notes?.length ?? 0);
		} catch { /* offline: keep the last count */ }
	}, [chatId]);
	useEffect(() => { void refresh(); }, [refresh]);
	useServerEvent("notes-changed", (payload) => {
		if (payload.chatId === chatId) void refresh();
	});
	useServerResync(() => void refresh());
	return <NotesChip chatId={chatId} count={count} href={href} />;
}
