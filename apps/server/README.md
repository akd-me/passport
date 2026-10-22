# @passport/server

Local Hono HTTP server, `ws` domain-event stream, CLI, and background jobs. Every handler receives one `Backend`; `src/compose.ts` owns the real package implementations.

```sh
# From the repository root (Node 24, pnpm 10)
pnpm install
pnpm build
pnpm --filter @passport/server demo
# Open the http://127.0.0.1:3000/?token=... URL printed in the terminal
pnpm --filter @passport/server typecheck
pnpm --filter @passport/server test
```

The demo has 40 emails, eight people, six matters, four calendar events, proposed replies, a held send, undoable history, and newsletter promotion evidence. It supports editing/approving/rejecting drafts, delayed outbox release/cancel, exact-state undo, matter status changes, trust configuration/pins, descriptor-based mock account setup/sync, model preferences, USER.md, manual reviews, and a daily digest. Everything is in memory, including credentials and config changes; restarting resets it. No email is sent and no model/provider network call is made. Verification fixtures represent header/signature results; content never sets badges.

## Composition and integration

```ts
import { createApp, createDemoBackend } from "@passport/server";
const backend = await createDemoBackend();
const app = createApp(backend); // app.request(...) works without a socket
// API requests still require authentication; see src/auth.test-client.ts for test injection.
```

`src/backend.ts` is the injection contract: `Store`, `ActionExecutor`, `PolicyEngine`, `AgentRuntime`, `ProviderRegistry`, `EventBus`, config persistence, account sync, optional abortable push, and shutdown. `startServer(backend)` adds static serving, WebSockets, schedulers, and a draining `close()`.

`createRealBackend(config, { storePath?, providers?, llm?, verifier?, clientMode? }?)` migrates the real SQLite Store,
loads or creates a private master key, hydrates accounts, and composes the provider registry, policy,
executor, agent and MCP server. Optional overrides support offline tests (`storePath: ":memory:"`).
Mail is not mirrored and never backfilled. `src/ondemand-wiring.ts` resolves each account's
`MailReader` for tools, MCP and the read-through routes; reads fill a bounded envelope and body cache.
`src/watch/` runs one new-mail watcher per mail account (`watch:<accountId>`, every
`watch.intervalSeconds`, default 30) that follows `MailReader.changes` from a cursor taken at
connect time in the `arrivals` quota lane, caches new envelopes, patches labels and deletions in the
cache, and enqueues arrivals for new Inbox mail that is not from you. An expired cursor marks labels
stale and runs one bounded sweep; rate limits back off the watcher. `src/sync/` keeps
provider-to-local identity mappings, the shared per-account provider connections (reconnected after
failure; mutations are never replayed) and the bounded calendar sync. `src/tasks/` owns tasks, runs,
lanes and conversation watches ([docs/tasks.md](../../docs/tasks.md)).
`drainAgentQueue()` awaits event-driven triage; `close()` drains work and releases providers/Store.

New arrivals are persisted in `Store.kv` under `arrival:<emailId>` before the watcher emits the arrival; triage is recorded on the account's Inbox task.
The immediate queue and the single-flight `agent.arrivals` job (every 30 seconds) share per-account
serialization. Failed attempts retry after 1 minute, 5 minutes, 15 minutes, and 1 hour, including
after a restart. After five failures, the Decisions feed shows “Needs your attention: triage failed”
as a proposed internal matter action. Approving it adds a manual-review next step to the existing
matter or creates a review matter for an unattached email. Rejection dismisses the proposal;
automatic triage stops after the fifth attempt. Without a configured model, entries remain pending
without consuming attempts. A durable `arrival:pending` index provides discovery through `Store.kv`. SQLite transaction-backed
compare-and-set claims protect against accidental double owners, with renewable 60-second leases.
Arrivals carry `runId: arrival:<emailId>`; the server stamps runtime Actions and mirrors run checkpoints
under that stable identity. A retry with logged Actions or a completed checkpoint is acknowledged.
Related calendars defer inference for up to one minute; timed-out proposals visibly state that
availability is unverified. Conflicting held calendar proposals return to review at release. The server keeps temporary local
adapters for SQLite KV transactions, calendar provider-ID lookup and recurrence expansion so this
change does not alter packages or the workspace dependency graph. The KV adapter uses SQLiteStore's
existing connection synchronously; a future public Store CAS API can replace it.

