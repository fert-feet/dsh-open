/**
 * Client-half tests: the generated bundle must register under the package name,
 * materialize without requiring anything, and turn a pending request into an
 * adopted workspace plus an ack.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const bundleSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/**
 * Evaluate the bundle against a sandbox `window.__ModuleLoader__`.
 * @param overrides - sandbox members to add (fetch, timers, ...).
 * @returns the captured registration and the materialized exports.
 */
function loadBundle(overrides = {}) {
	let registration;
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(spec) {
					registration = spec;
				},
			},
		},
		console,
		...overrides,
	};
	vm.runInNewContext(bundleSource, sandbox);
	assert.ok(registration, "bundle must register with __ModuleLoader__");
	const required = [];
	const exportsObject = registration.factory((id) => {
		required.push(id);
		throw new Error(`unexpected require(${id})`);
	});
	return { registration, exportsObject, required };
}

test("the bundle registers under the package name and exports apply + inject", () => {
	const { registration, exportsObject, required } = loadBundle();
	assert.equal(registration.id, "dsh-app");
	assert.equal(typeof exportsObject.apply, "function");
	assert.equal(JSON.stringify(exportsObject.inject), JSON.stringify(["workspaces", "uiWorkspace"]));
	assert.deepEqual(required, []);
});

/**
 * Build a fake client context whose workspace state is ready immediately.
 * @param acks - collected ack payloads.
 * @param opened - collected openWorkspace calls.
 * @param failCreate - when set, `workspaces.create` rejects with it.
 */
function fakeContext(acks, opened, failCreate) {
	const items = [];
	const created = [];
	const services = {
		workspaces: {
			list: {
				getSnapshot: () => ({ phase: "ready", items }),
			},
			create: async (input) => {
				if (failCreate !== undefined) throw failCreate;
				created.push(input);
				const workspace = { workspaceId: "ws-1", path: input.path };
				items.push(workspace);
				return workspace;
			},
		},
		uiWorkspace: {
			openWorkspace: async (workspaceId) => {
				opened.push(workspaceId);
			},
		},
	};
	let cleanup;
	return {
		created,
		ctx: {
			get: (name) => services[name],
			effect(fn) {
				cleanup = fn();
			},
		},
		dispose: () => cleanup?.(),
	};
}

/**
 * Sandbox factory answering one pending request then nothing.
 * @param response - `{ path, nonce }` to hand out once.
 * @param acks - collected ack payloads.
 */
function fakeNet(response, acks) {
	let pendingCalls = 0;
	return {
		fetch: async (url, init) => {
			if (url === "/dsh-app/pending") {
				pendingCalls += 1;
				return { ok: true, json: async () => (pendingCalls === 1 ? response : { path: null }) };
			}
			if (url === "/dsh-app/ack") {
				acks.push(JSON.parse(init.body));
				return { ok: true };
			}
			throw new Error(`unexpected fetch ${url}`);
		},
		setInterval: () => 1,
		clearInterval: () => {},
		setTimeout,
	};
}

test("a pending request is adopted, opened, and acked with its workspace id", async () => {
	const acks = [];
	const opened = [];
	const { ctx, dispose, created } = fakeContext(acks, opened);
	const { fetch, setInterval, clearInterval } = fakeNet({ path: "/tmp/proj", nonce: "n1" }, acks);
	const { exportsObject } = loadBundle({ fetch, setInterval, clearInterval, setTimeout });
	exportsObject.apply(ctx);
	await new Promise((resolve) => setTimeout(resolve, 100));
	dispose();

	assert.equal(created.length, 1);
	assert.equal(created[0].path, "/tmp/proj");
	assert.equal(opened.length, 1);
	assert.equal(opened[0], "ws-1");
	assert.equal(acks.length, 1);
	assert.equal(acks[0].nonce, "n1");
	assert.equal(acks[0].workspaceId, "ws-1");
});

test("a failing adoption is acked with an error and opens nothing", async () => {
	const acks = [];
	const opened = [];
	const { ctx, dispose } = fakeContext(acks, opened, new Error("host said no"));
	const { fetch, setInterval, clearInterval } = fakeNet({ path: "/tmp/proj", nonce: "n2" }, acks);
	const { exportsObject } = loadBundle({ fetch, setInterval, clearInterval, setTimeout });
	exportsObject.apply(ctx);
	await new Promise((resolve) => setTimeout(resolve, 100));
	dispose();

	assert.deepEqual(opened, []);
	assert.equal(acks.length, 1);
	assert.equal(acks[0].nonce, "n2");
	assert.equal(acks[0].error, "host said no");
});
