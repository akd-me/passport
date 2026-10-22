# @passport/agent

Personal email triage, people inference, matter organization, policy-controlled playbooks,
manual tool use, USER.md, and daily digests. Runtime dependencies: `@passport/types` and `@passport/tools`;
LLM requests use Node's `fetch`. Providers remain host-owned; an optional injected free/busy resolver supplies live calendar availability.

```ts
import { createAgentRuntime } from "@passport/agent";

const agent = createAgentRuntime({
  store, executor, policy, bus,
  llm: { provider: "ollama", model: "your-installed-model" },
  selfAddresses: ["you@example.com"],
  matterReviewDays: 7,
});
await agent.setUserProfile("# USER.md\nName: Morgan\nTone: concise\nassistant_attribution: false");
await agent.run({ kind: "email.received", emailId });
await agent.run({ kind: "manual", instruction: "Draft a reply", emailIds: [emailId] });
await agent.run({ kind: "schedule", name: "daily_digest" });
```

## LLM configuration

Pass an `LlmConfig` or an injected `LlmClient` as `llm`. `provider` supports `anthropic`,
`openai`, `openai-compatible`, and `ollama`. Set `model`, optional `fastModel` (classification),
`apiKey`, and optional `baseUrl`. Anthropic/OpenAI require keys; local compatible endpoints
may omit them. Defaults are Anthropic/OpenAI `/v1` endpoints or `http://localhost:11434/v1`.
For OpenRouter use `provider: "openai-compatible"`, `baseUrl: "https://openrouter.ai/api/v1"`.
Base URLs may also include the complete endpoint, but cannot contain user-info or query secrets.

`createLlmClient(config, options)` exposes injectable fetch/sleep, retry limits, timeout, Anthropic
max output tokens, and exact-model `pricing` rates (`inputUsdPerMillion`, `outputUsdPerMillion`,
optional cache read/write rates). It returns text, parsed JSON, tool calls, model, and token/cost
usage. Missing provider usage counts as zero reported tokens; unknown costs are `null`, never
guessed. Provider-reported costs take precedence. Aggregate successful-call usage lives at
`run_usage:<runId>`; failed/truncated responses are rejected rather than treated as valid results.

Anthropic uses a forced structured-output tool; compatible providers use JSON object mode with
local schema validation. The supported JSON Schema subset is documented by the exported
`JsonSchema` type. Interactive tools and JSON results are separate request modes. JSON extraction
handles fences, surrounding prose, nested objects/arrays, escapes, and braces in strings.
429/5xx and transport failures retry up to three times with exponential backoff; Retry-After
is respected within a 30-second delay cap. Requests time out after 30 seconds by default.
Errors contain no response bodies, credentials, or full email contents. Redirects are disabled.
Protocol references: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
and [Anthropic tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls).

## Host agents (Claude Code and Codex)

`provider: "codex"` and `provider: "claude-code"` run the host machine's logged-in CLI through its
subscription; no API key. `HostAgentLlmClient` implements `LlmClient`: every call is a fresh,
non-persisted run (`claude -p --safe-mode --tools "" --system-prompt …` or `codex exec --json -s
read-only --ignore-user-config` with the shell and other tools disabled) in a scratch `cwd`
(`createLlmClient(config, { hostAgentCwd })`). JSON mode uses `--json-schema` / `--output-schema`
(Codex requires an object root with `additionalProperties: false` and every property required;
other roots, including arrays, are described in the prompt) and is validated locally.
Interactive tools are emulated as structured output, so Passport executes them under policy. `model:
"fast"` uses `fastModel`, defaulting to `claude-haiku-5-5` / `gpt-5.6-luna`. Usage maps to `LlmUsage`
with `costUsd: null`.

`detectHostAgents()` resolves `claude` / `codex` on `PATH` plus `extraBinDirs()` (`~/.local/bin`,
Homebrew, `/usr/local/bin`, volta, bun, pnpm, `~/.npm-global/bin`, mise/asdf shims, fnm's default
alias), or `PASSPORT_CLAUDE_PATH` / `PASSPORT_CODEX_PATH`, and reports version, login and plan
without reading tokens; results are cached for 60 seconds.

`probeShellEnvironment()` reads `PATH` and allowlisted certificate, Homebrew, version-manager and
locale variables from the login shell (`$SHELL -ilc`, detached, stdin ignored, 5-second timeout,
SIGTERM then SIGKILL), falling back to `launchctl getenv PATH` on macOS and then the inherited
`PATH`; `applyShellEnvironment(result)` writes it into `process.env`. Use it in processes started
from Finder or launchd, where `PATH` lacks user-installed CLIs.

