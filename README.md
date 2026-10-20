# Passport

An open-source, local-first, agent-native email harness. Agents work on mail, calendar,
people and matters through a trust policy you control. Bring your own providers and models.
Actions are audited, reversible changes support undo, and sends wait in a cancellable outbox.

## Try the demo

Requires Node 25 (for built-in SQLite) and pnpm 10. From the repository root:

```sh
pnpm install
pnpm build
pnpm --filter @passport/server demo
```

Open **http://127.0.0.1:3000**. The demo has 40 emails, six matters, eight people, four
calendar events, decisions, editable drafts, trust controls and USER.md. It stays in memory;
no provider or model requests run, and restarting resets it.

## Run for real

After building, the CLI is `node apps/server/dist/cli.js`; the commands below use that form.
The package also declares a `passport` executable, so an installed/linked CLI accepts
`passport serve`, `passport accounts add gmail`, `passport sync`, and `passport triage <emailId>`.

Create `~/.passport/passport.config.json` (or set `PASSPORT_DATA_DIR` to another directory):

```json
{
  "host": "127.0.0.1",
  "port": 3000,
  "mcpPort": 4318,
  "syncIntervalSeconds": 120,
  "dailyDigestHour": 8,
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5"
  }
}
```

Set `ANTHROPIC_API_KEY` privately in your environment, then start:

```sh
node apps/server/dist/cli.js serve
```

The UI opens at **http://127.0.0.1:3000**; mailbox MCP is at **http://127.0.0.1:4318/mcp**.
An empty data directory works without a model key: sync, UI, human decisions and MCP remain
available, while automatic triage is disabled and Accounts shows **LLM not configured**.

LLM providers are `anthropic` (default), `openai`, `openai-compatible` and `ollama`.
Configure `model`, optional `fastModel`, `baseUrl` and `apiKey` in the `llm` object.
Environment overrides are `PASSPORT_LLM_PROVIDER`, `PASSPORT_LLM_MODEL`,
`PASSPORT_LLM_BASE_URL`, `PASSPORT_LLM_FAST_MODEL`, and `PASSPORT_LLM_API_KEY`;
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` supply the selected provider's key. Environment keys
are never copied into the config file. An explicitly written file key is preserved on save;
keep that file private. API responses omit all model keys.

For Ollama, for example, use `{"provider":"ollama","model":"your-installed-model","baseUrl":"http://localhost:11434"}`.
`PASSPORT_HOST`, `PASSPORT_PORT`, `PASSPORT_MCP_PORT`, `PASSPORT_SYNC_INTERVAL_SECONDS` and
`PASSPORT_DIGEST_HOUR` override server settings. The digest hour uses local wall-clock time;
`GET /api/digest/YYYY-MM-DD` uses UTC dates.

### Gmail with your own OAuth client

1. In your Google Cloud project, enable the Gmail API and configure consent. Add your account
   as a test user if the app is in testing mode.
2. Create an OAuth **Web application** client. Register the exact redirect URI
   `http://127.0.0.1:53682/oauth/callback`. A custom loopback URI can be supplied through
   `PASSPORT_OAUTH_REDIRECT_URI` and must also be registered with Google.
3. Run `node apps/server/dist/cli.js accounts add gmail`. Enter your email address, display
   name, client ID and client secret. Secret entry is hidden; scripting can use
   `PASSPORT_SETUP_CLIENTSECRET`. Open the printed authorization URL. Passport validates
   OAuth state, exchanges the code using PKCE, then shuts down its one-shot callback listener.
4. Start `serve`, or run `node apps/server/dist/cli.js sync` for one pass.

Use `accounts add google-calendar` with the Google Calendar API enabled to add calendar
sync separately. Microsoft Graph, JMAP and CalDAV also have descriptor-driven CLI setup.
OAuth accounts are added through the CLI; the Accounts page supports non-OAuth setup.
Provider-specific details and scopes are in [providers](packages/providers/README.md).

### IMAP with an app password

Create an app password with your provider, then run:

```sh
node apps/server/dist/cli.js accounts add imap
```

Enter the IMAP host, port (typically 993), TLS (`true` for implicit TLS), optional username,
app password, SMTP host, SMTP port (typically 465), and SMTP TLS. Blank optional values use
provider defaults; a separate SMTP password is optional. Secrets are hidden or read from
`PASSPORT_SETUP_PASSWORD` / `PASSPORT_SETUP_SMTPPASSWORD`. For STARTTLS use port 143/587
and `false` for the corresponding implicit TLS field.

Accounts and provider credentials live in SQLite. Credentials are encrypted with
`PASSPORT_MASTER_KEY`, or a generated `master.key` in the data directory with mode 0600.
Keep that key with your backups. Periodic sync and supported push notifications share one
connected adapter per account; failures reconnect on the next operation without replaying sends.

Run one backend writer per data directory. Stop `serve` before using mutating standalone
CLI commands against the same directory. Use HTTP MCP while the UI server is running.

## Use from Claude Code / Codex

For stdio, register the built CLI with an absolute path. This is the `passport mcp` command;
it starts the real backend, synchronization and background jobs without an HTTP listener,
and writes diagnostics only to stderr:

```sh
claude mcp add --transport stdio passport -- node /absolute/path/to/passport/apps/server/dist/cli.js mcp
codex mcp add passport -- node /absolute/path/to/passport/apps/server/dist/cli.js mcp
```

Or run `passport serve` and connect to its Streamable HTTP endpoint:

```sh
claude mcp add --transport http passport http://127.0.0.1:4318/mcp
codex mcp add passport --url http://127.0.0.1:4318/mcp
```

See the [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
and [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) for client configuration.
MCP tools include `search_emails`, `archive_emails`, drafts, calendar queries, matters and
people. All writes use the shared executor as external-agent actions, capped by your external
trust ceiling. Human approvals, cancellation and undo remain in the UI/API.

## Architecture

[docs/CONTRACT.md](docs/CONTRACT.md) defines the frozen interfaces and invariants.
`types` defines the model; `store` supplies SQLite, encrypted credentials and the event bus;
`providers` normalizes mail/calendar services; `policy` gates, audits and executes actions;
`agent` performs triage and scheduled reviews; `mcp` exposes tools to external agents.
`apps/server` composes these, maps provider identities during sync, queues triage, schedules
outbox/digest/review/decay jobs, and serves the React UI in `apps/web`.

The integration tests in `apps/server/src/e2e.test.ts` include three explicit **policy seams**
skips pending the executor's complete-Person creation and `emailPatch` conventions:
newsletter playbooks, known-contact draft decisions, and matter email metadata/undo.
No server workaround bypasses policy. Other covered paths include real sync, send holds,
release/cancel, archive undo, trust learning, digests and MCP.

```sh
pnpm build
pnpm typecheck
pnpm test
```
