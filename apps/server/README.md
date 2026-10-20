# @passport/server

Local Hono HTTP server, `ws` domain-event stream, CLI, and background jobs. Every handler receives one `Backend`; `src/compose.ts` owns the real package implementations.

```sh
# From the repository root (Node 25, pnpm 10)
pnpm install
pnpm build
pnpm --filter @passport/server demo
# http://127.0.0.1:3000
pnpm --filter @passport/server typecheck
pnpm --filter @passport/server test
```

The demo has 40 emails, eight people, six matters, four calendar events, proposed replies, a held send, undoable history, and newsletter promotion evidence. It supports editing/approving/rejecting drafts, delayed outbox release/cancel, exact-state undo, matter status changes, trust configuration/pins, descriptor-based mock account setup/sync, model preferences, USER.md, manual reviews, and a daily digest. Everything is in memory, including credentials and config changes; restarting resets it. No email is sent and no model/provider network call is made. Verification fixtures represent header/signature results; content never sets badges.

## Composition and integration

```ts
import { createApp, createDemoBackend } from "@passport/server";
const backend = await createDemoBackend();
const app = createApp(backend); // app.request(...) works without a socket
```

`src/backend.ts` is the injection contract: `Store`, `ActionExecutor`, `PolicyEngine`, `AgentRuntime`, `ProviderRegistry`, `EventBus`, config persistence, account sync, optional abortable push, and shutdown. `startServer(backend)` adds static serving, WebSockets, schedulers, and a draining `close()`.

`createRealBackend(config, { storePath?, providers?, llm?, verifier? }?)` migrates the real SQLite Store,
loads or creates a private master key, hydrates accounts, and composes the provider registry, policy,
executor, agent and MCP server. Optional overrides support offline tests (`storePath: ":memory:"`).
`src/sync/` persists local ID mappings, ingests mail/calendar deltas, commits opaque cursor envelopes
only on complete passes, resets expired snapshots, and emits new arrivals once. Connected providers
are shared per account and reconnect after failure; mutations are never automatically replayed.
`drainAgentQueue()` awaits event-driven triage; `close()` drains work and releases providers/Store.

The HTTP host adds a loopback Streamable HTTP MCP listener on port 4318 (`mcpPort` /
`PASSPORT_MCP_PORT`). `passport mcp` uses stdio with background jobs and stderr diagnostics, without
an HTTP listener. Use HTTP MCP when the UI server is running; one writer owns each data directory.

Three explicit **policy seams** skips in `src/e2e.test.ts` cover complete-Person creation,
newsletter/known-contact playbooks, and `emailPatch` metadata/undo. The server does not bypass
these executor conventions. Real send approval/hold/release/cancel, archive undo, trust, digests,
synchronization, OAuth callbacks, stdio and in-memory MCP are tested independently.

## Configuration

Load `<PASSPORT_DATA_DIR>/passport.config.json` (default `~/.passport/passport.config.json`). Missing file uses defaults; malformed files fail. `saveConfig` writes atomically with mode 0600 under a 0700 directory. Example:

```json
{
  "host": "127.0.0.1",
  "port": 3000,
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

Environment overrides: `PASSPORT_DATA_DIR`, `PASSPORT_HOST`, `PASSPORT_PORT`, `PASSPORT_SYNC_INTERVAL_SECONDS` (1–2147483), `PASSPORT_DIGEST_HOUR` (local wall-clock hour, 0–23), `PASSPORT_LLM_PROVIDER`, `PASSPORT_LLM_MODEL`, `PASSPORT_LLM_BASE_URL`, `PASSPORT_LLM_FAST_MODEL`, `PASSPORT_LLM_API_KEY`. LLM providers: `anthropic`, `openai`, `openai-compatible`, `ollama`. Anthropic is the default. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` and `PASSPORT_LLM_API_KEY` override optional file `llm.apiKey`; environment keys are not copied to disk, and file-authored keys are preserved. Public responses omit keys. Without a cloud key the agent is disabled and Accounts shows “LLM not configured”; local Ollama/compatible models can run without a key. Account secrets are separated using descriptor `secret` flags and passed to `Store.accounts.setCredentials`, never account settings/config. The real Store must encrypt them; demo credentials are ephemeral.

