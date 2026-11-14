import React, { act } from "react";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ActivitySection } from "../components/activity-dock.tsx";
import type { ActivityFeed, FeedBookWriter } from "../components/activity-dock.tsx";

const FIRST_RUN = "2026-11-14T12:00:00.000Z";
const RETRY_RUN = "2026-11-14T12:00:01.000Z";
const EMPTY_FEED: ActivityFeed = { jobs: [], extractions: [], bookWriters: [] };

type WriterKind = FeedBookWriter["kind"];

function feed(kind: WriterKind, createdAt: string): ActivityFeed {
	return {
		...EMPTY_FEED,
		bookWriters: [{
			id: `book-fixture:${kind}`,
			bookId: "book-fixture",
			kind,
			title: `Book ${kind} · Fixture`,
			createdAt,
			activity: kind === "map" ? "0 of 2 sections" : "Finding the contents",
			costUsd: null,
			contextLimit: null,
		}],
	};
}

describe("book writer Stop run identity", () => {
	const dom = parseHTML("<html><body></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const originalFetch = globalThis.fetch;
	let root: Root;
	let host: HTMLDivElement;
	let requests: { body: unknown; resolve: (response: Response) => void }[];

	before(() => {
		for (const [key, value] of Object.entries({
			React,
			window: dom.window,
			document: dom.document,
			navigator: globals.navigator ?? { userAgent: "", platform: "" },
			Element: dom.window.Element,
			HTMLElement: dom.window.HTMLElement,
			IS_REACT_ACT_ENVIRONMENT: true,
		})) {
			previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
	});

	beforeEach(() => {
		requests = [];
		globalThis.fetch = async (input, init) => {
			assert.equal(input, "/api/activity/abort");
			assert.equal(init?.method, "POST");
			// The project's ES2023 lib predates Promise.withResolvers.
			let resolve!: (response: Response) => void;
			const promise = new Promise<Response>((done) => { resolve = done; });
			requests.push({ body: JSON.parse(String(init?.body)), resolve });
			return promise;
		};
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		host.remove();
		globalThis.fetch = originalFetch;
	});

	after(() => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	});

	async function render(nextFeed: ActivityFeed) {
		await act(async () => root.render(<ActivitySection feed={nextFeed} />));
	}

	function stop(): HTMLButtonElement {
		const button = host.querySelector<HTMLButtonElement>('[data-testid="activity-abort"]');
		assert.ok(button);
		return button;
	}

	async function clickStop() {
		assert.equal(stop().disabled, false, "a new run must have an enabled Stop");
		await act(async () => { stop().dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		assert.equal(stop().disabled, true, "Stop locks only the run being aborted");
	}

	function assertRequest(index: number, kind: WriterKind) {
		assert.deepEqual(requests[index]?.body, {
			kind: kind === "map" ? "book-map-writer" : "book-contents-writer",
			id: `book-fixture:${kind}`,
		}, "the server receives its stable abort id, not the client-local run identity");
	}

	async function settle(index: number, status: number) {
		const request = requests[index];
		assert.ok(request);
		await act(async () => request.resolve(new Response(null, { status })));
	}

	for (const kind of ["map", "contents"] as const) {
		for (const emptyBetweenRuns of [false, true]) {
			it(`${kind}: successful Stop permits retry ${emptyBetweenRuns ? "after an empty feed" : "without an empty feed"}`, async () => {
				await render(feed(kind, FIRST_RUN));
				await clickStop();
				assertRequest(0, kind);
				await settle(0, 200);
				assert.equal(stop().disabled, true, "a successful abort stays pending until its run leaves the feed");

				if (emptyBetweenRuns) {
					await render(EMPTY_FEED);
					assert.equal(host.querySelector('[data-testid="activity-abort"]'), null);
				}
				await render(feed(kind, RETRY_RUN));
				await clickStop();
				assert.equal(requests.length, 2);
				assertRequest(1, kind);
				await settle(1, 200);
			});
		}

		for (const status of [200, 409, 500]) {
			it(`${kind}: late abort ${status} from the old run cannot affect the retry`, async () => {
				await render(feed(kind, FIRST_RUN));
				await clickStop();
				assertRequest(0, kind);
				await render(feed(kind, RETRY_RUN));
				assert.equal(stop().disabled, false);

				// A late failure must not lock an untouched retry; a late success
				// (including already-gone) must not clear its own pending Stop.
				if (status === 500) {
					await settle(0, status);
					assert.equal(stop().disabled, false);
					assert.equal(stop().title, "End this background process");
				}
				await clickStop();
				assert.equal(requests.length, 2);
				assertRequest(1, kind);
				if (status !== 500) await settle(0, status);
				assert.equal(stop().disabled, true, "old responses cannot clear the retry's pending Stop");
				assert.equal(stop().title, "End this background process");
				await settle(1, 500);
				assert.equal(stop().disabled, true);
				assert.equal(stop().title, "Abort failed — try again", "the retry still owns its own abort outcome");
			});
		}
	}
});
