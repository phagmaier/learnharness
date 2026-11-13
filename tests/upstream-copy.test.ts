/** Fork: the one-time copy of upstream's folder (electron/upstream-copy.cjs),
 * run against real temporary folders with fake learner files. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { copyUpstreamOnce, MARKER, STAGING } = require("../electron/upstream-copy.cjs") as {
	copyUpstreamOnce(options: { source: string; destination: string; isAlive?: (pid: number) => boolean }): { status: string; error?: Error };
	MARKER: string; STAGING: string;
};

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		for (const file of walk(root)) fs.chmodSync(file, 0o700);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		out.push(full);
		if (entry.isDirectory()) out.push(...walk(full));
	}
	return out;
}

/** A fake upstream folder shaped like a real LearnHarness userData. */
function setup({ withSource = true } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-upstream-copy-"));
	roots.push(root);
	const source = path.join(root, "LearnHarness");
	const destination = path.join(root, "LearnHarness-Fork");
	if (withSource) {
		const files: Record<string, string> = {
			"data/settings.json": '{"version":1}',
			"data/chats/s1.json": '{"id":"s1"}',
			"data/graph/sources.json": "[]",
			"chatgpt-credentials.json": '{"refresh":"fake"}',
			"Custom Dictionary.txt": "Hegel\n",
			"Local Storage/leveldb/000003.log": "prefs",
			"logs/main.log": "upstream log",
			"Cache/Cache_Data/index": "cache",
			"GPUCache/data_0": "gpu",
		};
		for (const [name, body] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
			fs.writeFileSync(path.join(source, name), body);
		}
		fs.writeFileSync(path.join(source, "auth.json"), '{"OPENAI_API_KEY":"fake"}', { mode: 0o600 });
		fs.chmodSync(path.join(source, "auth.json"), 0o600);
		fs.symlinkSync("nix-desktop-999999999", path.join(source, "SingletonLock"));
	}
	return { root, source, destination };
}

/** Names, link targets, modes and bytes: any change to the source shows. */
function fingerprint(dir: string) {
	const hash = createHash("sha256");
	const visit = (current: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(current, entry.name);
			const stat = fs.lstatSync(full);
			hash.update(`${path.relative(dir, full)}|${stat.mode}|${stat.mtimeMs}\n`);
			if (entry.isSymbolicLink()) hash.update(fs.readlinkSync(full));
			else if (entry.isDirectory()) visit(full);
			else hash.update(fs.readFileSync(full));
		}
	};
	visit(dir);
	return hash.digest("hex");
}

const dead = () => false;

