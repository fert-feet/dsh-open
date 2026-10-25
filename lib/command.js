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
 * Installing the file is only half of it: `~/.local/bin` is not on a default
 * macOS PATH, so a shim nobody finds has done nothing. The plugin therefore
 * also puts a marked block into the login shell's rc file — the one edit that
 * makes the command work in a fresh terminal without asking the user to type
 * `export PATH=…` themselves. The block is bounded by `RC_BLOCK_BEGIN` /
 * `RC_BLOCK_END`, idempotent, and removed again by "Remove command".
 *
 * Everything here is pure apart from the file writes and the one shell probe,
 * so the tests drive it against a temp HOME.
 */
import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The command users type. */
export const SHIM_NAME = "dsh-open";

/**
 * First line of the generated file. Its presence is what makes a file *ours*:
 * removal refuses to delete anything that does not carry it.
 */
export const SHIM_MARKER = "# dsh-open command shim (managed by the dsh-open plugin)";

/** Start of the PATH block this plugin owns inside a shell rc file. */
export const RC_BLOCK_BEGIN = "# >>> dsh-open >>>";

/** End of the PATH block. Everything between the two markers belongs to us. */
export const RC_BLOCK_END = "# <<< dsh-open <<<";

/** How much of a candidate file to read when checking for the marker. */
const MARKER_PROBE_BYTES = 4096;

/** How long the settings page may wait for the host to answer. */
export const COMMAND_TIMEOUT_MS = 10_000;

/** How long a login shell gets to report its PATH before we give up. */
export const SHELL_PROBE_TIMEOUT_MS = 3000;

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
 * `onPath` describes the host process's own environment; `onLoginPath`
 * describes the user's login shell and is only known when `loginDirs` was
 * supplied (the host probes the shell once per page view). `pathConfigured`
 * says whether the rc block pointing the login shell at the shim's directory
 * is present.
 *
 * @param options - same injection points as {@link candidateDirs}, plus
 *   `loginDirs` — the login shell's PATH, or undefined when it could not be read.
 * @returns `{installed, shimPath, dir, managed, onPath, onLoginPath, loginPathKnown, rcFile, pathConfigured, dirs}`.
 */
export function commandStatus({ home = homedir(), envPath = process.env.PATH ?? "", extra = [], loginDirs, shell } = {}) {
	const dirs = candidateDirs({ home, envPath, extra });
	const pathDirs = new Set(
		envPath
			.split(":")
			.filter(Boolean)
			.map((entry) => resolve(entry)),
	);
	const login = loginDirs === undefined ? undefined : new Set(loginDirs.map((entry) => resolve(entry)));
	const rc = shellRcTarget({ home, shell });
	const rcBlock = rc === undefined ? undefined : readRcBlock(rc.file);
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
		const reachable = login === undefined ? pathDirs.has(dir) : login.has(dir);
		return {
			installed: true,
			shimPath,
			dir,
			managed,
			onPath: pathDirs.has(dir),
			onLoginPath: reachable,
			loginPathKnown: login !== undefined,
			rcFile: rc?.file,
			pathConfigured: rcBlock !== undefined,
			dirs,
		};
	}
	return {
		installed: false,
		shimPath: undefined,
		dir: undefined,
		managed: false,
		onPath: false,
		onLoginPath: false,
		loginPathKnown: login !== undefined,
		rcFile: rc?.file,
		pathConfigured: rcBlock !== undefined,
		dirs,
	};
}

/**
 * Write the shim into the first candidate directory that accepts it.
 *
 * A directory that already holds our shim wins, so re-installing does not
 * scatter copies. Directories are created recursively when missing, which is
 * how `~/.local/bin` appears on a machine that never had one.
 *
 * @param options.script - contents from {@link shimScript}.
 * @returns `{ok: true, shimPath, dir, onPath}` or `{ok: false, reason: "no-writable-directory"}`.
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
			return { ok: true, shimPath, dir, onPath: pathDirs.has(dir) };
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

/**
 * The shell whose rc file should carry the PATH block.
 *
 * `$SHELL` is what a terminal will start; the passwd entry is the fallback for
 * a GUI process that inherited no environment.
 * @returns an absolute shell path.
 */
