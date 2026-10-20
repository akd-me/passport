# Passport tools

`@passport/tools` owns the 43 tool definitions, JSON Schemas, validation, inference
and handlers consumed by both the built-in agent and the MCP server. Clients see
the same mailbox, calendar, people, matters and tool inputs. Reads use the local
Store; provider synchronization determines freshness. No tool reads account
credentials or provider settings.

## Catalogue

“Mail inference” uses stored classifications and sender relationships: legal and
money classifications win; List-Unsubscribe normally means newsletters; otherwise
the message category or triage applies. Outgoing draft/send inference distinguishes
known contacts from strangers using every To/CC/BCC recipient. Unknown or mixed
recipients use the more conservative class. Verified identity alone does not make
a stranger a known contact. Scheduling and unsubscribe have dedicated categories.
Read tools do not submit actions and therefore have no write policy category.

| Tool | Risk | Purpose | Policy category / action |
| --- | --- | --- | --- |
| `search_emails` | read | FTS5 and structured EmailQuery filters, previews and cursors | — |
| `get_email` | read | One message with clipped or full bodies | — |
| `get_thread` | read | Chronological message pages | — |
| `list_mailboxes` | read | Account mailboxes and counts | — |
| `list_matters` | read | Workspaces filtered by status, person or text | — |
| `get_matter` | read | Matter with attached/linked mail, events and people | — |
| `list_people` | read | Contacts filtered by relationship or text | — |
| `get_person` | read | One contact and relationship context | — |
| `list_events` | read | Events overlapping a UTC range | — |
| `free_busy` | read | Clipped, merged busy intervals, excluding cancelled/declined events | — |
| `list_pending_decisions` | read | Proposed actions and delayed outbox holds | — |
| `list_actions` | read | Compact, filtered action audit log | — |
| `get_trust` | read | Category trust and global/external limits | — |
| `get_user_profile` | read | USER.md Markdown | — |
| `archive_emails` | write | Archive a batch from one account | Mail inference / archive |
| `label_emails` | write | Add label; `remove: true` removes it | Mail inference / label or unlabel |
| `mark_read` | write | Mark a batch read | Mail inference / mark_read |
| `move_emails` | write | Move within an account; trash/junk destinations rejected | Mail inference / move |
| `create_draft` | write | Create a reviewable draft | Outgoing inference / draft_create |
| `reply_draft` | write | Threaded reply or reply-all, deduplicating recipients and self aliases | Outgoing inference / draft_create |
| `send` | write | Submit one existing draft or an inline draft to policy/outbox | Outgoing inference / send |
| `unsubscribe` | write | Header one-click/mailto, HTTPS link, or explicit reply | unsubscribe / unsubscribe |
| `respond_to_event` | write | Accept, decline or tentatively respond to an invite | scheduling / calendar_respond |
| `propose_meeting` | write | Submit supplied slots and invitation draft | scheduling / calendar_propose |
| `create_matter` | write | Create a living workspace and initial attachments | matters / matter_create |
| `update_matter` | write | Patch editable workspace fields | matters / matter_update |
| `attach_to_matter` | write | Attach existing emails, events or people | matters / matter_attach |
| `update_person` | write | Patch editable contact fields | matters / person_update |
| `snooze` | write | Snooze mail and/or a matter until a future UTC time | Mail inference, or matters for matter-only snooze / snooze |
| `undo_action` | write | Submit a public stored inverse as a new action under current policy | Re-inferred; retains legal/money sensitivity / inverse action type |
| `cancel_held_action` | write | Cancel this actor's own held action | Original action category / executor.cancelHold lifecycle |
| `summarize_thread` | read | LLM-free participants, preview timeline, candidate open questions and last message | — |
| `find_free_slots` | read | Duration-sized slots within a window, working hours and IANA time zone | — |
| `list_recent_from_person` | read | Recent incoming mail from every known address, including untriaged mail | — |
| `search_people` | read | Name/address search with relationship filter | — |
| `batch_archive_by_query` | write | One archive action for up to 200 query matches; supports dryRun | Mail inference / archive |
| `apply_label_by_query` | write | One label action for up to 200 query matches; supports dryRun | Mail inference / label |
| `get_standing_rules` | read | Bullet rules from USER.md's Standing rules section | — |
| `add_standing_rule` | write | Append an exact one-line rule; preserve other USER.md sections | matters / profile_update |
| `remove_standing_rule` | write | Remove an exact bullet rule; preserve other sections | matters / profile_update |
| `get_daily_log` | read | Actions proposed/executed on a UTC date, grouped by current status | — |
| `explain_decision` | read | Historical policy reason, current category trust and relevant constraints | — |
| `preview_unsubscribe` | read | Supported method, transport and destination host/address; no request or send | — |

