/** Repeatable development SSR + real Electron rendering check, no providers.
 * Run inside nix develop on NixOS. The temporary probe route is created
 * exclusively for this run and removed before any production build.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { probeEnv } from "./smoke-demo-runtime.mjs";

const root = path.resolve(import.meta.dirname, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-dev-runtime-"));
const routeName = `runtime-smoke-${path.basename(scratch)}`;
const routeDir = path.join(root, "app", "api", routeName);
const env = { ...probeEnv(process.env, scratch), NODE_ENV: "development" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CHROME_PATH;
const chatId = "chat_dev_runtime_smoke";
const data = path.join(scratch, "data");
fs.mkdirSync(path.join(data, "chats"), { recursive: true });
fs.writeFileSync(path.join(data, "chats", `${chatId}.json`), JSON.stringify({
	version: 2, id: chatId, title: "Development SSR fixture", kind: "teach", createdAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z",
	messages: [{ id: "lesson", role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, content: [{ type: "text", text: "An arrow represents a vector." },
			{ type: "toolCall", id: "q", name: "explain", arguments: { question: "Describe the vector.", correctAnswer: "It has direction and length." } }] }],
}));

let server, logs = "", port, routeCreated = false;
try {
	fs.mkdirSync(routeDir); // refuse any existing user route
	routeCreated = true;
	fs.writeFileSync(path.join(routeDir, "route.ts"), `
import { realHeadless, browserServiceLaunch } from "../../../src/agent/subagents/headless.ts";
export const dynamic = "force-dynamic";
export async function GET() {
  const launch = browserServiceLaunch();
  const diagram = await realHeadless.renderMermaid(["graph LR\\n A[Vector]-->B[Image]"]);
  const demo = await realHeadless.runDemo('<!doctype html><html><body><button id="step" onclick="window.answer++">Step</button><script>window.answer = 41; document.getElementById("step").click();</script></body></html>', { settleMs: 0, probe: "window.answer" });
  return Response.json({ launch, diagram, demo, chromePath: process.env.CHROME_PATH ?? null });
}
`, { flag: "wx" });
	const listener = net.createServer();
	await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
	port = listener.address().port;
	await new Promise(resolve => listener.close(resolve));
	server = spawn("npm", ["run", "dev", "--", "--port", String(port)], { cwd: root, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
	const capture = chunk => { logs = (logs + chunk).slice(-32_000); };
	server.stdout.on("data", capture); server.stderr.on("data", capture);
	const url = `http://localhost:${port}`;
	const deadline = Date.now() + 120_000;
	let connected = false;
	while (Date.now() < deadline) {
		if (server.exitCode !== null) throw new Error(`Dev server exited ${server.exitCode}:\n${logs}`);
		try { const response = await fetch(`${url}/api/chats/${chatId}`, { signal: AbortSignal.timeout(5000) }); if (response.ok) { connected = true; break; } }
		catch { /* Plugin staging and first-route compilation precede readiness. */ }
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	assert.ok(connected, `Dev server did not become ready:\n${logs}`);
	const response = await fetch(`${url}/chat/${chatId}`, { signal: AbortSignal.timeout(60_000) });
	const html = await response.text();
	assert.equal(response.status, 200, logs);
	assert.ok(html.includes("An arrow represents a vector."));
	assert.ok(!html.includes("Cannot add property changed"));
	const probeResponse = await fetch(`${url}/api/${routeName}`, { signal: AbortSignal.timeout(60_000) });
	assert.equal(probeResponse.status, 200, await probeResponse.clone().text());
	const probe = await probeResponse.json();
	assert.equal(probe.chromePath, null);
	assert.ok(probe.launch?.binary?.includes("electron"));
	assert.equal(probe.launch.args[0], fs.realpathSync(root));
	assert.equal(probe.diagram.status, "rendered");
	assert.equal(probe.diagram.diagrams[0].ok, true);
	assert.match(probe.diagram.diagrams[0].svg, /<svg[\s>]/);
	assert.equal(probe.demo.ok, true, JSON.stringify(probe.demo));
	assert.equal(probe.demo.probeResult, 42);
	for (const name of ["LearnHarness", "LearnHarness-Fork", "LearnHarness-Fork-dev"]) assert.equal(fs.existsSync(path.join(scratch, "config", name)), false, `dev helper touched ${name}`);
	console.log("[smoke-dev-runtime] Chat/Dock SSR 200; real Electron Mermaid and demo probe=42 passed without CHROME_PATH; app profiles untouched");
	console.log(`[smoke-dev-runtime] browser check URL: ${url}/chat/${chatId}`);
	if (process.argv.includes("--hold")) await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
} catch (error) {
	console.error(logs);
	throw error;
} finally {
	if (server?.pid && server.exitCode === null) {
		const exited = new Promise(resolve => server.once("exit", resolve));
		try { if (process.platform === "win32") server.kill(); else process.kill(-server.pid, "SIGTERM"); } catch { /* already exited */ }
		await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
	}
	if (routeCreated) fs.rmSync(routeDir, { recursive: true, force: true });
	fs.rmSync(scratch, { recursive: true, force: true });
}