describe("one-time upstream copy", () => {
	it("copies learning data, keys, sign-ins and the browser profile, but not logs, caches or locks", () => {
		const { source, destination } = setup();
		assert.equal(copyUpstreamOnce({ source, destination, isAlive: dead }).status, "copied");
		for (const name of ["data/settings.json", "data/chats/s1.json", "data/graph/sources.json", "auth.json",
			"chatgpt-credentials.json", "Custom Dictionary.txt", "Local Storage/leveldb/000003.log"]) {
			assert.equal(fs.readFileSync(path.join(destination, name), "utf8"), fs.readFileSync(path.join(source, name), "utf8"), name);
		}
		for (const name of ["logs", "Cache", "GPUCache", "SingletonLock", STAGING]) {
			assert.equal(fs.existsSync(path.join(destination, name)), false, `${name} must not be copied`);
		}
		const marker = JSON.parse(fs.readFileSync(path.join(destination, MARKER), "utf8"));
		assert.equal(marker.result, "copied");
		assert.equal(marker.source, source);
	});

	it("never changes the upstream folder", () => {
		const { source, destination } = setup();
		const before = fingerprint(source);
		copyUpstreamOnce({ source, destination, isAlive: dead });
		assert.equal(fingerprint(source), before);
	});

	it("keeps auth.json private (0600)", () => {
		const { source, destination } = setup();
		copyUpstreamOnce({ source, destination, isAlive: dead });
		assert.equal(fs.statSync(path.join(destination, "auth.json")).mode & 0o777, 0o600);
	});

	it("runs once: a second launch finds the marker and leaves the fork's data alone", () => {
		const { source, destination } = setup();
		copyUpstreamOnce({ source, destination, isAlive: dead });
		fs.writeFileSync(path.join(destination, "data/settings.json"), '{"fork":true}');
		fs.writeFileSync(path.join(source, "data/settings.json"), '{"upstream":"later"}');
		assert.equal(copyUpstreamOnce({ source, destination, isAlive: dead }).status, "already-done");
		assert.equal(fs.readFileSync(path.join(destination, "data/settings.json"), "utf8"), '{"fork":true}');
	});

	it("with no upstream folder, starts empty and does not look again", () => {
		const { source, destination } = setup({ withSource: false });
		assert.equal(copyUpstreamOnce({ source, destination, isAlive: dead }).status, "nothing-to-copy");
		assert.deepEqual(fs.readdirSync(destination), [MARKER]);
		fs.mkdirSync(path.join(source, "data"), { recursive: true });
		assert.equal(copyUpstreamOnce({ source, destination, isAlive: dead }).status, "already-done");
		assert.equal(fs.existsSync(path.join(destination, "data")), false);
	});

	it("copies nothing while upstream is running, and copies once it has quit", () => {
		const { source, destination } = setup();
		const pids: number[] = [];
		const running = copyUpstreamOnce({ source, destination, isAlive: pid => { pids.push(pid); return true; } });
		assert.equal(running.status, "upstream-running");
		assert.deepEqual(pids, [999999999], "the PID comes from the lock's <hostname>-<pid> target");
		assert.equal(fs.existsSync(destination), false);
		assert.equal(copyUpstreamOnce({ source, destination, isAlive: dead }).status, "copied");
	});

	it("detects a live upstream with the real process check", () => {
		const { source, destination } = setup();
		fs.rmSync(path.join(source, "SingletonLock"));
		fs.symlinkSync(`nix-desktop-${process.pid}`, path.join(source, "SingletonLock"));
		assert.equal(copyUpstreamOnce({ source, destination }).status, "upstream-running");
	});

	it("replaces state a not-yet-copied fork launch created", () => {
		const { source, destination } = setup();
		fs.mkdirSync(path.join(destination, "Local Storage"), { recursive: true });
		fs.writeFileSync(path.join(destination, "Local Storage", "stale"), "fork launch");
		fs.writeFileSync(path.join(destination, "SingletonLock"), "fork's own lock");
		assert.equal(copyUpstreamOnce({ source, destination, isAlive: dead }).status, "copied");
		assert.deepEqual(fs.readdirSync(path.join(destination, "Local Storage")), ["leveldb"]);
		assert.equal(fs.readFileSync(path.join(destination, "SingletonLock"), "utf8"), "fork's own lock", "the fork's lock is untouched");
	});

	it("a failed copy leaves no marker or staging folder, and the next launch succeeds", { skip: process.getuid?.() === 0 && "root reads unreadable files" }, () => {
		const { source, destination } = setup();
		const unreadable = path.join(source, "data/chats/s1.json");
		fs.chmodSync(unreadable, 0o000);
		const failed = copyUpstreamOnce({ source, destination, isAlive: dead });
		assert.equal(failed.status, "failed");
		assert.match(String(failed.error), /EACCES/);
		assert.equal(fs.existsSync(path.join(destination, MARKER)), false);
		assert.equal(fs.existsSync(path.join(destination, STAGING)), false);
		fs.chmodSync(unreadable, 0o644);
		assert.equal(copyUpstreamOnce({ source, destination, isAlive: dead }).status, "copied");
		assert.equal(fs.readFileSync(path.join(destination, "data/chats/s1.json"), "utf8"), '{"id":"s1"}');
	});
});
