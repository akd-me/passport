# 04 — Passport as a Mac app: packaging and runtime decision memo

Date: 2026-10-22. Scope: the packaging and runtime slice only. A separate study covers T3 Code more broadly.
Repos read: `/Volumes/FastBoy/passport` at `24e5da7`; T3 Code at `/Users/akshaykumardileepmacmini/.t3/scratch/passport-refs/t3code`
(abbreviated `t3/` below). Neither repo was modified.

## TL;DR

- **T3 Code is an Electron app.** It uses Electron 44.9.3 and electron-builder 26.16.1 (`t3/apps/desktop/package.json`). Its main
  process spawns the *unchanged* server entry `apps/server/dist/bin.mjs` as a child process. That child is **the Electron binary
  itself, run with `ELECTRON_RUN_AS_NODE=1`** (`t3/apps/desktop/src/backend/DesktopBackendConfiguration.ts:538-556`), so no
  separate Node is bundled. The T3 server uses `node:sqlite` (`t3/apps/server/src/persistence/initializeV2Database.ts:1`), which
  is the same choice Passport made.
- **`node:sqlite` with FTS5 works inside Electron's Node.** I ran a probe against the installed, notarized
  `/Applications/T3 Code (Nightly).app` with `ELECTRON_RUN_AS_NODE=1`. It reported `electron 44.9.3`, `node 24.22.0` and
  `sqlite 3.53.4`, with compile options `ENABLE_FTS5`, `ENABLE_FTS3` and `ENABLE_RTREE`. `CREATE VIRTUAL TABLE … USING fts5`,
  `MATCH` and `json_extract` all worked. Passport's "no native modules, `node:sqlite` + FTS5" convention (`docs/CONTRACT.md:46`)
  therefore survives Electron unchanged. Neither better-sqlite3 nor sql.js is needed.
- **Recommendation: (a) Electron, mirroring T3's backend-as-child pattern.** The first milestone is an unsigned, locally built
  `.app` that wraps the existing `passport serve` and loads the UI in a `BrowserWindow`. It needs about **2–3 days**, and the server
  and web code barely change. Menu bar, notifications, login item, Keychain and deep links come next (about 5–7 days), then
  signing, notarization and auto-update (about 2–3 days, mostly Apple account setup). Keep the npm CLI and Docker paths; the app
  is a third distribution of the same server.

---

## 0. What Passport is today (runtime facts that drive the decision)

| Fact | Where |
| --- | --- |
| One process: Hono via `@hono/node-server`, `ws` at `/ws`, schedulers, and a separate loopback HTTP MCP listener on 4318 | `apps/server/src/server.ts:12-58` |
| The CLI entry starts `serve` and `demo`, holds a data-dir owner lease, and handles SIGINT/SIGTERM | `apps/server/src/cli.ts:107-198` |
| The UI is static `web/dist` served by the same Hono app; it is same-origin | `apps/server/src/app.ts:67-70` |
| Auth: a 64-hex `api-token` file. The login URL `http://127.0.0.1:3000/?token=…` is exchanged for an HttpOnly `passport_session` cookie; WS upgrades are cookie- and Origin-checked; Origin must be `http(s)` on an allowed host | `apps/server/src/auth.ts:19-80,153-169,225-265`; `apps/web/src/auth.ts` |
| Credentials are AES-GCM encrypted using `PASSPORT_MASTER_KEY` or a generated `master.key` | `packages/store/src/credentials.ts`; `docs/install.md:146` |
| Host CLIs are resolved from `PATH`, then `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`; overrides are `PASSPORT_CLAUDE_PATH` and `PASSPORT_CODEX_PATH`. The child env is an allowlist (no `PASSPORT_*`, no API keys) | `packages/agent/src/host/detect.ts:46-75`; `packages/agent/src/host/env.ts:9-106` |
| OAuth: Google "Desktop app" client and Microsoft public client, both with PKCE. The UI flow's callback is on the server port (`http://127.0.0.1:3000/oauth/callback`); the CLI uses a one-shot listener on `127.0.0.1:53682` | `docs/deploy.md:57-75`; `apps/server/src/oauth.ts:19-31`; `docs/accounts.md:74,101-127` |
| The npm bundle is esbuild with external deps: hono, imapflow, mailparser, nodemailer, ws, zod, MCP SDK and ical.js. `dist/package` is 2.5 MB and `web/dist` is 1.0 MB | `apps/server/dist/package/package.json`; `du` |
| `node:sqlite`'s `DatabaseSync` is **synchronous** | `docs/CONTRACT.md:46` |

The last row matters. Running the server *inside* a GUI main thread (Electron main, or a Tauri/Swift in-process JS engine) would
let SQLite queries stall menus and window events. Every option below keeps the server in its own process.

## 1. How T3 Code packages and runs (the slice that matters)

