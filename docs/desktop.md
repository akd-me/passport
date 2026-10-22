# Passport for macOS

`apps/desktop` (`@passport/desktop`) is a small Electron shell around the unchanged `passport serve`.
It follows the decision memo in [research/04-mac-app.md](design/research/04-mac-app.md). The main
process starts the server as a child process: Electron's own binary, run with `ELECTRON_RUN_AS_NODE=1`
against the same npm artifact that `npm install -g @akd-me/passport` installs. It shows the web UI in
one window and keeps a menu-bar item. Nothing in `apps/server` or `apps/web` imports Electron.

Status: milestones M1 (a local, unsigned `.app`) and M2 (menu bar, notifications, login item, deep
links, Keychain key, CLI command) are built. M3 (signing, notarization, auto-update) is not built yet;
see [the end of this page](#m3-signing-notarization-and-updates).

## Build and run

Builds need an Apple silicon Mac with Node 24 and pnpm (`corepack enable`).

```sh
pnpm install --frozen-lockfile
pnpm dist:desktop                         # apps/desktop/dist/mac-arm64/Passport.app
PASSPORT_DESKTOP_DMG=1 pnpm dist:desktop  # also a .dmg and .zip in apps/desktop/dist/
```

`pnpm dist:desktop` runs these steps:

1. `pnpm run pack`, which is `pnpm build` plus `pnpm pack`. This produces the same tarball npm and
   Docker use.
2. Unpacks it to `apps/desktop/build/server` and copies its production dependencies there from the
   workspace's own pnpm install (`scripts/stage-deps.mjs`). The app therefore ships the versions
   `pnpm-lock.yaml` pins, with no registry access at build time.
3. Renders the app icon and bundles the main process with esbuild (`dist/main.cjs`, `dist/preload.cjs`).
4. Runs `electron-builder --mac dir --arm64` with `identity: null`, so nothing is signed.
5. Smoke-tests the packaged app: it starts `Resources/server/bin/passport.js serve` with the app's
   Electron binary in Node mode, exactly as the app does (temporary data directory, free ports, a key
   on the bootstrap pipe), signs in with the login URL, and checks that the server stops when its
   parent pipe closes. `node apps/desktop/scripts/smoke.mjs --packaged <path to Passport.app>` runs
   the same check on its own.

The server goes to `Contents/Resources/server/`, outside `app.asar`, so it runs as plain files.
Configuration lives in `apps/desktop/electron-builder.yml`.

To run the app from source against the workspace build of the server:

```sh
pnpm build                               # once, and after server or web changes
pnpm --filter @passport/desktop dev      # bundles the main process, then runs `electron .`
pnpm --filter @passport/desktop test     # unit tests, then node:sqlite FTS5 inside Electron's Node
```

If your terminal runs inside another Electron app (VS Code, T3 Code), it may export
`ELECTRON_RUN_AS_NODE=1`. Then `electron` starts as plain Node and exits. Run
`env -u ELECTRON_RUN_AS_NODE pnpm --filter @passport/desktop dev` instead.

The smoke test prints the Electron, Node and SQLite versions. It fails if an Electron upgrade drops
FTS5 or JSON1.

### First launch

Drag `Passport.app` to `/Applications`. The app is unsigned, so Gatekeeper blocks a double-click the
first time: right-click the app, choose **Open**, then **Open** again. If you copied it from another Mac
or a download, first run `xattr -dr com.apple.quarantine /Applications/Passport.app`.

## How it runs

- **One instance.** A second launch focuses the running app and passes it any `passport://` link.
- **Attach or spawn.** At startup the app reads `<dataDir>/owner.lock`, using the same live-owner check
  as the CLI. If `passport serve` already owns the data directory, the app **attaches** to it on the
  host and port recorded in the lease (servers before v0.3 record none; then the app uses its own
  configured port) and never starts a second server. If that server later stops, the app takes over
  and starts its own within about 10 seconds. A `passport demo` owner is reported as such and not
  attached to. With no owner, the app **spawns** `passport serve` with `cwd` set to `$HOME` and the
  environment it inherited, minus `PASSPORT_MASTER_KEY`. When the app is launched from Finder, the
  server itself rebuilds `PATH` from your login shell so that `claude` and `codex` resolve.
- **Its own server only.** The child's stdin is a pipe the app never writes to. If the app's main
  process dies (a crash, a force quit, `kill -9`), the pipe closes and the server shuts down cleanly
  (`PASSPORT_PARENT=desktop`). The app also records the child's pid in
  `Application Support/Passport/server-child.json`. If a later launch finds that pid still owning
  the data directory, it stops that server and starts a new one rather than attaching to it.
- **Port.** The port is the one the CLI would use: `PASSPORT_PORT`, else `port` in
  `passport.config.json`, else 3000. It is never chosen at random, because OAuth redirect
  registrations use `http://127.0.0.1:3000/...`. If something that is not Passport holds the port, the
  window says so.
- **Sign-in.** The app reads `<dataDir>/api-token` and loads the `?token=` login URL. The server
  exchanges it for an HttpOnly session cookie inside the app's own browser session. The window also
  sends the token as a bearer header on every request to the server's origin (HTTP and `/ws`), so a
  window left open past the cookie's 24 hours, or a server that restarted and lost its sessions, keeps
  working. If the server still answers 401, the app re-reads `api-token` (it may have been rotated)
  and signs in again. The token never appears in the UI. Browser and `curl` access with the token
  keep working as before.
- **Crashes.** If the server exits unexpectedly, the app restarts it after 1 s, 2 s, 4 s and so on, up
  to 30 s. Filesystem errors (an unreadable `api-token`, a full disk for `server.log`) are reported
  with their errno and retried the same way. It reconnects the window and the menu-bar count when the
  server is back. Choose **Restart Server** in the menu bar to restart it immediately; the item is
  disabled while a start is in progress.
- **Quit.** Use the menu-bar **Quit Passport** or ⌘Q. The app sends the server SIGTERM and waits up to
  10 s, so the owner lease is released and SQLite's WAL is checkpointed. Closing the window does
  **not** quit: Passport keeps running in the menu bar, and the agent keeps working.
- **Links.** The window shows only the server's origin, including after server redirects and in
  subframes. Every other `http(s)` link opens in your default browser. The window may use
  notifications and clipboard writes; every other permission (camera, microphone, location) is
  denied.
- **Gmail and Outlook sign-in.** Your default browser does not share the window's cookies, so the
  Accounts form does not open the consent page directly. It opens a one-time
  `http://127.0.0.1:<port>/oauth/launch/<ticket>` URL instead. That URL binds your browser to the
  sign-in attempt (the same cookie check as in a normal browser tab), then forwards to Google or
  Microsoft. The loopback callback then completes in your browser and the window shows the result.
  The link stays valid until the attempt completes or expires after 10 minutes, so **Open
  authorization tab** can reopen it.

## Where things live

| What | Where |
| --- | --- |
| Workspace (mail index, config, `api-token`, `master.key` if any) | `~/.passport`, or `PASSPORT_DATA_DIR` |
| Desktop settings, Keychain-sealed master keys, browser session | `~/Library/Application Support/Passport/` (`desktop-settings.json`, `master-keys/`) |
| Server output (stdout and stderr of `passport serve`) | `~/Library/Logs/Passport/server.log` |
| App diagnostics | `~/Library/Logs/Passport/desktop.log` |
| Terminal command (optional) | `~/.local/bin/passport` |

Both logs rotate to `*.log.1` when they pass 10 MB. A server the app starts logs only its origin, not
the `?token=` login URL. Older entries, or a server you started yourself, may still contain the
token, so the logs are created with mode 0600. Do not paste them anywhere unredacted. **Show Logs in
Finder** in the menu bar opens the folder.

## Encryption key in the Keychain

The store encrypts account credentials with a master key. The CLI keeps that key in
`<dataDir>/master.key`. The app keeps it in the macOS Keychain instead, through Electron's
`safeStorage`. It hands the key to the server as JSON on an inherited pipe (file descriptor 3,
named by `PASSPORT_BOOTSTRAP_FD`), never in the command line or the environment, so `ps eww` and
other processes cannot read it. The server closes the pipe after reading it, and the key is never
forwarded to `claude` or `codex`. The app never logs the key.

The server records a **key check** in the store: an HMAC of a fixed string under the key, never the
key itself. Every process that opens the store compares its key against it, and a wrong key fails
with `MASTER_KEY_MISMATCH` instead of writing credentials nobody else can read.

At startup, the app picks the key in this order:

1. `PASSPORT_MASTER_KEY` from the app's environment, as is (still delivered on the pipe).
2. A key it already sealed for this data directory (`master-keys/<hash of the data dir>.bin`).
3. Otherwise, `<dataDir>/master.key` if it exists. The app imports it into the Keychain once and
   **leaves the file in place**, so existing credentials stay readable and the CLI keeps working.
4. Otherwise, for a brand-new workspace, 32 random bytes. No `master.key` is written. The app writes
   `<dataDir>/master.key.keychain`, a marker that tells the CLI where the key is.

Whatever it picks must pass the store's key check. If the sealed key cannot be unsealed (the Keychain
item was reset, or the app was re-signed) or does not match the store, but `master.key` does match,
the app uses `master.key` and seals it again. Otherwise it does not start a server, and the window
says why. It also refuses when a sealed key exists but macOS reports Keychain encryption as
unavailable, and when a workspace has a database but neither `master.key` nor a sealed key. A new key
there would make its credentials unreadable. If macOS refuses Keychain access, allow access and choose
**Restart Server**.