`runHostAgentSession(request, onEvent)` is an agentic run: MCP servers (`{ command, args, env }` or
`{ url, headers }`) are wired through a private `--mcp-config` file with `--strict-mcp-config` (Claude
Code) or `-c mcp_servers.*` with secrets in the child environment (Codex). `allowedTools` defaults to
every tool of the supplied servers; built-in shell/file tools stay off unless named. Events are
`started`, `text`, `tool_call`, `tool_result`, `completed` and `error`; `cancel()` or an aborted
`signal` terminates the CLI's POSIX process group, escalating SIGTERM to SIGKILL after two seconds
even if the CLI itself exits first. Groups remain registered for synchronous exit cleanup until
confirmed gone; that hook uses SIGKILL because it cannot wait. After leader exit, `done` waits at
most 250 ms for inherited stdio to close. Descendants that create a separate group/session escape
group cleanup; Windows retains direct-child termination, and host termination that bypasses Node's
exit hooks (such as SIGKILL) cannot run cleanup.

`maxTurns` is optional. Claude Code enforces it with `--max-turns`. Codex requires a positive safe
integer and counts JSON-stream turn starts plus tool-call starts (MCP, shell and web search); the
initial turn consumes one unit, so `maxTurns: 1` allows a final reply but cancels on the first tool
start. Exceeding the budget cancels the process group and resolves with `HOST_AGENT_MAX_TURNS`.
This bounds streamed activity; a tool may already have started by the time cancellation arrives,
so it cannot undo that tool's effects. Omit the option for no turn budget; `timeoutMs` still applies.

Children receive an allowlisted environment (no `PASSPORT_*`
or provider API keys), stderr is classified but never surfaced, and CLI-derived error text is
redacted. Live tests in `src/host/host.live.test.ts` skip when a CLI is absent or signed out (set
`PASSPORT_SKIP_LIVE_HOST_AGENTS=1` to skip them anyway).

## How triage decides

1. Read the email through `store.emails.get(id, { includeBodies: true })`; an envelope without
   bodies gets one reader `body` call, or is triaged from its subject and preview. Resolve from/to/cc case-insensitively.
   Infer `self` from configured addresses or human-verified self contacts, `service` from List-Id/no-reply/bulk headers, and
   `known` from any prior sent mail or at least two **prior** received emails; otherwise `stranger`.
   With a reader (see "On-demand readers" below) that evidence is two capped provider counts; the rest of
   this step describes the reader-less fallback, which scans only the newest 200 stored emails and executed actions.
   Sent evidence requires a sent-role mailbox, explicit provider sent provenance, or an
   executed send action; From headers alone never prove outbound contact. Drafts and
   later messages are excluded from history. Provider tombstones remain available as prior-contact
   and thread evidence through explicit `includeDeleted: true` queries. Per-person contribution IDs in
   `person-stats:<personId>` make reprocessing idempotent. Existing known/service relationships
   are retained. Verification is taken only from the normalized email's verification fields;
   recipients never inherit the sender's verification. Blue-to-green senders emit
   `person.downgraded` and remain stranger risk until blue returns or a human approves
   `downgradeAcknowledgedAt`. Inbound self From with failed DMARC/DKIM also warns
   and has stranger counterparty risk; its recipients gain no sent-history trust.
2. Preserve stored money/legal categories on reprocessing. Screen sensitive requests first:
   legal/payment/stranger-request heuristics, then `fastModel` for every remaining message,
   including bulk mail. Money, legal, and stranger requests take priority over routine signals.
   Only then classify List-Unsubscribe as newsletters, receipt/order/invoice patterns as receipts,
   calendar parts/ICS/invite subjects as scheduling, and service senders as notifications.
   A model cannot turn an unestablished contact into
   `replies_known`, even if their identity is blue.
3. Collect up to 12 matter candidates: the email's matter, open matters referencing the thread or
   (with a reader) recent mail with the sender (`with:<addr> newer_than:90d`), the people's matters,
   and matters whose title or summary shares a subject word. There is no FTS query over bodies. The main model picks a supplied ID or proposes a new matter. Receipts
   use `Purchases/<sender name or domain>`. Unknown model-supplied matter IDs are rejected.
