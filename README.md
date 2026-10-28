# dsh-open

`dsh-open .` — open a folder in the running DeepSeek Harness desktop app, the way
`code .` opens one in VS Code.

The app itself has no such entry point: its Electron shell only reads `--updated`,
`dsh://` links only focus an existing window, and a second launch just raises the
first. This plugin adds the missing channel — a command that hands a directory to
the app already open on screen, starting it first when nothing is running.

```
dsh-open ~/Project/foo      # open foo
dsh-open                    # open the current directory
dsh-open --no-launch .      # send to a host that must already be running
```

The app comes to the front with that folder as the workspace. A cold start works
too: the request is written to disk before the app boots, and the host half picks
it up when it activates.

## Status

Source install today; npm package and the [plugin catalog](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
entry follow. Until then, install from a checkout (below).

## Requirements

- DeepSeek Harness **0.2.x** with the desktop app (the browser half needs the
  `workspaces` and `uiWorkspace` client services)
- Node.js **22+** (only the CLI and the installer run it)
- macOS for the cold-start path; `--no-launch` works on any platform

## Install

```sh
git clone https://github.com/fert-feet/dsh-open
cd dsh-open
node scripts/install.mjs
```

Then get the command onto PATH. Open **Settings → dsh-open → Install command**
(also reachable as a tab of **Settings → 内置插件 / Plugins**), which
does the whole job in one click — no terminal, no npm, no manual `export PATH`:

- it writes a small wrapper to `~/.local/bin` (or the first writable directory on
  its PATH) that runs the copy already installed in the profile, and
- and it adds that directory to your login shell's profile — a marked
  `# >>> dsh-open >>>` block in `~/.zshrc`, `~/.bash_profile` or
  `~/.config/fish/config.fish`, whichever shell `$SHELL` names. Open a new
  terminal to pick it up.

**Remove command** takes both back out. A `dsh-open` the plugin did not write is
never touched; the page says so and installs its own copy alongside.

Alternative for a developer: `npm link` links the checkout's bin into the global
prefix.

`install.mjs` edits the desktop profile at `$DSH_HOME/profiles/desktop`
(`~/.dsh` by default) in exactly four ways:

| what | why |
| --- | --- |
| `package.json` → `dependencies["dsh-open"] = "file:<this checkout>"` | pins the plugin in place |
| `package.json` → `dsh.profile.bundles += "dsh-open"` | the app loads it at boot |
| `cordis.patch.yml` → `- insert: [{ id: dsh-open, name: dsh-open }]` | mounts the host half |
| `node_modules/dsh-open` → symlink to this checkout | the loader resolves the name |

Every edited file is copied to `*.dsh-open-<stamp>.bak` first, and any failure
restores all of them. Installing twice is a no-op.

The app reads profile bundles at boot, so **quit and reopen DeepSeek Harness**
once after installing. If your shell has no profile the plugin recognises, the
settings page says so and you add the directory to PATH yourself:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

## How it works

```
 dsh-open <dir>                 DeepSeek Harness (desktop app)
 ─────────────                 ────────────────────────────────
 write run/dsh-open/request.json      host half (plugin, cordis)
        │  { path, nonce, at }             │ fs.watch + cold-start read
        │                                  ▼
        │                            queue, validate directory
        │                                  │ GET /dsh-open/pending
        │                                  ▼
        │                            browser half (window.__ModuleLoader__)
        │                                  │ workspaces.create({ path })
        │                                  │ uiWorkspace.openWorkspace(id)
        │  POST /dsh-open/ack ◀─────────────┘
        ▼  { nonce }
  exit 0 / 1
```

`$DSH_HOME/run/dsh-open` is the shared mailbox (`$DSH_HOME` defaults to `~/.dsh`;
the desktop app and `dsh web` both use it):

- `request.json` — written by the CLI, consumed and deleted by the host
- `ack.json` — written by the host, read and deleted by the CLI
- `host.json` — presence record `{ pid, port, at, version }`, removed on shutdown
- `host.log` — breadcrumbs (`queued`, `ack`, `dropped`)

The host half is a cordis plugin (`lib/index.js`, zero dependencies) that
registers five exact routes on `ctx.webServer` and disposes them with its fiber:
the three mailbox routes above, plus `GET /dsh-open/command` (status, including
whether the login shell finds the shim) and `POST /dsh-open/setup`
(install/remove the shim and its PATH block).

The browser half (`lib/client.js`, bundled from `src/client.js`) declares
`inject: ["workspaces", "uiWorkspace"]`, so cordis hands it both services. It
polls the mailbox and contributes the settings page twice: a **dsh-open** entry
in the Settings sidebar (`settings.section`, order 45, next to WeChat and the
market) and a tab inside the built-in Plugins section (`settings.plugins.tab`,
order 40). Either registration is inert on a deployment that does not compose
that slot.

The page itself is one card: a status pill (Ready / Not installed / Installed
elsewhere / Unavailable), a sentence saying what to do, a details grid (command,
install location, whether the login shell PATH carries it) and the single
primary action plus Refresh. Copy follows the browser language (Chinese or
English), and colours come from DSH's `--dsw-alias-*` theme tokens, so light and
dark both work.

## Security

- The three routes live on the host's loopback server and **are not
  authenticated**: any process on the machine can queue a directory name. What
  that buys is a workspace switch — the plugin never reads file contents, never
  runs a command, and only `stat`s the path to confirm it is a directory.
- `POST /dsh-open/setup` is the only route that mutates anything outside the
  mailbox. It is fenced three ways: loopback connections only, a mandatory
  `x-dsh-open: setup` header (a cross-site form cannot set one), and a
  same-origin `Origin` check. It writes at most two things — the shim and a
  marked PATH block in one shell profile — refuses to remove a shim it did not
  write, and only ever removes its own bounded block from the profile.
- The plugin writes only under `$DSH_HOME/run/dsh-open` (mailbox) and, at install
  time, the four profile edits listed above. It makes no network calls.
- `install.mjs` is a developer script. It is not run by `npm install`, and users
  installing from a package registry never need it.

## Limits

- **macOS only for cold start**: the CLI starts the app with `open -a "DeepSeek
  Harness"`. `--no-launch` skips that step everywhere.
- **One app window**: the request is delivered to the single desktop window, the
  same one a user would click. Multi-window routing is out of scope.
- **No file targets**: `dsh-open <file>` fails with `not a directory`. A file
  belongs in its folder — open the folder instead.
- **The browser half needs a page**: if the app window is closed but the host
  runs, requests queue until a window polls (every 750 ms) or the CLI times out
  (15 s).
- **The PATH edit covers the common shells**: zsh, bash, fish, sh/dash/ksh get a
  profile edit; any other `$SHELL` gets instructions on the page instead of a
  guessed file.
- **The settings page appears after a restart**: the browser half arrives with the
  boot payload and talks to a route the host half registers at boot, so a fresh
  install (or an upgrade) shows the working tab only after the app restarts.

## Uninstall

**Settings → dsh-open → Remove command** deletes the shim and the
`# >>> dsh-open >>>` PATH block it added. Then remove the plugin itself:

```sh
npm unlink -g dsh-open
```

Delete the `dsh-open` entries from `$DSH_HOME/profiles/desktop/package.json`
(`dependencies` and `dsh.profile.bundles`) and `cordis.patch.yml` (the `dsh-open`
insert row), remove `node_modules/dsh-open`, and reopen the app. The
`*.dsh-open-<stamp>.bak` copies taken at install time can also be restored
verbatim. If the page is already gone, delete the block between the two
`# >>> dsh-open >>>` / `# <<< dsh-open <<<` markers from your shell profile by
hand.

## Development

```sh
npm test          # client bundle freshness + unit tests (host, browser, CLI, installer)
npm run e2e       # boots a real dsh web host from the app bundle and drives the
                  # whole chain, including the boot payload and shutdown cleanup
```

## License

MIT
