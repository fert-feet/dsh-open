# dsh-open

`dsh-open .` — open a folder in the running DeepSeek Harness desktop app, the way
`code .` opens one in VS Code. The app never accepted a path on the command line
(its Electron shell only reads `--updated`, and `dsh://` links only focus an
existing window), so this plugin adds the missing channel:

```
dsh-open ~/Project/foo      # open foo
dsh-open                    # open the current directory
dsh-open --no-launch .      # send to a host that must already be running
```

The app comes to the front with that folder as the workspace. A cold start works
too: the request is written to disk before the app boots, and the host half
picks it up when it activates.

## Install

```sh
node scripts/install.mjs
```

This edits the desktop profile at `$DSH_HOME/profiles/desktop` (`~/.dsh` by
default) in exactly four ways:

| what | why |
| --- | --- |
| `package.json` → `dependencies["dsh-open"] = "file:<this repo>"` | pins the plugin in place |
| `package.json` → `dsh.profile.bundles += "dsh-open"` | the app loads it at boot |
| `cordis.patch.yml` → `- insert: [{ id: dsh-open, name: dsh-open }]` | mounts the host half |
| `node_modules/dsh-open` → symlink to this repo | the loader resolves the name |

Every edited file is copied to `*.dsh-open-<stamp>.bak` first, and any failure
restores all of them. Installing twice is a no-op.

The app reads profile bundles at boot, so **quit and reopen DeepSeek Harness**
once. The installer says so when it notices a live host.

The `dsh-open` binary has to be on `PATH`. Either `npm link` this package or point
at it directly:

```sh
npm link                 # dsh-open → this checkout
# or
~/Project/learn-everything/dsh-open/bin/dsh-open.js .
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
registers three exact routes on `ctx.webServer` and disposes them with its fiber.
The browser half (`lib/client.js`, bundled from `src/client.js`) declares
`inject: ["workspaces", "uiWorkspace"]`, so cordis hands it both services.

## Limits

- **macOS only for cold start**: the CLI starts the app with `open -a "DeepSeek
  Harness"`. `--no-launch` skips that step everywhere.
- **One app window**: the request is delivered to the single desktop window, the
  same one a user would click. Multi-window routing is out of scope.
- **No file targets**: `dsh-open <file>` fails with `not a directory`. A file
  belongs in its folder — open the folder instead.
- **The `browser` half needs a page**: if the app window is closed but the host
  runs, requests queue until a window polls (every 750 ms) or the CLI times out.
- **Uninstall**: delete the `dsh-open` entries from the profile's `package.json`
  and `cordis.patch.yml`, remove `node_modules/dsh-open`, and reopen the app.
  Backups from install time can be copied back as well.

## Development

```sh
npm test          # client bundle freshness + 27 unit tests
npm run e2e       # boots a real dsh web host from the app bundle and drives the
                  # whole chain, including the boot payload and shutdown cleanup
```
