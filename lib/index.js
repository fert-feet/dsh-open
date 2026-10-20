/**
 * dsh-app host half — the bridge between the `dsh-app` command line and the
 * browser half.
 *
 * The CLI drops request.json into the shared runtime directory; this half
 * watches it, validates the target, and hands the request to the browser half
 * over two same-origin HTTP routes (the desktop window loads the host's own
 * origin, so no port discovery and no cross-origin fence are involved). The
 * browser half acks after it has created the workspace and opened a session,
 * and that ack is what unblocks the CLI.
 *
 * Files in `runtimeDir`:
 *   request.json — written by the CLI, consumed (deleted) by this half
 *   ack.json     — written by this half after the browser half acks or the
 *                  request turns out to be unusable
 *   host.json    — presence record so the CLI can tell a live host from a
 *                  stale one before deciding to launch the app
 *   host.log     — append-only breadcrumbs; the app's stdout is not ours
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Cordis plugin name, matched by the bundle patch row id. */
export const name = "dsh-app";

/** The dialogs both halves depend on. */
export const inject = ["webServer"];

const ROUTE_PENDING = "/dsh-app/pending";
const ROUTE_ACK = "/dsh-app/ack";
const ROUTE_HEALTH = "/dsh-app/health";

/** A request older than this is a leftover, not an intent. */
const REQUEST_STALE_MS = 10 * 60 * 1000;

/** Body cap for the ack route; the payload is three short fields. */
const MAX_BODY_BYTES = 64 * 1024;

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * Resolve the shared runtime directory.
 * @param config - plugin config from the bundle patch row.
 * @returns absolute directory path.
 */
export function resolveRuntimeDir(config = {}) {
	const configured = typeof config.runtimeDir === "string" && config.runtimeDir.trim() !== "" ? config.runtimeDir : undefined;
	if (configured !== undefined) return resolve(configured);
	return resolve(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "run", "dsh-app");
}

/**
 * Read a JSON file, treating any failure (missing, truncated, not JSON) as absent.
 * @param file - absolute path.
 * @returns the parsed value, or undefined.
 */
export function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Write a JSON file through a sibling temp file plus rename, so a watcher can
 * never read a half-written payload.
 * @param file - destination path.
 * @param value - JSON-serializable value.
 */
export function writeJsonAtomic(file, value) {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	// rename over an existing destination is atomic on POSIX.
	renameSync(tmp, file);
}

/**
 * Whether a path is an existing directory.
 * @param path - absolute path.
 * @returns true when stat succeeds and reports a directory.
 */
export function directoryExists(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Validate one request payload.
 * @param value - parsed request.json.
 * @param now - clock.
 * @returns a normalized request, or undefined when unusable.
 */
export function normalizeRequest(value, now = Date.now()) {
	if (value === null || typeof value !== "object") return undefined;
	if (typeof value.path !== "string" || !value.path.startsWith("/")) return undefined;
	if (typeof value.nonce !== "string" || value.nonce === "") return undefined;
	const at = typeof value.at === "number" ? value.at : now;
	if (now - at > REQUEST_STALE_MS) return undefined;
	return { path: value.path, nonce: value.nonce, at };
}

/**
 * Collect a small JSON request body.
 * @param req - incoming message.
 * @returns parsed body, or undefined when oversized or unparseable.
 */
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) return undefined;
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Mount the bridge.
 * @param ctx - cordis context carrying `webServer`.
 * @param config - `{ runtimeDir }` from the bundle patch row.
 */
