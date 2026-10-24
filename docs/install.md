# Installation

On a Mac, the [Mac app](#mac-app) is the recommended install: it bundles its own Node runtime and
runs the same server. Everything below the Mac app section is the server path (npm, source,
Docker in [deployment](deploy.md)), which works on any platform, including headless machines.

## Mac app

There is no signed download yet. Build the app on an Apple silicon Mac with Node 24 and pnpm:

```sh
git clone https://github.com/akd-me/passport.git
cd passport
corepack enable
pnpm install --frozen-lockfile
PASSPORT_DESKTOP_DMG=1 pnpm dist:desktop   # apps/desktop/dist/*.dmg, plus mac-arm64/Passport.app
```

Open the DMG and drag **Passport** to `/Applications`. The app is unsigned and not notarized, so
Gatekeeper blocks a double-click the first time: right-click the app, choose **Open**, then
**Open** again. If the DMG came from another Mac or a download, first run
`xattr -dr com.apple.quarantine /Applications/Passport.app`.

The app uses `~/.passport` (or `PASSPORT_DATA_DIR`) like the CLI, keeps the encryption key in the
Keychain, and attaches to a `passport serve` that already owns the workspace. The
[Mac app guide](desktop.md) covers the menu bar, notifications, logs, `passport://` links and the
bundled `passport` command.

## Node

Use Node **24** and pnpm **10.33.0** for development. Persistent workspaces require
**Node >=22.16 with SQLite FTS5**. There are no native SQLite addons.

The engineering contract's Node >=22.5 floor is insufficient on stock Node:
`node:sqlite` exists there, but a clean persistent startup fails with
`no such module: fts5`. Stock Node 22.13 also fails this probe. Node's
[22.16 SQLite build enables FTS5](https://github.com/nodejs/node/blob/v22.16.0/deps/sqlite/sqlite.gyp).
The public manifest therefore declares `engines.node: >=22.16`; the workspace's
root engine declaration is unchanged. The shim checks FTS5 before opening a
persistent workspace and recommends upgrading if it is missing. Demo mode still
works on Node 22.5; the shim supplies its required `--experimental-sqlite` flag.
Direct source/compiled entrypoints on Node 22.5–22.12 need that flag explicitly.

## Published CLI

The public npm name is **`@akd-me/passport`** and the executable is **`passport`**.
The unscoped `passport` package is the unrelated Passport.js project.
These registry commands require the first release to have been published:

```sh
npx @akd-me/passport demo
npx @akd-me/passport serve
# Or retain the CLI for everyday use:
npm install -g @akd-me/passport
passport --help
passport mcp --help
```

Open the login URL printed at startup (it includes the API token). `demo` is an ephemeral, offline fixture workspace;
`serve` creates a persistent workspace. No account or API key is required: if
Codex or Claude Code is installed and signed in on this machine, the agent uses
that subscription (see [Models](#models)). With no agent available, automatic
triage is disabled, while the UI, on-demand reads, the new-mail watcher, human
decisions and MCP remain available.

## Build from source

```sh
git clone https://github.com/akd-me/passport.git
cd passport
nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm demo
```

`pnpm dev` watches the source demo. `pnpm --filter @passport/server dev` and
`pnpm --filter @passport/server demo` remain available. For live frontend changes,
run `pnpm --filter @passport/web dev` in another terminal and use its printed URL.
Start a persistent workspace with `node apps/server/bin/passport.js serve`.

## Pack and test the installable artifact

```sh
pnpm run pack
node scripts/smoke-package.mjs apps/server/dist/akd-me-passport-<version>.tgz
```

`<version>` is the first release heading in `CHANGELOG.md` (the build reads it from there).

`pnpm run pack` builds everything, then runs `pnpm pack` in
`apps/server/dist/package`; the tarball is written to `apps/server/dist/`.
Use `pnpm run pack` explicitly: bare `pnpm pack` invokes pnpm's built-in command
against the root workspace rather than the root script.
The smoke script installs it with npm into an OS temporary directory, runs
`passport --help`, `passport mcp --help`, MCP install `--dry-run` and repeat project
MCP registration, then starts both demo and persistent servers on free loopback
ports. It reads the token from each printed login URL (or `PASSPORT_API_TOKEN`)
and uses authenticated curl requests to check `/api/health` and decisions,
fetches the packaged UI/assets, checks graceful shutdown and deletes its data.
It uses no real mail or model credentials. Curl and network access to npm are
required for this installation check. Any failed assertion exits non-zero.
CI runs this B4 regression in a separate package-smoke job on Node 22 and 24,
using the tarball produced by the build/test job.

To install a local build yourself:

```sh
npm install -g ./apps/server/dist/akd-me-passport-<version>.tgz
passport demo
```

The internal workspace stays named `@passport/server` to preserve source commands
and avoid changing other engineers' dependency graphs. `scripts/build-cli.mjs`
generates its public manifest with name `@akd-me/passport`, public access and
version from the first version heading in `CHANGELOG.md`.

The equivalent esbuild configuration is `apps/server/esbuild.config.mjs`:
workspace roots matching `noExternal: [/^@passport\//]` are bundled from their
source; real npm imports are external. Their exact installed versions are
collected from the reachable workspace manifests into the public `dependencies`,
and the build rejects an undeclared external import. Esbuild is reused from the
existing lockfile-pinned tsx toolchain, so this track adds no dependency or lockfile
changes. `node:sqlite` and other Node built-ins remain built-ins.

Only the bin shim, bundled `dist/`, built `web/dist/`, root README and license are
included via `files`. No private workspace package needs to be published. The
bundle sits at `dist/server/cli.js` so the server's existing `../../web/dist/`
lookup works without modifying source. Rebuild before packing manually:

```sh
pnpm build
pnpm --dir apps/server/dist/package pack --pack-destination ..
```

## Configuration

The default data directory is `~/.passport`; set `PASSPORT_DATA_DIR` to override
it. Configuration is read from `<data-dir>/passport.config.json`:

```json
{
  "host": "127.0.0.1",
  "port": 3000,
  "mcpPort": 4318,
  "watch": { "intervalSeconds": 30 },
  "syncIntervalSeconds": 120,
  "calendarMaxSyncAgeMinutes": 10,
  "dailyDigestHour": 8,
  "llmSelection": "auto",
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-5-5"
  }
}
```

`watch.intervalSeconds` (5–86400, default 30) is how often the new-mail watcher asks each mail
account what changed since its cursor; IMAP accounts with IDLE are also checked as soon as the
server signals new mail. `syncIntervalSeconds` now paces calendar sync and the check for accounts added outside the UI. There is no initial
sync or backfill: the watcher's cursor starts when you connect an account, and agents read older
mail on demand. A leftover `sync.initialDays` is ignored with a one-time warning; see
[accounts](accounts.md#watching-for-new-mail-account-controls-and-diagnostics).

`llmSelection` is `auto` (default) or `explicit`; see [Models](#models). In `auto`
mode `llm` is only the fallback used when no host agent is available.
`llm.provider` accepts `codex`, `claude-code` (no key), `anthropic`, `openai`,
`openai-compatible` or `ollama`; optional fields include `fastModel`, `baseUrl`
and `apiKey` (API providers only). Prefer environment variables for secrets. Passport does
not automatically load `.env` for a native CLI process; export variables in your
shell or service manager. Docker Compose loads the supplied `.env` file.

| Environment variable | Purpose |
| --- | --- |
| `PASSPORT_DATA_DIR` | Database, config and generated key directory |
| `PASSPORT_HOST`, `PASSPORT_PORT` | API bind address and port; defaults `127.0.0.1:3000` |
| `PASSPORT_MCP_PORT` | Loopback HTTP MCP port, default `4318` |
| `PASSPORT_LLM_PROVIDER`, `PASSPORT_LLM_MODEL` | Pin the provider (`codex`, `claude-code`, or an API provider) and model; skips auto-detection |
| `PASSPORT_CODEX_PATH`, `PASSPORT_CLAUDE_PATH` | Host CLI binary Passport cannot find; wins over `hostAgents.codexPath`/`claudePath` in the config file |
| `PASSPORT_SHELL_ENV_PREPARED` | Set by a launcher that already read PATH from the login shell; skips the probe (see [below](#running-from-a-gui-or-launchd)) |
| `PASSPORT_LLM_FAST_MODEL` | Optional model for classification |
| `PASSPORT_LLM_BASE_URL` | Compatible/Ollama endpoint override |
| `PASSPORT_LLM_API_KEY` | API provider key (optional; never passed to host agents) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Provider-specific fallback keys for API providers |
| `PASSPORT_MASTER_KEY` | Credential encryption secret; omitted generates `master.key` (the Mac app uses the Keychain instead) |
| `PASSPORT_WATCH_INTERVAL_SECONDS` | New-mail watcher interval (`watch.intervalSeconds`), default `30` |
| `PASSPORT_SYNC_INTERVAL_SECONDS` | Calendar sync (and account discovery) interval, default `120` |
| `PASSPORT_CALENDAR_MAX_SYNC_AGE_MINUTES` | Maximum calendar sync age at proposal release, default `10` minutes |
| `PASSPORT_DIGEST_HOUR` | Local wall-clock digest hour, default `8` |
| `PASSPORT_OAUTH_REDIRECT_URI` | Override the registered OAuth callback |

Environment model keys are not copied into saved configuration; a file-authored
key remains in that file. Provider credentials are encrypted in SQLite. Keep
the generated `master.key` or your chosen master secret with your backups; cached
envelopes and bodies, tasks, notes and the rest of the database are not encrypted by Passport.

### Data directory

| Path | Contents |
| --- | --- |
| `passport.sqlite` (+ WAL) | Envelope and body cache, tasks, notes, people, matters, action log, encrypted credentials |
| `passport.config.json` | Configuration above |
| `api-token`, `mcp-token` | UI/API and MCP bearer tokens (0600) |
| `master.key` or `master.key.keychain` | Credential key, or the marker that the Mac app keeps it in the Keychain |
| `owner.lock` | The live server's lease |
| `scratch/` | `mail_export` output for MCP clients with a shell: one private (0700) directory per MCP server session |
| `host-agent/` | Working directory for each Codex or Claude Code call |
| `setup-browser-profile/`, `setup-agent/` | Agent-driven account setup; keep out of backups |

The cache is bounded: bodies are evicted beyond 200 MB and envelopes beyond the 100,000 most
recently used. `mail_export` files are written for the client's own `rg` or scripts and are meant
to live 24 hours. The server sweeps `scratch/` at startup and from the `tasks.maintenance` job,
removing session directories older than 24 hours. Keep `scratch/` out of
backups.

## Models

Passport's default agent is the **Codex or Claude Code subscription on this
machine**. Install and sign in to either CLI once:

| Agent | Install | Sign in | Check |
| --- | --- | --- | --- |
| Codex | `npm install -g @openai/codex` ([docs](https://developers.openai.com/codex/cli)) | `codex login` (ChatGPT) | `codex login status` |
| Claude Code | [setup guide](https://docs.claude.com/en/docs/claude-code/setup) | `claude auth login` (Claude plan) | `claude auth status` |

With `llmSelection: "auto"`, each `serve` (and `doctor`, `sync`, `triage`) start
detects the CLIs on `PATH` plus the usual install locations (see
[Running from a GUI or launchd](#running-from-a-gui-or-launchd)), and uses Codex if it is signed in, else Claude Code, else the
configured API provider, else no agent. `passport init`, **Settings →
Model** and `PUT /api/settings/llm` record an explicit choice; `GET
/api/host-agents` returns what was detected. `passport doctor` lists both CLIs
with the fix for each and sends a one-word test request through the selected one.

Model defaults are `gpt-6.1-sol` (main) and `gpt-5.6-luna` (fast) for Codex and
`claude-sonnet-5-5` / `claude-haiku-5-5` for Claude Code; set `llm.model` and
`llm.fastModel` to any model your plan offers. A task run is one CLI session in
`<data-dir>/host-agent` whose only tools are Passport's own, served from the
server over a per-run loopback MCP endpoint; shell, file edits, web search, user
config and plugins stay disabled, so email content cannot drive local commands,
and every write still goes through Passport's policy. The CLI keeps the session's
transcript in its own data directory so follow-ups can resume it (see
[tasks](tasks.md#sessions)). Other calls (triage steps, routines) are fresh,
ephemeral, tool-less CLI runs. The CLI gets a minimal environment (home, path, locale, proxy and
CLI config variables only). Usage counts against your plan's limits; Passport
reports token usage without a cost. Docker images do not contain the CLIs; use an
API provider there, or run Passport natively.

### API providers (advanced)

Anthropic, OpenAI, OpenAI-compatible endpoints and Ollama remain available:
choose **advanced** in `passport init`, **Settings → Advanced**, or set
`PASSPORT_LLM_PROVIDER`. Keys come from the environment variables above.

For Ollama, set `PASSPORT_LLM_PROVIDER=ollama`, select an installed model and use
`PASSPORT_LLM_BASE_URL=http://localhost:11434`. In Docker, use a hostname reachable
from the container instead. See [deployment](deploy.md).

## Running from a GUI or launchd

A process started from Finder, the Dock, the Mac app or a LaunchAgent does not get your terminal's
`PATH`: macOS gives it roughly `/usr/bin:/bin:/usr/sbin:/sbin`. A `claude` or `codex` installed
with Homebrew, nvm, fnm, volta, mise, asdf, pnpm, bun or a custom npm prefix is then invisible,
and an npm-installed `codex` cannot find `node`.

When `passport serve` or `passport demo` starts without a terminal (stdin is not a TTY) and
`PASSPORT_SHELL_ENV_PREPARED` is unset, Passport runs your login shell once (`$SHELL -ilc`, then
`/bin/zsh`; 5-second limit) and copies `PATH`, the Homebrew, version-manager, certificate and
locale variables from it. Nushell and other non-POSIX shells are skipped. If no shell answers,
macOS's `launchctl getenv PATH` is used, and otherwise the inherited `PATH`. The startup log
shows the source and the number of `PATH` entries, never the `PATH` itself. A launcher that has
already done this can set `PASSPORT_SHELL_ENV_PREPARED=1` (and optionally
`PASSPORT_SHELL_ENV_SOURCE=login-shell|launchctl|fallback` for `doctor`) to skip the probe. The
Mac app does not set it: its server child runs the probe itself.

Discovery also checks `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.volta/bin`,
`~/.bun/bin`, `~/Library/pnpm`, `~/.npm-global/bin`, mise and asdf shims, and fnm's default alias.
If a CLI is still not found, set its full path (`which codex` in a terminal) under **Settings →
Model → Agent programs**, which saves it to `passport.config.json`:

```json
{ "hostAgents": { "codexPath": "/Users/me/.nvm/versions/node/v22.12.0/bin/codex" } }
```

**Re-detect** in the same panel reads the login shell again and re-checks both CLIs; in
automatic selection Passport switches to a newly signed-in agent without a restart.
`passport doctor` prints the **PATH source** (login shell, launchctl, fallback, inherited, or
prepared by the app) and each CLI's resolved path.

## Accounts and agents

Run `passport serve` and use **Connect another** in the sidebar (or **Settings → Accounts**). Gmail uses a
Google Desktop app OAuth client; see [accounts](accounts.md) for scopes and setup.
`passport init --llm auto --skip-account` initializes a workspace unattended
(`--llm codex|claude-code|none` also work); `printf 'none\nskip\n' | passport init`
also works. `passport sync` asks the running server for an immediate new-mail check and calendar
sync, or uses the store directly when no owner is live.

`passport mcp install --client claude-code|codex|cursor|claude-desktop` merges the
client config and preserves unrelated settings. `--http`, `--dry-run`, and
Claude Code's `--user` are supported. Existing files receive a timestamped backup;
previews redact secrets throughout the config. Stdio registrations include
`PASSPORT_DATA_DIR` for nondefault workspaces. The installed shim delegates these
options to the same CLI used from source. See [tools](tools.md#install-a-client).

Only `passport serve` (and `demo`) owns background work. It atomically publishes
`<data-dir>/owner.lock` with PID, process start time and a heartbeat every 10 seconds.
A heartbeat expires after 60 seconds; an exited PID also permits takeover. A second
live owner fails. Shutdown removes only its own lock. Use one server per data directory.
`passport mcp` shares the store in client mode without schedulers or arrival queues.
It still supports reads and policy-controlled submissions without `serve`, printing
a stderr notice that held/proposed actions wait for the server.

`jobs`, `trust`, `decisions`, `sync`, and `triage` use the running server's HTTP API
with `PASSPORT_API_TOKEN` or `<data-dir>/api-token`. A 401 is an error with recovery
instructions, never a local fallback. Direct access is allowed only when no server
responds and the owner lock is absent/stale; the command announces that fallback.
A live owner with an unreachable listener is an error.

Automatic arrivals persist checkpoints for people, classification, matters and
playbooks. Retries resume unfinished work; five failures surface a proposed
decision naming the incomplete step. Meeting proposals remain held while any
calendar sync is incomplete or its completed sync is too old. Release waits in
30-second increments up to three times, then returns the proposal for review
with `AVAILABILITY_UNVERIFIED`. Conflicting slots also return for review.

Live provider/model validation is separate from the offline suite and package
smoke checks. See [SECURITY.md](../SECURITY.md) before exposing a listener.
