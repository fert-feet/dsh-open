#!/usr/bin/env node
/**
 * End-to-end check against a real dsh host (no Electron, no browser).
 *
 * Boots the DeepSeek Harness bundled CLI as a web host with a throwaway DSH_HOME
 * whose `web` profile bundles dsh-open, then exercises the whole chain:
 *
 *   dsh-open <dir>  →  request.json  →  host watcher  →  GET /dsh-open/pending
 *   →  (simulated browser ack)  →  POST /dsh-open/ack  →  CLI exit 0
 *
 * It also asserts that the host composed the browser half into the boot payload
 * and that host.json disappears when the host shuts down.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = new URL("..", import.meta.url).pathname;
const CLI = "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
const APP_CLI = join(REPO, "bin", "dsh-open.js");
const BOOT_TIMEOUT_MS = 60000;

/**
 * Fail the run with a readable message.
 * @param message - what went wrong.
 */
function bail(message) {
	process.stderr.write(`e2e: ${message}\n`);
	process.exitCode = 1;
}

/**
 * Wait until `check()` returns a truthy value.
 * @param check - predicate.
 * @param timeoutMs - budget.
 * @param label - what we wait for, for the timeout message.
 * @returns the truthy value.
 */
async function waitFor(check, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value !== undefined && value !== null && value !== false) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await sleep(100);
	}
}

/**
 * Create a throwaway DSH_HOME whose web profile bundles dsh-open.
 * @returns paths for the run.
 */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "dsh-open-e2e-"));
	const home = join(root, "home");
	const profile = join(home, "profiles", "web");
	const project = join(root, "project");
	mkdirSync(join(profile, "node_modules"), { recursive: true });
	mkdirSync(project);
	writeFileSync(
		join(profile, "package.json"),
		`${JSON.stringify(
			{
				name: "dsh-profile-web",
				private: true,
				dependencies: { "dsh-open": `file:${REPO}` },
				dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-open"] } },
			},
			null,
			2,
		)}\n`,
	);
	symlinkSync(REPO, join(profile, "node_modules", "dsh-open"), "dir");
	return { root, home, project, run: join(home, "run", "dsh-open") };
}

/**
 * Boot the host and capture its URL.
 * @param home - DSH_HOME.
 * @returns the child, its exit promise, and a function that resolves the URL once printed.
 */
function bootHost(home) {
	const child = spawn(CLI, ["web", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
		env: { ...process.env, DSH_HOME: home, DSH_PROFILE: "" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk) => (output += chunk));
	child.stderr.on("data", (chunk) => (output += chunk));
	const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
	return {
		child,
		exited,
		url: () =>
			waitFor(
				() => {
					const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(output);
					return match === null ? undefined : match[0];
				},
				30000,
				"the host URL",
			),
		output: () => output,
	};
}

/**
 * Fetch JSON from the host.
 * @param base - origin (no token).
 * @param token - access token.
 * @param path - absolute path.
 * @param init - fetch options.
 * @returns parsed body.
 */
async function api(base, token, path, init) {
	const response = await fetch(`${base}${path}?token=${token}`, init);
	if (!response.ok) throw new Error(`${path} answered ${String(response.status)}`);
	return response.json();
}

const fixturePaths = fixture();
let host;
try {
	if (!existsSync(CLI)) throw new Error(`bundled CLI not found at ${CLI}`);

	host = bootHost(fixturePaths.home);
	const url = await host.url();
	const base = new URL(url).origin;
	const token = new URL(url).searchParams.get("token");

	await waitFor(() => existsSync(join(fixturePaths.run, "host.json")), 30000, "host.json");
	const health = await api(base, token, "/dsh-open/health");
	if (health.ok !== true || health.pending !== null) throw new Error(`unexpected health: ${JSON.stringify(health)}`);

	// The settings page needs the presence of the command route and a usable
	// interpreter for the shim it would write.
	const command = await api(base, token, "/dsh-open/command");
	if (typeof command.installed !== "boolean") throw new Error(`unexpected command status: ${JSON.stringify(command)}`);
	if (typeof command.interpreter?.binary !== "string" || command.interpreter.binary === "") {
		throw new Error(`the command route must name an interpreter: ${JSON.stringify(command.interpreter)}`);
	}

	// The browser half must be part of the boot payload served to the window.
	// The shell redirects once to hand out its session cookie, and the boot
	// payload is only rendered for a cookie-bearing request.
	const first = await fetch(url, { headers: { accept: "text/html" }, redirect: "manual" });
	const cookies = (typeof first.headers.getSetCookie === "function" ? first.headers.getSetCookie() : [first.headers.get("set-cookie") ?? ""])
		.map((cookie) => cookie.split(";")[0])
		.filter((cookie) => cookie !== "");
	const page = await fetch(url, { headers: { accept: "text/html", cookie: cookies.join("; ") } }).then((response) => response.text());
	if (!page.includes('"id":"dsh-open"')) throw new Error("the boot payload does not list the dsh-open client module");

	// Run the CLI in the background, then play the browser's part.
	const cli = spawn(process.execPath, [APP_CLI, fixturePaths.project, "--timeout", "25000"], {
		env: { ...process.env, DSH_HOME: fixturePaths.home },
	});
	let cliOut = "";
	cli.stdout.on("data", (chunk) => (cliOut += chunk));
	let cliErr = "";
	cli.stderr.on("data", (chunk) => (cliErr += chunk));
	const cliExit = new Promise((resolve) => cli.on("close", (code) => resolve(code)));

	const pending = await waitFor(
		async () => {
			const body = await api(base, token, "/dsh-open/pending");
			return typeof body.path === "string" ? body : undefined;
		},
		15000,
		"the host to queue the request",
	);
	if (pending.path !== fixturePaths.project) throw new Error(`queued ${pending.path}, expected ${fixturePaths.project}`);
	await api(base, token, "/dsh-open/ack", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ nonce: pending.nonce, workspaceId: "ws-e2e" }),
	});
	const code = await cliExit;
	if (code !== 0) throw new Error(`dsh-open exited ${String(code)}: ${cliErr.trim()}`);
	if (!cliOut.includes(`opened ${fixturePaths.project}`)) throw new Error(`unexpected CLI output: ${cliOut.trim()}`);
	const after = await api(base, token, "/dsh-open/pending");
	if (after.path !== null) throw new Error("the host kept the request after it was acked");

	host.child.kill("SIGTERM");
	await host.exited;
	if (existsSync(join(fixturePaths.run, "host.json"))) throw new Error("host.json survived the shutdown");
	process.stdout.write("e2e: ok — request → host → browser ack → CLI exit 0, command route, boot payload and cleanup verified\n");
} catch (error) {
	bail(error instanceof Error ? error.message : String(error));
	if (host !== undefined) {
		process.stderr.write(`--- host output ---\n${host.output()}\n`);
		host.child.kill("SIGTERM");
	}
} finally {
	rmSync(fixturePaths.root, { recursive: true, force: true });
}