export function apply(ctx, config = {}) {
	const runtimeDir = resolveRuntimeDir(config);
	mkdirSync(runtimeDir, { recursive: true });
	const requestFile = join(runtimeDir, "request.json");
	const ackFile = join(runtimeDir, "ack.json");
	const hostFile = join(runtimeDir, "host.json");
	const logFile = join(runtimeDir, "host.log");

	/** @type {{ path: string, nonce: string, at: number } | undefined} */
	let pending;
	/** @type {import("node:fs").FSWatcher | undefined} */
	let watcher;
	const disposers = [];

	const note = (line) => {
		try {
			appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
		} catch {
			// Breadcrumbs are best effort; a full disk must not break the bridge.
		}
	};

	const respond = (res, status, body) => {
		const text = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"content-length": Buffer.byteLength(text),
		});
		res.end(text);
	};

	const ack = (nonce, extra = {}) => {
		writeJsonAtomic(ackFile, { nonce, at: Date.now(), ...extra });
		note(`ack ${nonce} ${JSON.stringify(extra)}`);
	};

	const removeQuietly = (file) => {
		try {
			unlinkSync(file);
		} catch {
			// Already consumed by another path.
		}
	};

	/**
	 * Take one request.json: delete it and either queue it for the browser half
	 * or ack the failure so the CLI does not sit out the whole timeout.
	 */
	const consumeRequest = () => {
		const raw = readJson(requestFile);
		removeQuietly(requestFile);
		if (raw === undefined) return;
		const request = normalizeRequest(raw);
		if (request === undefined) {
			note(`dropped unusable request ${JSON.stringify(raw)}`);
			return;
		}
		if (!directoryExists(request.path)) {
			ack(request.nonce, { error: "not-a-directory", path: request.path });
			return;
		}
		pending = request;
		note(`queued ${request.path}`);
	};

	disposers.push(
		ctx.webServer.register({
			kind: "exact",
			path: ROUTE_HEALTH,
			handler: (req, res) => {
				if (req.method !== "GET") return respond(res, 405, { error: "method-not-allowed" });
				respond(res, 200, {
					ok: true,
					pid: process.pid,
					port: ctx.webServer.port,
					profile: process.env.DSH_PROFILE ?? null,
					version: VERSION,
					pending: pending === undefined ? null : pending.path,
				});
			},
		}),
	);

	disposers.push(
		ctx.webServer.register({
			kind: "exact",
			path: ROUTE_PENDING,
			handler: (req, res) => {
				if (req.method !== "GET") return respond(res, 405, { error: "method-not-allowed" });
				if (pending === undefined) return respond(res, 200, { path: null });
				respond(res, 200, { path: pending.path, nonce: pending.nonce });
			},
		}),
	);

	disposers.push(
		ctx.webServer.register({
			kind: "exact",
			path: ROUTE_ACK,
			handler: async (req, res) => {
				if (req.method !== "POST") return respond(res, 405, { error: "method-not-allowed" });
				const body = await readBody(req);
				if (body === null || typeof body !== "object" || typeof body.nonce !== "string") {
					return respond(res, 400, { error: "bad-body" });
				}
				if (pending !== undefined && pending.nonce === body.nonce) pending = undefined;
				ack(body.nonce, {
					workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : null,
					error: typeof body.error === "string" ? body.error : undefined,
				});
				respond(res, 200, { ok: true });
			},
		}),
	);

	watcher = watch(runtimeDir, { persistent: false }, (_event, filename) => {
		if (filename !== "request.json") return;
		try {
			consumeRequest();
		} catch (error) {
			note(`consume failed: ${String(error)}`);
		}
	});

	// A cold start writes request.json before this half exists.
	consumeRequest();

	writeJsonAtomic(hostFile, { pid: process.pid, port: ctx.webServer.port, at: Date.now(), version: VERSION });

	const cleanup = () => {
		try {
			watcher?.close();
		} catch {
			// Already closed.
		}
		for (const dispose of disposers.splice(0).reverse()) {
			try {
				dispose();
			} catch {
				// Fiber teardown is best effort.
			}
		}
		removeQuietly(hostFile);
	};

	if (typeof ctx.effect === "function") ctx.effect(() => cleanup);
	else if (typeof ctx.on === "function") ctx.on("dispose", cleanup);
}
