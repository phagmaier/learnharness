import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DeleteCourseDialog } from "../components/delete-course-dialog.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import type { CourseSummary } from "../src/core/contracts/course.ts";
import { installModalDom } from "./modal-dom.ts";

let root: Root | undefined;
let restore: (() => void) | undefined;
const originalFetch = globalThis.fetch;
const course = (id: string): CourseSummary => ({
	id, title: `Course ${id}`, createdAt: "2026-11-14T09:00:00.000Z", updatedAt: "2026-11-14T09:00:00.000Z",
	setupChatId: `${id}-setup`, completedCount: 0,
	units: [{ id: "vectors", title: "Vectors", status: "in-progress", chatId: `${id}-vectors` }],
});
const byTest = <T extends HTMLElement = HTMLElement>(id: string) => {
	const element = document.querySelector<T>(`[data-testid="${id}"]`);
	assert(element, `missing ${id}`);
	return element;
};
const disabled = (id: string) => byTest<HTMLButtonElement>(id).disabled;
const notes = (count: number) => ({ units: [{ unitId: "vectors", number: 1, title: "Vectors", chatId: "vectors-chat", notes: Array.from({ length: count }, (_, id) => ({ id: `note-${id}` })) }] });

function fixture() {
	const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	const globals = { React, window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModal = installModalDom(dom);
	restore = () => {
		restoreModal();
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	const requests: Array<{ url: string; method: string; resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
	globalThis.fetch = (input, init) => {
		const { promise, resolve, reject } = Promise.withResolvers<Response>();
		requests.push({ url: String(input), method: init?.method ?? "GET", resolve, reject });
		return promise;
	};
	const request = (index: number) => {
		const value = requests[index];
		assert(value, `missing request ${index}`);
		return value;
	};
	let changeCourse!: React.Dispatch<React.SetStateAction<CourseSummary | null>>;
	let closed = 0;
	const deleted: string[] = [];
	function Harness() {
		const [selected, setSelected] = useState<CourseSummary | null>(course("first"));
		changeCourse = setSelected;
		return <DeleteCourseDialog course={selected} onClose={() => { closed++; setSelected(null); }} onDeleted={id => { deleted.push(id); setSelected(null); }} />;
	}
	root = createRoot(document.querySelector("#root")!);
	return {
		requests, request, deleted,
		closed: () => closed,
		async mount() { await act(async () => root!.render(<InteractionLayersProvider><Harness /></InteractionLayersProvider>)); },
		async select(id: string) { await act(async () => changeCourse(course(id))); },
		async click(id: string) { await act(async () => byTest(id).click()); },
		async respond(index: number, body: unknown, status = 200) { await act(async () => request(index).resolve(Response.json(body, { status }))); },
		async reject(index: number) { await act(async () => request(index).reject(new Error("fixture offline"))); },
	};
}

afterEach(async () => {
	await act(async () => root?.unmount()); root = undefined;
	await delay(5);
	restore?.(); restore = undefined; globalThis.fetch = originalFetch;
});

it("blocks deletion until every unit's notes can be read, then retries deletion refusals without reloading notes", async () => {
	const f = fixture(); await f.mount();
	assert.match(byTest("delete-course-dialog").textContent!, /Reading notes…/);
	assert.equal(disabled("delete-confirm"), true);
	assert.equal(disabled("delete-cancel"), false);
	await f.click("delete-confirm");
	assert.equal(f.requests.length, 1, "a pending notes read must not start deletion");

	await f.respond(0, { units: [
		...notes(1).units,
		{ unitId: "eigenvectors", number: 2, title: "Eigenvectors", chatId: "eigenvectors-chat", notes: [], error: "Notes index was written by a newer version." },
	] });
	assert.match(byTest("delete-course-dialog").textContent!, /Unit 2 \(Eigenvectors\): Notes index was written by a newer version\./);
	assert.equal(disabled("delete-confirm"), true);
	assert.equal(disabled("delete-cancel"), false);
	assert.equal(document.querySelector('[data-testid="delete-download-notes"]'), null);
	await f.click("delete-confirm");
	assert.equal(f.requests.length, 1, "an unreadable unit must not be treated as zero notes");

	await f.click("delete-notes-retry");
	assert.equal(f.request(1).method, "GET");
	assert.equal(f.request(1).url, "/api/courses/first/notes");
	assert.match(byTest("delete-course-dialog").textContent!, /Reading notes…/);
	assert.equal(disabled("delete-confirm"), true);
	await f.respond(1, notes(2));
	assert.equal(disabled("delete-confirm"), false);
	assert.match(byTest("delete-course-line").textContent!, /their 2 notes\./);
	assert.equal(byTest("delete-download-notes").getAttribute("href"), "/api/courses/first/notes/archive.zip");

	await f.click("delete-confirm");
	assert.equal(f.request(2).method, "DELETE");
	await f.respond(2, { error: "Vectors is still running." }, 409);
	assert.match(byTest("delete-failure").textContent!, /Vectors is still running\./);
	await f.click("delete-retry");
	assert.equal(f.request(3).method, "DELETE", "the deletion refusal retry must not retry the successful notes read");
	await f.respond(3, { chatIds: ["first-setup", "first-vectors"], graphRevision: 1 });
	assert.deepEqual(f.deleted, ["first"]);
});

for (const failure of ["network", "request"] as const) {
	it(`keeps Delete blocked after a ${failure} failure and still allows Cancel`, async () => {
		const f = fixture(); await f.mount();
		if (failure === "network") await f.reject(0);
		else await f.respond(0, { error: "Course notes are unreadable." }, 500);
		assert.match(byTest("delete-course-dialog").textContent!, failure === "network" ? /network error/i : /Course notes are unreadable\./);
		assert.equal(disabled("delete-confirm"), true);
		assert.equal(disabled("delete-notes-retry"), false);
		assert.equal(disabled("delete-cancel"), false);
		await f.click("delete-confirm");
		assert.equal(f.requests.length, 1);
		assert.deepEqual(f.deleted, []);
		await f.click("delete-cancel");
		assert.equal(f.closed(), 1);
		assert.equal(document.querySelector('[data-testid="delete-course-dialog"]'), null);
	});
}

it("resets note status on course changes and close, ignoring responses from older openings", async () => {
	const f = fixture(); await f.mount();
	await f.select("second");
	await f.respond(0, notes(7));
	assert.equal(byTest("course-name-code").textContent, "Course second");
	assert.equal(disabled("delete-confirm"), true, "the first course's response cannot enable deletion of the second");
	assert.match(byTest("delete-course-dialog").textContent!, /Reading notes…/);
	await f.respond(1, notes(2));
	assert.equal(disabled("delete-confirm"), false);

	await f.select("third");
	assert.equal(disabled("delete-confirm"), true, "a completed count belongs only to its course");
	assert.equal(document.querySelector('[data-testid="delete-download-notes"]'), null);
	await f.click("delete-cancel");
	await f.select("third");
	await f.respond(2, notes(9));
	assert.equal(disabled("delete-confirm"), true, "a closed opening's response cannot enable a reopened dialog");
	await f.respond(3, notes(1));
	assert.equal(disabled("delete-confirm"), false);
	assert.match(byTest("delete-course-line").textContent!, /their 1 note\./);
});
