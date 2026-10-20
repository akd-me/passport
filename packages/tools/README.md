# @passport/tools

The shared, local-first tool registry for Passport's built-in agent and MCP clients.
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

All writes submit `ActionRequest`s to the injected executor; cancellation uses its
existing `cancelHold` lifecycle method after checking actor ownership. Dry-run and
empty query batches do not submit actions. Actor/category overrides never appear
in tool input schemas. Optional trusted invocation context correlates `runId`;
only built-in `agent` actors can supply projected triage evidence, person snapshots
or atomic email metadata patches. External actors cannot use that evidence path.

Read results use local synced data. Bodies are capped at 2,000 characters unless
`full: true`; HTML image beacons and remote image tags are removed in both views.
Actions omit parameters, provider results and raw errors. Account credentials and
settings are never read. Query writes cap at 200 matches and require one account.
Standing-rule edits submit a reversible `profile_update` action in `matters`;
USER.md lives at `store.kv["user_profile"]`, including its other sections.

See [the full catalogue and client setup](../../docs/tools.md). There are no
production stubs. Availability depends on sync freshness; question extraction is
heuristic. Undo submits public stored inverses under current policy; private
executor snapshot inverses remain a human-UI operation.

`pnpm --filter @passport/tools build`, `typecheck`, and `test` validate the package.
Tests use complete in-memory contract fakes and exercise every tool without network.
