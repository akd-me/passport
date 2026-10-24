# @passport/tools

The shared registry has **69 tools** for Passport’s built-in agent and MCP clients.
Its only runtime dependency is `@passport/types`. Schemas use a small immutable JSON
Schema builder with registry-side validation/defaults; no Zod or provider SDK is required.

```ts
import { createToolRegistry, toAnthropicTools, toOpenAiTools, toMcpTools } from "@passport/tools";

const tools = createToolRegistry({
  store, executor, policy, bus,
  actor: { kind: "external-agent", id: "my-client" },
  selfAddresses: ["me@example.com"],
});
const result = await tools.find(t => t.name === "archive_emails")!.handler({
  emailIds: [emailId], reason: "Archive the resolved conversation",
});
// { actionId, status, outcome, reason, holdUntil, ... }
const anthropic = toAnthropicTools(tools); // input_schema
const openai = toOpenAiTools(tools);       // function.parameters (Chat Completions)
const mcp = toMcpTools(tools);             // inputSchema + annotations
```

`ToolResult` is a plain JSON object; errors carry `isError: true`. Adapters only
reshape definitions: invocation, authentication, and protocol envelopes belong to
the caller. Handlers validate every invocation, even when called without an SDK.
Unknown fields, cross-account writes, protected contact fields and unsafe mailbox
moves are rejected. Unexpected dependency failures are redacted.

Writes submit `ActionRequest`s to the injected executor; undo and cancellation
use its actor-aware `undo` and `cancelHold` lifecycle methods. Dry-run and
empty query batches do not submit actions. Actor/category overrides never appear
in tool input schemas. Optional trusted invocation context correlates `runId`;
only built-in `agent` actors can supply projected triage evidence, person snapshots
or atomic email metadata patches. External actors cannot use that evidence path.

The on-demand `mail_*` tools read the provider through injected readers; the legacy
read tools fall back to cached local data without readers. Bodies are capped at 2,000 characters unless
`full: true`; HTML image beacons and remote image tags are removed in both views.
Actions omit parameters, provider results and raw errors. Account credentials and
settings are never read. Query writes cap at 200 matches and require one account.
Standing-rule edits and learned Voice/Signature/VIP proposals submit a reversible
`profile_update` action in category `profile_update`, which always asks the person;
USER.md lives at `store.kv["user_profile"]`, including its other sections.

Task runs pass trusted `taskId`, `runId`, `accountIds` and an orchestrator. Account-scoped
reads/writes reject other accounts with `ACCOUNT_FORBIDDEN`. The five orchestration tools
(`ask_user`, `task_delegate`, `task_status`, `task_cancel`, `task_organize`) manage questions,
subtasks and local lifecycle; external callers without task context get `TASK_REQUIRED`.
`request_secret` returns a one-use reference only; `render` appends restricted HTML capped at
64 KiB and ten attempts including sanitiser failures per run. Arrival and routine allowlists
are enforced by the agent runtime. See [scopes and limits](../../docs/tools.md).

All results have a serialized UTF-8 byte budget: 512 KiB by default for the built-in agent
(the MCP server defaults to 64 KiB, see `DEFAULT_MCP_RESPONSE_BYTE_BUDGET`), configured with
`responseByteBudget` (minimum 1024). `full: true` keeps this total cap. Clipped bodies
carry `truncated: true` and `continueFrom`; `get_email_body({emailId,offset,length})`
returns text/HTML chunks with UTF-16 offsets and sanitized HTML. Default length is
16,000, maximum 1,000,000; resume at `continueFrom`. Oversized metadata returns
`RESPONSE_TOO_LARGE`; request fewer results. Search and query writes exclude
`keywords.$deleted === true` unless `includeDeleted: true`; direct reads retain
history and report `deleted: true`. Thread and matter histories include tombstones.

`getEffectiveProfile(store)` from `@passport/types` supplies the default USER.md when
unset. Profile reads, standing-rule edits and undo capture use the complete document.

A shared destination guard follows `parentId` to the root, detects trash/junk roles
and role-less aliases (Trash, Deleted Items, Deleted Messages, Bin, Junk, Spam,
[Gmail]/Trash and [Gmail]/Spam, case-insensitive), and escalates additions and last-safe-mailbox
removals to destructive actions before policy evaluation. External agents receive
the delete ceiling for every mailbox mutation, including query writes. Self
identities require configured addresses or `verifiedSelf` from human approval;
self changes are denied externally and known-address additions ask for approval.

`availability`, `availabilityEvents`, and `expandRecurringEvents` are shared with
agent scheduling. Availability includes old recurring masters and all in-range
events, preferring optional `freeBusy(accountId,range)` injection (`null` means
no connected provider). Local expansion supports DAILY/WEEKLY/MONTHLY, INTERVAL,
BYDAY, COUNT, UNTIL, and WKST, including event-zone DST and exposed cancelled
instances. Unsupported rules fail explicitly. Providers that omit exception
identities cannot supply local cancellation exclusions; live free/busy is preferred.

See [the full catalogue and client setup](../../docs/tools.md), including label
creation/undo behavior and host resolver wiring. There are no production stubs;
question extraction is heuristic. Undo loads trusted private snapshots by ID,
evaluates the current actor/ceiling, and marks the original undone after execution.

`pnpm --filter @passport/tools build`, `typecheck`, and `test` validate the package.
Tests use complete in-memory contract fakes and exercise every tool without network.
