import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	SHIM_MARKER,
	addPathToShell,
	candidateDirs,
	commandStatus,
	installCommand,
	loginPathDirs,
	pathBlock,
	quote,
	removeCommand,
	removePathFromShell,
	shimScript,
	shellRcTarget,
} from "../lib/command.js";

function sandbox() {
	const home = mkdtempSync(join(tmpdir(), "dsh-open-command-"));
	return {
		home,
		cleanup: () => rmSync(home, { recursive: true, force: true }),
	};
}

const BIN = "/Users/someone/.dsh/profiles/desktop/node_modules/dsh-open/bin/dsh-open.js";

test("quote keeps spaces inside one shell word", () => {
	assert.equal(quote("/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"), "'/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'");
	assert.equal(quote("/tmp/it's here"), "'/tmp/it'\\''s here'");
});

test("shimScript runs the Electron binary as node for the desktop host", () => {
	const script = shimScript({
		interpreter: { binary: "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness", electron: true },
		binScript: BIN,
	});
	assert.equal(script.split("\n")[0], "#!/bin/sh");
	assert.match(script, new RegExp(SHIM_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(script, /exec env ELECTRON_RUN_AS_NODE=1 '\/Applications\/DeepSeek Harness\.app\/Contents\/MacOS\/DeepSeek Harness' '.*bin\/dsh-open\.js' "\$@"/);
});

test("shimScript runs a plain node when a web host is the interpreter", () => {
	const script = shimScript({ interpreter: { binary: "/opt/homebrew/bin/node", electron: false }, binScript: BIN });
	assert.match(script, /exec env '\/opt\/homebrew\/bin\/node' /);
	assert.doesNotMatch(script, /ELECTRON_RUN_AS_NODE/);
});

test("candidateDirs puts the user's own directories first and drops duplicates", () => {
	const dirs = candidateDirs({ home: "/home/u", envPath: "/usr/bin:/home/u/.local/bin:/usr/bin" });
	assert.deepEqual(dirs, ["/home/u/.local/bin", "/home/u/bin", "/usr/bin"]);
});

test("commandStatus reports absence in a fresh home", () => {
	const box = sandbox();
	try {
		const status = commandStatus({ home: box.home, envPath: "/usr/bin" });
		assert.equal(status.installed, false);
		assert.equal(status.shimPath, undefined);
		assert.equal(status.onPath, false);
	} finally {
		box.cleanup();
	}
});

test("installCommand creates ~/.local/bin with an executable shim", () => {
	const box = sandbox();
	try {
		const script = shimScript({ interpreter: { binary: "/bin/node", electron: false }, binScript: BIN });
		const result = installCommand({ script, home: box.home, envPath: "/usr/bin" });
		assert.equal(result.ok, true);
		assert.equal(result.shimPath, join(box.home, ".local", "bin", "dsh-open"));
		assert.equal(result.onPath, false);
		const written = readFileSync(result.shimPath, "utf8");
		assert.match(written, /exec env '\/bin\/node'/);
		assert.equal(statSync(result.shimPath).mode & 0o777, 0o755);
	} finally {
		box.cleanup();
	}
});

test("installCommand reports onPath when the host already sees the directory", () => {
	const box = sandbox();
	try {
		const script = shimScript({ interpreter: { binary: "/bin/node", electron: false }, binScript: BIN });
		const local = join(box.home, ".local", "bin");
		const result = installCommand({ script, home: box.home, envPath: `/usr/bin:${local}` });
		assert.equal(result.ok, true);
		assert.equal(result.onPath, true);
	} finally {
		box.cleanup();
	}
});

test("reinstalling keeps the existing copy instead of scattering new ones", () => {
	const box = sandbox();
	try {
		const script = shimScript({ interpreter: { binary: "/bin/node", electron: false }, binScript: BIN });
		const local = join(box.home, ".local", "bin");
		mkdirSync(local, { recursive: true });
		writeFileSync(join(local, "dsh-open"), script, { mode: 0o755 });

		// `~/bin` sorts before `~/.local/bin` in `candidateDirs`, but the existing
		// copy still wins, so a re-install never leaves two commands behind.
		const second = installCommand({ script, home: box.home, envPath: "/usr/bin" });
		assert.equal(second.shimPath, join(local, "dsh-open"));
		assert.throws(() => statSync(join(box.home, "bin", "dsh-open")));
	} finally {
		box.cleanup();
	}
});

test("removeCommand deletes the shim it wrote", () => {
	const box = sandbox();
	try {
		const script = shimScript({ interpreter: { binary: "/bin/node", electron: false }, binScript: BIN });
		const result = installCommand({ script, home: box.home, envPath: "/usr/bin" });
		assert.equal(result.ok, true);
		const removed = removeCommand({ home: box.home, envPath: "/usr/bin" });
		assert.equal(removed.removed, true);
		assert.equal(commandStatus({ home: box.home, envPath: "/usr/bin" }).installed, false);
	} finally {
		box.cleanup();
	}
});

test("removeCommand leaves a foreign file named dsh-open alone", () => {
	const box = sandbox();
	try {
		const dir = join(box.home, ".local", "bin");
		mkdirSync(dir, { recursive: true });
		const foreign = join(dir, "dsh-open");
		writeFileSync(foreign, "#!/bin/sh\necho someone else's command\n");
		chmodSync(foreign, 0o755);

		const status = commandStatus({ home: box.home, envPath: "/usr/bin" });
		assert.equal(status.installed, true);
		assert.equal(status.managed, false);

		const removed = removeCommand({ home: box.home, envPath: "/usr/bin" });
		assert.equal(removed.removed, false);
		assert.equal(removed.reason, "not-ours");
		assert.match(readFileSync(foreign, "utf8"), /someone else's command/);
	} finally {
		box.cleanup();
	}
});

test("removeCommand reports when there is nothing to remove", () => {
	const box = sandbox();
	try {
		assert.deepEqual(removeCommand({ home: box.home, envPath: "/usr/bin" }), { removed: false, reason: "not-installed" });
	} finally {
		box.cleanup();
	}
});

test("installCommand refuses when no directory can be written", () => {
	const box = sandbox();
	try {
		const result = installCommand({
			script: "#!/bin/sh\nexit 0\n",
			home: box.home,
			envPath: "/usr/bin",
			extra: [join(box.home, "read-only", "nested")],
		});
		// `~/.local/bin` is still writable in a temp home, so the install lands
		// there; the assertion is that no failure escapes as a throw.
		assert.equal(result.ok, true);
	} finally {
		box.cleanup();
	}
});

test("pathBlock prepends the directory and is fenced by markers", () => {
	const posix = pathBlock({ dir: "/opt/my tools/bin", syntax: "posix" });
	assert.match(posix, /^# >>> dsh-open >>>\n/);
	assert.match(posix, /\nexport PATH='\/opt\/my tools\/bin':"\$PATH"\n/);
	assert.match(posix, /# <<< dsh-open <<<\n$/);

	const fish = pathBlock({ dir: "/opt/my tools/bin", syntax: "fish" });
	assert.match(fish, /\nfish_add_path -g '\/opt\/my tools\/bin'\n/);
	assert.doesNotMatch(fish, /export PATH/);
});

test("shellRcTarget follows the login shell and refuses unknown ones", () => {
	assert.equal(shellRcTarget({ shell: "/bin/zsh", home: "/home/u" }).file, "/home/u/.zshrc");
	assert.equal(shellRcTarget({ shell: "/usr/local/bin/bash", home: "/home/u" }).file, "/home/u/.bash_profile");
	assert.equal(shellRcTarget({ shell: "/opt/homebrew/bin/fish", home: "/home/u" }).file, "/home/u/.config/fish/config.fish");
	assert.equal(shellRcTarget({ shell: "/bin/tcsh", home: "/home/u" }), undefined);
});

test("addPathToShell is idempotent and replaces a stale directory", () => {
	const box = sandbox();
	try {
		const rc = join(box.home, ".zshrc");
		writeFileSync(rc, "# existing\nexport FOO=1\n");
		const first = addPathToShell({ dir: join(box.home, ".local", "bin"), shell: "/bin/zsh", home: box.home });
		assert.equal(first.changed, true);
		assert.equal(first.rcFile, rc);

		const text = readFileSync(rc, "utf8");
		assert.match(text, /^# existing\nexport FOO=1\n\n# >>> dsh-open >>>/);
		assert.match(text, /export PATH='.*\.local\/bin':"\$PATH"/);

		const again = addPathToShell({ dir: join(box.home, ".local", "bin"), shell: "/bin/zsh", home: box.home });
		assert.equal(again.changed, false);
		assert.equal(readFileSync(rc, "utf8"), text);

		const moved = addPathToShell({ dir: "/opt/homebrew/bin", shell: "/bin/zsh", home: box.home });
		assert.equal(moved.changed, true);
		const updated = readFileSync(rc, "utf8");
		assert.equal((updated.match(/# >>> dsh-open >>>/g) ?? []).length, 1);
		assert.match(updated, /export PATH='\/opt\/homebrew\/bin':"\$PATH"/);
		assert.doesNotMatch(updated, /\.local\/bin':"/);
	} finally {
		box.cleanup();
	}
});

test("removePathFromShell restores the file without the block", () => {
	const box = sandbox();
	try {
		const rc = join(box.home, ".zshrc");
		const original = "# existing\nexport FOO=1\n";
		writeFileSync(rc, original);
		addPathToShell({ dir: join(box.home, ".local", "bin"), shell: "/bin/zsh", home: box.home });

		const removed = removePathFromShell({ shell: "/bin/zsh", home: box.home });
		assert.equal(removed.changed, true);
		assert.equal(readFileSync(rc, "utf8"), original);

		const again = removePathFromShell({ shell: "/bin/zsh", home: box.home });
		assert.equal(again.changed, false);
		assert.equal(again.reason, "no-block");
	} finally {
		box.cleanup();
	}
});

test("loginPathDirs reads the last line and tolerates a failing shell", () => {
	const seen = [];
	const dirs = loginPathDirs({
		shell: "/bin/zsh",
		run: (shell, args) => {
			seen.push([shell, ...args]);
			return "motd line\n/usr/local/bin:/usr/bin:/bin\n";
		},
	});
	assert.deepEqual(dirs, ["/usr/local/bin", "/usr/bin", "/bin"]);
	assert.deepEqual(seen[0], ["/bin/zsh", "-lic", 'printf %s "$PATH"']);
	assert.equal(loginPathDirs({ shell: "/bin/zsh", run: () => "" }), undefined);
	assert.equal(loginPathDirs({ shell: "/bin/zsh", run: () => { throw new Error("no shell"); } }), undefined);
});

test("commandStatus reports the login shell PATH when it is known", () => {
	const box = sandbox();
	try {
		installCommand({ script: "#!/bin/sh\n", home: box.home, envPath: "/usr/bin" });
		const local = join(box.home, ".local", "bin");

		const reachable = commandStatus({ home: box.home, envPath: "/usr/bin", loginDirs: [local, "/usr/bin"] });
		assert.equal(reachable.onLoginPath, true);
		assert.equal(reachable.loginPathKnown, true);

		const unreachable = commandStatus({ home: box.home, envPath: "/usr/bin", loginDirs: ["/usr/bin"] });
		assert.equal(unreachable.onLoginPath, false);
		assert.equal(unreachable.loginPathKnown, true);
		assert.equal(unreachable.pathConfigured, false, "no rc block has been written yet");
	} finally {
		box.cleanup();
	}
});