4. For any category in `alwaysAsk`, record only a proposal/attention item explaining the
   approval requirement; never label, archive, or mark read automatically. Otherwise submit the playbook: newsletters → label `Newsletters`, archive; receipts → label `Receipts`,
   archive; folder providers without label support attach the matter and archive
   without a label. The executor creates missing labels on label-capable accounts;
   undo removes membership while retaining the label. Notifications → mark read, archive; known replies → `draft_create` with the source
   `inReplyToEmailId` and thread context. No triage playbook sends a reply.
5. Scheduling checks all calendar accounts over the proposal range without a 50-event
   cap, preferring injected `freeBusy(accountId,range)` for connected accounts. Return
   `null` for disconnected accounts to fall back to local events. Local recurrence
   expansion supports DAILY/WEEKLY/MONTHLY with INTERVAL, BYDAY, COUNT, UNTIL and
   WKST, event-zone DST, and exposed cancellation/override identities. A linked invite proposes `calendar_respond`;
   conflicting acceptance becomes tentative. Without a linked event, `calendar_propose`
   carries a reply draft and up to three validated free slots in the next 14 days. The shared
   contract calls this action `calendar_propose`, not `propose_meeting`. Missing calendar data
   cannot establish real-world availability; the server must sync calendars before running it.
6. Stranger and other non-routine mail gets a summary in `decision:<runId>:<emailId>` and the
   finished event's `decisions` payload, without drafting/sending. This attention item is separate
   from the executor's approval queue; only the executor/policy determines action statuses.

Every domain mutation is submitted to `executor.submit` with `{ kind: "agent", id: runId }`,
`runId`, category, and an explanation. The runtime never calls domain Store write methods.
Proposed/denied creation actions do not produce fabricated matter IDs. Independent routine
mail actions may still be submitted while a matter creation awaits approval. People projected
for reasoning can be unpersisted; only existing persisted person IDs are attached to matters.

## USER.md and prompts

`getUserProfile`/`setUserProfile` use `store.kv["user_profile"]`; the initial template is
[USER.md](./USER.md), also exported as `DEFAULT_USER_PROFILE`. Agent reads, tools, MCP resources and policy inverse
capture share `getEffectiveProfile(store)` from `@passport/types`; the first rule edit retains
the entire default document. Editing this checked-in template
does not update a running user's profile: save it through the setter. All LLM prompts include
the profile and distinguish trusted instructions from untrusted email/tool/matter content.
Templates are short pure functions in `src/prompts/`.

Drafts use the user's tone from the assistant's perspective and must never claim to be the
human or invent personal actions/commitments. Assistant attribution is off by default. To
permit it, set `assistant_attribution: true` in USER.md **and** configure
`drafts: { attribution: true }`. Optional `drafts.attributionLine` replaces the default
`(drafted by my assistant)`. The formatter removes that line when disabled and deduplicates it
when enabled. This switch applies to triage, calendar response drafts, and manual draft/send inputs.

## Manual tools and schedules

The manual loop offers all 44 tools from `@passport/tools`, using the same names,
JSON Schemas, account checks and handlers as MCP. Triage playbook writes and matter
reviews invoke those handlers too. The system prompt lists registry tool names, so
new tools become available automatically. The full [catalogue](../../docs/tools.md)
describes inputs, results and policy categories.

Reads and writes both count toward an absolute 12-tool-call manual limit, including
batched calls. Recoverable input errors return to the model; dependency/LLM failures
persist the failed run before throwing. `run()` returns an `AgentRunResult` with
`toolBudget: {callsMade,llmCalls,inputTokens,outputTokens,totalTokens}`, also persisted
with the run. Triage calls count in that budget too. Token counts use reported usage.
Sends use the policy-controlled outbox. Runs on one runtime instance are serialized through one
queue with two priorities: `run(trigger, { priority })` takes `"interactive"` (default for manual
triggers) or `"background"` (default for arrivals and schedules). Interactive runs start before any
queued background run but never preempt the run in progress; `queued()` reports waiting runs.
The composition root still owns event deduplication and cross-runtime coordination.

`daily_digest` writes UTC `digest:YYYY-MM-DD` Markdown covering completed/failed work, pending
actions/outbox items, attention summaries, matters updated that day, and observed trust/verification
changes. It uses journaled run data and trust snapshots, not an invented LLM narrative. Trust changes
before the first recorded snapshot cannot be reconstructed from this Store contract.
`matter_review` checks active matters against the configurable inactivity threshold, considering
event activity and the newest 20 emails the matter references (fetched by id, never a store scan), and submits evidence-based summary/nextStep/status updates through policy.
`outbox` delegates due-release processing to `executor.releaseDue`.

