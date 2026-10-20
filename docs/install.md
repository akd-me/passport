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

Open http://127.0.0.1:3000. `demo` is an ephemeral, offline fixture workspace;
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
`passport --help`, `passport mcp --help` and project MCP registration, then starts
both demo and persistent servers. It uses curl to check health and decisions,
fetches the packaged UI/assets, checks graceful shutdown and deletes its data.
It uses no real mail or model credentials. Curl and network access to npm are
required for this installation check.

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

After stopping the backend writer, use `passport accounts add gmail`,
`passport accounts add graph` or `passport accounts add imap`. See
[accounts](accounts.md) for OAuth clients, scopes and provider fields. Then start
`passport serve`, or run `passport sync` for one pass.

`passport mcp install --client claude-code` writes `.mcp.json` in the current
project, preserving other entries. It refuses to replace a different existing
Passport entry. The config refers to this installation's absolute executable
path and includes an explicit data directory if set. Review before committing
it because paths can be machine-specific. No model/provider secret is captured.

`passport mcp` starts a backend over stdio. Do not run it against a directory
already owned by `serve`; connect your MCP client to
http://127.0.0.1:4318/mcp instead. See the [root README](../README.md#use-it-from-claude-code-or-codex)
and [tool catalogue](tools.md).

Live provider/model validation is separate from the offline suite and package
smoke checks. See [SECURITY.md](../SECURITY.md) before exposing a listener.