**Optional: delete `master.key`.** After an import, you may delete `~/.passport/master.key` so the key
exists only in the Keychain. Before you do, make sure your accounts sync from the app. Do not delete
it if you also run the npm or Docker server, or CLI commands that open the store directly, on that
data directory. Without the file, they cannot decrypt credentials. Keep a copy of the file in your
backups either way.

**Workspaces the app creates have no `master.key`.** CLI commands never create one beside an existing
`passport.sqlite` or the `master.key.keychain` marker. Doing so would mint a second key and strand
credentials. Instead:

- While the app runs, `passport decisions`, `trust`, `sync` and `triage` talk to its server and work.
  For MCP clients, use `passport mcp install --http`, which talks to the running server.
- Without a server, `passport accounts list`, `trust` and `decisions` still work. They open the store
  without a key, and credentials stay sealed (writing one is refused).
- Everything else that needs credentials (`passport serve` from npm, `passport mcp` over stdio,
  `sync` or `triage` with no server, `init`, `accounts add`) stops with `MASTER_KEY_UNAVAILABLE` and
  says to use Passport.app. `passport doctor` reports the key as kept in the Keychain.

A backup of `~/.passport` alone cannot restore credentials for such a workspace, because the sealed
key lives in Application Support and the Keychain. Reconnecting the accounts is the recovery path.