The HTTP host adds a loopback Streamable HTTP MCP listener on port 4318 (`mcpPort` /
`PASSPORT_MCP_PORT`). `passport mcp` uses stdio in client mode, with stderr diagnostics and no
schedulers, arrival queue or HTTP listener. Only `serve`/`demo` acquires `<data-dir>/owner.lock`
(PID/start time, atomic writes, 10-second heartbeat, 60-second expiry or exited PID). Shutdown
removes only its own lock. Both stdio and HTTP clients can coexist with that owner.

The **policy seams** integration tests in `src/e2e.test.ts` cover complete-Person creation,
newsletter/known-contact playbooks, and `emailPatch` metadata/undo. The server does not bypass
these executor conventions. Real send approval/hold/release/cancel, archive undo, trust, digests,
the watcher, calendar sync, tasks, OAuth callbacks, stdio and in-memory MCP are tested independently.

## Configuration

Load `<PASSPORT_DATA_DIR>/passport.config.json` (default `~/.passport/passport.config.json`). Missing file uses defaults; malformed files fail. `saveConfig` writes atomically with mode 0600 under a 0700 directory. Example:

```json
{
  "host": "127.0.0.1",
  "port": 3000,
  "watch": { "intervalSeconds": 30 },
  "syncIntervalSeconds": 120,
  "dailyDigestHour": 8,
  "llm": {
    "provider": "ollama",
    "model": "llama3.2",
    "baseUrl": "http://localhost:11434"
  },
  "accounts": []
}
```

