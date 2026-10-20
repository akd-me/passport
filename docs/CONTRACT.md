# Passport: engineering contract

Read this before touching any package. It is the agreement that lets packages be built in parallel.

## What we are building

An open-source, local-first **harness** that lets AI agents operate on a person's email, calendar and
contacts under a trust policy. Think "t3code, but the workspace is a mailbox instead of a repo."

- **Bring your own providers**: Gmail API, Microsoft Graph, IMAP/SMTP, JMAP (mail); Google Calendar,
  Graph, CalDAV (calendar). Users supply their own OAuth client ids / app passwords / tokens.
- **Bring your own model**: Anthropic, OpenAI, OpenAI-compatible, Ollama.
- **Two new units**: the *person* (identity, verification state, relationship) and the *matter*
  (a living workspace for a topic). Threads are an implementation detail.
- **Every state change is an Action** that passes through the policy engine, is logged, and is
  undoable where possible. Sends are held in a delayed outbox so they are cancellable.
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

## Definition of done for a package

1. `pnpm --filter @passport/<name> typecheck` and `test` pass.
2. `src/index.ts` exports everything the dependents listed above need, matching the interfaces in `@passport/types`.
3. A `README.md` in the package: what it does, how to use it in 20 lines, what is stubbed.
4. No TODOs that silently return fake data. If something is stubbed, it throws `NotImplementedError` with a clear message, or is documented as a stub.

## Things that must be true of the whole system

- No code path mutates mail, calendar, people or matters without creating an `ActionRecord`.
- An `ActionRecord` with `status: "executed"` and `inverse: null` is only allowed for `irreversible` actions.
- `send` is never executed synchronously when `outboxHoldMinutes > 0`; it is `held` first.
- External agents (MCP clients) are capped by `externalAgentCeiling`.
- Verification state (blue/green) is derived from headers/signatures, never from message content.
