import { clearOpeningPrompt, OPENING_PROMPT_FAILURE, stashOpeningPrompt } from "./opening-prompt";

interface SessionCreation {
	title: string;
	kind?: "practice";
	/** Fork plan 04: a course setup session, or (item 8, with kind
	 *  "practice") a "Practice this unit" session linked to its unit. */
	course?: { role: "setup" } | { role: "practice"; courseId: string; unitId: string };
	graphContext?: { propositions: readonly { id: string; name: string; statement: string }[] };
	/** Fork plan 05: the library book a Teach session or course setup starts
	 *  with; a setup also carries how the course uses it. */
	book?: { bookId: string; mode?: "follow" | "reference" };
}

/** A start the server refused because of its book (fork plan 05): the
 *  message says why and what to do, in place of the generic retry notice,
 *  since sending again with the same book would fail again. */
export class SessionStartRefusal extends Error {}

/** Per source-composer instance. Retain a successful creation if storage
 * fails, so an unchanged retry does not create another empty session.
 * Changed text/context/settings is a different start, not a stale title.
 */
export class SessionStarter {
	private created?: { identity: string; id: string };

	async start(body: SessionCreation, fetchLike: typeof fetch, settingsIdentity?: string): Promise<string> {
		const identity = JSON.stringify([body, settingsIdentity]);
		if (this.created?.identity !== identity) {
			if (this.created) clearOpeningPrompt(this.created.id);
			this.created = undefined;
			const res = await fetchLike("/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const refusal = await res.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
				if (refusal?.code === "book-unavailable" && typeof refusal.error === "string") {
					throw new SessionStartRefusal(`${refusal.error} Choose another book, or clear it.`);
				}
				throw new Error(OPENING_PROMPT_FAILURE);
			}
			const result = await res.json() as { id?: unknown };
			if (typeof result.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(result.id)) throw new Error(OPENING_PROMPT_FAILURE);
			this.created = { identity, id: result.id };
		}
		if (!stashOpeningPrompt(this.created.id, body.title)) throw new Error(OPENING_PROMPT_FAILURE);
		return `/chat/${this.created.id}`;
	}
}

/** The start composer's opening question per mode (fork plan 04 adds the
 *  course placeholder). */
export function modePlaceholder(mode: "teach" | "practice" | "course"): string {
	if (mode === "practice") return "What do you want to practice?";
	if (mode === "course") return "What do you want to learn in this course?";
	return "What do you want to learn?";
}