## Results and write behavior

Tool results are plain JSON objects. MCP encodes each result in one text block.
Every submitted write returns `actionId`, `status`, `outcome`, `reason` (the policy
reason), and `holdUntil`, plus compatible audit fields. `actionReason` preserves
the caller's requested explanation. Errors carry `isError: true`.

- `proposed` / `ask`: waiting for a human; it has not executed.
- `held` / `hold`: delayed outbox; cancellable until release, not delivered.
- `executed` / `allow`: the executor completed it.
- `rejected` / `deny`: refused by policy; an error result explains the decision.

Other lifecycle states, including failed execution, remain visible in the log.
Unexpected provider/dependency exceptions return a redacted error; do not assume
a write succeeded without its action result. Raw action parameters, provider
results, credentials and provider exception text are not returned.

Bodies are limited to 2,000 characters unless `full: true`. Remote images and
hidden image beacons are stripped from HTML even with `full: true`; no assets are
fetched. List/search reads normally return IDs and short previews. Limits default
to 25 and max at 100. Mail writes accept 1–100 IDs; query writes select up to 200
and submit exactly one action. Cross-account query matches are rejected before
submission: add `query.accountId` to scope them. `dryRun: true` returns count,
known total, cap indicator and five sample previews without submitting. An empty
query batch returns zero matches without an action.

Example query write:

```json
{
  "query": { "accountId": "account-id", "category": "newsletters" },
  "dryRun": true,
  "reason": "Review newsletter archive batch"
}
```

`find_free_slots` accepts `durationMinutes`, `window: {start,end}` in UTC,
`timeZone` (default UTC), and `workingHours: {start:"09:00",end:"17:00",days:[1,2,3,4,5]}`.
Days are Sunday=0 through Saturday=6. The maximum window is 31 days. It observes
zone offsets and daylight-saving changes and returns earliest non-overlapping
slots, with `limitReached` when capped. It does not reserve time.

`summarize_thread` returns a page of participants/timeline/questions and the
actual last message, plus `nextCursor` for remaining source messages. Questions
are candidates extracted from unquoted question marks, not a claim that every
question is unresolved. `get_daily_log` includes older actions executed on the
requested date and groups by their current status. `explain_decision` separates
the historical decision from current trust/config; changing trust does not
retroactively approve or re-run an action.

`preview_unsubscribe` prefers an HTTPS one-click header, then header mailto,
then an HTTPS header link. Reply is shown as an explicit alternative, never
selected automatically. It exposes destination hosts/addresses, not token-bearing
URLs. It does not infer body links or call a provider.

Standing-rule writes replace the complete USER.md through a `profile_update`
action, with the previous Markdown captured at execution for undo. A pending
proposal leaves USER.md unchanged. Review pending profile edits against subsequent
human changes before approving a whole-document replacement.

`undo_action` resubmits a public stored inverse with the caller's current actor;
the original record remains intact. The executor's private snapshot inverses are
not public submission inputs and must be undone through the human API/UI. The
new `profile_update` inverse is public and works through this tool. Cancellation
uses the existing executor lifecycle after an actor ownership check. No tool
approves a decision, changes trust, releases the outbox, or purges mail.

## External and built-in agents

The registry receives its actor from trusted host code. MCP always uses
`{kind:"external-agent",id:clientName}` and respects `externalAgentCeiling`.
Client names are audit labels. HTTP bearer auth authenticates access to the MCP
listener; it does not grant higher trust. Tools accept no actor/category override.
Resources and prompts remain available at `passport://matters/{id}`,
`passport://people/{id}`, `passport://user-profile`, `passport://decisions`,
`triage_inbox` and `summarize_matter`.

The built-in runtime uses `{kind:"agent",id:runId}` with the same definitions and
handlers. Its triage pipeline supplies trusted, code-derived identity snapshots
and classification/email metadata context; this is not part of model-facing
schemas and is ignored for external actors. Manual instructions have a 12-call
budget across reads and writes. New registry tool names automatically appear in
the system prompt and available-tool list. `run()` returns and persists
`toolBudget: {callsMade,llmCalls,inputTokens,outputTokens,totalTokens}`. Token
counts use reported LLM usage, not estimates; absent usage counts as zero.

