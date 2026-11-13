/** Fork: how the Electron shell runs the one-time upstream copy and settles
 * its result with dialogs. Real main.cjs with a fake Electron; no app,
 * profile or folder is touched. The copy itself: tests/upstream-copy.test.ts. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, it } from "node:test";

const mainFile = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const mainSource = readFileSync(mainFile, "utf8");
const mainRequire = createRequire(mainFile);

function shell({ packaged = true, env = {} as Record<string, string>, responses = [] as number[], running = [] as boolean[] } = {}) {
	const events: string[] = [];
	const copies: { source: string; destination: string }[] = [];
	const messages: { title?: string; message: string; buttons: string[] }[] = [];
	const paths: Record<string, string> = { appData: path.join(os.homedir(), ".config") };
	const app = {
		isPackaged: packaged,
		setName() {},
		getPath: (name: string) => paths[name] ?? "/unused",
		setPath: (name: string, value: string) => { paths[name] = value; },
		requestSingleInstanceLock: () => false,
		quit() {},
		exit: (code: number) => events.push(`exit ${code}`),
		relaunch: (options?: { execPath?: string }) => events.push(`relaunch ${options?.execPath ?? "self"}`),
	};
	const dialog = {
		showMessageBox: async (options: { title?: string; message: string; buttons: string[] }) => {
			messages.push(JSON.parse(JSON.stringify(options))); // values from the VM realm
			return { response: responses.shift() ?? 0 };
		},
	};
	const context = createContext({
		require: (id: string) => {
			if (id === "electron") return { app, dialog };
			if (id === "node:fs") return { mkdirSync() {}, appendFileSync() {} };
			if (id === "./upstream-copy.cjs") return {
				copyUpstreamOnce: (options: { source: string; destination: string }) => { copies.push({ ...options }); return { status: "copied" }; },
				upstreamRunning: () => running.shift() ?? false,
			};
			return mainRequire(id);
		},
		process: { platform: "linux", argv: [], env, on() {} },
		__dirname: path.dirname(mainFile),
	});
	runInContext(mainSource, context, { filename: mainFile });
	return {
		events, copies, messages,
		run: (code: string) => runInContext(code, context),
		settle: (result: object) => runInContext(`settleUpstreamCopy(${JSON.stringify(result)})`, context) as Promise<boolean>,
	};
}

describe("fork: upstream copy in the shell", () => {
	it("copies from upstream's folder into the fork's, in packaged builds only", () => {
		const packaged = shell();
		assert.deepEqual(JSON.parse(JSON.stringify(packaged.run("runUpstreamCopy()"))), { status: "copied" });
		const config = path.join(os.homedir(), ".config");
		assert.deepEqual(packaged.copies, [{ source: path.join(config, "LearnHarness"), destination: path.join(config, "LearnHarness-Fork") }]);
		for (const skipped of [shell({ packaged: false }), shell({ env: { LH_DEV_URL: "http://localhost:3000" } })]) {
			assert.equal(skipped.run("runUpstreamCopy()").status, "skipped");
			assert.equal(skipped.copies.length, 0);
		}
	});

	it("confirms a copy once and continues starting", async () => {
		const s = shell();
		assert.equal(await s.settle({ status: "copied" }), true);
		assert.deepEqual(s.messages.map(m => [m.message, m.buttons]), [[
			"Copied your LearnHarness data into LearnHarness Fork. The original in ~/.config/LearnHarness is untouched.", ["OK"],
		]]);
		assert.deepEqual(s.events, []);
	});

	for (const status of ["already-done", "nothing-to-copy", "skipped"]) {
		it(`shows nothing when the result is ${status}`, async () => {
			const s = shell();
			assert.equal(await s.settle({ status }), true);
			assert.equal(s.messages.length, 0);
		});
	}

	it("while upstream runs, Retry asks again; once upstream quits, relaunches to copy", async () => {
		const s = shell({ responses: [0, 0], running: [true, false] });
		assert.equal(await s.settle({ status: "upstream-running" }), false);
		assert.equal(s.messages.length, 2);
		assert.equal(s.messages[0]!.title, "LearnHarness is running");
		assert.equal(s.messages[0]!.message, "Quit LearnHarness so LearnHarness Fork can copy your learning data. Your original data stays untouched.");
		assert.deepEqual(s.messages[0]!.buttons, ["Retry", "Quit"]);
		assert.deepEqual(s.events, ["relaunch self", "exit 0"]);
	});

	it("an AppImage relaunches its own file, not the temporary mount", async () => {
		const s = shell({ env: { APPIMAGE: "/apps/LearnHarness-Fork.AppImage" }, responses: [0], running: [false] });
		await s.settle({ status: "upstream-running" });
		assert.deepEqual(s.events, ["relaunch /apps/LearnHarness-Fork.AppImage", "exit 0"]);
	});

	it("Quit exits without copying or starting", async () => {
		const s = shell({ responses: [1] });
		assert.equal(await s.settle({ status: "upstream-running" }), false);
		assert.deepEqual(s.events, ["exit 0"]);
	});

	it("a failed copy explains, then quits so the next start retries", async () => {
		const s = shell();
		assert.equal(await s.settle({ status: "failed", error: { message: "EACCES: permission denied" } }), false);
		assert.deepEqual(s.messages.map(m => [m.message, m.buttons]), [[
			"LearnHarness Fork couldn't copy your data from ~/.config/LearnHarness: EACCES: permission denied. Nothing in the original was changed. The fork will try again the next time it starts.", ["Quit"],
		]]);
		assert.deepEqual(s.events, ["exit 1"]);
	});
});
