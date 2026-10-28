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
 * @param platformModules - modules the loader's `require` resolves.
 * @returns the captured registration and the materialized exports.
 */
function loadBundle(overrides = {}, platformModules = {}) {
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
		if (id in platformModules) return platformModules[id];
		throw new Error(`unexpected require(${id})`);
	});
	return { registration, exportsObject, required };
}

test("the bundle registers under the package name and exports apply + inject", () => {
	const { registration, exportsObject, required } = loadBundle();
	assert.equal(registration.id, "dsh-open");
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
function fakeContext(acks, opened, failCreate, extraServices = {}) {
	const items = [];
	const created = [];
	const services = {
		...extraServices,
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
			if (url === "/dsh-open/pending") {
				pendingCalls += 1;
				return { ok: true, json: async () => (pendingCalls === 1 ? response : { path: null }) };
			}
			if (url === "/dsh-open/ack") {
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

test("apply is a no-op beyond the bridge when no slots service exists", () => {
	const acks = [];
	const opened = [];
	const { ctx, dispose } = fakeContext(acks, opened);
	const { fetch, setInterval, clearInterval } = fakeNet({ path: null }, acks);
	const { exportsObject } = loadBundle({ fetch, setInterval, clearInterval, setTimeout });
	assert.doesNotThrow(() => exportsObject.apply(ctx));
	dispose();
});

test("the settings page registers as a sidebar section and a Plugins tab", () => {
	const registered = [];
	const injected = [];
	const slots = {
		inject(name, callback) {
			injected.push(name);
			return callback();
		},
		register(contribution, component) {
			registered.push({ contribution, component });
			return () => {};
		},
	};
	const { ctx, dispose } = fakeContext([], [], undefined, { slots });
	const { fetch, setInterval, clearInterval } = fakeNet({ path: null }, []);
	const { exportsObject } = loadBundle({ fetch, setInterval, clearInterval, setTimeout });
	exportsObject.apply(ctx);
	dispose();

	assert.deepEqual(injected, ["settings.section", "settings.plugins.tab"]);
	assert.equal(registered.length, 2);
	const [section, tab] = registered;
	assert.equal(section.contribution.name, "settings.section");
	assert.equal(section.contribution.id, "dsh-open");
	assert.equal(section.contribution.order, 45);
	assert.equal(section.contribution.label(), "dsh-open");
	assert.equal(typeof section.component, "function");
	assert.equal(tab.contribution.name, "settings.plugins.tab");
	assert.equal(tab.contribution.id, "dsh-open");
	assert.equal(tab.contribution.order, 40);
	assert.equal(tab.contribution.label(), "dsh-open");
	assert.equal(typeof tab.component, "function");
});

test("the nav icon claims only its own settings row, then releases it", () => {
	const MARK = "data-dsh-open-nav-icon";
	const row = (text) => ({
		textContent: text,
		attributes: new Set(),
		setAttribute(name) {
			this.attributes.add(name);
		},
		removeAttribute(name) {
			this.attributes.delete(name);
		},
	});
	const rows = [row("插件列表"), row("dsh-open"), row("bili 设置")];
	const styles = [];
	const document = {
		head: { appendChild: (element) => styles.push(element) },
		body: {},
		createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
		querySelector: (selector) => (selector === '[role="dialog"]' ? {} : null),
		querySelectorAll: (selector) =>
			selector === '[role="dialog"] nav button' ? rows : rows.filter((candidate) => candidate.attributes.has(MARK)),
	};
	const { ctx, dispose } = fakeContext([], []);
	const { fetch, setInterval, clearInterval } = fakeNet({ path: null }, []);
	const { exportsObject } = loadBundle({
		fetch,
		setInterval,
		clearInterval,
		setTimeout,
		document,
		queueMicrotask,
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
	});
	// The registration loop runs all three contributions; the nav icon is last,
	// so its cleanup is the one fakeContext keeps.
	assert.equal(typeof ctx.get("slots"), "undefined");
	exportsObject.apply(ctx);

	assert.deepEqual(
		rows.map((candidate) => candidate.attributes.has(MARK)),
		[false, true, false],
	);
	assert.match(styles[0].textContent, /mask-image/);
	assert.equal(styles[0].dataset.plugin, "dsh-open");

	dispose();
	assert.equal(rows[1].attributes.has(MARK), false);
});
