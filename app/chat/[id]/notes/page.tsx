import { notFound, redirect } from "next/navigation";
import { NotesPage } from "@/components/notes-page";
import { getChat, isNotesUnreadable, listNotesWithCost } from "@/src/server";

export const dynamic = "force-dynamic";

/** A Teach session's notes (fork plan 03 item 4); Practice sessions have none. */
export default async function SessionNotesPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) notFound();
	if (chat.kind === "practice") redirect(`/chat/${encodeURIComponent(id)}`);
	let notes: ReturnType<typeof listNotesWithCost> = [];
	let error: string | null = null;
	try {
		notes = listNotesWithCost(id);
	} catch (err) {
		if (!isNotesUnreadable(err)) throw err;
		error = err.message;
	}
	return <NotesPage key={chat.id} chatId={chat.id} title={chat.title} initialNotes={notes} initialError={error} />;
}