Both actors use the same executor, global mode, category trust and always-ask
rules. The built-in agent additionally runs triage, people/matter inference and
scheduled digests; MCP clients can build their own workflows from the same tools.

## Install a client

After `pnpm build`, run the installed `passport` CLI (or
`node /absolute/path/to/apps/server/dist/cli.js`):

```sh
passport mcp install --client claude-code
passport mcp install --client claude-code --user
passport mcp install --client codex
passport mcp install --client cursor
passport mcp install --client claude-desktop
passport mcp install --client codex --http --dry-run
```

Installation merges Passport's connection entry, preserves unrelated keys, backs
up an existing file as `<file>.bak-<timestamp>-<id>`, and writes atomically with
0600 permissions. `--dry-run` prints the redacted planned config and writes no
config, backup or token file. Codex config edits preserve unrelated TOML text and
Passport tool/time-out settings; unsupported inline/dotted Passport table forms
fail without overwriting the file. Convert these to `[mcp_servers.passport]` first.

Stdio uses the absolute current Node executable and built server entry; clients
launch `passport mcp`, which keeps stdout exclusive to MCP. Example project
`.mcp.json` for Claude Code (user scope instead writes `~/.claude.json`):

```json
{
  "mcpServers": {
    "passport": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/apps/server/dist/cli.js", "mcp"]
    }
  }
}
```

Codex `~/.codex/config.toml`:

```toml
[mcp_servers.passport]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/apps/server/dist/cli.js", "mcp"]
```

Cursor `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "passport": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/apps/server/dist/cli.js", "mcp"]
    }
  }
}
```

Claude Desktop on macOS uses the same stdio JSON as Cursor in
`~/Library/Application Support/Claude/claude_desktop_config.json`.

### HTTP clients

Start `passport serve` to run the authenticated MCP listener on
`http://127.0.0.1:4318/mcp` by default. `PASSPORT_MCP_PORT` changes its port.
The listener and installer share `PASSPORT_MCP_TOKEN` when set; otherwise they
read/create `<dataDir>/mcp-token` (32 random bytes as hex, created with 0600).
`PASSPORT_DATA_DIR` selects the same data directory for both commands. The URL
prints once at listener startup; tokens never print. Treat the generated client
config as private because it contains the bearer token.

Add `--http` to installation for any client. `PASSPORT_MCP_URL` or `--url` can
specify another endpoint. The token must match that endpoint. The installer
copies the same token into the config; restarting a server with a different env
override requires updating its client configs.

Claude Code HTTP `.mcp.json` (the installer substitutes the real token):

```json
{
  "mcpServers": {
    "passport": {
      "type": "http",
      "url": "http://127.0.0.1:4318/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Codex HTTP:

```toml
[mcp_servers.passport]
url = "http://127.0.0.1:4318/mcp"
http_headers = { Authorization = "Bearer <token>" }
```

Cursor HTTP:

```json
{
  "mcpServers": {
    "passport": {
      "url": "http://127.0.0.1:4318/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Claude Desktop's local config uses a dependency-free Passport stdio bridge:

```json
{
  "mcpServers": {
    "passport": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/apps/server/dist/cli.js", "mcp", "proxy", "--url", "http://127.0.0.1:4318/mcp"],
      "env": { "PASSPORT_MCP_TOKEN": "<token>" }
    }
  }
}
```

Configuration references: [Claude Code](https://code.claude.com/docs/en/mcp),
[Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Cursor](https://cursor.com/docs/mcp), and
[Claude Desktop local configuration](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

## Host integration

`createMailboxMcpServer({store,executor,policy,bus,clientName?})` and
`createAgentRuntime(...)` retain their constructor inputs. The libraries now
import `@passport/tools` from the workspace. Host-created HTTP listeners must
supply `serveHttp(server,{port,token,host?})`: every request, including session
GET/DELETE, requires the bearer. The default bind remains `127.0.0.1`; only an
explicit `host` changes it. Host/Origin validation still applies. The server app
already loads and passes the shared token through its small listener seam.

Custom executors must implement `profile_update` in category `matters`: capture
prior USER.md immediately before execution, write `store.kv["user_profile"]`,
and persist a `profile_update` inverse containing the prior Markdown. The
reference executor does this; custom/in-memory fakes need the new case if they
execute standing-rule writes. Existing agent identity/emailPatch conventions
remain supported. The host still owns provider sync, human approval and outbox
release scheduling; neither MCP nor the registry starts these lifecycles.
