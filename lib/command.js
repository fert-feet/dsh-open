/**
 * The `dsh-open` command shim — what the settings page installs.
 *
 * `dsh plugin add` puts the package in the profile's `node_modules` and links
 * its bin into the profile's own `node_modules/.bin`, a directory no shell
 * puts on the PATH. The missing piece is therefore one small file in a
 * directory the user's shell *does* search, pointing at the `bin/dsh-open.js`
 * that is already on disk. Writing that file needs no network, no npm, and no
 * write access outside the user's home.
 *
 * Everything here is pure apart from the file writes, so the tests drive it
 * against a temp HOME.
 */
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The command users type. */
export const SHIM_NAME = "dsh-open";

/**
 * First line of the generated file. Its presence is what makes a file *ours*:
 * removal refuses to delete anything that does not carry it.
 */
export const SHIM_MARKER = "# dsh-open command shim (managed by the dsh-open plugin)";

/** How much of a candidate file to read when checking for the marker. */
const MARKER_PROBE_BYTES = 4096;

/** How long the settings page may wait for the host to answer. */
export const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Directories worth looking in for the shim, in the order they are tried.
 *
 * The user's own `~/.local/bin` and `~/bin` come first because they need no
 * privileges; directories from the host process's PATH follow, so a host that
 * was started from a shell carrying e.g. `/opt/homebrew/bin` can install there
 * too. `~/.local/bin` is created on demand.
 *
 * @param options - `home` and `envPath` are injectable for tests.
 * @returns absolute, de-duplicated directory paths.
 */
export function candidateDirs({ home = homedir(), envPath = process.env.PATH ?? "", extra = [] } = {}) {
	const preferred = [join(home, ".local", "bin"), join(home, "bin")];
	const fromPath = envPath
		.split(":")
		.filter(Boolean)
		.map((entry) => resolve(entry));
	return [...new Set([...extra, ...preferred, ...fromPath])];
}

/**
 * Single-quote a path for `sh`, including paths that contain spaces or quotes.
 * @param value - literal path.
 * @returns the quoted form.
 */
export function quote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Render the shim.
 *
 * The interpreter is the process that runs the host half — the Electron binary
 * with `ELECTRON_RUN_AS_NODE=1` when the desktop app is hosting, plain `node`
 * when a `dsh web` host is. Either way the wrapper needs no PATH lookup and no
 * node version probing at run time.
 *
 * @param options.interpreter - `{ binary, electron }`.
 * @param options.binScript - absolute path to `bin/dsh-open.js`.
 * @returns the file contents.
 */
export function shimScript({ interpreter, binScript }) {
	const env = interpreter.electron ? "ELECTRON_RUN_AS_NODE=1 " : "";
	return [
		"#!/bin/sh",
		SHIM_MARKER,
		"# Remove this file to uninstall the command.",
		`exec env ${env}${quote(interpreter.binary)} ${quote(binScript)} "$@"`,
		"",
	].join("\n");
}

/**
 * Work out whether the command is installed, whether it is on a PATH the
 * *host* can see, and whether the file found is ours.
 *
 * `onPath` is advisory: the host's PATH and the user's interactive shell PATH
 * are not the same list, so the page phrases it as "on this PATH", not "works
 * in your terminal".
 *
 * @param options - same injection points as {@link candidateDirs}.
 * @returns `{installed, shimPath, managed, onPath, dirs}` with `shimPath` undefined when absent.
 */
export function commandStatus({ home = homedir(), envPath = process.env.PATH ?? "", extra = [] } = {}) {
	const dirs = candidateDirs({ home, envPath, extra });
	const pathDirs = new Set(
		envPath
			.split(":")
			.filter(Boolean)
			.map((entry) => resolve(entry)),
	);
	for (const dir of dirs) {
		const shimPath = join(dir, SHIM_NAME);
		let stats;
		try {
			stats = statSync(shimPath);
		} catch {
			continue;
		}
		if (!stats.isFile()) continue;
		let managed = false;
		try {
			managed = readFileSync(shimPath).subarray(0, MARKER_PROBE_BYTES).includes(SHIM_MARKER);
		} catch {
			managed = false;
		}
		return { installed: true, shimPath, managed, onPath: pathDirs.has(dir), dirs };
	}
	return { installed: false, shimPath: undefined, managed: false, onPath: false, dirs };
}

/**
 * Write the shim into the first candidate directory that accepts it.
 *
 * A directory that already holds our shim wins, so re-installing does not
 * scatter copies. Directories are created recursively when missing, which is
 * how `~/.local/bin` appears on a machine that never had one.
 *
 * @param options.script - contents from {@link shimScript}.
 * @returns `{ok: true, shimPath, onPath}` or `{ok: false, reason: "no-writable-directory"}`.
 */
export function installCommand({ script, home = homedir(), envPath = process.env.PATH ?? "", extra = [] } = {}) {
	const dirs = candidateDirs({ home, envPath, extra });
	const pathDirs = new Set(
		envPath
			.split(":")
			.filter(Boolean)
			.map((entry) => resolve(entry)),
	);
	const ordered = [...dirs].sort((left, right) => {
		const a = isOurShim(join(left, SHIM_NAME)) ? 0 : 1;
		const b = isOurShim(join(right, SHIM_NAME)) ? 0 : 1;
		return a - b;
	});
	for (const dir of ordered) {
		const shimPath = join(dir, SHIM_NAME);
		try {
			mkdirSync(dir, { recursive: true, mode: 0o755 });
			accessSync(dir, constants.W_OK);
			writeFileSync(shimPath, script, { mode: 0o755 });
			chmodSync(shimPath, 0o755);
			return { ok: true, shimPath, onPath: pathDirs.has(dir) };
		} catch {
			continue;
		}
	}
	return { ok: false, reason: "no-writable-directory" };
}

/**
 * Delete the shim, but only a file this plugin wrote.
 * @returns `{removed: true, shimPath}` or `{removed: false, reason}`.
 */
export function removeCommand({ home = homedir(), envPath = process.env.PATH ?? "", extra = [] } = {}) {
	const status = commandStatus({ home, envPath, extra });
	if (!status.installed || status.shimPath === undefined) return { removed: false, reason: "not-installed" };
	if (!status.managed) return { removed: false, reason: "not-ours", shimPath: status.shimPath };
	try {
		rmSync(status.shimPath);
		return { removed: true, shimPath: status.shimPath };
	} catch (error) {
		return { removed: false, reason: "unlink-failed", shimPath: status.shimPath, detail: String(error?.message ?? error) };
	}
}

/** Whether `file` exists and carries the marker. */
function isOurShim(file) {
	try {
		return readFileSync(file).subarray(0, MARKER_PROBE_BYTES).includes(SHIM_MARKER);
	} catch {
		return false;
	}
}
