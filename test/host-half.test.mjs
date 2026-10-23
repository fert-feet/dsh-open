/**
 * Host-half tests: the file/HTTP bridge, exercised over a real loopback
 * listener with a filesystem that behaves like the CLI's.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { apply, normalizeRequest } from "../lib/index.js";
import { FakeWebServer, fakeContext, getJson, postJson, waitFor } from "./helpers/fake-web-server.mjs";

const cleanups = [];

/** Register a teardown for the current test. */
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * Stand up a runtime dir, a listening server, and the plugin mounted on it.
 * @returns handles for the test.
 */
async function setup() {
	const runtimeDir = mkdtempSync(join(tmpdir(), "dsh-open-test-"));
	const server = new FakeWebServer();
	await server.listen();
	const { ctx, dispose } = fakeContext(server);
	apply(ctx, { runtimeDir });
	cleanups.push(async () => {
		dispose();
		await server.close();
		rmSync(runtimeDir, { recursive: true, force: true });
	});
	return { runtimeDir, server, dispose };
}

/**
 * Write request.json the way the CLI will: sibling temp file plus rename.
 * @param runtimeDir - shared runtime directory.
 * @param value - request payload.
 */
function writeRequest(runtimeDir, value) {
	const tmp = join(runtimeDir, "request.json.tmp");
	writeFileSync(tmp, JSON.stringify(value));
	renameSync(tmp, join(runtimeDir, "request.json"));
}

/** A directory that exists for the duration of the test. */
function makeWorkspace() {
	const dir = mkdtempSync(join(tmpdir(), "dsh-open-workspace-"));
	cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("normalizeRequest accepts a live absolute request", () => {
	const now = Date.now();
	assert.deepEqual(normalizeRequest({ path: "/tmp/x", nonce: "n1", at: now }, now), { path: "/tmp/x", nonce: "n1", at: now });
});

test("normalizeRequest rejects relative paths, missing nonce, and stale requests", () => {
	const now = Date.now();
	assert.equal(normalizeRequest({ path: "tmp/x", nonce: "n1", at: now }, now), undefined);
	assert.equal(normalizeRequest({ path: "/tmp/x", at: now }, now), undefined);
	assert.equal(normalizeRequest({ path: "/tmp/x", nonce: "n1", at: now - 11 * 60 * 1000 }, now), undefined);
});

test("health reports the live host", async () => {
	const { server } = await setup();
	const { status, body } = await getJson(server, "/dsh-open/health");
	assert.equal(status, 200);
	assert.equal(body.ok, true);
	assert.equal(body.pid, process.pid);
	assert.equal(body.port, server.port);
	assert.equal(body.pending, null);
});

test("a valid request becomes pending and the request file is consumed", async () => {
	const { runtimeDir, server } = await setup();
	const workspace = makeWorkspace();
	writeRequest(runtimeDir, { path: workspace, nonce: "nonce-1", at: Date.now() });

	const pending = await waitFor(async () => {
		const result = await getJson(server, "/dsh-open/pending");
		return result.body.path === workspace ? result.body : undefined;
	}, 4000, "pending request");
	assert.equal(pending.nonce, "nonce-1");
	assert.equal(existsSync(join(runtimeDir, "request.json")), false);
});

test("an ack is persisted and clears the pending request", async () => {
	const { runtimeDir, server } = await setup();
	const workspace = makeWorkspace();
	writeRequest(runtimeDir, { path: workspace, nonce: "nonce-2", at: Date.now() });
	await waitFor(async () => (await getJson(server, "/dsh-open/pending")).body.nonce === "nonce-2", 4000, "pending");

	const ack = await postJson(server, "/dsh-open/ack", { nonce: "nonce-2", workspaceId: "ws-1" });
	assert.equal(ack.status, 200);
	assert.deepEqual(ack.body, { ok: true });
	const persisted = JSON.parse(readFileSync(join(runtimeDir, "ack.json"), "utf8"));
	assert.equal(persisted.nonce, "nonce-2");
	assert.equal(persisted.workspaceId, "ws-1");
	const after = await getJson(server, "/dsh-open/pending");
	assert.equal(after.body.path, null);
});

test("an ack for an unknown nonce is still accepted but does not clear pending", async () => {
	const { runtimeDir, server } = await setup();
	const workspace = makeWorkspace();
	writeRequest(runtimeDir, { path: workspace, nonce: "nonce-3", at: Date.now() });
	await waitFor(async () => (await getJson(server, "/dsh-open/pending")).body.nonce === "nonce-3", 4000, "pending");

	const ack = await postJson(server, "/dsh-open/ack", { nonce: "stale-nonce" });
	assert.equal(ack.status, 200);
	const after = await getJson(server, "/dsh-open/pending");
	assert.equal(after.body.nonce, "nonce-3");
});

test("a request for a nonexistent directory is acked with an error", async () => {
	const { runtimeDir, server } = await setup();
	writeRequest(runtimeDir, { path: "/definitely/not/here", nonce: "nonce-4", at: Date.now() });

	const ack = await waitFor(() => {
		const file = join(runtimeDir, "ack.json");
		return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
	}, 4000, "error ack");
	assert.equal(ack.nonce, "nonce-4");
	assert.equal(ack.error, "not-a-directory");
	const after = await getJson(server, "/dsh-open/pending");
	assert.equal(after.body.path, null);
});

test("a stale request is dropped without an ack", async () => {
	const { runtimeDir, server } = await setup();
	const workspace = makeWorkspace();
	writeRequest(runtimeDir, { path: workspace, nonce: "nonce-5", at: Date.now() - 11 * 60 * 1000 });
	await waitFor(() => !existsSync(join(runtimeDir, "request.json")), 4000, "request consumption");

	const after = await getJson(server, "/dsh-open/pending");
	assert.equal(after.body.path, null);
	assert.equal(existsSync(join(runtimeDir, "ack.json")), false);
});

test("an unparseable request file is dropped", async () => {
	const { runtimeDir, server } = await setup();
	writeFileSync(join(runtimeDir, "request.json"), "{not json");
	await waitFor(() => !existsSync(join(runtimeDir, "request.json")), 4000, "request consumption");
	const after = await getJson(server, "/dsh-open/pending");
	assert.equal(after.body.path, null);
});

test("the ack route rejects a malformed body", async () => {
	const { server } = await setup();
	const response = await fetch(`http://127.0.0.1:${server.port}/dsh-open/ack`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ nope: true }),
	});
	assert.equal(response.status, 400);
});