export function loginShell() {
	const fromEnv = process.env.SHELL?.trim();
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
	try {
		const fromPasswd = userInfo().shell;
		if (typeof fromPasswd === "string" && fromPasswd !== "") return fromPasswd;
	} catch {
		// No passwd entry (containers, some CI images).
	}
	return "/bin/zsh";
}

/**
 * The rc file a login shell reads, and which dialect to write for.
 *
 * A macOS terminal starts a *login* shell, so bash reads `.bash_profile`
 * rather than `.bashrc`; a machine whose only file is `.profile` keeps using
 * it. Unknown shells get no target, because writing a file that nothing reads
 * would be worse than saying so.
 *
 * @param options.shell - defaults to {@link loginShell}.
 * @returns `{file, syntax: "posix" | "fish"}` or undefined.
 */
export function shellRcTarget({ shell = loginShell(), home = homedir() } = {}) {
	const name = shell.split("/").filter(Boolean).pop() ?? "";
	if (name === "zsh") return { file: join(home, ".zshrc"), syntax: "posix" };
	if (name === "fish") return { file: join(home, ".config", "fish", "config.fish"), syntax: "fish" };
	if (name === "bash") {
		const profile = join(home, ".bash_profile");
		const fallback = join(home, ".profile");
		if (!fileExists(profile) && fileExists(fallback)) return { file: fallback, syntax: "posix" };
		return { file: profile, syntax: "posix" };
	}
	if (name === "sh" || name === "dash" || name === "ksh") return { file: join(home, ".profile"), syntax: "posix" };
	return undefined;
}

/**
 * Render the marked PATH block.
 *
 * The directory is prepended: the user pressed "Install command" for *this*
 * plugin's copy, and an earlier `npm link` (or a second install) must not win
 * the lookup silently. The literal path is single-quoted so a space or a
 * quote in the directory cannot change the meaning of the line.
 *
 * @param options.dir - directory holding the shim.
 * @param options.syntax - shell dialect.
 * @returns the block, markers included, ending with a newline.
 */
export function pathBlock({ dir, syntax }) {
	const lines = [
		RC_BLOCK_BEGIN,
		"# Added by the dsh-open plugin so `dsh-open` is found in new terminals.",
		"# Remove it with Settings → Plugins → dsh-open → Remove command.",
	];
	if (syntax === "fish") lines.push(`fish_add_path -g ${quote(dir)}`);
	else lines.push(`export PATH=${quote(dir)}:"$PATH"`);
	lines.push(RC_BLOCK_END);
	return `${lines.join("\n")}\n`;
}

/** Matches the block, plus the newline before it when there is one. */
const RC_BLOCK_PATTERN = /\n?# >>> dsh-open >>>[\s\S]*?# <<< dsh-open <<<\n?/;

/**
 * Read the block currently in `file`.
 * @returns `{begin, end, block}` when the file exists and carries both markers.
 */
export function readRcBlock(file) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const begin = text.indexOf(RC_BLOCK_BEGIN);
	if (begin === -1) return undefined;
	const closing = text.indexOf(RC_BLOCK_END, begin);
	if (closing === -1) return undefined;
	return { begin, end: closing + RC_BLOCK_END.length, block: text.slice(begin, closing + RC_BLOCK_END.length) };
}

/**
 * Put the PATH block into the login shell's rc file, replacing an older copy.
 * @param options.dir - directory holding the shim.
 * @returns `{changed, rcFile, syntax}` or `{changed: false, reason}`.
 */
