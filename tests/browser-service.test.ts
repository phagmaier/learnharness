/**
 * Wave E stage 3 (owner 2026-10-10): demos run in the app's own Chromium
 * via a --browser-service helper (main.cjs boots a hidden window with a CDP
 * port), system Chrome as fallback. These pin the handshake, spawn-env
 * sanitizer, real-filesystem development lookup and packaged self-execution.
 * The live chain is exercised by scripts/smoke-browser-service.mjs and
 * scripts/smoke-dev-runtime.mjs, separately from the ordinary suite.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as headless from "../src/agent/subagents/headless.ts";
const { browserServiceSpawnEnv, parseBrowserServiceLine } = headless;

describe("browser-service helper (pure halves)", () => {
	it("parses the handshake line into a port", () => {
		assert.equal(parseBrowserServiceLine("BROWSER_SERVICE_CDP 54321"), 54321);
	});

	it("rejects non-handshake lines", () => {
		assert.equal(parseBrowserServiceLine("DevTools listening on ws://127.0.0.1:57983/devtools/browser/x"), null);
		assert.equal(parseBrowserServiceLine(""), null);
		assert.equal(parseBrowserServiceLine("BROWSER_SERVICE_CDP 0"), null);
		assert.equal(parseBrowserServiceLine("BROWSER_SERVICE_CDP 99999"), null);
	});

	it("spawn env strips ELECTRON_RUN_AS_NODE — the helper must be a full app", () => {
		const env = browserServiceSpawnEnv({
			ELECTRON_RUN_AS_NODE: "1",
			LH_DEV_URL: "http://localhost:3000",
			PATH: "/usr/bin",
			LH_BROWSER_SERVICE_PROFILE: "/stale/profile",
		});
		assert.equal("ELECTRON_RUN_AS_NODE" in env, false);
		assert.equal("LH_DEV_URL" in env, false);
		assert.equal("LH_BROWSER_SERVICE_PROFILE" in env, false);
		assert.equal(env.PATH, "/usr/bin");
	});

	it("spawn env never mutates the caller's env object", () => {
		const original = { ELECTRON_RUN_AS_NODE: "1", KEEP: "yes" };
		browserServiceSpawnEnv(original);
		assert.equal(original.ELECTRON_RUN_AS_NODE, "1");
		assert.equal(original.KEEP, "yes");
	});
});

it("resolves dev Electron from the real project directory, independently of bundled module URLs", () => {
	const original = process.cwd();
	const electronVersion = Object.getOwnPropertyDescriptor(process.versions, "electron");
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "lh-electron-resolution-"));
	try {
		Reflect.deleteProperty(process.versions, "electron");
		fs.mkdirSync(path.join(project, "electron"));
		fs.writeFileSync(path.join(project, "electron", "main.cjs"), "// fixture app");
		fs.mkdirSync(path.join(project, "node_modules", "electron"), { recursive: true });
		fs.writeFileSync(path.join(project, "package.json"), '{"name":"fixture"}');
		const binary = path.join(project, "runtime", "electron");
		fs.writeFileSync(path.join(project, "node_modules", "electron", "index.js"), `module.exports = ${JSON.stringify(binary)};`);
		process.chdir(project);
		assert.equal(headless.browserServiceBinary(), binary);
		assert.deepEqual(headless.browserServiceLaunch(), { binary, args: [fs.realpathSync(project), "--browser-service"] });
		fs.rmSync(path.join(project, "electron"), { recursive: true });
		assert.equal(headless.browserServiceLaunch(), null, "no app directory permits the existing Chrome fallback");
	} finally {
		if (electronVersion) Object.defineProperty(process.versions, "electron", electronVersion);
		process.chdir(original); fs.rmSync(project, { recursive: true, force: true });
	}
});

it("preserves packaged self-execution without looking up a development app", () => {
	const saved = Object.getOwnPropertyDescriptor(process.versions, "electron");
	try {
		Object.defineProperty(process.versions, "electron", { configurable: true, value: "fixture" });
		assert.deepEqual(headless.browserServiceLaunch(), { binary: process.execPath, args: ["--browser-service"] });
	} finally { if (saved) Object.defineProperty(process.versions, "electron", saved); else Reflect.deleteProperty(process.versions, "electron"); }
});