## On-demand readers (v0.3)

Pass `readers: MailReaderResolver` to `createAgentRuntime` to read through the provider instead of a
local mirror. Each run resolves an account's reader at most once and spends at most 12 reader calls
(`RUN_READ_BUDGET`) in the run's quota lane (`interactive` for interactive runs, `arrivals` for
triage, `background` otherwise). Reads that fail or exceed the budget degrade to cached or local data;
`toolBudget.reads` reports calls, failures, skips and provider units.

- **People.** `known` evidence is `countIds("in:sent (to:x OR cc:x OR bcc:x)", 1)` and
  `countIds("from:x", 3)` over all of the person's addresses, stored in `stats` with
  `statsRefreshedAt` on the person row. Counts that establish the relationship are reused for seven
  days (`PERSON_STATS_MAX_AGE_MS`); weaker counts are recounted on every arrival, since one more
  message can promote a stranger. `resolvePeople({ refreshStats: true })` forces a recount. Nothing
  scans the store. Unchanged person rows are not resubmitted as `person_update`.
- **Replies.** Thread context is one `thread(threadProviderId, { format: "text" })` call, falling
  back to stored thread rows.

## Integrator requirements: frozen contract adaptations

The shared contract appends reversible `profile_update` for USER.md edits. Three
package-local conventions bridge the remaining interface gaps:

- **Person creation:** `person_update` with a complete `Person` patch and a new ULID means upsert.
  The executor must support creation and log/undo it; a partial patch for a missing person should fail.
- **Email metadata:** agent-generated `matter_create` and `matter_attach` params carry optional
  `emailPatch: { category, personIds }`. The executor must call `getAgentEmailPatch(request)` and
  apply it to the action's `matter.emailIds`/`emailIds` in its logged transaction, including inverse
  restoration. Creation attaches the initial emails as part of that same action. On successful
  creation, expose `result.matterId` (or `result.matter.id`/`result.id`); the runtime can also discover
  a persisted matter through its email linkage. If executed creation cannot be discovered, it fails
  clearly with `EXECUTOR_RESULT`. Without this convention the executor cannot persist category or
  resolved person IDs through any frozen shared ActionType.
- **Digest/attention events:** `AgentFinishedEvent` extends the existing `agent.run.finished`
  event with optional `digest: { date, markdown }` and `decisions`. No unsupported event discriminant
  is cast into `EventBus`. Server/UI consumers can import that type to inspect the extra payloads.

The server must subscribe to `email.received` **after** persisting the email, then call
`agent.run({ kind: "email.received", emailId: event.email.id })`. Handle the returned promise/rejection;
EventBus handlers themselves return void. Schedule daily digests, matter reviews, and outbox
release; forward finished/downgrade events to the UI and present attention summaries. After approving
previously pending person creation, a subsequent explicit triage may be needed to attach those IDs.
The UI dismisses/resolves attention items by deleting their `decision:<runId>:<emailId>` key;
the `agent:pending_decisions` index preserves unresolved items across days and is pruned by digests.
`run:<id>` contains start/finish/action IDs and a
short operational summary, never a raw transcript. The server supplies credentials only to the LLM
client and keeps all mail/calendar credentials in its own provider/executor composition.

## Extending playbooks and verification

Add deterministic rules to `heuristicCategory`, a new branch in `triage`, and short prompt/schema
functions when needed. Invoke the shared registry through the run context; keep provider access
and policy overrides out of playbooks. Add tools in `@passport/tools` so both MCP and the agent receive them with shared
validation; retain the manual call cap. Add fixture tests with `src/testing/memory-store.ts`'s `MemoryStore`,
`FakeExecutor`, `FakePolicy`, `MemoryBus`, and scripted `FakeLlm`; no network is used in tests.

Run `pnpm --filter @passport/agent typecheck`, `pnpm --filter @passport/agent test`, and
`pnpm --filter @passport/agent build`. Builds omit tests/testing helpers. Production features are
implemented; no production stubs. Test fakes deliberately do not model provider delivery,
approval/undo, or real outbox release. Calendar proposals use optional injected provider free/busy and otherwise synced Store
events. Google/CalDAV exception identities are currently unexposed, so their local
recurring availability cannot honour instance cancellations; use live availability.
The runtime does not fetch missing bodies or attachment blobs.