test("dispose removes the routes and the presence file", async () => {
	const { runtimeDir, server, dispose } = await setup();
	assert.equal(existsSync(join(runtimeDir, "host.json")), true);
	dispose();
	assert.equal(existsSync(join(runtimeDir, "host.json")), false);
	const health = await fetch(`http://127.0.0.1:${server.port}/dsh-open/health`);
	assert.equal(health.status, 404);
});

/**
 * Run `body` with HOME and PATH pointed at a fresh temp home, so the command
 * routes see an empty machine instead of the developer's own directories.
 * @returns whatever `body` returns.
 */
async function inScratchHome(body) {
	const home = mkdtempSync(join(tmpdir(), "dsh-open-home-"));
	const before = { HOME: process.env.HOME, PATH: process.env.PATH };
	process.env.HOME = home;
	process.env.PATH = "/usr/bin:/bin";
	cleanups.push(async () => {
		process.env.HOME = before.HOME;
		process.env.PATH = before.PATH;
		rmSync(home, { recursive: true, force: true });
	});
	return body(home);
}

test("the command route reports an empty machine as not installed", async () => {
	const { server } = await setup();
	await inScratchHome(async () => {
		const { status, body } = await getJson(server, "/dsh-open/command");
		assert.equal(status, 200);
		assert.equal(body.installed, false);
		assert.equal(body.onPath, false);
		assert.equal(body.version, "0.1.0");
		assert.equal(typeof body.binScript, "string");
		assert.equal(body.interpreter.electron, Boolean(process.versions.electron));
	});
});

test("the setup route installs the shim and the command route sees it", async () => {
	const { server } = await setup();
	await inScratchHome(async (home) => {
		const install = await postJson(server, "/dsh-open/setup", { action: "install" }, { "x-dsh-open": "setup" });
		assert.equal(install.status, 200);
		assert.equal(install.body.ok, true);
		assert.equal(install.body.status.installed, true);

		const shimPath = join(home, ".local", "bin", "dsh-open");
		assert.equal(install.body.status.shimPath, shimPath);
		assert.equal(statSync(shimPath).mode & 0o777, 0o755);
		assert.match(readFileSync(shimPath, "utf8"), /dsh-open command shim/);

		const status = await getJson(server, "/dsh-open/command");
		assert.equal(status.body.installed, true);
		assert.equal(status.body.managed, true);

		const remove = await postJson(server, "/dsh-open/setup", { action: "remove" }, { "x-dsh-open": "setup" });
		assert.equal(remove.status, 200);
		assert.equal(remove.body.removed, true);
		assert.equal(existsSync(shimPath), false);
	});
});

test("the setup route is refused without its header", async () => {
	const { server } = await setup();
	await inScratchHome(async () => {
		const { status, body } = await postJson(server, "/dsh-open/setup", { action: "install" });
		assert.equal(status, 403);
		assert.equal(body.error, "missing-header");
	});
});

test("the setup route refuses a cross-origin caller", async () => {
	const { server } = await setup();
	await inScratchHome(async () => {
		const { status, body } = await postJson(server, "/dsh-open/setup", { action: "install" }, {
			"x-dsh-open": "setup",
			origin: "http://evil.example",
		});
		assert.equal(status, 403);
		assert.equal(body.error, "bad-origin");
	});
});

test("the setup route rejects unknown actions", async () => {
	const { server } = await setup();
	await inScratchHome(async () => {
		const { status, body } = await postJson(server, "/dsh-open/setup", { action: "nuke" }, { "x-dsh-open": "setup" });
		assert.equal(status, 400);
		assert.equal(body.error, "bad-action");
	});
});