export function addPathToShell({ dir, shell = loginShell(), home = homedir() } = {}) {
	const target = shellRcTarget({ shell, home });
	if (target === undefined) return { changed: false, reason: "unsupported-shell", shell };
	const block = pathBlock({ dir, syntax: target.syntax });
	let text = "";
	try {
		text = readFileSync(target.file, "utf8");
	} catch {
		// A machine may simply not have the file yet.
	}
	const current = readRcBlock(target.file);
	if (current !== undefined) {
		if (current.block.trim() === block.trim()) return { changed: false, rcFile: target.file, syntax: target.syntax };
		const next = `${text.slice(0, current.begin)}${block.trimEnd()}${text.slice(current.end)}`;
		try {
			writeFileSync(target.file, next);
			return { changed: true, rcFile: target.file, syntax: target.syntax };
		} catch (error) {
			return { changed: false, reason: "write-failed", rcFile: target.file, detail: String(error?.message ?? error) };
		}
	}
	const base = text.replace(/\n+$/, "");
	const next = `${base}${base === "" ? "" : "\n\n"}${block}`;
	try {
		mkdirSync(dirname(target.file), { recursive: true, mode: 0o755 });
		writeFileSync(target.file, next);
		return { changed: true, rcFile: target.file, syntax: target.syntax };
	} catch (error) {
		return { changed: false, reason: "write-failed", rcFile: target.file, detail: String(error?.message ?? error) };
	}
}

/**
 * Take the block back out, leaving the rest of the file as it was.
 * @returns `{changed, rcFile}` or `{changed: false, reason}`.
 */
export function removePathFromShell({ shell = loginShell(), home = homedir() } = {}) {
	const target = shellRcTarget({ shell, home });
	if (target === undefined) return { changed: false, reason: "unsupported-shell", shell };
	let text;
	try {
		text = readFileSync(target.file, "utf8");
	} catch {
		return { changed: false, reason: "no-rc-file", rcFile: target.file };
	}
	if (readRcBlock(target.file) === undefined) return { changed: false, reason: "no-block", rcFile: target.file };
	const next = text.replace(RC_BLOCK_PATTERN, "");
	try {
		writeFileSync(target.file, next);
		return { changed: true, rcFile: target.file };
	} catch (error) {
		return { changed: false, reason: "write-failed", rcFile: target.file, detail: String(error?.message ?? error) };
	}
}

/**
 * Ask the login shell what its PATH is.
 *
 * A GUI app inherits no shell environment, so this is the only way to know
 * whether `~/.local/bin` is actually reachable from the user's terminal. The
 * probe runs the user's own shell with `-lic`, which sources the rc files, and
 * is capped by `timeoutMs` — an rc file with a slow network setup must not
 * hang the settings page. Interactive rc files may print a banner; the last
 * non-empty line is the answer.
 *
 * @param options.shell - shell to run.
 * @param options.timeoutMs - kill after this long.
 * @param options.run - `(shell, args, timeoutMs) => stdout`, injectable for tests.
 * @returns the PATH entries, or undefined when the shell could not be read.
 */
export function loginPathDirs({ shell = loginShell(), timeoutMs = SHELL_PROBE_TIMEOUT_MS, run = runShell } = {}) {
	let output;
	try {
		output = run(shell, ["-lic", 'printf %s "$PATH"'], timeoutMs);
	} catch {
		return undefined;
	}
	const lines = String(output ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const answer = lines.pop();
	if (answer === undefined || answer === "") return undefined;
	const dirs = answer.split(":").filter(Boolean);
	return dirs.length === 0 ? undefined : dirs;
}

/**
 * Default probe runner.
 * @returns standard output as text.
 */
function runShell(shell, args, timeoutMs) {
	return execFileSync(shell, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
}

/** Whether `file` exists and carries the marker. */
function isOurShim(file) {
	try {
		return readFileSync(file).subarray(0, MARKER_PROBE_BYTES).includes(SHIM_MARKER);
	} catch {
		return false;
	}
}

/** Whether `file` is an existing regular file. */
function fileExists(file) {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}
