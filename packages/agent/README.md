# @passport/agent

Personal email triage, people inference, matter organization, policy-controlled playbooks,
manual tool use, USER.md, and daily digests. Runtime dependencies: `@passport/types` only;
LLM requests use Node's `fetch`. No mail/calendar provider is accessed by this package.

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

## How triage decides

1. Read the stored email, including available bodies. Resolve from/to/cc case-insensitively.
   Infer `self` from configured addresses, `service` from List-Id/no-reply/bulk headers, and
   `known` from any prior sent mail or at least two **prior** received emails; otherwise `stranger`.
   Drafts and later messages are excluded from history. Existing known/service relationships
   are retained. Verification is taken only from the normalized email's verification fields;
   recipients never inherit the sender's verification. Blue-to-green senders emit
   `person.downgraded` and are treated as strangers for reply decisions.
2. Classify List-Unsubscribe as newsletters, receipt/order/invoice patterns as receipts,
   calendar parts/ICS/invite subjects as scheduling, and service senders as notifications.
   The remaining mail uses `fastModel`. A model cannot turn an unestablished contact into
   `replies_known`, even if their identity is blue.
3. Collect matter candidates from the current/thread mail, persisted people, and quoted FTS
   subject tokens. The main model picks a supplied ID or proposes a new matter. Receipts
   use `Purchases/<sender name or domain>`. Unknown model-supplied matter IDs are rejected.
4. Submit the playbook: newsletters → label `Newsletters`, archive; receipts → label `Receipts`,
   archive; notifications → mark read, archive; known replies → `draft_create` with the source
   `inReplyToEmailId` and thread context. No triage playbook sends a reply.
5. Scheduling checks all stored calendar accounts. A linked invite proposes `calendar_respond`;
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
[USER.md](./USER.md), also exported as `DEFAULT_USER_PROFILE`. Editing this checked-in template
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

The manual loop offers `search_mail`, `read_email`, `read_matter`, `list_matters`, `free_busy`,
`draft`, `send`, `archive`, `label`, `matter_create`, `matter_update`, and `matter_attach`.
Reads and writes both count toward an absolute 12-tool-call limit, including batched calls.
Writes validate existing references/account ownership and bind the agent actor in code.
`send` submits to the executor's outbox; it never delivers synchronously here. Recoverable input
errors return to the model; executor/LLM failures finish and persist the failed run before throwing.
Runs on one runtime instance are serialized. The composition root must avoid duplicate event
delivery and concurrent runtimes over the same mailbox; there is no distributed lock or replay cache.

`daily_digest` writes UTC `digest:YYYY-MM-DD` Markdown covering completed/failed work, pending
actions/outbox items, attention summaries, matters updated that day, and observed trust/verification
changes. It uses journaled run data and trust snapshots, not an invented LLM narrative. Trust changes
before the first recorded snapshot cannot be reconstructed from this Store contract.
`matter_review` checks active matters against the configurable inactivity threshold, considering
mail/event activity, and submits evidence-based summary/nextStep/status updates through policy.
`outbox` delegates due-release processing to `executor.releaseDue`.

## Integrator requirements: frozen contract adaptations

No shared types were changed. Three package-local conventions bridge gaps in the frozen interfaces:

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
functions when needed. Submit typed ActionRequests through the run context; keep provider access
and policy overrides out of playbooks. Extend the manual tool schema/dispatcher together so new
tools retain validation and the call cap. Add fixture tests with `src/testing/memory-store.ts`'s `MemoryStore`,
`FakeExecutor`, `FakePolicy`, `MemoryBus`, and scripted `FakeLlm`; no network is used in tests.

Run `pnpm --filter @passport/agent typecheck`, `pnpm --filter @passport/agent test`, and
`pnpm --filter @passport/agent build`. Builds omit tests/testing helpers. Production features are
implemented; no production stubs. Test fakes deliberately do not model provider delivery,
approval/undo, or real outbox release. Calendar proposals use synced Store events rather than
live provider free/busy, and the runtime does not fetch missing bodies or attachment blobs.
