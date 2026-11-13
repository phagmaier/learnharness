/** Real helper/profile/lifetime check. Run inside nix develop on NixOS.
 * Only synthetic pages and scratch profiles; no app server or providers.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { probeEnv, stopBrowserService } from "./smoke-demo-runtime.mjs";

const root = path.resolve(import.meta.dirname, "..");
const binary = createRequire(path.join(root, "package.json"))("electron");
for (const dev of [false, true]) {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-helper-profile-smoke-"));
	const env = probeEnv(process.env, scratch);
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.CHROME_PATH;
	const ownedProfile = fs.mkdtempSync(path.join(os.tmpdir(), "learnharness-browser-service-"));
	env.LH_BROWSER_SERVICE_PROFILE = ownedProfile;
	if (dev) env.LH_DEV_URL = "http://127.0.0.1:1";
	const helper = spawn(binary, [path.join(root, "tests", "fixtures", "browser-service-observer.cjs"), "--browser-service", "--disable-background-networking", "--disable-component-update",
		...(process.platform === "linux" ? ["--no-sandbox"] : [])], { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
	helper.once("exit", () => fs.rmSync(ownedProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }));
	let output = "", errors = "", browser, profile;
	const profiles = [];
	helper.on("message", message => { if (message?.kind === "profile-path") profiles.push(message); });
	helper.stderr.on("data", data => { errors = (errors + data).slice(-8000); });
	const assertUntouched = () => {
		for (const name of ["LearnHarness", "LearnHarness-Fork", "LearnHarness-Fork-dev"]) assert.equal(fs.existsSync(path.join(scratch, "config", name)), false, `helper touched ${name}`);
	};
	try {
		const port = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Helper handshake timed out: ${errors}`)), 15_000);
			helper.once("error", error => { clearTimeout(timer); reject(error); });
			helper.once("exit", code => { clearTimeout(timer); reject(new Error(`Helper exited ${code}: ${errors}`)); });
			helper.stdout.on("data", data => {
				output += data;
				const match = /^BROWSER_SERVICE_CDP (\d+)$/m.exec(output);
				if (match) { clearTimeout(timer); resolve(Number(match[1])); }
			});
		});
		const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
		browser = await puppeteer.connect({ browserWSEndpoint: version.webSocketDebuggerUrl });
		profile = profiles.find(message => message.name === "userData")?.value;
		assert.ok(profile && path.basename(profile).startsWith("learnharness-browser-service-"), "Chromium did not use the temporary profile");
		assert.deepEqual(profiles.map(({ name, value, ready }) => ({ name, value, ready })), [
			{ name: "userData", value: profile, ready: false }, { name: "sessionData", value: profile, ready: false },
		]);
		assert.ok(fs.readdirSync(profile).length > 0, "Chromium never wrote into its isolated profile");
		assertUntouched();
		const [page] = await browser.pages();
		assert.ok(page);
		await page.setContent("<p>Synthetic helper page.</p>");
		assert.equal(await page.$eval("p", node => node.textContent), "Synthetic helper page.");
		browser.disconnect(); browser = undefined;
		const stopped = await stopBrowserService(helper);
		assert.equal(stopped.requested, true);
		assert.equal(stopped.code, 0);
		assertUntouched();
		assert.equal(fs.existsSync(profile), false, `temporary profile remained after IPC disconnect: ${fs.existsSync(profile) ? fs.readdirSync(profile).join(", ") : ""}; ${errors}`);
		console.log(`[smoke-browser-service] ${dev ? "dev" : "regular"} launch: isolated Chromium profile, page execution and parent-disconnect cleanup passed`);
	} finally {
		browser?.disconnect();
		if (helper.exitCode === null && helper.signalCode === null) await stopBrowserService(helper);
		if (profile) fs.rmSync(profile, { recursive: true, force: true });
		fs.rmSync(ownedProfile, { recursive: true, force: true });
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}