Unsigned and re-signed builds may ask for Keychain access again after each rebuild. Signing (M3)
fixes that.

## Menu bar, Dock and notifications

The menu-bar icon's title is the number of **proposed** actions waiting for your decision. The Dock
badge shows the same number. Both clear while no server answers, rather than showing a stale count. Actions already held in the outbox are not counted. The main process
keeps the count current with the window closed. It subscribes to the server's `/ws` event stream and
re-reads `GET /api/decisions` after every `action.*` event, and again after each reconnect.

When a new proposal arrives and the Passport window is not focused, a notification appears. The app
remembers what it last saw across server restarts, so proposals made while it was reconnecting are
announced too. It shows
only an action label and, at most, the message subject (for example "Send a message: Lunch on
Friday?"). It never shows message bodies or the agent's free-text reason. If more than three arrive at
once, the rest are summarised in one notification. Clicking a notification opens the window at that
decision.

The menu also offers these settings:

- **Open at Login** (packaged app only). This registers a macOS login item. A launch at login starts
  with no window: just the menu bar and the server.
- **Hide Dock Icon When No Window Is Open.** For a pure menu-bar app. The icon returns when you open
  the window.
- **Notifications.** Turn decision notifications on or off.

macOS may not run login items from unsigned apps reliably; this is expected to work once the app is
signed in M3.

## Deep links

The app registers the `passport://` scheme, for in-app navigation only. OAuth never uses it.

| Link | Opens |
| --- | --- |
| `passport://open` | the queue |
| `passport://decision/<id>` | the queue (`/?decision=<id>`) |
| `passport://matter/<id>` | `/matters/<id>` |
| `passport://settings` | Settings → Accounts |
| `passport://settings/trust`, `passport://settings/routines` | that Settings section |

Unknown links just bring the window forward. The web UI does not read the `decision` parameter yet,
so a decision link opens the queue without preselecting the card.

## The `passport` command

Choose **Install `passport` Command…** in the menu bar to write `~/.local/bin/passport`. This small
shell script runs the app's bundled CLI:
`ELECTRON_RUN_AS_NODE=1 "<app>/Contents/MacOS/Passport" "<app>/Contents/Resources/server/bin/passport.js" "$@"`.
It defaults `PASSPORT_DATA_DIR` to the app's data directory. You do not need Node or npm for the app or
this command. Agent-driven account setup (**Connect with an agent**) is the exception: its browser
helper runs through `npx`, so it needs Node.js installed, and says so when it is missing. The manual
Gmail and Outlook forms and IMAP need nothing extra. The app does
not overwrite a `passport` it did not write, such as the npm package's link. If you move the app,
install the command again; the script tells you when the app has moved. Make sure `~/.local/bin` is
on your `PATH`.

## Environment variables for testing

| Variable | Effect |
| --- | --- |
| `PASSPORT_DATA_DIR`, `PASSPORT_PORT`, `PASSPORT_MCP_PORT`, `PASSPORT_HOST`, `PASSPORT_API_TOKEN` | Same as the CLI; passed through to the server |
| `PASSPORT_DESKTOP_USER_DATA` | A separate Application Support directory: settings, sealed keys, logs and the single-instance lock |
| `PASSPORT_DESKTOP_SERVER_ENTRY` | A different server CLI entry (default: the bundled one, or `apps/server/bin/passport.js` in development) |
| `--hidden` (argument) | Start with no window, as a login launch does |

This runs a throwaway instance that leaves your real workspace alone:

```sh
PASSPORT_DATA_DIR=/tmp/pp/data PASSPORT_DESKTOP_USER_DATA=/tmp/pp/app PASSPORT_PORT=3917 \
  PASSPORT_MCP_PORT=4917 apps/desktop/dist/mac-arm64/Passport.app/Contents/MacOS/Passport
```

## Known limitations

These come from the R3 review of the app and are accepted for now:

- **R3-4 (residual).** The key no longer appears in the server's environment. Until M3, though,
  Electron's default fuses still allow `Passport --inspect`, and `PASSPORT_DESKTOP_USER_DATA` is
  honoured in packaged builds (the testing recipe below relies on it). A same-user process could use
  either to run code under the app's Keychain access. M3 should turn off
  `EnableNodeCliInspectArguments`, turn on `EnableEmbeddedAsarIntegrityValidation` and
  `OnlyLoadAppFromAsar` (`RunAsNode` must stay on), and ignore the override in signed builds.
- **R3-17.** When the packaged binary runs in Node mode, every server start prints
  `ERROR:electron/shell/common/mac/codesign_util.cc:79 task_name_for_pid` to `server.log`. It is
  harmless: the unsigned app cannot inspect its own code signature.
- **R3-18.**
  - **Open at Login** is off by default, and macOS 13+ may hold a new login item for approval in
    System Settings → General → Login Items without the app saying so.
  - Notifications fire for proposed actions only, not for tasks waiting on an answer.
  - There is no `passport://task/<id>` link yet.
  - A `passport://decision/<id>` link opens the queue without selecting the card.
  - The `passport` command bakes in the data directory the app had when the command was installed.
    Reinstall it after changing `PASSPORT_DATA_DIR`.
- **R3-8.** The staged `node_modules` is laid out like npm's (hoisted, with nested copies where
  versions conflict), not like pnpm's. The versions are the lockfile's, but the layout is not the
  exact tree CI tests.

