/**
 * Fork: the one-time copy of upstream LearnHarness's folder into the fork's
 * (docs/fork/plans/02-fork-identity-packaging.md, item 3).
 *
 * Runs in the packaged fork after it holds its own single-instance lock and
 * BEFORE app ready, so Chromium has not opened the fork's profile yet. The
 * source is only ever read. The copy lands in a staging folder inside the
 * destination, is moved into place entry by entry, and the marker is written
 * last: an interrupted or failed copy leaves no marker and is retried on the
 * next launch, so it never turns into an empty start.
 *
 * Result statuses: "already-done" (marker present), "nothing-to-copy" (no
 * upstream folder; marker written), "upstream-running" (upstream holds its
 * lock; nothing copied, no marker), "copied", "failed" (with `error`).
 */
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "upstream-copy.json";
const STAGING = ".upstream-copy-staging";

// Top-level entries never copied: logs, Chromium's single-instance lock
// files (they name the upstream process), and caches Chromium rebuilds.
// Electron's Chromium profile is the userData folder itself, so these are
// all top-level names.
const SKIPPED = new Set([
	"logs",
	"SingletonLock", "SingletonSocket", "SingletonCookie",
	"Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache",
	"ShaderCache", "GrShaderCache", "Crashpad", "blob_storage",
	MARKER, STAGING,
]);

/** Process liveness without signalling: EPERM still means "exists". */
function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

/** Chromium's SingletonLock is a symlink to "<hostname>-<pid>". A missing or
 *  unreadable lock, or one naming a dead process (a crash), is not running. */
function upstreamRunning(source, isAlive = processAlive) {
	let target;
	try {
		target = fs.readlinkSync(path.join(source, "SingletonLock"));
	} catch {
		return false;
	}
	const pid = Number(target.slice(target.lastIndexOf("-") + 1));
	return Number.isInteger(pid) && pid > 0 && isAlive(pid);
}

function writeMarker(destination, record) {
	fs.mkdirSync(destination, { recursive: true });
	const file = path.join(destination, MARKER);
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(record, null, "\t")}\n`, { mode: 0o600 });
	fs.renameSync(temp, file);
}

function copyUpstreamOnce({ source, destination, isAlive = processAlive, now = () => new Date() }) {
	if (fs.existsSync(path.join(destination, MARKER))) return { status: "already-done" };
	if (!fs.existsSync(source)) {
		writeMarker(destination, { result: "nothing-to-copy", source, at: now().toISOString() });
		return { status: "nothing-to-copy" };
	}
	if (upstreamRunning(source, isAlive)) return { status: "upstream-running" };

	const staging = path.join(destination, STAGING);
	try {
		fs.rmSync(staging, { recursive: true, force: true }); // a crashed earlier attempt
		fs.mkdirSync(staging, { recursive: true });
		const entries = fs.readdirSync(source).filter((name) => !SKIPPED.has(name));
		for (const name of entries) {
			// verbatimSymlinks: copy links as links, never follow them out of
			// the source. File modes are kept (auth.json stays 0600).
			fs.cpSync(path.join(source, name), path.join(staging, name), {
				recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false,
			});
		}
		// Anything already at a destination name was created by this
		// not-yet-copied fork launch (e.g. Chromium state from a launch that
		// stopped at the "upstream running" dialog); the copy replaces it.
		for (const name of entries) {
			const target = path.join(destination, name);
			fs.rmSync(target, { recursive: true, force: true });
			fs.renameSync(path.join(staging, name), target);
		}
		fs.rmSync(staging, { recursive: true, force: true });
		writeMarker(destination, { result: "copied", source, at: now().toISOString() });
		return { status: "copied" };
	} catch (error) {
		try {
			fs.rmSync(staging, { recursive: true, force: true });
		} catch {
			/* best effort; the next attempt clears it first */
		}
		return { status: "failed", error };
	}
}

module.exports = { copyUpstreamOnce, upstreamRunning, MARKER, STAGING, SKIPPED };
