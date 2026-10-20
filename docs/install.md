# Installation

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
`serve` creates a persistent workspace. No account or model key is required just
to start it. Without a model key, automatic triage is disabled, while UI, sync,
human decisions and MCP remain available.

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
node scripts/smoke-package.mjs apps/server/dist/akd-me-passport-0.1.0.tgz
```

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
npm install -g ./apps/server/dist/akd-me-passport-0.1.0.tgz
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
  "syncIntervalSeconds": 120,
  "calendarMaxSyncAgeMinutes": 10,
  "dailyDigestHour": 8,
  "llm": {
    "provider": "anthropic",
    "model": "your-chosen-model"
  }
}
```

Choose an available model at your provider. `llm.provider` accepts `anthropic`,
`openai`, `openai-compatible` or `ollama`; optional fields include `fastModel`,
`baseUrl` and `apiKey`. Prefer environment variables for secrets. Passport does
not automatically load `.env` for a native CLI process; export variables in your
shell or service manager. Docker Compose loads the supplied `.env` file.

| Environment variable | Purpose |
| --- | --- |
| `PASSPORT_DATA_DIR` | Database, config and generated key directory |
| `PASSPORT_HOST`, `PASSPORT_PORT` | API bind address and port; defaults `127.0.0.1:3000` |
| `PASSPORT_MCP_PORT` | Loopback HTTP MCP port, default `4318` |
| `PASSPORT_LLM_PROVIDER`, `PASSPORT_LLM_MODEL` | Model adapter and model name |
| `PASSPORT_LLM_FAST_MODEL` | Optional model for classification |
| `PASSPORT_LLM_BASE_URL` | Compatible/Ollama endpoint override |
| `PASSPORT_LLM_API_KEY` | Selected provider's key |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Provider-specific fallback keys |
| `PASSPORT_MASTER_KEY` | Credential encryption secret; omitted generates `master.key` |
| `PASSPORT_SYNC_INTERVAL_SECONDS` | Poll interval, default `120` |
| `PASSPORT_CALENDAR_MAX_SYNC_AGE_MINUTES` | Maximum calendar sync age at proposal release, default `10` minutes |
| `PASSPORT_DIGEST_HOUR` | Local wall-clock digest hour, default `8` |
| `PASSPORT_OAUTH_REDIRECT_URI` | Override the registered OAuth callback |

Environment model keys are not copied into saved configuration; a file-authored
key remains in that file. Provider credentials are encrypted in SQLite. Keep
the generated `master.key` or your chosen master secret with your backups; mail
bodies and the whole database are not encrypted by Passport.

For Ollama, set `PASSPORT_LLM_PROVIDER=ollama`, select an installed model and use
`PASSPORT_LLM_BASE_URL=http://localhost:11434`. In Docker, use a hostname reachable
from the container instead. See [deployment](deploy.md).

## Accounts and agents

Run `passport serve` and use **Accounts → Add account** in the browser. Gmail uses a
Google Desktop app OAuth client; see [accounts](accounts.md) for scopes and setup.
`passport init --llm none --skip-account` initializes a workspace unattended;
`printf 'none\nskip\n' | passport init` also works. `passport sync` requests one
sync pass from the running server, or uses the store directly when no owner is live.

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