| Concern | What T3 does | Evidence |
| --- | --- | --- |
| Shell | Electron 44.9.3; electron-builder 26.16.1; `electron-updater` ^6.8.9; signing via `@electron/osx-sign` | `t3/apps/desktop/package.json`; `t3/scripts/sign-macos.ts` |
| Electron vs. latest | Electron 45.0.0 went stable on 2026-10-20 with Node v24.22.0. Electron 44 has been stable since 2026-08-24 (shipped with Node 24.18.1; 44.9.3 now carries 24.22.0) | https://releases.electronjs.org/schedule ; https://electronjs.org/blog/electron-44-0 |
| Embedded server | The main process spawns `process.execPath` (the Electron binary) with `ELECTRON_RUN_AS_NODE=1`, args `[--require compileCache] apps/server/dist/bin.mjs --bootstrap-fd 3`, `cwd=$HOME`, and `extendEnv: true`. The server reads a JSON bootstrap (port, host, `desktopBootstrapToken`/secret, `shellEnvironmentPrepared`) from fd 3. Extra fds 4–7 carry telemetry and browser control | `t3/apps/desktop/src/backend/DesktopBackendConfiguration.ts:515-560`; `t3/apps/desktop/src/backend/DesktopBackendManager.ts:382-460` (comment at 434: "Run the child in Node mode so this backend process does not become a GUI app instance") |
| Server entry location | `<app>/Contents/Resources/app.asar/apps/server/dist/bin.mjs`, read from inside the asar. Windows uses a separate `server.asar` | `t3/apps/desktop/src/app/DesktopEnvironment.ts:165-212` |
| Renderer origin | The UI is served from a custom privileged scheme `t3code://` (dev: `t3code-dev://`) through `protocol.handle` from the asset directory, with a CSP. It is *not* `http://127.0.0.1` | `t3/apps/desktop/src/electron/ElectronProtocol.ts:16-29,114-140,250-290` |
| In-app auth | No user-visible token. The main process holds a bootstrap secret, derives a time-based credential, and exchanges it with the local backend for a bearer session that the renderer uses | `t3/apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts:70-125` |
| PATH from Finder | At startup the main process runs `$SHELL -ilc '<print marked env vars>'` with a 5 s timeout and falls back to `/bin/zsh`. If no PATH comes back, it tries `/bin/launchctl getenv PATH` (2 s). It merges the result with the inherited PATH and copies `HOMEBREW_*`, `SSL_CERT_*`, `NODE_EXTRA_CA_CERTS`, `__MISE_DIFF` and `SSH_AUTH_SOCK`. If no locale is set on macOS it sets `LC_CTYPE=en_US.UTF-8`. The server skips its own `fixPath` when `shellEnvironmentPrepared` is true | `t3/apps/desktop/src/shell/DesktopShellEnvironment.ts` (whole file; probe list at `LOGIN_SHELL_ENV_NAMES`); `t3/packages/shared/src/shell.ts:141-160,209-321`; `t3/apps/server/src/os-jank.ts:64-110` |
| Binary override | There is a per-provider `binaryPath` setting for Codex and Claude, among others | `t3/packages/contracts/src/settings.ts:597,681,806` |
| CLI from the app | The app writes a shell shim that runs `ELECTRON_RUN_AS_NODE=1 <Electron binary> <asar>/apps/server/dist/bin.mjs "$@"`, so `t3` works without npm | `t3/apps/desktop/src/app/DesktopCliShim.ts:1-80` |
| Secrets | `Electron.safeStorage` (Keychain-backed on macOS) protects saved environment secrets. `@napi-rs/keyring` is used only for reading *other* apps' keys (Chromium import, Cursor) | `t3/apps/desktop/src/electron/ElectronSafeStorage.ts:70-95`; `t3/apps/desktop/src/settings/DesktopSavedEnvironments.ts:229-275` |
| Dock badge | The renderer calls `desktopBridge.setNotificationBadge`, and the main process calls `app.setBadgeCount`. **No `Tray`/menu-bar item exists in T3** | `t3/apps/desktop/src/ipc/methods/notificationBadge.ts`; `t3/apps/web/src/threadNotifications.ts:41-80`; grep shows no `Tray` usage |
| Lifecycle | On macOS, `window-all-closed` does not quit, so the backend keeps running while the Dock icon is alive. `requestSingleInstanceLock` is used. External links go through `setWindowOpenHandler` → `shell.openExternal` | `t3/apps/desktop/src/app/DesktopLifecycle.ts:244-253`; `t3/apps/desktop/src/window/DesktopWindow.ts:616-621`; `t3/apps/desktop/src/app/DesktopClerk.ts:110-120` |
| Deep links | `protocols: [{ schemes: ["t3code","t3code-dev"] }]` lands in `CFBundleURLTypes` (verified in the installed app's Info.plist); the app handles `open-url` | `t3/scripts/build-desktop-artifact.ts:2909-2920`; `t3/apps/desktop/src/app/DesktopClerk.ts:210` |
| mac build | `target: ["dmg","zip"]` (the zip feeds electron-updater), `category: developer-tools`, custom `extendInfo` usage strings | `t3/scripts/build-desktop-artifact.ts:2883-2930` |
| Entitlements | `cs.allow-jit`, `cs.allow-unsigned-executable-memory`, `cs.disable-library-validation`, camera and mic (because child processes inherit the app's TCC identity), plus passkey extras. **No `com.apple.security.app-sandbox`** | `t3/scripts/build-desktop-artifact.ts:1395-1420`; `codesign -d --entitlements -` on the installed app |
| Signing and notarization in CI | `CSC_LINK`/`CSC_KEY_PASSWORD` (Developer ID .p12) plus App Store Connect API key `APPLE_API_KEY`/`_ID`/`_ISSUER` and `APPLE_TEAM_ID`; electron-builder notarizes. Installed app: `spctl` → "accepted, source=Notarized Developer ID", hardened runtime flag `0x10000(runtime)` | `t3/.github/workflows/release-desktop.yml:12-20,272-330,438-476`; local `spctl -a -vv` |
| Update feed | electron-updater with the GitHub provider (release or prerelease channel), with a `generic` provider for a mock server | `t3/scripts/build-desktop-artifact.ts:2738-2762,2862-2880`; `t3/apps/desktop/src/electron/ElectronUpdater.ts` |
| Size | Installed nightly is **389 MB**: Electron Framework 237 MB, `app.asar` 105 MB (T3 ships much more than Passport would). `LSMinimumSystemVersion` is 13.0 | `du -sh` on `/Applications/T3 Code (Nightly).app` |

**Why T3 chose this, and why it applies to Passport.** T3's server is a Node + `node:sqlite` program that also ships as an npm
CLI. Running the *same* `bin.mjs` under Electron's Node keeps one server codebase for desktop, CLI and remote use. It avoids
bundling a second ~110 MB Node runtime, and Electron's Node line (24.x) is the one the server already targets. Every one of those
conditions holds for Passport. Passport is in fact simpler: no PTYs, no native addons, no preview browser.

## 2. Options

Shared assumptions: the server remains a separate OS process running `node:sqlite`. The UI remains the existing React build. "Effort" means one experienced engineer working with an agent, through the M1 + M2 scope in §4, excluding Apple-account lead time.

### (a) Electron, mirroring T3 Code (recommended)

- **Reuse.** `apps/server` and `apps/web` are used as-is. A new `apps/desktop` (main + preload, about 600–1,000 LOC to start)
  spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1` against `Resources/app.asar/server/cli.js serve` (or an unpacked
  copy), loads the UI in a `BrowserWindow`, and stops the child on quit.
- **Server location.** Use a **child process via `ELECTRON_RUN_AS_NODE`**, like T3, rather than `utilityProcess.fork`.
  `utilityProcess` cannot take stdin (stdin must be `ignore`, per https://www.electronjs.org/docs/latest/api/utility-process),
  and it is Electron-specific. The plain-Node child is byte-identical to `passport serve`, can be restarted on crash, and reuses
  the existing SIGTERM shutdown path in `cli.ts`. In-main-process is rejected because synchronous SQLite would block the UI thread.
- **`node:sqlite`/FTS5.** Verified present in Electron 44.9.3 / Node 24.22.0 / SQLite 3.53.4 (probe above). Electron 45 ships
  the same Node 24.22.0 per https://releases.electronjs.org/schedule. Passport's `>=22.16` FTS5 floor (`docs/install.md:1-14`)
  is met. Add the FTS5 probe as a desktop smoke test so an Electron bump cannot silently drop it.
- **Size.** Electron Framework alone is 237 MB unpacked (measured). Passport's payload is about 5–15 MB (bundle + `web/dist` +
  npm deps), so expect **about 250 MB installed and roughly 90–110 MB as a DMG** (this is an estimate from the measured framework
  size). Arm64-only builds avoid the universal-binary doubling.
- **Startup.** Electron window paint plus Node child boot. The SQLite open and migrations are the same as `passport serve` today.
  Expect about 1–2 s to an interactive UI; show a splash or "connecting" page as T3 does
  (`t3/apps/desktop/src/window/DesktopWindow.ts:939`).
- **Auth.**
  - *M1 (zero server change):* the main process reads the token (`apiToken(dataDir)` logic or `passport token`) and calls
    `win.loadURL(loginUrl)`. The existing `?token=` flow sets the HttpOnly cookie inside Electron's session; the user never sees
    it. The Origin stays `http://127.0.0.1:<port>`, so `allowsOrigin` (`apps/server/src/auth.ts:153-169`) still passes.
  - *M3:* deliver a per-launch secret via fd 3 (T3 pattern) or `PASSPORT_API_TOKEN` in the child env. Optionally move to a
    `passport://app` privileged scheme, which requires teaching `allowsOrigin` to accept that origin.
  - Browser and `curl` access keep the token, so remote and Docker setups are unchanged.
- **Required web change.** `AccountWizard.tsx:136-152` opens `about:blank` and then assigns the auth URL. In Electron that
  creates an in-app window. Add a `setWindowOpenHandler` that routes `http(s)` to `shell.openExternal`, and change the wizard to
  call `window.open(authUrl)` directly, or use a preload bridge when it is running in the desktop app. The system browser is what
  Google expects for OAuth.
- **Effort.** M1 2–3 days; M2 5–7 days; M3 (sign, notarize, update) 2–3 days.
- **Risks.**
  - Bundle size.
  - Electron's 8-week major cadence with 3-version support means roughly 3 bumps a year
    (https://www.electronjs.org/docs/latest/tutorial/electron-timelines).
  - The hardened runtime needs `allow-jit` and `allow-unsigned-executable-memory` for V8 in the `ELECTRON_RUN_AS_NODE` child (T3's
    list). `disable-library-validation` can be dropped, since Passport loads no third-party dylibs.
  - Spawned `claude`/`codex` inherit the app's TCC identity (T3's comment, `build-desktop-artifact.ts:1408-1412`). They shouldn't
    need camera or mic, but expect Files & Folders prompts if they touch `~/Documents`.

### (b) Tauri 2 with a Node sidecar

- **Reuse.** The server ships as a sidecar declared in `bundle.externalBin`, which needs a `-aarch64-apple-darwin`-suffixed binary
  (https://v2.tauri.app/develop/sidecar/). The sidecar is either the official Node 24 binary plus `dist/`, or a Node
  single-executable app (SEA). The UI loads in WKWebView.
- **Changes.**
  - A Rust shell (tray, menu, lifecycle) using the official plugins: notification, deep-link, autostart, updater, single-instance
    and shell (https://v2.tauri.app/plugin/).
  - There is no official Keychain plugin (Stronghold is a separate encrypted DB), so Keychain needs a Rust crate such as
    `keyring`. That is a Rust dependency rather than a Node native module, so it does not break `CONTRACT.md`.
  - SEA path: `--build-sea` exists only from Node 25.5. On Node 24 you use the postject flow and then `codesign`. SEA modules
    cannot `require()` from disk without `createRequire`, so the external npm deps would have to be bundled too. SEA is still
    "Stability 1.1, Active development" (https://nodejs.org/api/single-executable-applications.html). Shipping a plain `node`
    binary plus `dist/` is simpler than SEA.
  - The sidecar must be signed with the hardened runtime and JIT entitlements inside the bundle. The Tauri docs do not cover
    this; plan for it yourself.
- **Size.** The Tauri shell is a few MB, and blogs report 3–10 MB installers
  (https://tech-insider.org/tauri-vs-electron-2026/ — secondary source). Add Node: `node-v24.22.1-darwin-arm64.tar.xz` is
  28 MB and `.tar.gz` 53 MB (https://nodejs.org/dist/latest-v24.x/), roughly 110 MB unpacked. That gives **about 120 MB
  installed and about 40–50 MB DMG**, around 2× smaller than Electron rather than 10×, because Node dominates.
- **Startup.** The window is faster (shared WebKit); the Node boot is the same.
- **Auth.** Same as (a): load `http://127.0.0.1:<port>/?token=`, or Tauri's localhost plugin.
- **Effort.** 7–10 days to reach (a)'s M2. Rust glue, sidecar signing, and Safari/WebKit QA of the React UI (WKWebView ≠
  Chromium) are new work.
- **Risks.**
  - Two runtimes to sign and update.
  - WebKit rendering and `WebSocket` quirks.
  - The updater must replace both the shell and the sidecar.
  - Less prior art for "Node server sidecar plus host-CLI spawning" than Electron, where T3 is a working reference.

### (c) Thin native SwiftUI/AppKit + WKWebView shell around a bundled Node

- **Reuse.** The same server process, using bundled Node in `Contents/Resources/node` (or SEA) plus `dist/`. A SwiftUI `App` with
  `MenuBarExtra`, a `WKWebView` window, `Process` to spawn Node, `SMAppService` for login, `UNUserNotificationCenter`, Keychain
  Services, and Sparkle 2 for updates (EdDSA-signed appcast; https://sparkle-project.org/documentation/).
- **Size and startup.** Similar to (b): about 115–125 MB installed, and the fastest window.
- **Auth.** Same as (b). `WKHTTPCookieStore` can also receive the session cookie directly.
- **Effort.** 8–12 days. Every native feature is first-class, but it is a second language and codebase with no T3 reference.
  Dev ergonomics: Xcode project, Swift toolchain in CI.
- **Risks.**
  - Owner and contributor familiarity.
  - WebKit QA.
  - Signing a nested Node binary.
  - Linux and Windows contributors cannot build it.
- **Fit.** This is the best "feels native" option. Consider it later if Electron's size or feel becomes the top complaint. The
  server boundary means it can replace (a)'s shell without touching server code.

### (d) Server as a LaunchAgent/menu-bar daemon, with a window on top

- **Shape.** `passport serve` runs under launchd. It is registered either through `SMAppService.agent(plistName:)` with a plist
  in `Contents/Library/LaunchAgents` (Electron exposes this as `app.setLoginItemSettings({ type: 'agentService', serviceName })`,
  https://www.electronjs.org/docs/latest/api/app), or through a plain `~/Library/LaunchAgents` plist. The window (Electron or
  native) and a tiny menu-bar helper attach to it over HTTP/WS using the existing `serverClient` (`apps/server/src/cli.ts:66`)
  and owner-lock (`apps/server/src/owner-lock.ts`) semantics.
- **Pros.**
  - The agent survives window quit and app crashes.
  - The CLI, `passport mcp` and MCP clients always find a running server.
  - Updates can restart only the window.
- **Cons.**
  - Two lifecycles. Updating the bundle that the agent runs from needs coordination (stop agent → swap → restart).
  - launchd's environment is minimal, so the PATH probe from §3 must run inside the agent.
  - Login-item approval UX: `requires-approval` status (same Electron page).
  - Notifications from a background agent need either the main app's identity or a helper bundle.
- **Effort.** +3–5 days on top of (a) or (c).
- **Verdict.** (d) is a *deployment mode* of (a) or (c), not a competitor. Phase 1 should keep the simpler "Electron owns the
  child; app stays alive in the menu bar with no window" model, which delivers "agent runs while the window is closed". Move to an
  agentService LaunchAgent only if quitting the app must not stop triage.

### Summary table

| | (a) Electron | (b) Tauri + Node | (c) Swift + Node | (d) LaunchAgent + window |
| --- | --- | --- | --- | --- |
| Server/web reuse | 100% / ~99% (window.open fix) | 100% / ~99% + WebKit QA | 100% / ~99% + WebKit QA | 100% / same as host shell |
| Runtime for server | Electron's Node 24.22 (verified FTS5) | bundled Node 24 | bundled Node 24 | either |
| Installed size (est.) | ~250 MB | ~120 MB | ~120 MB | +0 |
| New language | none | Rust | Swift | none/Swift |
| Reference implementation | T3 Code (same pattern) | none for this shape | none | partial |
| Effort to M2 | **7–10 d** | 12–17 d | 13–19 d | +3–5 d |
| Main risk | size, Electron churn | sidecar signing, WebKit | Swift skills, WebKit | two lifecycles |

## 3. Mac-native capabilities

| Capability | (a) Electron | (b) Tauri | (c) Swift | Notes for Passport |
| --- | --- | --- | --- | --- |
| Menu bar / status item with "needs you" count | `Tray` + `tray.setTitle("3")` on macOS; `app.setBadgeCount(n)` for the Dock (needs notification permission; https://www.electronjs.org/docs/latest/api/app) | core tray API (guide, not plugin) | `MenuBarExtra` | T3 has **no** tray (badge only). Passport's count must come from the **main process** subscribing to `/ws` DomainEvents and `/api/decisions`, not from the renderer, because the window may be closed. That is the difference from T3's renderer-driven badge. |
| Native notification when the proactive agent needs a decision | `new Notification()` in main; click → focus window + navigate | notification plugin | `UNUserNotificationCenter`, with actionable "Approve/Open" buttons | Same source: a main-process WS subscription to proposal/held events. Never include message bodies beyond a subject line (matches the redaction posture). |
| Launch at login, agent running with window closed | `app.setLoginItemSettings({ openAtLogin: true })` (default `mainAppService` → `SMAppService`). **`openAsHidden`/`wasOpenedAsHidden` were removed in Electron 45** (same doc), so start windowless by default and show the window only on Dock/tray click or deep link. Keep the app alive on `window-all-closed` (T3 does: `DesktopLifecycle.ts:244-253`). The Electron docs warn login items "may silently fail" unless signed and notarized | autostart plugin | `SMAppService.mainApp` | Optional `app.dock.hide()` when no window is open gives a pure menu-bar feel. |
| Keychain for OAuth tokens (replacing `master.key`) | `safeStorage.encryptString` (Keychain-held key; https://www.electronjs.org/docs/latest/api/safe-storage) — **no native module** | `keyring` crate | Keychain Services | **Do not move every token into Keychain items.** Keep the store's AES-GCM design and make the *master key* Keychain-protected: main generates 32 bytes, stores `safeStorage.encryptString(key)` in `userData`, and passes it to the child as `PASSPORT_MASTER_KEY`, which already exists (`docs/install.md:146`) and is already withheld from host CLIs by `env.ts`. Later, deliver it on fd 3 instead of env. Migration: on first desktop run, if `~/.passport/master.key` exists, import it into safeStorage, then offer to delete the file. Caveat from the doc: unsigned or re-signed builds re-prompt for Keychain access after each update, which is another reason to sign in M3. |
| Deep links `passport://thread/…` | `protocols` in builder config → `CFBundleURLTypes`; `open-url` registered **before** `ready`; `setAsDefaultProtocolClient` only for schemes already in Info.plist (same doc). `requestSingleInstanceLock` + `second-instance` | deep-link plugin | `onOpenURL` | Use `passport://` only for app navigation (notifications, MCP clients, "Open in Passport"). **Not for OAuth** (see next row). |
| Loopback OAuth redirect from a packaged app | Works unchanged: the server already listens on `127.0.0.1:<port>/oauth/callback` and the system browser hits it | same | same | Keep the server port stable (persist the chosen port; do not randomise per launch), because the Microsoft registration is an exact `http://127.0.0.1:3000/...` entry (`docs/deploy.md:67-69`). |
| Google "Desktop app" policy | — | — | — | Desktop apps are **public clients** ("cannot keep secrets confidential"). **Custom URI schemes are "no longer supported"**, and out-of-band copy/paste is also gone. Use the **loopback IP** (`127.0.0.1` preferred over `localhost`) on an available port, and "always use PKCE" (https://developers.google.com/identity/protocols/oauth2/native-app). Passport already does this (`docs/accounts.md:101-127`). Gmail `gmail.modify`/readonly are *restricted* scopes: a shared, Passport-owned client would need verification, and possibly a security assessment, before leaving Testing mode's 100-user cap (https://developers.google.com/workspace/gmail/api/auth/scopes ; vendor summary https://developer.nylas.com/docs/dev-guide/provider-guides/google/google-verification-security-assessment-guide). **Keep BYO client for now**; the app changes nothing here. |
| Microsoft public client | — | — | — | Register under "Mobile and desktop applications" (Electron is named explicitly). `http` is allowed only for loopback; the port is ignored for `localhost` matching. Microsoft says "prefer 127.0.0.1 over localhost", but an `http://127.0.0.1` URI must be added via the manifest's `replyUrlsWithType`; IPv6 `[::1]` is unsupported (https://learn.microsoft.com/en-us/entra/identity-platform/reply-url). This matches the existing doc flow. |
| Signing + notarization | electron-builder + `@electron/osx-sign`; env `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY(_ID/_ISSUER)`, `APPLE_TEAM_ID`, exactly as T3 CI (`release-desktop.yml:12-20,438-476`). Needs a paid Apple Developer Program membership and a Developer ID Application cert | `tauri build` signs + notarizes with similar env; sidecar must be signed too | Xcode archive + `notarytool` | |
| Auto-update | electron-updater: **macOS app must be signed**, and the **zip target is required** to produce `latest-mac.yml` (https://www.electron.build/docs/features/auto-update ; https://www.electron.build/docs/mac). GitHub Releases provider like T3 (`build-desktop-artifact.ts:2738-2762`) | updater plugin (signed manifests) | Sparkle 2 (EdDSA `SUPublicEDKey`, `SUFeedURL`; https://sparkle-project.org/documentation/) | Before quit-and-install, stop the server child gracefully (SIGTERM → existing `handle.close()`), so the owner lock is released and the WAL is flushed. |
| App Sandbox | **Do not sandbox.** T3 isn't (no `app-sandbox` entitlement in the installed app), and it is distributed as Notarized Developer ID | same | same | Passport must exec `~/.local/bin/claude` / Homebrew `codex`, read their config dirs (`~/.claude`, `~/.codex` — host CLIs need them), and keep `~/.passport`. A sandboxed app's children inherit the sandbox and cannot see these paths without exception entitlements. The Mac App Store requires sandboxing (https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox; this point is from general knowledge, as the fetch returned only the page title), so **the App Store is out of scope**. Distribute via a DMG from GitHub Releases, and optionally a Homebrew cask. |

## 4. Finding and running the host CLIs from a Finder-launched app

**Problem.** launchd gives GUI apps roughly `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and often no locale. Passport's current resolver
adds only `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin` (`packages/agent/src/host/env.ts:57-60`). That covers the
native Claude installer and Homebrew. It misses `npm i -g @openai/codex` under nvm, fnm, volta, mise/asdf, pnpm, bun or a custom
npm prefix. Worse, an npm-installed `codex` is a `#!/usr/bin/env node` script, so it also needs `node` on PATH.
`hostAgentEnv` partly mitigates this by prepending `dirname(binaryPath)` (`env.ts:72-79`), which fixes nvm but not volta or
mise shims that resolve Node elsewhere.

**How T3 does it** (`t3/apps/desktop/src/shell/DesktopShellEnvironment.ts`, `t3/packages/shared/src/shell.ts`):

1. At desktop startup, before spawning the server, it runs each login-shell candidate (`$SHELL`, the user's passwd shell, then
   `/bin/zsh`) as `shell -ilc '<print each var between __T3CODE_ENV_<NAME>_START__/END__ markers>'`. stdin is ignored, there is
   a 5 s timeout with SIGTERM and a 1 s grace, and it handles nushell. The markers make the result immune to rc-file chatter.
2. If no PATH came back on macOS, it runs `/bin/launchctl getenv PATH` (2 s timeout).
3. It merges and de-duplicates (shell PATH first, then the inherited PATH) and writes the result into `process.env`. It copies
   `HOMEBREW_*`, `SSL_CERT_FILE`/`DIR`, `NODE_EXTRA_CA_CERTS`, `SSH_AUTH_SOCK`, `XDG_*` and `__MISE_DIFF` (needed so `mise x`
   wrappers don't loop). It sets `LC_CTYPE=en_US.UTF-8` if no locale is present.
4. The server child inherits that env (`extendEnv: true`) and is told `shellEnvironmentPrepared: true`, so it skips its own
   `fixPath` (`t3/apps/server/src/os-jank.ts:64-110`). Running the server standalone still self-hydrates.
5. A per-provider **`binaryPath` setting** overrides discovery (`t3/packages/contracts/src/settings.ts:597,681`).

**Recommendation for Passport.** Copy the approach, not the Effect code.

- Add `packages/agent/src/host/shell-env.ts`, a small, dependency-free version of steps 1–3 using `execFile` with
  `{ timeout: 5000, detached: true, stdio: ['ignore','pipe','ignore'] }`. It returns `{ PATH, SSL_CERT_FILE, SSL_CERT_DIR,
  NODE_EXTRA_CA_CERTS, HOMEBREW_PREFIX, __MISE_DIFF, LANG/LC_* }`. Pass it the `$SHELL` *name list* and probe a list of variable
  names; never `eval` user input.
- **Run it in the Electron main process once** (it costs 0.1–2 s depending on the user's rc files; run it in parallel with
  window creation), then spawn the server with the merged env and `PASSPORT_SHELL_ENV_PREPARED=1`. Also call it from `passport
  serve` when stdin isn't a TTY and the flag is absent, which covers LaunchAgent and option (d).
- Keep Passport's **child-env allowlist** (`env.ts:9-55`). Add `__MISE_DIFF`, `HOMEBREW_*`, `VOLTA_HOME`, `FNM_*` and
  `NVM_DIR` to `FORWARDED` so wrappers keep working, while API keys and `PASSPORT_*` stay withheld.
- Extend `extraBinDirs` with `~/.volta/bin`, `~/.bun/bin`, `~/Library/pnpm`, `~/.npm-global/bin`, `~/.local/share/mise/shims`
  and `~/.asdf/shims` as a last-resort fallback when the shell probe times out.
- Surface `PASSPORT_CLAUDE_PATH`/`PASSPORT_CODEX_PATH` as **Settings → Agents → binary path** fields persisted in
  `passport.config.json`. Show the resolved path, version and login state from `detectHostAgents` (already returned as
  `binaryPath`). Add a "Re-detect" button that calls `detectHostAgents({ refresh: true })` after re-running the shell probe.
- `doctor` should report "PATH source: login shell | launchctl | fallback" so support questions are answerable.

## 5. Recommendation and migration plan

**Choose (a) Electron, mirroring T3's backend-as-child pattern.**

- It is the only option with a working reference that has the same server shape (Node + `node:sqlite` + spawning `claude`/`codex`).
- I verified FTS5 in the exact runtime.
- Server and web stay identical across npm, Docker and desktop.
- Every Mac capability in §3 is available without a second language or native Node modules.
- Size (~250 MB) is the accepted cost. (c) remains a clean later swap because the process boundary is HTTP/WS + env/fd.

### M1 — "double-clickable .app on the owner's Mac" (2–3 days, unsigned, arm64 only)

1. `apps/desktop/`: `package.json` (`electron` pinned to 44.9.3, matching T3, or 45.x; `electron-builder` 26.x). Use
   `main.cjs`/`main.ts` bundled with the existing esbuild, plus `preload.cjs` (empty for now). Add a root script
   `pnpm dist:desktop` that runs `pnpm build`, copies `apps/server/dist/package/{dist,web}` plus its production `node_modules`
   into the app's `extraResources/server/` (left outside the asar, so the static `web/dist` lookup via `import.meta.url` keeps
   working), and runs `electron-builder --mac dir` or `dmg` with `identity: null`.
2. Main process:
   - `requestSingleInstanceLock`.
   - Run the shell-env probe (§4).
   - Resolve `dataDir` (`~/.passport`, the same workspace as the CLI).
   - If `activeOwner(dataDir)` says a `passport serve` is already running, **attach** to it via its configured port instead of
     spawning.
   - Otherwise spawn `process.execPath` with `ELECTRON_RUN_AS_NODE=1` and
     `[resources/server/dist/server/cli.js, 'serve']`, `cwd: $HOME`, the merged env, and stdout/stderr piped to
     `~/Library/Logs/Passport/server.log`.
   - Poll `/api/health`, then `loadURL(loginUrl)` (token read from `<dataDir>/api-token`).
   - On quit, SIGTERM the child and wait up to 10 s.
   - Keep the app alive on `window-all-closed`.
3. Window: `setWindowOpenHandler` → `shell.openExternal` for `http(s)`, plus a `will-navigate` guard to the server origin.
   One-line web fix in `AccountWizard.tsx` so OAuth opens the system browser directly.
4. Run the FTS5 probe in `pnpm test:desktop-smoke` (spawn the Electron binary with `ELECTRON_RUN_AS_NODE=1`).
5. Result: `Passport.app` in `apps/desktop/dist/mac-arm64/`. Drag it to `/Applications` and right-click → Open once (Gatekeeper,
   unsigned). Use `xattr -dr com.apple.quarantine` if it was downloaded.

### M2 — "a Mac app, not a tab" (5–7 days)

- `Tray` with a status-item title count. Main subscribes to `ws://127.0.0.1:<port>/ws` (Node 24 has a global `WebSocket`) with
  a cookie or bearer, and drives the count, `app.setBadgeCount` and `Notification` from "decision needed" events. Click →
  focus + `passport://decision/<id>`.
- Login item (`openAtLogin`). Start windowless; `app.dock.hide()` while no windows are open (setting).
- `passport://` scheme + `open-url` + router mapping. Expose `Open in Passport` links in MCP tool results later.
- Keychain-protected master key via `safeStorage` → `PASSPORT_MASTER_KEY` env (no server change), plus a one-time `master.key`
  import.
- In-app auth hardening: pass a per-launch `PASSPORT_API_TOKEN` to the child so no token file is needed for app-only users.
  Alternatively, keep the file for CLI parity, which I recommend.
- CLI shim (T3 `DesktopCliShim.ts` pattern). Offer to write `~/.local/bin/passport` → `ELECTRON_RUN_AS_NODE=1
  "/Applications/Passport.app/Contents/MacOS/Passport" ".../server/dist/server/cli.js" "$@"`. Then `passport mcp install` writes
  a command path that survives without npm.
- Settings → Agents binary paths + "PATH source" in doctor.

### M3 — distributable (2–3 days of engineering, plus Apple account lead time)

- Apple Developer Program, Developer ID Application cert, App Store Connect API key, then CI secrets mirroring T3's names.
- Hardened runtime. Entitlements: `cs.allow-jit` and `cs.allow-unsigned-executable-memory` (needed by the V8 child), no
  sandbox, no camera or mic unless required. Notarize via electron-builder.
- `mac.target: ["dmg","zip"]`, `publish: github` (akd-me/passport releases), electron-updater with stable and nightly channels.
  Stop the server before `quitAndInstall`.
- Optional Homebrew cask.

### Deferred, or not doing

- **Mac App Store:** requires sandbox; incompatible with spawning host CLIs.
- **Universal x64 build:** add later if asked.
- **Custom `passport://app` renderer origin and fd-3 bootstrap:** M3+ polish; needs an `allowsOrigin` change.
- **LaunchAgent (option d):** only if "quit app ≠ stop agent" becomes a requirement.
- **Swift shell (option c):** revisit if size or native feel becomes the top issue.
- **Windows and Linux desktop:** builder config makes these cheap later, but they are out of scope.

### Keep the server, CLI and Docker paths? Yes.

- The app is a thin launcher over the same `passport serve`. Keeping npm (`@akd-me/passport`) and Docker costs almost nothing:
  the build already produces `dist/package`, and the app bundles that same artifact.
- They serve the open-source audience: home-server/NAS, headless, Linux, contributors, and MCP-only users.
- Make the desktop app the **recommended** path in the README for Mac users. Leave the other paths documented as
  "server/advanced".
- Two guardrails:
  1. One data dir, one owner. The app must *attach* to a running CLI server rather than fight the owner lock.
  2. Everything desktop-only stays in `apps/desktop`, and any server hooks are env-flag gated
     (`PASSPORT_SHELL_ENV_PREPARED`, `PASSPORT_MASTER_KEY`), so the server never imports Electron.

## Sources

- T3 Code paths: cited inline. Local probes: `ELECTRON_RUN_AS_NODE=1 "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)" probe.cjs`; `codesign -dv --entitlements -`; `spctl -a -vv`; `du -sh`; `PlistBuddy`.
- Electron release schedule (45.0.0 stable 2026-10-20, Node 24.22.0): https://releases.electronjs.org/schedule
- Electron 44.0 blog (Chromium 152, Node 24.18.1): https://electronjs.org/blog/electron-44-0
- Electron `app` API (login items, `openAsHidden` removed in 45, protocol client, `open-url`, badge): https://www.electronjs.org/docs/latest/api/app
- Electron `utilityProcess`: https://www.electronjs.org/docs/latest/api/utility-process
- Electron `safeStorage`: https://www.electronjs.org/docs/latest/api/safe-storage
- Electron timelines and support policy: https://www.electronjs.org/docs/latest/tutorial/electron-timelines
- electron-builder auto-update and mac targets: https://www.electron.build/docs/features/auto-update ; https://www.electron.build/docs/mac
- Tauri 2 sidecar: https://v2.tauri.app/develop/sidecar/ ; plugins: https://v2.tauri.app/plugin/
- Tauri vs. Electron size and startup (secondary, rough): https://tech-insider.org/tauri-vs-electron-2026/
- Node SEA (v26.12.1 docs; `--build-sea` since 25.5): https://nodejs.org/api/single-executable-applications.html
- Node 24.22.1 darwin-arm64 tarball sizes: https://nodejs.org/dist/latest-v24.x/
- Sparkle: https://sparkle-project.org/documentation/
- Google OAuth for desktop apps (loopback, PKCE, no custom schemes): https://developers.google.com/identity/protocols/oauth2/native-app
- Gmail scopes (restricted tier): https://developers.google.com/workspace/gmail/api/auth/scopes
- Microsoft redirect URI rules: https://learn.microsoft.com/en-us/entra/identity-platform/reply-url
- Apple App Sandbox: https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox (the fetch returned only the title; the sandbox/MAS statements rely on general knowledge and should be verified)
- Apple SMAppService (macOS 13+): https://developer.apple.com/documentation/servicemanagement/smappservice (title only fetched; version from general knowledge)