Environment overrides: `PASSPORT_DATA_DIR`, `PASSPORT_HOST`, `PASSPORT_PORT`, `PASSPORT_WATCH_INTERVAL_SECONDS` (new-mail watcher, 5–86400), `PASSPORT_SYNC_INTERVAL_SECONDS` (calendar sync and account discovery, 1–2147483), `PASSPORT_DIGEST_HOUR` (local wall-clock hour, 0–23), `PASSPORT_LLM_PROVIDER`, `PASSPORT_LLM_MODEL`, `PASSPORT_LLM_BASE_URL`, `PASSPORT_LLM_FAST_MODEL`, `PASSPORT_LLM_API_KEY`, `PASSPORT_CLAUDE_PATH`, `PASSPORT_CODEX_PATH` (host CLI binaries; win over the file's `hostAgents.claudePath`/`codexPath`), `PASSPORT_SHELL_ENV_PREPARED` (a launcher already read PATH from the login shell; optional `PASSPORT_SHELL_ENV_SOURCE`). Without a terminal and that flag, `serve`/`demo` read PATH from the login shell before host-agent detection (`src/shell-env.ts`; see [install](../../docs/install.md#running-from-a-gui-or-launchd)). LLM providers: `anthropic`, `openai`, `openai-compatible`, `ollama`. Anthropic is the default. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` and `PASSPORT_LLM_API_KEY` override optional file `llm.apiKey`; environment keys are not copied to disk, and file-authored keys are preserved. Public responses omit keys. Without a cloud key the agent is disabled and Accounts shows “LLM not configured”; local Ollama/compatible models can run without a key. Account secrets are separated using descriptor `secret` flags and passed to `Store.accounts.setCredentials`, never account settings/config. The real Store must encrypt them; demo credentials are ephemeral.

## Authentication and network access

`passport serve` prints one login URL at startup. Open `http://127.0.0.1:3000/?token=...` to exchange the token for an opaque `HttpOnly; SameSite=Strict; Path=/` session cookie, then receive a 303 redirect to `/` with the token removed. Without a session, the web app shows a token entry page before loading workspace data. Sessions expire after 24 hours or when the server restarts. Demo mode generates an ephemeral token and never writes it to disk, unless `PASSPORT_API_TOKEN` explicitly supplies the token.

For durable workspaces, `PASSPORT_API_TOKEN` takes precedence; otherwise the server atomically creates `<data dir>/api-token` from 32 random bytes encoded as 64 hex characters, with mode 0600. `passport token` prints the durable token again; `passport token --rotate` replaces the file token and revokes existing sessions and old bearer credentials on the next request. Environment tokens must be rotated by changing the environment and restarting. An already-open WebSocket stays connected until closed; restart to disconnect all clients immediately. The current demo token is available only from that process's startup URL.

Non-browser clients send `Authorization: Bearer <token>` on all `/api` requests (including health). HTTP query tokens are accepted only for the root login URL. Browser API writes automatically send `X-Requested-With: passport`; cookie-authenticated state-changing requests without it return 403. Bearer clients are exempt from that header. Auth endpoints remain subject to Host and Origin checks:

- `POST /api/auth/login { "token": "..." }`: sets the session cookie and redirects to `/` (303).
- `GET /api/auth/status`: returns `{authenticated, tokenPath}` without returning any credential.
- `POST /api/auth/logout`: requires authentication (and the header for cookie clients), revokes the current session, and clears the cookie.

`PASSPORT_HOST` defaults to `127.0.0.1`. A non-loopback bind refuses to start unless `PASSPORT_API_TOKEN` is explicitly set or `passport serve --allow-remote` is used; either choice prints a warning. Binding remotely does not add a trusted Host automatically. The Host allowlist defaults to `127.0.0.1`, `localhost`, and `[::1]`, each with any port. Add exact LAN/Tailscale/proxy names with `PASSPORT_ALLOWED_HOSTS=passport.example.ts.net,mail.lan:8443`; bare names allow any port and entries with a port require that port. Wildcards and URL syntax are rejected. Untrusted Hosts return 421, including requests for static assets. If present, Origins on state-changing requests and WebSocket upgrades must be HTTP(S) origins with an allowed host; mismatches return 403, including for bearer clients. Clients outside a browser can omit Origin.

Set `PASSPORT_TRUST_PROXY=true` (or `1`) only behind a trusted reverse proxy that terminates TLS and overwrites `X-Forwarded-Proto`. An `https` value then sets `Secure` on cookies; direct HTTPS also sets it. Forwarded Host headers never expand the Host allowlist. The UI uses a self-only CSP with inline styles allowed, no inline scripts, no framing, `nosniff`, and `Referrer-Policy: no-referrer`; responses use `Cache-Control: no-store`.

In development, the existing Vite `/api` and `/ws` proxies carry cookies and the request header. Paste the token in the Vite login page, or use `http://127.0.0.1:5173/?token=...`; the client exchanges it through `/api/auth/login` and removes it from the address bar. The separate MCP HTTP listener has its own security configuration; this middleware does not apply to it or to `passport mcp` over stdio. See [the security model](../../docs/security.md) before exposing Passport to a network.

## HTTP API

Same-origin JSON at `/api`; errors are `{ "error": { "code": "...", "message": "..." } }`. Malformed input returns 400, missing records 404, stale/conflicting actions 409, explicit integration stubs 501. Unexpected provider errors return a generic 500 without exposing credential-bearing messages. No CORS: Vite proxies the API. API requests and WebSocket upgrades require authentication; see above.

All IDs in paths are URL-encoded. `Page<T>` is `{items, total?, nextCursor?}`. List defaults are controlled by Store; the demo uses offset-string cursors. `limit` is 1–500.

| Method and path                     | Input and response                                                                                                                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                   | `{ok, mode}`                                                                                                                                                                                                                                  |
| `GET /api/decisions`                | `Page<ActionRecord>` containing proposed and held actions, up to 500                                                                                                                                                                          |
| `POST /api/actions/:id/approve`     | Empty body or `{request: ActionRequest}` (`editedRequest` alias accepted). Human editor may change draft `textBody`; routing, recipients, actor and category stay with the stored request. Returns `ActionRecord`.                            |
| `POST /api/actions/:id/reject`      | Optional `{reason: string}` → `ActionRecord`                                                                                                                                                                                                  |
| `POST /api/actions/:id/cancel-hold` | No body → `ActionRecord`                                                                                                                                                                                                                      |
| `POST /api/actions/:id/undo`        | No body → original `ActionRecord` marked undone; inverse gets a separate log record                                                                                                                                                           |
| `GET /api/actions`                  | `ActionQuery`: comma-separated `status`, `category`, `actorKind`, `runId`, `matterId`, ISO `after`/`before`, `limit`, `cursor` → `Page<ActionRecord>`                                                                                         |
| `GET /api/emails`                   | Provider search: `q` (portable query), `account`, `limit` (1–100, default 25), `pageToken` (needs `account`) → `{items: MailRow[], nextPageToken?, cost, source}`; all accounts fan out and merge by date. Without a reader (demo): the cached `EmailQuery` with `source: "cache"`. Rate limits answer 429 with `Retry-After` |
| `GET /api/emails/:id`               | Read-through by ULID or mail handle: cache, else provider → full `Email` including bodies |
| `GET /api/threads/:id`              | Thread handle: read from the provider; cached thread id: from the cache → `{thread: Thread, emails: Page<Email>}` |
| `GET /api/matters`                  | `status` (comma-separated), `personId`, `text`, `limit` → `Matter[]`                                                                                                                                                                          |
| `GET /api/matters/:id`              | `{matter, emails: Page<Email>, events: CalendarEvent[], actions: Page<ActionRecord>, people: Person[]}`                                                                                                                                       |
| `PATCH /api/matters/:id`            | Partial `title`, `summary`, `nextStep`, `status`, `dueAt`, `snoozedUntil`; submits a human `matter_update` through the executor → `ActionRecord`                                                                                              |
| `GET /api/people`                   | `relationship`, `text`, `limit` → `Person[]`                                                                                                                                                                                                  |
| `GET /api/people/:id`               | `{person, emails: Page<Email>, matters: Matter[]}`                                                                                                                                                                                            |
| `GET /api/events`                   | Calendar records, not domain history. `accountId`, `matterId`, paired ISO `start`/`end`, `limit` → `CalendarEvent[]`                                                                                                                          |
| `GET /api/trust`                    | `{config: GlobalPolicyConfig, categories: TrustState[], promotionOffers: PromotionOffer[]}`                                                                                                                                                   |
| `PUT /api/trust/config`             | Partial `GlobalPolicyConfig` → full config                                                                                                                                                                                                    |
| `PUT /api/trust/:category/pin`      | `{level: TrustLevel \| null}` → `TrustState` (null restores earned level)                                                                                                                                                                     |
| `GET /api/user-profile`             | `{markdown: string}`                                                                                                                                                                                                                          |
| `PUT /api/user-profile`             | `{markdown: string}` → saved profile                                                                                                                                                                                                          |
| `GET /api/accounts`                 | `{accounts: Account[], llm: LlmConfig without apiKey + apiKeyConfigured, mode}`                                                                                                                                                               |
| `POST /api/accounts`                | `{kind, emailAddress?, displayName?, fields: Record<string,string>}`; descriptor-driven fields, required ones validated → `Account` (201). Email/name may be descriptor fields.                                                               |
| `POST /api/accounts/:id/sync`       | Calendar sync plus an immediate new-mail check → `{ok: true}` |
| `GET /api/providers`                | Available setup descriptors. OAuth functions omitted; only scope metadata is JSON. Demo offers mock only. OAuth setup uses the CLI callback listener.                                                                                         |
| `PUT /api/settings/llm`             | Partial `provider`, `model`, `baseUrl`, `fastModel`; rejects API keys → public LLM config                                                                                                                                                     |
| `GET /api/settings/host-agents`     | `{pathSource: {source, label, entries}, paths: {claude-code, codex: {configured, environment}}, agents: HostAgentStatus[]}`; `?refresh=1` re-detects                                                                                         |
| `PUT /api/settings/host-agents`     | Partial `{claudePath, codexPath}` (absolute or `~/`; `null`/`""` clears) → saved to config, re-detected, same shape as GET                                                                                                                  |
| `POST /api/settings/host-agents/redetect` | Re-read PATH from the login shell, re-detect host agents → same shape as GET                                                                                                                                                            |
| `POST /api/agent/run`               | Optional `{instruction, emailIds, matterId}` → `AgentRun` plus the `taskId` of the task created for it |
| `/api/tasks/*`                      | Tasks, runs, items, messages, interrupt, snooze, settle, archive, pin, watches: see [docs/tasks.md](../../docs/tasks.md#http-api). `501 TASKS_UNAVAILABLE` on the demo backend |
| `GET /api/digest/:date`             | `YYYY-MM-DD` → `{date, markdown}`; Store KV key `digest:YYYY-MM-DD`; 404 if no digest                                                                                                                                                         |

`ws://127.0.0.1:3000/ws` streams each raw `DomainEvent` as one JSON text frame. Reconnect clients should refetch current HTTP state; there is no replay protocol. Slow clients are disconnected. The upgrade requires a bearer header, session cookie, or `?token=<token>` for non-browser WS clients. Browser clients use the same-origin cookie automatically. Host and Origin are validated before upgrading.

The built `apps/web/dist` is served when present, with SPA history fallback. Unknown `/api/*` routes stay JSON 404s. Without a web build the root explains how to start/build the UI.

## Schedulers and CLI

`startSchedulers` discovers accounts on startup and each `syncIntervalSeconds`, and registers per-account jobs: the new-mail watcher (`watch:<accountId>`, plus `watch:<accountId>:push`, a bounded IMAP IDLE long poll that triggers an immediate check) for mail accounts and the bounded calendar sync (`sync:<accountId>`) for calendars, without overlapping runs. It calls `releaseDue` every 30 seconds, `applyDecay` every 24 hours, store maintenance weekly (Sunday 03:30; the watcher enforces the cache bounds hourly), and the daily `matter_review` and `daily_digest` routines (at the configured local hour, rescheduled each day for DST), each on its own routine task. `stop()` clears all timers and drains active work before storage closes. Failed jobs are logged without credential/body data and retried at the next interval.

The `passport` bin is `dist/cli.js` after build. During development use `pnpm --filter @passport/server exec tsx src/cli.ts ...`:

```sh
passport demo                       # full ephemeral UI
passport serve                      # durable backend, UI and HTTP MCP on :4318/mcp
passport token                      # print the durable API token
passport token --rotate             # rotate a file token and revoke sessions
passport sync --demo
passport accounts list --demo
passport accounts add mock --demo
passport trust --demo
passport decisions --demo
passport triage <emailId>            # explicitly triage a stored email
passport mcp                        # real MCP over stdio; diagnostics on stderr
```

Account add prompts for descriptor fields, hiding secret entry. Secret fields can also use `PASSPORT_SETUP_<FIELD_ID_IN_UPPERCASE>` environment variables (punctuation becomes `_`), avoiding terminal echo. OAuth setup prints a consent URL and validates state/PKCE at `http://127.0.0.1:53682/oauth/callback` (override with `PASSPORT_OAUTH_REDIRECT_URI`), then stores tokens encrypted. Demo CLI mutations last only for that process. `SIGINT`/`SIGTERM` drain the server. Tests use no provider/LLM network; the WebSocket test uses an ephemeral loopback port.
