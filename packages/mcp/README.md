# @passport/mcp

Point a coding agent at your inbox. This package exposes Passport mail, calendar,
people and matters through the Model Context Protocol, with all mutations gated
by the injected `ActionExecutor`. It consumes the shared `@passport/tools` registry plus `@passport/types`, the MCP SDK
and Zod for resource/prompt arguments. Tool schemas and handlers live only in the registry.

## Host integration

The server app constructs and owns the real store, executor, policy engine and
event bus. After migrating the store and configuring providers, use this code
in its **stdio entrypoint** (for example, `mcp-stdio.mjs`):

```js
import { createMailboxMcpServer, serveStdio } from "@passport/mcp";

// store, executor, policy and bus are the host's already-constructed instances.
const server = createMailboxMcpServer({ store, executor, policy, bus });
await serveStdio(server);

// At shutdown: await server.close(), then shut down the host's collaborators.
```

Alternatively, in an **HTTP entrypoint**:

```js
import { createMailboxMcpServer, serveHttp } from "@passport/mcp";

const server = createMailboxMcpServer({ store, executor, policy, bus });
const http = await serveHttp(server, { port: 4318, path: "/mcp", token: process.env.PASSPORT_MCP_TOKEN });
// http.url === "http://127.0.0.1:4318/mcp"
// At shutdown: await http.close(), then shut down the host's collaborators.
```

`createMailboxMcpServer(deps)` returns an unconnected SDK `McpServer`.
`serveStdio(server)` connects it and resolves; `server.close()` closes stdio.
`serveHttp(server, { port, token, path?, host? })` resolves to `{ httpServer, url, close }` once
listening. `path` defaults to `/mcp`; `port: 0` selects an available port.
Use a fresh factory-created server for each transport. The HTTP helper creates
an isolated SDK server per session, sharing the injected collaborators, and
supports POST, GET/SSE and DELETE session termination. `close()` is idempotent.
Use the returned handle to shut down the entire HTTP host, including its sessions.

The listener binds to `127.0.0.1` by default, validates Host/Origin, and requires
`Authorization: Bearer <token>` on every request. An explicit `host` option overrides
the bind address. TLS termination remains the host's responsibility. Client names are audit labels, not authenticated
identities. By default, the MCP initialization name becomes the action actor
ID. A trusted host may provide `clientName` to override it; omit the override
when distinct HTTP client names should be recorded.

The host must run provider synchronization and the executor's `releaseDue()`
outbox scheduler. It also supplies the human approval UI/API. This package does
not own these lifecycles. Keep stdout exclusive to MCP in a stdio process;
write private, credential-free diagnostics to stderr. MCP error responses redact
unexpected dependency exceptions, so the host should log errors inside its
collaborators without logging credentials or complete message bodies.

## Claude Code configuration

After the host builds its stdio entrypoint, register its absolute path:

```sh
claude mcp add --transport stdio passport -- node /absolute/path/to/mcp-stdio.mjs
```

Equivalent project `.mcp.json`:

```json
{
  "mcpServers": {
    "passport": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp-stdio.mjs"]
    }
  }
}
```

For an already-running HTTP entrypoint, use this instead:

```sh
passport mcp install --client claude-code --http
```