## HTTP API

Same-origin JSON at `/api`; errors are `{ "error": { "code": "...", "message": "..." } }`. Malformed input returns 400, missing records 404, stale/conflicting actions 409, explicit integration stubs 501. Unexpected provider errors return a generic 500 without exposing credential-bearing messages. No CORS: Vite proxies the API. Bind defaults to loopback; authentication for remote hosting is outside this wave.

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
| `GET /api/emails`                   | `EmailQuery`: `accountId`, `mailboxId`, `threadId`, `matterId` (`null` supported), `personId`, `text`, `category`, ISO `after`/`before`, `limit`, `cursor`, `sort`, `includeBodies=true`, comma-separated keyword `has`/`not` → `Page<Email>` |
| `GET /api/emails/:id`               | Full `Email` including bodies                                                                                                                                                                                                                 |
| `GET /api/threads/:id`              | `{thread: Thread, emails: Page<Email>}`                                                                                                                                                                                                       |
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
| `POST /api/accounts/:id/sync`       | Sync one account → `{ok: true}`                                                                                                                                                                                                               |
| `GET /api/providers`                | Available setup descriptors. OAuth functions omitted; only scope metadata is JSON. Demo offers mock only. OAuth setup uses the CLI callback listener.                                                                                         |
| `PUT /api/settings/llm`             | Partial `provider`, `model`, `baseUrl`, `fastModel`; rejects API keys → public LLM config                                                                                                                                                     |
| `POST /api/agent/run`               | Optional `{instruction, emailIds, matterId}` → `AgentRun`                                                                                                                                                                                     |
| `GET /api/digest/:date`             | `YYYY-MM-DD` → `{date, markdown}`; Store KV key `digest:YYYY-MM-DD`; 404 if no digest                                                                                                                                                         |

`ws://127.0.0.1:3000/ws` streams each raw `DomainEvent` as one JSON text frame. Reconnect clients should refetch current HTTP state; there is no replay protocol. Slow clients are disconnected. Mutating browser requests and WebSocket upgrades require matching origins; non-browser local clients can omit Origin.

The built `apps/web/dist` is served when present, with SPA history fallback. Unknown `/api/*` routes stay JSON 404s. Without a web build the root explains how to start/build the UI.

## Schedulers and CLI

`startSchedulers` discovers accounts on startup and each sync interval, prevents overlapping account syncs, and consumes optional abortable push. It calls `releaseDue` every 30 seconds, `applyDecay` every 24 hours, the daily `matter_review` trigger, and the `daily_digest` trigger at the configured local hour (rescheduled each day for DST). `stop()` aborts push, clears all timers, and drains active work before storage closes. Failed jobs are logged without credential/body data and retried at the next interval.

The `passport` bin is `dist/cli.js` after build. During development use `pnpm --filter @passport/server exec tsx src/cli.ts ...`:

```sh
passport demo                       # full ephemeral UI
passport serve                      # durable backend, UI and HTTP MCP on :4318/mcp
passport sync --demo
passport accounts list --demo
passport accounts add mock --demo
passport trust --demo
passport decisions --demo
passport triage <emailId>            # explicitly triage a stored email
passport mcp                        # real MCP over stdio; diagnostics on stderr
```

Account add prompts for descriptor fields, hiding secret entry. Secret fields can also use `PASSPORT_SETUP_<FIELD_ID_IN_UPPERCASE>` environment variables (punctuation becomes `_`), avoiding terminal echo. OAuth setup prints a consent URL and validates state/PKCE at `http://127.0.0.1:53682/oauth/callback` (override with `PASSPORT_OAUTH_REDIRECT_URI`), then stores tokens encrypted. Demo CLI mutations last only for that process. `SIGINT`/`SIGTERM` drain the server. Tests use no provider/LLM network; the WebSocket test uses an ephemeral loopback port.
