import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const cli = new URL("../bin/dsh-open.js", import.meta.url).pathname;
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * Spawn the CLI against a private DSH_HOME.
 * @param args - CLI arguments.
 * @param home - DSH_HOME to use.
 * @returns the child process plus a promise for its exit.
 */
function run(args, home) {
	const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, DSH_HOME: home } });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const done = new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
	return { child, done };
}

/**
 * Make a fresh DSH_HOME and a target directory inside it.
 * @returns paths for the test.
 */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "dsh-open-cli-"));
	const home = join(root, "home");
	const project = join(root, "project");
	mkdirSync(join(home, "run", "dsh-open"), { recursive: true });
	mkdirSync(project, { recursive: true });
	return { home, project, dir: join(home, "run", "dsh-open") };
}

test("--help prints usage and exits 0", async () => {
	const { done } = run(["--help"], tmpdir());
	const result = await done;
	assert.equal(result.code, 0);
	assert.match(result.stdout, /Usage:\n {2}dsh-open \[dir\]/);
});

test("--version prints the package version", async () => {
	const { done } = run(["--version"], tmpdir());
	const result = await done;
	assert.equal(result.code, 0);
	assert.equal(result.stdout.trim(), version);
});

test("a nonexistent target is rejected", async () => {
	const { home } = fixture();
	const { done } = run([join(home, "nope")], home);
	const result = await done;
	assert.equal(result.code, 1);
	assert.match(result.stderr, /not a directory:/);
});

test("a file target is rejected", async () => {
	const { home, project } = fixture();
	const file = join(project, "file.txt");
	writeFileSync(file, "x");
	const { done } = run([file], home);
	const result = await done;
	assert.equal(result.code, 1);
	assert.match(result.stderr, /not a directory:/);
});

test("with a live host the request is written and the ack closes the command", async () => {
	const { home, project, dir } = fixture();
	writeFileSync(join(dir, "host.json"), JSON.stringify({ pid: process.pid, profile: "desktop" }));
	const { done } = run([project], home);

	let request;
	for (let attempt = 0; attempt < 50 && request === undefined; attempt += 1) {
		await sleep(20);
		const text = await readFileSafe(join(dir, "request.json"));
		if (text !== undefined) request = JSON.parse(text);
	}
	assert.ok(request !== undefined, "the CLI should write request.json");
	assert.equal(request.path, project);
	assert.equal(typeof request.nonce, "string");
	writeFileSync(join(dir, "ack.json"), JSON.stringify({ nonce: request.nonce, workspaceId: "ws-1" }));

	const result = await done;
	assert.equal(result.code, 0);
	assert.match(result.stdout, new RegExp(`opened ${escapeRegExp(project)}`));
});

test("an ack carrying an error is reported", async () => {
	const { home, project, dir } = fixture();
	writeFileSync(join(dir, "host.json"), JSON.stringify({ pid: process.pid }));
	const { done } = run([project], home);

	let request;
	for (let attempt = 0; attempt < 50 && request === undefined; attempt += 1) {
		await sleep(20);
		const text = await readFileSafe(join(dir, "request.json"));
		if (text !== undefined) request = JSON.parse(text);
	}
	writeFileSync(join(dir, "ack.json"), JSON.stringify({ nonce: request.nonce, error: "not-a-directory" }));

	const result = await done;
	assert.equal(result.code, 1);
	assert.match(result.stderr, /not a directory:/);
});

test("no ack within the timeout fails", async () => {
	const { home, project, dir } = fixture();
	writeFileSync(join(dir, "host.json"), JSON.stringify({ pid: process.pid }));
	const { done } = run([project, "--timeout", "300"], home);
	const result = await done;
	assert.equal(result.code, 1);
	assert.match(result.stderr, /timed out waiting for DeepSeek Harness/);
});

test("--no-launch fails when no host is running", async () => {
	const { home, project } = fixture();
	const { done } = run([project, "--no-launch"], home);
	const result = await done;
	assert.equal(result.code, 1);
	assert.match(result.stderr, /is not running/);
});

test("unknown options and bad timeouts exit 2", async () => {
	const { home, project } = fixture();
	const unknown = await run([project, "--nope"], home).done;
	assert.equal(unknown.code, 2);
	const badTimeout = await run([project, "--timeout", "soon"], home).done;
	assert.equal(badTimeout.code, 2);
});

/**
 * Read a file, returning undefined when it does not exist yet.
 * @param file - path.
 * @returns contents or undefined.
 */
async function readFileSafe(file) {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Escape a literal for use inside a RegExp.
 * @param value - literal text.
 * @returns the escaped text.
 */
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
