# Passport: engineering contract

Read this before touching any package. It is the agreement that lets packages be built in parallel.

## What we are building

An open-source, local-first **harness** that lets AI agents operate on a person's email, calendar and
contacts under a trust policy. Think "t3code, but the workspace is a mailbox instead of a repo."

- **Bring your own providers**: Gmail API, Microsoft Graph, IMAP/SMTP, JMAP (mail); Google Calendar,
  Graph, CalDAV (calendar). Users supply their own OAuth client ids / app passwords / tokens.
- **Bring your own model**: by default the Codex or Claude Code CLI signed in on the host (subscription,
  no API key); Anthropic, OpenAI, OpenAI-compatible, Ollama as API providers.
- **Two new units**: the *person* (identity, verification state, relationship) and the *matter*
  (a living workspace for a topic). Threads are an implementation detail.
- **Every locally originated state change is an Action** that passes through the policy engine,
  is logged, and is undoable where possible. Provider mirroring is system ingestion (see below).
  Sends are held in a delayed outbox so they are cancellable.
- **Trust is earned per category** and the UI exposes four modes:
  supervised / auto_accept_edits / auto / full_access (same shape as a code agent's permission picker).

## Packages and ownership

| Package | Responsibility | Depends on |
|---|---|---|
| `@passport/types` | The contract. Types + pure constants only. **Frozen during parallel work; add, don't rename.** | nothing |
| `@passport/store` | `Store` implementation on `node:sqlite` (FTS5), migrations, encrypted credentials, in-memory `EventBus`. | types |
| `@passport/providers` | `MailProvider` / `CalendarProvider` adapters + `ProviderRegistry` + auth-results parsing + a `mock` provider with fixtures. | types |
| `@passport/policy` | `PolicyEngine` (risk × reversibility × trust × counterparty), trust ladder state machine with decay and promotion offers, `ActionExecutor` (the single gate: outbox, undo, inverse computation, provider dispatch). | types |
| `@passport/mcp` | Mailbox MCP server (stdio + streamable HTTP) exposing tools that call `Store` and `ActionExecutor`. External agents never bypass policy. | types, store, providers, policy |
| `@passport/agent` | `AgentRuntime`: triage loop on new mail, matter clustering, people graph maintenance, USER.md, daily digest. Model-agnostic LLM client. | types, store, providers, policy |
| `@passport/server` | Composition root: config loading, sync scheduler, outbox scheduler, HTTP + WebSocket API for the web UI, CLI entry. | all |
| `@passport/web` | React UI: Decisions feed, Matters, People, Trust dial, Action log with undo, account setup. | types (talks to server over HTTP/WS) |

A package may import another package **only via its package root** (`@passport/x`), never deep paths.
Packages in the same wave must not import each other; code against the interfaces in `@passport/types`
and accept dependencies via constructor injection.

## Conventions

- TypeScript strict, ESM, Node ≥ 22.5. `pnpm` workspaces. `vitest` for tests.
- IDs: ULID strings generated in the store (`packages/store` exports `newId()`); provider ids live in `providerId`.
- Timestamps: ISO-8601 UTC strings. Never `Date` objects in persisted records.
- Errors: throw `Error` subclasses with a `code` string property; never swallow provider errors.
- Logging: use `console` through a tiny `logger` with levels; never log credentials or full bodies.
- No native modules. SQLite is `node:sqlite` (`DatabaseSync`), which ships FTS5 and JSON1.
- Secrets at rest: AES-256-GCM via `node:crypto`, key from `PASSPORT_MASTER_KEY` env or a key file in the data dir.
- Every package exports from `src/index.ts` only. Keep public surface small and documented with JSDoc.
- Tests live next to code as `*.test.ts`. Use the `mock` provider and an in-memory SQLite store; no network in tests.

## Code style

Biome is authoritative for formatting: 100-column lines, two-space indentation, double quotes,
trailing commas, and semicolons. Run `pnpm format` to apply it and `pnpm lint` to check formatting,
imports, lint rules, and all workspace types. `pnpm format:check` checks formatting alone.

- Use one statement per line and braces around control-flow bodies. Expand long conditional
  expressions into named intermediate values or helpers, with early returns where useful.
- Every catch is explicit: narrow an expected error and comment why it can be ignored, preserve
  the fallback with a diagnostic through the existing logging seam, or propagate a typed error
  with a stable code. Comment retained fallbacks. Never log credentials, message bodies, raw
  provider errors, or token-bearing URLs; package diagnostics are optional and default to no-op.
- Aim for files under about 400 lines. Split at an action, route, repository, provider, or component
  boundary when that makes the code easier to follow; keep related state and evaluation order clear.
- `packages/types` is append-only in substance. Formatting is fine; existing types, names, and
  invariants must remain compatible. Internal cleanup does not justify removing a public contract.

The mechanical formatting commit is recorded in `.git-blame-ignore-revs`; use
`git blame --ignore-revs-file .git-blame-ignore-revs` when investigating earlier changes.

## Definition of done for a package

1. `pnpm --filter @passport/<name> typecheck` and `test` pass.
2. `src/index.ts` exports everything the dependents listed above need, matching the interfaces in `@passport/types`.
3. A `README.md` in the package: what it does, how to use it in 20 lines, what is stubbed.
4. No TODOs that silently return fake data. If something is stubbed, it throws `NotImplementedError` with a clear message, or is documented as a stub.

## Things that must be true of the whole system

- Every change to mail, calendar, people or matters originated locally by a human, agent, or
  external agent requires an `ActionRecord`. Provider mirroring by the sync service (ingesting
  provider-side changes, including provider-side deletions) is system ingestion and is exempt
  from this rule.
- Provider-side email deletions retain the local email and its matter and thread memberships,
  marking `keywords["$deleted"] = true` so matter history remains available. The same applies to
  messages absent from a successfully completed cursor-expiry reconciliation. Reappearing
  messages refresh provider-owned fields and clear the tombstone without another arrival.
  Account removal may hard-delete its emails. Full resync preserves local annotations, defers
  missing-message reconciliation until the full pass succeeds, and retries interrupted recovery
  from a null cursor. Windowed snapshots retain older mail outside their ingestion window.
  Explicit onboarding backfills only widen ingestion; they do not prune mail.
- An `ActionRecord` with `status: "executed"` and `inverse: null` is only allowed for `irreversible` actions.
- `send` is never executed synchronously when `outboxHoldMinutes > 0`; it is `held` first.
- External agents (MCP clients) are capped by `externalAgentCeiling`.
- Verification state (blue/green) is derived from headers/signatures, never from message content.

## Parallel-build rule (wave 1)

`store`, `providers`, `policy`, `mcp`, `agent`, and `server`+`web` are built concurrently in separate
worktrees. During this wave **every package depends only on `@passport/types`** and receives its
collaborators (Store, ActionExecutor, PolicyEngine, ProviderRegistry, AgentRuntime, EventBus) through
constructor injection. Tests use small in-memory fakes of those interfaces. The composition root in
`apps/server` is wired to the real implementations in the integration step that follows.

## Additive contract: host agents (v0.2)

- `LlmProviderKind` gains `"claude-code" | "codex"`: the host machine's logged-in CLI, never an API key.
- New types: `HostAgentKind`, `HostAgentStatus` (detection, no tokens), `LlmSelection` (`auto` | `explicit`),
  and the session API `HostAgentSessionRequest`, `HostAgentMcpServer`, `HostAgentReasoning`, `HostAgentEvent`,
  `HostAgentUsage` (`costUsd` is `null` for subscription usage), `HostAgentSessionResult`.
- `@passport/agent` exports `detectHostAgents`, `HostAgentLlmClient` (an `LlmClient`) and
  `runHostAgentSession(request, onEvent) → { done, cancel }`. Host-agent code lives in `packages/agent/src/host/`
  and, like the rest of `agent`, imports neither `providers` nor server code.
- Spawned CLIs get an allowlisted environment (no `PASSPORT_*`, no provider API keys); stderr is classified,
  never surfaced; token-shaped strings are redacted from any CLI-derived error text.

## Additive contract: on-demand mail (v0.3)

Design: `docs/design/on-demand.md`; tool shapes, cache and governor: `docs/design/research/03-ondemand-tools.md`
§2, §3 and §5.1. Everything below is additive. `@passport/types` stays append-only: never rename or remove an
export, and add only optional fields to existing interfaces.

- **Reader.** `MailProvider` gains optional `reader?(): MailReader`, bound to the connected account.
  `AccountCapabilities` gains optional `search` and `onDemand`. `MailReader` methods: `search(MailSearchInput)`,
  `list(container, MailListFilter, limit, pageToken?)`, `labels(counts?)`, `envelopes(providerIds)` →
  `Map<providerId, MailEnvelope | null>`, `thread(threadProviderId, { format })`, `body(providerId)` → `MailBody`,
  `countIds(query, cap)`, `changes(cursor | null, limit)` → `MailChanges`, `findByRfc822(rfc822Id)`. Each takes
  optional `MailReadOptions` (`lane`, default `"interactive"`, and `signal`).
- **Cost on every result.** Collections (`search`, `list`, `labels`) return `ReadResult<T>` (`items`,
  `nextPageToken?`, `approxTotal?`); everything else returns `ReadValue<T>` (`value`). Both extend `ReadMeta`:
  `source` (`"provider" | "cache" | "mixed"`), `cost: ReadCost` (`gmailUnits?`, `graphRequests?`, `imapCommands?`,
  `budgetRemaining?`, `windowResetsAt?`), `staleAsOf?` and `translation?`.
- **Rows.** `MailRow` is the compact row: `id` and `threadId` are opaque account-scoped handles
  (`mailHandle` / `parseMailHandle`, same format as adapter ids), plus `rfc822Id`, `account`, `date`, `from`
  (`"Name <addr>"`), `to` (first 3, then `"+N more"`; `compactRecipients`), `subject`, `snippet` (≤160),
  `labels` (display names), `unread`, `flagged`, `attachments` (count), `listId?`, `auth?`. `toMailRow` projects
  an envelope. `MailLabel` is `{ id, name, role?, parentId?, counts? }`.
- **Quota.** `QuotaLane` is `"interactive" | "arrivals" | "background"`. Interactive calls never block on long
  backoff: past about 5 s they fail with `RATE_LIMITED` carrying `retryAfterSeconds` and `scope`, which tools
  return as a `RateLimitedResult` (`rateLimitedResult` helper). Expensive shapes return
  `WouldExceedBudgetResult`. Stable codes are in `MAIL_READ_ERROR_CODES`: `RATE_LIMITED`,
  `WOULD_EXCEED_BUDGET`, `STALE_ID`, `NOT_FOUND`.
- **Providers.** `@passport/providers` exports `QuotaGovernor` (`acquire`, `report`, `snapshot`),
  `QUOTA_PRESETS`, `GMAIL_UNIT_COSTS`, `RateLimitedError`, the portable query parser (`parsePortableQuery`,
  `renderGmailQuery`, `listFilterToAst`, `matchesQuery`) and `MockMailProvider.reader()`.

Invariants (on-demand.md §5):

- Passport never backfills. `changes(null, …)` and the watcher cursor start at connect time ("now").
- Every provider read declares its quota cost and goes through the per-account governor.
- Provider-derived strings (subjects, snippets, names, label names, bodies, attachments) are untrusted and
  are wrapped as data in tool results and prompts.
- A task's permission mode cannot exceed the account's trust ladder, and a child task cannot exceed its parent.