The JSON entry for HTTP is `{ "type": "http", "url": "http://127.0.0.1:4318/mcp", "headers": { "Authorization": "Bearer <token>" } }`.
See the [official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

## Codex configuration

Register the host's stdio entrypoint:

```sh
codex mcp add passport -- node /absolute/path/to/mcp-stdio.mjs
```

Or add this to `~/.codex/config.toml`:

```toml
[mcp_servers.passport]
command = "node"
args = ["/absolute/path/to/mcp-stdio.mjs"]
```

For the running HTTP server, use `passport mcp install --client codex --http`,
or replace the table above with:

```toml
[mcp_servers.passport]
url = "http://127.0.0.1:4318/mcp"
http_headers = { Authorization = "Bearer <token>" }
```

See the [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).
The stdio command names the host's bootstrap file, which constructs dependencies;
the library itself does not load account configuration or credentials.

## Tools

The registry exposes 43 tools. The original tools are described below; the full
[shared catalogue](../../docs/tools.md) also covers summaries, free slots, person
search, query batches, standing rules, daily logs, decision explanations and
unsubscribe previews. `passport mcp install --client <client> [--http]` installs
client configuration with backups and supports `--dry-run`.

Read tools:

- `search_emails`: flat `EmailQuery` arguments, including `text` (FTS5 syntax),
  account/mailbox/thread/matter/person filters, keywords, category, timestamps,
  sort, cursor, `limit`, `includeBodies` and `full`.
- `get_email`: `emailId`, optional `full`.
- `get_thread`: `threadId`, optional `limit`, `cursor`, `full`; chronological items.
- `list_mailboxes`: optional `accountId`; otherwise all configured accounts.
- `list_matters`: optional status array, person, text and limit.
- `get_matter`: `matterId`, optional `limit`, email-ID cursor and `full`;
  returns the matter, emails, events and people, including explicit attachments.
- `list_people`, `get_person`: relationship/text filters or `personId`.
- `list_events`: required `{ range: { start, end } }`, optional account, matter,
  limit and `full`.
- `free_busy`: required range, optional account; clips and merges locally synced
  busy intervals, excluding cancelled and declined events.
- `list_pending_decisions`: proposed/held actions; cursor and limit.
- `list_actions`: action log filtered by status, category, actor kind, run, matter
  and timestamps, with cursor and limit.
- `get_trust`: per-category ladder plus global config, including the external ceiling.
- `get_user_profile`: `{ markdown }` from `store.kv.get("user_profile")`, empty if unset.

Write tools:

- `archive_emails`, `mark_read`: `emailIds`, optional `accountId`, `reason`.
- `label_emails`: same, plus `label`; `remove: true` submits `unlabel`.
- `move_emails`: same, plus `toMailboxId`; rejects cross-account and trash/junk moves.
- `create_draft`: `draft` (`DraftInput`) and `reason`.
- `reply_draft`: `emailId`, `textBody`, optional `replyAll`, `quoteOriginal`, `reason`.
  Sets `inReplyToEmailId`; the provider sets In-Reply-To, References and thread ID
  according to the shared draft contract. Uses Reply-To/From, preserves existing
  `Re:`, excludes own account addresses and human-verified self-contact aliases, deduplicates
  To/CC and never copies BCC.
  Quoting uses original plain text, falling back to the preview for HTML-only mail.
- `send`: exactly one of `draftEmailId` or inline `draft`, plus `reason`.
- `unsubscribe`: `emailId`, optional method (`header`, `link`, `reply`), `reason`.
- `respond_to_event`: `eventId`, status (`accepted`, `declined`, `tentative`),
  optional comment, `reason`.
- `propose_meeting`: `slots` (UTC ranges), `draft`, `reason`; submits `calendar_propose`.
- `create_matter`: `matter`, optional account, `reason`. Status defaults to active;
  summary and attachment lists default to empty.
- `update_matter`: `matterId`, editable `patch`, optional account, `reason`.
- `attach_to_matter`: `matterId`, email/event/person ID lists, optional account, `reason`.
- `update_person`: `personId`, editable `patch`, optional account, `reason`.
- `snooze`: email IDs and/or matter ID, future `until`, optional account, `reason`.
- `undo_action`: `actionId`, `reason`; submits the stored inverse under current policy.
- `cancel_held_action`: `actionId`; cancels only this MCP client's held action.

Dates are UTC ISO-8601 strings. Limits default to 25, maximum 100. Bulk mail
actions accept up to 100 IDs per account; split cross-account batches. Internal
matter/person operations require `accountId` when multiple accounts exist.
Schemas reject unknown input fields. Verification, IDs, timestamps and contact
statistics cannot be patched by agents. All write tools except cancellation
require a human-readable reason.

## Results and policy

Tool data is compact JSON in a text content block; SDK input-validation errors
may be plain text error blocks. Search omits bodies by default;
`includeBodies: true` includes limited bodies. Message bodies are capped at 2000
characters and `truncated: true` indicates the limited-body view; `full: true`
requests the complete bodies. `full: true` also implies bodies in search.
Raw provider headers, account settings, credential access, action parameters,
provider action results and raw action errors are not exposed. Attachment blob
handles are available for composing drafts.

Paginated email/action reads return `nextCursor`. Matter email cursors are email
IDs, separate from store search cursors. A matter also includes up to 100 linked
emails and events; `linkedEmailsNextCursor`, when present, continues via
`search_emails({ matterId, cursor })`. Resource discovery lists at most 100 matters
and 100 people; any known ID remains readable through its URI.

Every submitted write uses `{ kind: "external-agent", id: clientName }`; no tool
accepts an actor or category override. Category/counterparty inference uses target
email classifications and headers, outgoing To/CC/BCC and stored relationships.
Unknown or mixed recipients remain strangers. Money/legal classifications take
precedence over newsletter organization; unsubscribe and scheduling use their
own categories. The executor enforces the external-agent ceiling, global mode,
category trust, always-ask rules and delayed outbox.

Write results contain `actionId`, `status`, `outcome`, `reason`, plus compatible `id`, `decision.outcome`, `decision.reason`,
`decision.trustLevel`, `holdUntil` and a short `policy_note`:

- `ask` / `proposed`: waiting for a human; the action has not run.
- `hold` / `held`: delayed outbox; cancellable until release.
- `allow`: inspect status for the actual execution result.
- `deny`: MCP `isError: true`, with the denial reason and policy note.

Standing rules submit reversible `profile_update` actions in category `matters`.
There are no delete/purge, approval, trust-configuration or outbox-release tools.
The server never writes directly to the store. Resource-list change notifications
follow relevant bus events, and bus listeners are removed when a client closes.

`undo_action` calls the executor's actor-aware undo path by ID. The executor loads
its trusted private inverse, evaluates current policy and the external ceiling,
and records the undo before execution. Below effective full access, an external
agent may undo only its own `actor.id` actions. Protected identity and destructive
restorations remain denied. A proposed undo waits for human approval; execution
marks the original `undone`. Clients cannot submit or edit private snapshots.
`cancel_held_action` retains its ownership-checked lifecycle.

Mailbox writes share a destination guard: trash/junk roles and label aliases,
including removal of the last safe mailbox, receive destructive risk and the
same external deny rule as delete. Self-address/relationship changes are denied
externally, known-person address additions ask, and self classification requires
configured addresses or human-approved `verifiedSelf`.

The host can inject `freeBusy(accountId,range)` into the MCP constructor. Return
`null` for disconnected accounts; availability falls back to all matching stored
events and expands supported recurrence rules. See [tools](../../docs/tools.md)
for supported rules, exposed cancellation identities, and label creation/undo.

## Resources and prompts

- `passport://matters/{id}`: matter Markdown with recent mail, people and events.
- `passport://people/{id}`: identity, verification, relationship and notes.
- `passport://user-profile`: USER.md.
- `passport://decisions`: first 100 pending/held actions as Markdown, with continuation.
- `triage_inbox` prompt: optional `accountId` and `mailboxId`.
- `summarize_matter` prompt: required `matterId`.

## Build, tests and limitations

```sh
pnpm install
pnpm build # builds registry and server CLI used by integration tests
pnpm --filter @passport/mcp typecheck
pnpm --filter @passport/mcp test
pnpm --filter @passport/mcp build
```

Tests use the real SDK `Client` and `InMemoryTransport` with complete in-memory
contract fakes under `src/testing/`, without provider or network calls. Fake text
search is intentionally simple; real FTS5 syntax is passed unchanged to `Store`.
Fakes record policy outcomes and submissions, not provider effects, and are
excluded from the production build.

There are no production stubs. Availability is computed from synced local events,
so sync freshness determines its accuracy. Meeting proposals carry caller-supplied
slots and a draft through the executor; they do not reserve time independently.
Provider execution, undo inverses, approval and outbox release remain the host's
injected policy/executor responsibilities. The shared contract appends `profile_update` for reversible USER.md writes.
