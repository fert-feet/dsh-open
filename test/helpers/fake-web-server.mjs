/**
 * A stand-in for `ctx.webServer` with the real service's dispatch semantics:
 * exact routes first, then the longest matching prefix, then 404. It listens on
 * an OS-assigned loopback port so tests exercise the routes over real HTTP
 * instead of calling handlers directly.
 */
import { createServer } from "node:http";

export class FakeWebServer {
	/** @type {Map<string, Function>} */
	#exact = new Map();
	/** @type {Map<string, Function>} */
	#prefixes = new Map();
	#server;
	#port = 0;
	#sockets = new Set();

	/**
	 * Start listening on 127.0.0.1 with an OS-assigned port.
	 * @returns the bound port.
	 */
	async listen() {
		this.#server = createServer((req, res) => this.#dispatch(req, res));
		this.#server.on("connection", (socket) => {
			this.#sockets.add(socket);
			socket.on("close", () => this.#sockets.delete(socket));
		});
		await new Promise((resolve, reject) => {
			this.#server.once("error", reject);
			this.#server.listen(0, "127.0.0.1", resolve);
		});
		this.#port = this.#server.address().port;
		return this.#port;
	}

	/** Bridge for `ctx.webServer.port`. */
	get port() {
		return this.#port;
	}

	/**
	 * Register one route, mirroring the real duplicate-row contract.
	 * @param {{ kind: "exact" | "prefix", path: string, handler: Function }} route
	 * @returns disposer removing the row.
	 */
	register(route) {
		const table = route.kind === "exact" ? this.#exact : this.#prefixes;
		if (table.has(route.path)) throw new Error(`duplicate route ${route.kind} ${route.path}`);
		table.set(route.path, route.handler);
		return () => table.delete(route.path);
	}

	/**
	 * Match and run one request.
	 * @param req - incoming message.
	 * @param res - server response.
	 */
	#dispatch(req, res) {
		const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
		const exact = this.#exact.get(pathname);
		if (exact !== undefined) return exact(req, res);
		let best;
		for (const [prefix, handler] of this.#prefixes) {
			if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
			if (best === undefined || prefix.length > best[0].length) best = [prefix, handler];
		}
		if (best !== undefined) return best[1](req, res);
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
	}

	/** Stop the server, dropping held-open connections. */
	async close() {
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		await new Promise((resolve) => this.#server.close(resolve));
	}
}

/**
 * A minimal cordis-shaped context: `webServer` plus an `effect` seat that
 * records cleanup callbacks so a test can dispose the plugin fiber.
 * @param server - a listening FakeWebServer.
 * @returns `{ ctx, dispose }`.
 */
export function fakeContext(server) {
	const cleanups = [];
	const ctx = {
		webServer: server,
		effect(fn) {
			cleanups.push(fn());
		},
	};
	return {
		ctx,
		dispose() {
			for (const cleanup of cleanups.splice(0).reverse()) cleanup();
		},
	};
}

/**
 * Poll until `predicate` returns a truthy value.
 * @param predicate - sync check.
 * @param timeoutMs - give-up budget.
 * @param label - failure description.
 * @returns the first truthy value.
 */
export async function waitFor(predicate, timeoutMs = 4000, label = "condition") {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/**
 * GET a JSON route.
 * @param server - listening FakeWebServer.
 * @param path - absolute pathname.
 * @returns parsed body and status.
 */
export async function getJson(server, path) {
	const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
	return { status: response.status, body: await response.json() };
}

/**
 * POST a JSON body.
 * @param server - listening FakeWebServer.
 * @param path - absolute pathname.
 * @param body - JSON payload.
 * @returns parsed body and status.
 */
export async function postJson(server, path, body) {
	const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.json() };
}
