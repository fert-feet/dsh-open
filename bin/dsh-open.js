#!/usr/bin/env node
/**
 * `dsh-open <dir>` — open a folder in the running DeepSeek Harness desktop app.
 *
 * The command is transport-agnostic at this layer: it drops a request into the
 * shared runtime directory, waits for the app's host half to ack it, and maps
 * the ack (or the absence of one) onto an exit code. The app is launched when
 * no live host answered, so a cold `dsh-open .` behaves like the warm one.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** How long the app gets to answer before the command gives up. */
const DEFAULT_TIMEOUT_MS = 30000;

/** Poll interval while waiting for the ack file. */
const POLL_INTERVAL_MS = 100;

/** macOS application name used for the cold-start handoff. */
const APP_NAME = "DeepSeek Harness";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * Resolve the shared runtime directory (`$DSH_HOME/run/dsh-open`).
 * @returns absolute directory path.
 */
function runtimeDir() {
	const home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
	return join(home, "run", "dsh-open");
}

/**
 * Read a JSON file, treating any failure as absent.
 * @param file - absolute path.
 * @returns the parsed value, or undefined.
 */
function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Write a JSON file through a sibling temp file plus rename so the watcher
 * never reads a half-written payload.
 * @param file - destination path.
 * @param value - JSON-serializable value.
 */
function writeJsonAtomic(file, value) {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, file);
}

/**
 * Whether a pid belongs to a live process.
 * @param pid - candidate pid.
 * @returns false only when the process is definitively gone.
 */
function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

/**
 * Whether a live host announced itself in the runtime directory.
 * @returns true when host.json names a running process.
 */
function hostAlive() {
	const host = readJson(join(runtimeDir(), "host.json"));
	return typeof host?.pid === "number" && processAlive(host.pid);
}

/**
 * Ask macOS to activate (or start) the app.
 * @returns undefined on success, or a failure message.
 */
function launchApp() {
	if (process.platform !== "darwin") return "automatic launch is only supported on macOS; open the DeepSeek Harness app yourself";
	const result = spawnSync("open", ["-a", APP_NAME], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
	if (result.error !== undefined) return `could not run open: ${result.error.message}`;
	if (result.status !== 0) return (result.stderr || `open exited with status ${String(result.status)}`).trim();
	return undefined;
}

/**
 * Tell a human what happened.
 * @param line - message text.
 */
function fail(line) {
	process.stderr.write(`dsh-open: ${line}\n`);
}

/**
 * Print usage.
 */
function usage() {
	process.stdout.write(`dsh-open ${VERSION} — open a folder in DeepSeek Harness

Usage:
  dsh-open [dir]           open dir (default: .) in the running app
  dsh-open --help          show this help
  dsh-open --version       print the version

Options:
  --no-launch             never start the app; fail when it is not running
  --timeout <ms>          how long to wait for the app (default ${DEFAULT_TIMEOUT_MS})
`);
}

/**
 * Run the command.
 * @param argv - arguments after the program name.
 * @returns the exit code.
 */
async function main(argv) {
	let target = ".";
	let noLaunch = false;
	let timeoutMs = DEFAULT_TIMEOUT_MS;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			usage();
			return 0;
		}
		if (arg === "--version" || arg === "-v") {
			process.stdout.write(`${VERSION}\n`);
			return 0;
		}
		if (arg === "--no-launch") {
			noLaunch = true;
			continue;
		}
		if (arg === "--timeout") {
			const value = argv[index + 1];
			index += 1;
			const parsed = Number(value);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				fail(`--timeout needs a positive number of milliseconds, got ${String(value)}`);
				return 2;
			}
			timeoutMs = parsed;
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			fail(`unknown option ${arg}`);
			return 2;
		}
		if (target !== ".") {
			fail(`unexpected extra argument ${arg}`);
			return 2;
		}
		target = arg;
	}

	const directory = resolve(target);
	let stats;
	try {
		stats = statSync(directory);
	} catch {
		fail(`not a directory: ${directory}`);
		return 1;
	}
	if (!stats.isDirectory()) {
		fail(`not a directory: ${directory}`);
		return 1;
	}

	const dir = runtimeDir();
	mkdirSync(dir, { recursive: true });
	const requestFile = join(dir, "request.json");
	const ackFile = join(dir, "ack.json");

	const nonce = randomUUID();
	try {
		rmSync(ackFile, { force: true });
	} catch {
		// A missing ack is the normal state.
	}
	writeJsonAtomic(requestFile, { path: directory, nonce, at: Date.now() });

	const live = hostAlive();
	if (!live) {
		if (noLaunch) {
			fail(`DeepSeek Harness is not running (no live host in ${dir})`);
			return 1;
		}
		const launched = launchApp();
		if (launched !== undefined) {
			fail(launched);
			return 1;
		}
	}

	const startedAt = Date.now();
	const deadline = startedAt + timeoutMs;
	for (;;) {
		const ack = readJson(ackFile);
		if (ack?.nonce === nonce) {
			rmSync(ackFile, { force: true });
			if (typeof ack.error === "string") {
				fail(ack.error === "not-a-directory" ? `not a directory: ${directory}` : `could not open ${directory}: ${ack.error}`);
				return 1;
			}
			process.stdout.write(`opened ${directory}\n`);
			return 0;
		}
		if (!live && Date.now() - startedAt > 15000 && !hostAlive()) {
			// No host announced itself: the app is starting, or the plugin was
			// installed while the app was already running (hosts load plugins at boot).
			fail("DeepSeek Harness has no live host; if you just installed dsh-open, restart the app once");
			return 1;
		}
		if (Date.now() > deadline) {
			fail(`timed out waiting for DeepSeek Harness to open ${directory}`);
			return 1;
		}
		await new Promise((done) => setTimeout(done, POLL_INTERVAL_MS));
	}
}

process.exitCode = await main(process.argv.slice(2));