## M3: signing, notarization and updates

These steps are not done yet. The config already contains the pieces that do not need an Apple
account:

- A hardened runtime.
- `build-resources/entitlements.mac.plist`, with only `cs.allow-jit` and
  `cs.allow-unsigned-executable-memory`, which V8 needs, including in the server child. There is no App
  Sandbox, because the server must run `claude` and `codex` and read `~/.passport`.
- The `dmg` and `zip` targets. The zip is what electron-updater uses.
- A `publish: github` entry for `akd-me/passport`, which `dist.mjs` never uses (it runs with
  `--publish never`).

Remaining work:

1. Join the Apple Developer Program. Create a **Developer ID Application** certificate and an App
   Store Connect API key.
2. Provide these to the build, in CI as secrets with the same names T3 Code uses:
   - `CSC_LINK`: the base64-encoded `.p12`, or a path to it.
   - `CSC_KEY_PASSWORD`.
   - `APPLE_API_KEY`: the path to the `.p8` file.
   - `APPLE_API_KEY_ID`.
   - `APPLE_API_ISSUER`.
   - `APPLE_TEAM_ID`.
3. Build with `PASSPORT_DESKTOP_SIGN=1 PASSPORT_DESKTOP_DMG=1 pnpm dist:desktop`. This drops
   `identity: null`, and electron-builder then signs and notarizes. Verify with `spctl -a -vv` and
   `codesign -dv --entitlements - Passport.app`.
4. Add electron-updater with GitHub Releases (stable and prerelease channels). Stop the server child
   before `quitAndInstall`.
5. Flip the Electron fuses listed under [Known limitations](#known-limitations) (R3-4).
6. A release workflow that uploads the DMG, the zip and `latest-mac.yml`. Optionally, a Homebrew cask.

Out of scope on purpose: the Mac App Store, which requires a sandbox; Intel or universal builds; and
Windows and Linux.
