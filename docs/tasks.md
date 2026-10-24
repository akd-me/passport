# Tasks

A **task** is the unit of agent work in Passport v0.3, the email analogue of a T3 Code thread:
a durable conversation with **runs** (one agent pass each), a timeline of **items** (messages,
tool calls, approvals, notices), and a server-owned lifecycle. Design: `docs/design/on-demand.md`
§3 and §4.3. Types: `packages/types/src/tasks.ts` (re-exported from `@passport/types`).

Vocabulary: "task" is agent work, "conversation" is an email thread, "matter" is unchanged.

## Model

| Type | Fields |
|---|---|
| `Task` | `id`, `title`, `accountIds`, `status` (`inbox` / `working` / `snoozed` / `settled` / `archived`), `pinned`, `snoozedUntil?`, `permissionMode` (`supervised` / `auto_accept_edits` / `auto` / `full_access`), `permissionModePinned?`, `interactionMode` (`default` / `plan`), `createdBy` (`user` / `agent` / `system`), `kind` (`task` / `inbox` / `routine`), `parentTaskId?`, `needsUser` (`null` / `approval` / `question` / `failure` / `limited`), `pendingActionIds?`, `lastActivityAt`, `createdAt`, `settledAt?`, `watches: ConversationWatch[]`, `jobId?` (routine), `revision?`, `approvalGrants?: TaskApprovalGrant[]`; v0.4, all optional: `returnedAt?`, `seenAt?`, `unseenOutcome?` (`done` / `woke` / `null`), `queue?: TaskQueueEntry[]`, `queueHeld?`, `limited?: TaskLimited \| null`, `titleGenerated?`, `providerSessionId?`, `providerSessionKind?` (`claude-code` / `codex`: the host-agent session follow-ups resume, see [Sessions](#sessions)); v0.4 W2A, all optional: `pendingQuestions?: TaskPendingQuestion[]` ([Questions](#questions)), `delegation?: TaskDelegation \| null` (set on subtasks), `waitingOnTaskIds?` (subtasks started with `mode: "wait"` still working), `settleRequested?` (`task_organize` settle, applied at run end); see [Subtasks](#subtasks) and [Organise](#organise) |
| `TaskApprovalGrant` | `category`, `actionId`, `trustLevel`, `risk`, `reversibility`, `grantedAt` (see [Approval scopes](#approval-scopes)) |
| `ConversationWatch` | `threadHandle`, `account`, `since`, `lastWakeAt?`, `consecutiveWakes` |
| `TaskQueueEntry` | `runId` (the `queued` TaskRun it runs as), `text`, `createdAt`, `answers?` (the questions it answers) (see [Follow-up queue](#follow-up-queue)) |
| `TaskPendingQuestion` | `itemId` (the `question` item), `runId`, `text`, `options?` (at most 6), `blocking`, `askedAt` |
| `TaskDelegation` | `parentRunId`, `mode` (`async` / `wait`), `completionWake` (`always` / `settled_only`), `depth` (1 or 2), `delegatedAt`, `cancelledByParent?` |
| `TaskLineage` | `taskId`, `parent: Task \| null`, `children: { task, activeRuns, lastRunStatus }[]` (newest first, at most 50) |
| `TaskQueue` | `taskId`, `held`, `entries: TaskQueueEntry[]` |
| `TaskLimited` | `runId` (the stopped run), `resetAt` (or `null` when unknown), `autoResume`, `source` (`host_agent` / `provider`), `at` (see [Usage limits](#usage-limits)) |
| `TaskRestoreState` | `status`, `snoozedUntil`, `settledAt`: what settle, snooze and archive replaced (`TaskWithPrevious = Task & { previous }`) |
| `TaskRun` | `id`, `taskId`, `status` (`queued` / `running` / `waiting` / `completed` / `failed` / `cancelled`), `trigger`, `priority` (`interactive` / `background`), `agentRunId`, `createdAt`, `startedAt?`, `endedAt?`, `summary?`, `actionIds`, `usage?` (`llmCalls`, `toolCalls`, `inputTokens`, `outputTokens`), `error?` (a stable code), `restartOf?` (v0.4: the run a restart interrupted and this one continues) |
| `TaskRunTrigger` | `{ kind: "message", itemId, mode }` · `{ kind: "arrival", emailId }` · `{ kind: "schedule", jobId, name }` · `{ kind: "watch", threadHandle, emailId }` · `{ kind: "wake", reason }` |
| `TaskItem` | `id`, `runId` (null for lifecycle notices), `taskId`, `seq` (per task, from 1), `kind`, `at`, `payload`, `untrusted?` |

Item payloads by `kind`:

| kind | payload |
|---|---|
| `user_message` | `{ text, answers? }`; `answers` lists the `question` items the message answered |
| `assistant_message` | `{ text }` (model output; `untrusted: true` because it may quote mail) |
| `tool_call` | `{ name, inputSummary, resultSummary, cost?, durationMs, isError, planned? }`; summaries are redacted (bodies, secrets, token-shaped strings) and at most 200 characters |
| `approval_request` | `{ actionId, summary }`; approve or reject with `/api/actions/:id/{approve,reject}` |
| `question` | `{ text }` (reserved: nothing emits it yet) |
| `render` | `{ title, html, height }`; server-sanitised restricted HTML, `untrusted: true`, 64 KiB and 10 per run; see [rich output](tools.md#rich-output-v04) |
| `question` | `{ text, options?, blocking }` from `ask_user` (`untrusted: true`, model text); see [Questions](#questions) |
| `secret_request` | `{ requestId, text, expiresAt }`; private password field, never the value; see [request_secret](tools.md#private-secrets-v04) |
| `system_notice` | `{ text, code? }`: `RUN_CANCELLED`, `RUN_FAILED` or another run error code (`USAGE_LIMITED` for a usage limit), `RESTARTED`, `RETRY`, `WATCH_LOOP_GUARD`, `WATCH_EXPIRED`, `ARRIVALS_DROPPED` (inbox tasks), `APPROVAL_SCOPE`, `ALWAYS_UNAVAILABLE`, `TASK_APPROVED` (approval scopes; `TASK_APPROVED` is `untrusted`), `BUDGET_EXHAUSTED` (the run reached its [budget](#sessions)), `QUESTION_DISMISSED` (`untrusted`, quotes the question) |
| `notification` | `{ source: "arrival" \| "watch" \| "schedule" \| "system" \| "subtask", summary, row?, subtaskId? }`; `row` is a `MailRow`; `subtask` notifications (`untrusted`) name the child in `subtaskId`. A task created with `matterId` or `emailIds` gets a `system` one on its first run ("With matter “…” and 2 messages “…”, “…”"; `row` when there is exactly one message) |

**Untrusted data.** Items with `untrusted: true` contain provider-derived strings (subjects,
senders, snippets, tool arguments and results, model text). Their `$`, mention-style `@` and
line-leading `/` carry an invisible U+200B so host agents never treat them as commands (fullwidth
`＄`/`／`/`＠`, Unicode indentation and NEL included; an `@` inside `local@dotted.domain` is
kept). Render them as plain text. The `render` kind is the explicit exception: only server-sanitised
restricted HTML inside an opaque, script-free sandbox, never in the application document.
Passport's own `assistant_message` and `question` text uses a Markdown subset (structure and
emphasis only): no raw HTML, and
links and images become visible text with their URL, never anchors or `<img>` that load or lead
somewhere unseen.

**Prompt framing.** When the server puts mail-derived text into a model prompt (task history,
watch wakes) it wraps it in `<untrusted-data-<random> source="…">` … `</untrusted-data-<random>>`.
The 12-hex suffix is new for every frame, and every `untrusted-data` tag inside the framed text
loses its `<` (becomes `‹`), so mail can neither close the frame nor open a decoy.

**`waiting`** is reserved. Passport runs never block on an approval: a proposal becomes an
`approval_request` item, and the run carries on and completes.

## Kinds

- **`task`**: started from the composer (`POST /api/tasks`, or `/api/agent/run` for the v0.2
  composer). Title: the `title` field or the first 60 characters of the message. Without a
  `title`, when the first run ends a fast-model completion (`model: "fast"`, the request and the
  framed first reply) proposes one of at most 60 characters, neutralized like model text, and
  the task gets `titleGenerated: true`. Any later rename (`PATCH`) sets it to `false`; a rename
  before the proposal arrives wins. Without a configured model the message title stays.
- **`inbox`**: one per mail account, created by the system on the first arrival. Every triage
  run of a new message runs in the background on it. Non-routine arrivals use one host-agent
  session with the tool belt (the native tool loop on API providers); deterministic newsletters,
  receipts and service notifications use a model-free playbook. Each run starts with a
  `notification` item carrying
  the arrival's `MailRow`, and a retry starts with a `RETRY` notice. Its run's `agentRunId` is
  `arrival:<emailId>`.
- **`routine`**: one per model-backed scheduler job (`agent.daily_digest`,
  `agent.matter_review`, every user routine). The job's `taskId` points at it, and each job run
  is a `schedule` run on it, using the same session/tool loop as a message run. Built-in matter
  review supplies at most ten deterministically selected inactive matters as framed data; the
  digest retains its deterministic audit snapshot and adds the session’s explanation to the
  timeline.

User routines may set `runOn: "fresh"`: each scheduled/webhook run creates a new `kind: "task"`
child with the routine task as `parentTaskId`, instead of appending a run to the bound task.
It inherits the accounts and interaction mode and is clamped to the parent's permissions.
Task details show an **Automations** panel for jobs bound to that task.

System tasks (`inbox`, `routine`) follow the global trust dial: before each run their
`permissionMode` is refreshed to the dial, unless the person set one with `PATCH`
(`permissionModePinned`).

## Runs

- **Lanes.** User messages run in the interactive lane. Arrivals, routines and watch wakes run
  in the background lane. An interactive run starts before any waiting background run, and
  nothing preempts the run in progress.
- **Queue vs steer.** `mode: "queue"` (the default) runs the message after the task's active
  message run: it waits in the task's [follow-up queue](#follow-up-queue) and enters the lane
  only when the run before it ends. `mode: "steer"` cancels the task's active message runs and
  starts one new run whose prompt holds both the cancelled message and the new one; the queue
  is left as it is and drains after it. A run waiting in the lane leaves it immediately. A
  running one stops at its next model or tool call, and the answer of an in-flight model call
  is discarded. Arrival and routine runs can't be cancelled. Steering a system task queues.
- **Interrupt** holds the queue (`queueHeld: true` when it has entries) and cancels every
  cancellable run of the task. Each one ends `cancelled` with a `RUN_CANCELLED` notice. A run
  cancelled by a steer leaves the status to its replacement, so the task never bounces through
  the inbox.
- **Context.** A message run that starts a fresh session (or runs on an API provider) gets a
  prompt with the task title, up to 16 recent user/assistant/notification items (6,000
  characters, wrapped as untrusted data), and the request. A run that resumes the task's
  provider session gets a short turn instead (see [Sessions](#sessions)).
- **Plan mode** (`interactionMode: "plan"`). Write tools (including `watch_conversation` and
  `unwatch_conversation`) don't execute. They return
  `{ status: "planned" }`, appear as `tool_call` items with `planned: true`, and the model is asked
  for a numbered proposal list.
- **Change summary.** `run.actionIds` lists every ActionRecord whose `request.runId` equals the
  run's `agentRunId`. Fetch `/api/actions?runId=<agentRunId>` for the records and their undo.
- **Permission clamp.** A task's mode is clamped to the global trust dial at creation and on
  `PATCH`, and a child task's mode to its parent's. During a run, the policy engine also caps
  every action of that run at the task's effective mode (the minimum over the parent chain). It
  can only lower the level the trust ladder would give.
- **Restart continuation.** At startup, each message, watch or wake run a previous process left
  `queued` or `running` ends `cancelled` (`SERVER_RESTARTED`) and is continued once: the task
  gets one `RESTARTED` notice listing what was in flight (the interrupted runs, the conversations
  it still watches, pending wakes that will still fire), and a new run starts with `restartOf`
  set. A message run continues as a message run on the same `user_message` item (so the status
  rules treat it as the person's); watch and wake runs continue as a background `wake` run
  (`reason: "restarted"`). The prompt says the run was cut off, lists the watched and pending
  handles (JSON-quoted), asks the agent to check what was already done before repeating a
  write, and repeats the person's request (or the framed notification that started the run).
  A run that already continued a restart, runs of a settled or archived task, and arrival and
  schedule runs (which have their own retries), are marked `failed` (`SERVER_RESTARTED`) as before, and an interrupted message run
  that is not continued surfaces the task with `needsUser: "failure"`. Queued follow-ups are not
  runs yet: they stay in the queue and drain once recovery is done.

### Sessions

On a host agent (Codex or Claude Code), each message, watch, wake, non-routine arrival and
routine run of a task is **one agentic session**: the CLI gets Passport's tools as an MCP server and calls them
natively, streaming as it goes. There is no JSON tool protocol and no per-step CLI process.

- **Tool belt.** The run's own registry tools (the same ones an API-provider run gets, under
  `{kind:"agent",id:runId}`, with `ToolContext.taskId`, the run's permission ceiling, plan-mode
  read-only and the on-demand readers) are served from the server process over Streamable HTTP
  on `127.0.0.1`, behind a fresh 32-byte bearer per run that is revoked when the run ends. The
  CLI sees them as `mcp__passport__<tool>` and nothing else: shell, file edits, web search and
  the person's own CLI configuration stay off. The session's system prompt adds a short
  orchestration section (what a task is, how approvals come back, the budget, when to hand
  back), under 4 KB.
- **Timeline.** Items are appended as the session streams: a `tool_call` when each tool call
  completes (the same redacted, at most 200-character summaries), an `assistant_message` for
  each text block, and the run's `usage` (tokens, tool calls; `llmCalls` counts sessions) when
  it ends.
- **Budget.** Every manual or task run, on a host agent or an API provider, may make at most
  200 tool calls and run for at most 30 minutes (`agentBudget: { maxToolCalls, maxRunMinutes }`
  in `passport.config.json`, 1–10,000 calls and 1–1,440 minutes, or
  `PASSPORT_AGENT_MAX_TOOL_CALLS` and `PASSPORT_AGENT_MAX_RUN_MINUTES`). A session's next tool call past the budget is refused and
  the session stopped; a run that hits either limit completes with a `BUDGET_EXHAUSTED` notice,
  and the work done so far (including proposals) is kept. Routine scheduler timeouts are one
  minute longer than the configured runtime budget, so the runtime can report exhaustion first.
  Task-bound daily digests keep their deterministic saved evidence and ask the same session for
  one `render` summarising the day.
- **Resume.** The provider session id is recorded on the task (`providerSessionId`,
  `providerSessionKind`) as soon as the session starts. The next run resumes it
  (`claude --resume <session_id>`, `codex exec resume <thread_id>`), resolved when that run
  starts, so a follow-up queued behind the first run resumes it too. The resumed turn holds
  the task line, the current plan mode, notifications and notices since the person's previous
  message, the current status of the task's last 10 proposals (both framed as untrusted data),
  and the request. The full history prompt is used instead when the task has no session, when
  the configured host agent is a different one, and when a resume fails before the session
  did anything (the provider no longer has it); the fresh session's id replaces the old one.
- **Stop and steer.** Interrupt and steer cancel the session: the CLI process group is stopped,
  any later tool call it makes is refused, and the run ends `cancelled` once in-flight tool
  calls return. A steer's replacement run resumes the cancelled session with both messages.
- **API providers** (Anthropic, OpenAI, OpenAI-compatible, Ollama) keep the native tool loop
  in-process with the same budget, and task runs get the same orchestration section. A host
  agent without a tool belt keeps the completion loop, with the same budget. Each arrival and
  scheduled run starts a fresh session; a person’s follow-up may resume the last session recorded
  on that Inbox or routine task. Native tool reads retain the run’s quota lane and cancellation.

## Status rules

The rules below are one pure function, `resolveTaskStatus(task, event)` in
`apps/server/src/tasks/status.ts`, with five events: `run_started`, `run_ended`, `reopened`
(unsettle, unsnooze, unarchive), and `question_asked` and `question_resolved` (v0.4). Its table test is `status.test.ts`. The T3 Working predicate
is exported from `@passport/types` as `isTaskWorking(task, { activeRuns })`: false while the
task waits on the person (`needsUser` set) or, for a subtask, on its parent (a blocking
question), otherwise true while a run is queued or running, a conversation is watched, or a
subtask started with `mode: "wait"` is still working (`waitingOnTaskIds`). `taskBadge(task, { activeRuns })` gives the one badge every surface
shows, highest first: `approval`, `input` (a question, including a subtask's question to its
parent), `working` (a run), `waiting` (watching or waiting on subtasks),
`limited`, `failed`, `woke`, `done`, or `null` when nothing is new.

While a run is active the task is `working`. Two exceptions: snoozed and archived tasks stay
hidden, and an inbox task already waiting on the person stays in the inbox. A user message also
un-snoozes and un-settles the task and clears a previous failure.

A proposal surfaces the task as soon as it appears: `status: "inbox"`,
`needsUser: "approval"`, and the action id is added to `pendingActionIds`. Deciding the action
anywhere removes it from the list, and `needsUser` clears once the list is empty.

When a run ends, the first matching rule applies:

0. The person settled, snoozed or archived the task while the run was active: it stays there. A
   failed run only sets `needsUser: "failure"`.
1. Failed (not arrivals, which `ArrivalQueue` retries): `inbox` with `needsUser: "failure"`, or
   `needsUser: "limited"` when the run stopped at a [usage limit](#usage-limits).
2. Pending approvals: `inbox` with `needsUser: "approval"`; then pending questions (not a
   subtask's): `inbox` with `needsUser: "question"`.
3. Another run of the task is still active: `working`.
4. A run started by the person's message: `inbox`, or `working` while it watches a conversation
   or waits on `mode: "wait"` subtasks.
5. Snoozed and archived tasks stay where they are through background work.
6. Schedule, watch and wake runs that produced something (ActionRecords or assistant text):
   `inbox` (`working` while watching). Runs that produced nothing go back to where the task was.
7. Arrival triage never moves the task by itself, only through rules 1–2.

Then, when `settleRequested` is set ([Organise](#organise)): the task settles (watches end)
unless the run failed or something waits on the person, which drops the request, or another
run is active or a follow-up is queued, which keeps it for the next run end. A task the person
put away during the run forgets the request; the person's next message or a reopen clears it.

`question_asked` surfaces the task like a proposal (approvals keep priority; a snoozed task
comes back early; a settled or archived one only records `needsUser`; a subtask's question
does not surface it). `question_resolved` hands `needsUser` to the next thing waiting
(approval, then another question) or clears a `question`; a failure or limit stays.

`lastActivityAt` ("when it last came back to you") moves only when the task surfaces or the
person acts. Background no-op runs don't count, so auto-settle is not reset by them. A task that
rested in Working (watching) and is handed back to the inbox when a run ends counts as surfacing.

**Returned, seen and unseen outcomes (v0.4).** `returnedAt` is stamped on every write that moves
`lastActivityAt` (T3's inbox order: a run the person requested, a run that handed the task
back, a surfacing approval, failure or limit, a reopen, a snooze wake). Order the inbox by
`returnedAt ?? lastActivityAt`. A run that hands the task back to the inbox without needing the
person sets `unseenOutcome`: `done` for a message run, `woke` for schedule, watch and wake runs
(never arrivals); a snooze whose time came also sets `woke`. `POST /seen` sets `seenAt` and
clears `unseenOutcome`; sending a message does the same. `POST /mark-unread` clears `seenAt`
and brings the outcome back (`done` when there was none). A row recedes when `unseenOutcome` is
null and `needsUser` is null.

Lifecycle:

- **Snooze** hides the task until `snoozedUntil`. The `tasks.maintenance` job (every 10 minutes)
  returns it to `inbox` when that time passes. An approval, a failure or a user message brings it
  back sooner.
- **Settle** and **archive** end every conversation watch and cancel the task's cancellable runs
  (each ends `cancelled`). A non-cancellable run (arrival triage, routines) finishes, but the
  task stays settled or archived, and new approvals only add to `pendingActionIds` and set
  `needsUser`. A settled or archived task cannot start a watch (`TASK_SETTLED`).
- **Pin** never changes status, so pinning during a run is kept as well.
- **Auto-settle.** Tasks in `inbox` that are idle for 3 days, not pinned, and with no
  `needsUser` move to `settled`.
- **Undo and reopen.** Settle, snooze and archive answer with the task plus `previous`
  (`status`, `snoozedUntil`, `settledAt` before the call). `/unsettle`, `/unsnooze` and
  `/unarchive` bring a task in that state back to where it rests now (Working while a run is
  active or it watches and nothing waits on the person, else the inbox) with a fresh
  `returnedAt`; called on a task in another state they change nothing, so a repeated undo is
  harmless. To restore a snooze that settle replaced, follow `/unsettle` with `/snooze` and
  `previous.snoozedUntil`. Watches that settle or archive ended stay ended, and the queue they
  held stays held until resumed.
- Settle and archive also hold the follow-up queue first, so stopping the active run does not
  start the next queued message on a task the person put away.

## Questions

`ask_user({ text, options?, blocking? = true })` (a registry tool; see
[tools](tools.md#questions-subtasks-and-organise-v04)) appends a `question` item, adds a
`TaskPendingQuestion` to `Task.pendingQuestions` (at most 5 open, `409 QUESTION_LIMIT` to the
tool), and surfaces the task with `needsUser: "question"`. The tool returns at once; with
`blocking` the agent is told to end its turn. The run is not held open.

- **Answer.** `POST /api/tasks/:id/questions/:itemId/answer { text }` answers that question:
  the text becomes the task's next message through the [follow-up queue](#follow-up-queue)
  (queued behind an active message run), its `user_message` carries `answers: [itemId]`, and
  the prompt quotes the question (`You asked: "…"` / `The person's answer: …`). Any message
  sent while questions are pending (`POST …/messages`, either mode) answers all of them.
- **Dismiss.** `POST …/questions/:itemId/dismiss` resolves it without an answer and appends a
  `QUESTION_DISMISSED` notice; no run starts. The agent sees the notice on its next turn.
- Answering or dismissing a question that is no longer pending answers `409
  QUESTION_RESOLVED`; an unknown item `404 NOT_FOUND`.
- `needsUser` stays `"question"` while any question or a `request_secret` request is open;
  approvals take priority, and deciding the last one hands over to the question.

## Subtasks

`task_delegate` starts a **subtask**: a `kind: "task"` child with `parentTaskId`,
`createdBy: "agent"` and `delegation`. It runs its own message run on `message` (prompted as
"The request from your parent task"), in the parent's interaction mode, on the parent's
accounts or a subset (`ACCOUNT_MISMATCH` otherwise), with `permissionMode: "inherit"` (the
parent's effective mode) or a lower one: the clamp never lets it exceed the parent. Limits:
depth 2 (a top-level task's child is depth 1; `DEPTH_LIMIT`), 10 working subtasks per task
(`SUBTASK_LIMIT`), and no subtasks from a settled or archived task (`TASK_SETTLED`).

- **Completion.** When a subtask's work ends (its run ended and no follow-up waits), the parent
  gets a `notification` (`source: "subtask"`, `subtaskId`): "Subtask “…” finished: <its reply>",
  "failed (CODE)", "was stopped" or "stopped at a usage limit", plus how many of its proposals
  wait for the person. The parent then **wakes** with a background `wake` run
  (`reason: "subtasks"`, prompted to call `task_status`) when the child was started with
  `mode: "wait"`, when it asked a question, when `completionWake` is `always`, or (`settled_only`,
  the default) when none of the parent's subtasks is still working. Several completions share
  one wake: a completion that finds the parent's subtask wake queued or running joins it (the
  agent lane runs one run at a time, so a running wake started after that child finished). A
  settled or archived parent gets the notification without a wake.
- **Wait mode.** `mode: "wait"` records the child in the parent's `waitingOnTaskIds`: the agent
  ends its turn, the parent rests in Working (badge Waiting) and wakes when the child finishes.
- **Questions.** A subtask's `ask_user` question is recorded on the child
  (`pendingQuestions`, its own `question` item) but never surfaces it to the person: the parent
  gets a `notification` ("Subtask “…” asks: "…". Options: …") and wakes when the child's run
  ends. The parent answers with `task_delegate({ taskId, message })`, which sends the message
  to the child and answers its pending questions.
- **Approvals.** Agents have no approval tool, so a subtask cannot approve anything and its
  parent cannot approve for it: the child's proposals wait for the person on the child task,
  which then appears in the sidebar and Needs you. Approval-scope grants are per task; a child
  inherits none.
- **Cancel.** `task_cancel` stops the child like the person's Stop (queue held, runs
  cancelled), its own subtasks first, drops its open questions, removes it from
  `waitingOnTaskIds` and marks `delegation.cancelledByParent`, so its end neither notifies nor
  wakes the parent. A later `task_delegate` follow-up to it clears the mark.
- **Lineage.** `GET /api/tasks/:id/lineage` returns the parent and the children (with
  `activeRuns` and the last run's status); `GET /api/tasks?parentTaskId=<id>` lists children.
  Subtasks are ordinary tasks for every other route.

## Organise

`task_organize({ action, until?, title? })` lets the agent file its own task: `snooze` (with
a future `until`, the ordinary snooze), `unsnooze`, `pin`, `unpin`, `rename` (neutralized,
`titleGenerated: true` until the person renames it), `mark_unread`, and `settle`. Settle is
deferred: it sets `settleRequested` and the status rules apply it when the run ends (see
[Status rules](#status-rules)). Each answers `{ action, applies: "now" | "run_end", task }`.

## Follow-up queue

A `queue` message waits in `Task.queue` when the task has an active message run, already has
queued entries, has a held queue, or (after resuming it) was limited. Each entry has a TaskRun in
status `queued` under its `runId` (its `trigger.itemId` is empty until it starts), so
`POST /messages` still answers `202 { task, run }`. Queued messages are not on the timeline: the
`user_message` item is appended when the entry starts. When a message run ends (completed,
failed or cancelled other than by a steer), the oldest entry starts, unless the queue is held,
the task is limited, settled or archived, or another message run is active. Starting removes
the entry and runs it under its `runId`.

- `PATCH …/queue/:runId` `{ text }` edits an entry; `POST …/queue/reorder` `{ runIds }` takes
  the full new order (`409 QUEUE_CHANGED` if it does not list every entry exactly once);
  `DELETE …/queue/:runId` removes one, its run ending `cancelled` with `QUEUE_REMOVED` and no
  timeline notice; `POST …/queue/:runId/promote-to-steer` sends it now as a steer under the
  same run id. An entry that already started answers `404 NOT_FOUND`.
- **Held queue.** `/interrupt`, settle and archive set `queueHeld: true` when entries exist.
  Nothing drains until `POST …/queue/resume` or the person's next message (which clears the hold,
  joins the end of the queue, and the oldest entry starts).
- At most 20 entries (`409 QUEUE_FULL`). The queue survives restarts.

## Usage limits

A run that ends because the host CLI's subscription limit or an API provider's limit was hit
ends `failed` with `error: "USAGE_LIMITED"` (notice code `USAGE_LIMITED`) instead of a plain
failure. Detection: `HOST_AGENT_RATE_LIMIT`, a host CLI failure whose text says so (Claude
Code's `usage limit reached|<epoch>`, Codex's "hit your usage limit"), and `LLM_HTTP` with
status 429 after the client's own retries. The task surfaces with `needsUser: "limited"` and
`limited: { runId, resetAt, autoResume: false, source, at }`; `resetAt` is parsed from the error
text (an epoch, an ISO time, or "try again in 2 hours 5 minutes") and is `null` when the CLI did
not say. Recovery:

- `POST /api/tasks/:id/resume` clears the limit and continues the stopped run now (the same
  continuation as a restart: a message run continues on its `user_message` item; watch and wake
  runs as a `wake` run with `reason: "limit_resumed"`), then the queue drains after it.
- `POST /api/tasks/:id/resume-at-reset` sets `autoResume: true` and continues the run at
  `resetAt` (an in-process timer, re-armed at startup, with `tasks.maintenance` as the durable
  backstop). `409 RESET_UNKNOWN` when `resetAt` is null.
- Snooze until the reset is the ordinary `/snooze` with `until: limited.resetAt`.
- A new message counts as resume: the stopped run continues first, then the message.
- The follow-up queue waits while the task is limited.

## Conversation watches

`watch_conversation({ threadHandle, account? })` and `unwatch_conversation({ threadHandle? })`
are registry tools, available to the built-in agent and over MCP. The task comes from the
trusted call context (`ToolContext.taskId`). Calls without one, such as from external MCP
clients, return `TASK_REQUIRED`. `threadHandle` must be a thread handle (a mail row's
`threadId`), else `INVALID_INPUT`. Each task keeps at most 20 watches. Wake and expiry prompts
JSON-quote the handles.

While a task watches, it rests in `working`. After each tick, the new-mail watcher reports every
added message. A message on a watched thread wakes the task when all of these hold:

- it was received strictly after the watch's `since`;
- it is not from the person (the account's addresses or verified-self people) and not in the
  account's Sent or Drafts mailbox;
- its Message-ID (or its id) was not seen for this task in the last 7 days (replay key).

Replies on one thread within 120 seconds coalesce into one wake that uses the latest message.
Pending wakes are persisted (kv `task-watch-pending`, with their due time and Message-IDs), so a
restart, update or crash replays them once the next process starts; shutdown keeps them pending
instead of firing them. A message's Message-ID is recorded as seen only once its wake run exists.
A wake appends a `notification` (`source: "watch"`, `row`) and starts a background `watch` run.
The wake is classified from headers first (`Auto-Submitted`, `X-Autoreply`, `Precedence`),
then from sender and subject:

- `bounce`: from `mailer-daemon@` or `postmaster@`, or a delivery-failure subject.
- `auto_reply`: an automatic header, or an "Automatic reply" or "Out of office" subject.
- `reply`: anything else.

**Loop guard.** Each wake counts once, after its run (`consecutiveWakes`). A wake is a strike
when it was an auto-reply or bounce, when its run failed or created no ActionRecords, or when the
run sent mail (`send`, `calendar_propose`, `calendar_respond`) that policy let through without
asking the person. The last case catches autoresponders without `Auto-Submitted` headers ("Thanks,
ticket #123 received") answering the agent's own reply. A real reply whose run asked the person
or did other work resets the count. At 3 the watch stops: a third automatic message in a row
stops it without running the agent. The task gets a `WATCH_LOOP_GUARD` notice and surfaces
(`inbox`, `needsUser: "failure"`, fresh `lastActivityAt`), so auto-settle never takes it first.

**Expiry.** A watch older than 14 days ends with a `WATCH_EXPIRED` notice and one `wake` run
(`reason: "watch_expired"`) so the agent can follow up or hand back. If that run does nothing,
the task still comes back to the inbox with a fresh `lastActivityAt`.

## Arrivals backlog

The durable arrival queue (one `arrival:<emailId>` entry per new Inbox message) keeps at most the
200 newest pending arrivals, and an arrival never attempted within 24 hours of being queued is
dropped instead of triaged. While no model is configured, new mail is therefore not turned into a
backfill when one is configured later. An arrival whose message is gone at the provider is
dropped after one retry. Drops are reported as one `ARRIVALS_DROPPED` notice per account on its
Inbox task. `POST /api/agent/triage/:id` answers `409 TRIAGE_PENDING` while the message is still
queued for automatic triage.

## Arrival triage migration (v0.4)

`triage: { "mode": "session" }` is the default in `passport.config.json`. Set
`triage: { "mode": "pipeline" }` for the one-release structured-completion fallback.
The flag changes arrivals only; routines use sessions in either mode.

Before inference Passport resolves people from bounded provider evidence, applies verification
and downgrade rules, and screens deterministic sensitive evidence before routine signals. Plain
newsletters, receipts and service notifications never reach a model: they receive their category,
a matter, a dated notes line, and the existing label/archive or mark-read/archive playbook through
policy. `alwaysAsk` keeps the playbook as a human-review decision. Receipt matters stay under
`Purchases/<vendor>`; other routine buckets use `<category>/<vendor>`.

A material arrival gets a prompt under 4 KiB containing its `MailRow`, heuristic and sensitive
pre-classification, and matching matter-watch IDs, all framed with `frameUntrusted`. The session
reads mail and notes, organizes the arrival with `create_matter` / `attach_to_matter` plus `category`,
logs notes, and proposes a reply only when warranted. Code preserves sensitive classifications,
clamps `replies_known` to actual known senders, and attaches the resolved people. Scheduling uses
availability tools and `respond_to_event` / `propose_meeting`; a reply draft covers a request with
no available slots. Triage cannot send, unsubscribe or change USER.md. Human-review decisions
are retained for sensitive/stranger/other mail and `alwaysAsk` categories.

Session retries with existing ActionRecords, or a successfully completed run checkpoint, acknowledge
the arrival without repeating inference. If a crash left partial work, the prior actions and run
remain the review record rather than replaying the session. The pipeline fallback keeps its
step-level recovery. Stable `arrival:<emailId>` IDs, queue claims, retry/backlog limits,
`ARRIVALS_DROPPED` and the conversation-watch loop guard are unchanged.

**Parity and accepted differences.** `packages/agent/src/triage-parity.test.ts` runs both modes
against eleven shared email/person/matter fixtures, comparing categories, people links, matter
create/attach outcomes, draft presence and scheduling response presence. Two additional comparisons
cover `alwaysAsk`. Routine organization uses deterministic vendor buckets and factual summaries;
model wording, titles, notes wording and the number of inference calls need not match.
Three original fast-screen fixtures script money/legal/stranger output for otherwise neutral bulk
mail. Those are explicit accepted category differences: session mode does not make that model
screening call. Deterministic sensitive content and stored money/legal classifications still win
before the bulk pre-filter. Real semantic classification quality requires later live evaluation.

## Learn how you write (v0.4)

First connect of a real mail provider creates one system `kind: "task"` task titled
**Learn how you write**, in the interactive lane, with permission mode at most `auto_accept_edits`.
The task ID `voice:<accountId>` prevents duplicate creation on reconnect. A CLI connection without
a task owner persists a request that the next server picks up. Existing accounts are not sampled
on upgrade; mock/demo connections do not create this task.

Trusted run metadata enforces one `mail_search` over that account’s Sent folder, limit 50,
without pagination or thread expansion. Only sampled message IDs may be read, once each, using
`mail_read` in text/message view with quotes collapsed and an 8,000-character body window.
The run may read USER.md and submit one `profile_update` proposal after a successful body read;
other tools, further searches and further proposals are refused. IMAP without an advertised or
configured Sent folder skips the task. Empty or unusable samples should produce an explanation
without a proposal.

Voice, Signature and VIP suggestions form one reversible `profile_update` action in the new
`profile_update` category. It always asks the person, even at full access or with an approval grant.
The approval panel and Decisions show the proposed USER.md. The executor leaves the profile
unchanged until approval and captures its value at execution for undo. VIP suggestions are knowledge,
not relationship or verification changes.

Known limitations: the sample is small and may not represent every writing context. Voice and
Signature suggestions are single lines; at most twenty VIP entries are accepted. The learned
proposal replaces the whole effective profile while preserving unrelated sections when proposed;
review it against any human edits made while it was pending. A failed or empty learning run can be
revisited by sending a message in its task; it does not automatically sample again on reconnect.

## HTTP API

Private secret input adds `GET/POST /api/tasks/:taskId/secrets/:id`. POST accepts `{ value }`
or `{ status: "declined" | "cancelled" }`; only request metadata is returned. While
`request_secret` waits, the task surfaces with `needsUser: "question"` (existing approvals
keep priority). Saving, declining, timeout or run cancellation resolves the request; no
entered value is appended to the timeline. `secret.request.updated` events carry metadata
and an optional one-use reference, never the secret. See [tools](tools.md#private-secrets-v04).

Every route requires the bearer token. Errors use the standard body
`{ "error": { "code", "message" } }`. On the demo backend every task route answers
`501 TASKS_UNAVAILABLE`.

| Method and path | Body / query | Response |
|---|---|---|
| `GET /api/tasks` | `status=inbox,working` (comma list), `kind=task,inbox,routine`, `pinned=true\|false`, `parentTaskId` (v0.4: children only), `limit` (1–500, default 50), `cursor` | `Page<Task>`: `{ items, total, nextCursor }`, ordered by `lastActivityAt` desc |
| `POST /api/tasks` | `{ message, title?, accountIds?, permissionMode?, interactionMode?, parentTaskId?, matterId?, emailIds? }` | `201 { task, run }` (the first run, `queued`) |
| `GET /api/tasks/by-action/:actionId` | | `TaskByAction`: `{ taskId, runId }`; `404 NOT_FOUND` when no task run holds the action |
| `GET /api/tasks/:id` | | `TaskDetail`: `{ task, runs }` (runs newest first, at most 50) |
| `GET /api/tasks/:id/items` | `afterSeq` (default 0), `limit` (default 100) | `{ items, lastSeq }` (ascending `seq`) |
| `POST /api/tasks/:id/messages` | `{ text, mode?: "queue" \| "steer" }` | `202 { task, run }`; a queued message's `run` is `queued` with an empty `trigger.itemId` |
| `POST /api/tasks/:id/interrupt` | | `Task` (`queueHeld` when entries are waiting) |
| `POST /api/tasks/:id/snooze` | `{ until }` (future ISO time) | `TaskWithPrevious`: the `Task` plus `previous` |
| `POST /api/tasks/:id/settle` | | `TaskWithPrevious` |
| `POST /api/tasks/:id/archive` | | `TaskWithPrevious` |
| `POST /api/tasks/:id/unsettle` · `/unsnooze` · `/unarchive` | | `TaskWithPrevious`; unchanged when the task is not in that state |
| `POST /api/tasks/:id/seen` | | `Task` (`seenAt` set, `unseenOutcome: null`) |
| `POST /api/tasks/:id/mark-unread` | | `Task` (`seenAt: null`, `unseenOutcome` kept or `done`) |
| `GET /api/tasks/:id/queue` | | `TaskQueue` |
| `PATCH /api/tasks/:id/queue/:runId` | `{ text }` | `TaskQueue`; `404` when not queued |
| `POST /api/tasks/:id/queue/reorder` | `{ runIds }` (every entry once) | `TaskQueue`; `409 QUEUE_CHANGED` |
| `DELETE /api/tasks/:id/queue/:runId` | | `TaskQueue` |
| `POST /api/tasks/:id/queue/:runId/promote-to-steer` | | `202 { task, run }` |
| `POST /api/tasks/:id/queue/resume` | | `TaskQueue` (`held: false`; the next entry may have started) |
| `POST /api/tasks/:id/resume` | | `202 { task, run }` (`run` is the continuation, `null` if the stopped run is gone); `409 NOT_LIMITED` |
| `POST /api/tasks/:id/resume-at-reset` | | `Task` (`limited.autoResume: true`); `409 NOT_LIMITED`, `409 RESET_UNKNOWN` |
| `POST /api/tasks/:id/pin` · `/unpin` | | `Task` |
| `POST /api/tasks/:id/questions/:itemId/answer` | `{ text }` | `202 { task, run }` (the answer's run, possibly `queued`); `404 NOT_FOUND`, `409 QUESTION_RESOLVED` |
| `POST /api/tasks/:id/questions/:itemId/dismiss` | | `Task`; `404`, `409 QUESTION_RESOLVED` |
| `GET /api/tasks/:id/lineage` | | `TaskLineage` |
| `POST /api/tasks/:id/unwatch` | `{ threadHandle? }` (omit to stop every watch) | `Task` |
| `PATCH /api/tasks/:id` | `{ title?, permissionMode?, interactionMode? }` | `Task` (mode clamped) |
| `POST /api/actions/:id/approve` | `{ request?, scope?: "once" \| "task" \| "always" }` | `ActionRecord`; with `task` or `always` also `approvalScope: ApprovalScopeResult` (`{ requested, applied, taskId?, pinnedLevel?, code? }`). The task's `pendingActionIds` and `needsUser` follow |
| `PATCH /api/actions/:id/draft` | `{ textBody }` (1–100,000 characters) | Pending proposal only; `ActionRecord`, still `proposed`; only body changes, stale HTML cleared; `409 ACTION_NOT_PENDING` after a decision |
| `POST /api/render/preview` | `{ html, height? }` | `{ html, height }` through the render tool's parser, without persisting an item; same 64 KiB and 80–1200 px limits |
| `POST /api/actions/:id/reject` | unchanged | `ActionRecord` |
| `POST /api/agent/run` | unchanged v0.2 body `{ instruction?, emailIds?, matterId? }` | the finished `AgentRun` plus `taskId`; a `kind: "task"` task is created per call |

Text limits: `message` and `text` are 1–20,000 characters, and `title` 1–200 (stored at most
60). Unknown body fields are rejected with `400 INVALID_FIELD`.

**Composer context** (`POST /api/tasks`). `emailIds` (at most 100) takes email ULIDs or mail
handles (`<account>:email:<providerId>`); an uncached handle is read from the provider and
cached. The first run receives `{ matterId, emailIds }` exactly as `/api/agent/run` passes them,
and the timeline gets a `notification` (`source: "system"`) naming them. Errors, all `400`:
`INVALID_FIELD` (shape, an empty `matterId`), `UNKNOWN_ACCOUNT` (an `accountIds` entry),
`UNKNOWN_MATTER`, `UNKNOWN_EMAIL`, and `ACCOUNT_MISMATCH` (a message outside `accountIds`).
Nothing is created when validation fails.

**Decision lookup** (`GET /api/tasks/by-action/:actionId`). Resolves through the run whose
`actionIds` lists the action (searched within the action's `request.runId` when the record
exists), falling back to the newest TaskRun whose `agentRunId` equals `request.runId`. Any task
status is returned, archived included, so `?decision=<id>` deep links open
`/tasks/:taskId?approval=<id>`.

Example:

```http
POST /api/tasks
{ "message": "Find the Hetzner invoices from this year and attach them to Taxes",
  "permissionMode": "auto_accept_edits" }

201
{ "task": { "id": "01K…", "title": "Find the Hetzner invoices from this year and attach them…",
            "kind": "task", "status": "working", "permissionMode": "auto_accept_edits",
            "interactionMode": "default", "needsUser": null, "pendingActionIds": [],
            "watches": [], "pinned": false, "createdBy": "user", "accountIds": ["acc-1"],
            "lastActivityAt": "2026-10-22T09:00:00.000Z", "createdAt": "2026-10-22T09:00:00.000Z",
            "revision": 2 },
  "run": { "id": "01K…", "taskId": "01K…", "status": "queued", "priority": "interactive",
           "trigger": { "kind": "message", "itemId": "01K…", "mode": "queue" },
           "agentRunId": "01K…", "actionIds": [], "createdAt": "2026-10-22T09:00:00.000Z" } }

GET /api/tasks/01K…/items?afterSeq=1
{ "items": [
    { "seq": 2, "kind": "tool_call", "untrusted": true, "runId": "01K…",
      "payload": { "name": "mail_search", "inputSummary": "query=\"from:hetzner newer_than:1y\"",
                   "resultSummary": "9 rows", "cost": { "gmailUnits": 25 },
                   "durationMs": 412, "isError": false } },
    { "seq": 3, "kind": "approval_request", "untrusted": true,
      "payload": { "actionId": "01K…", "summary": "Attach 2 invoices to Taxes" } } ],
  "lastSeq": 3 }

POST /api/tasks/01K…/messages
{ "text": "Only the PDFs", "mode": "steer" }
202 { "task": { …, "status": "working" }, "run": { …, "status": "queued" } }
```

## Approval scopes

`POST /api/actions/:id/approve` takes an optional `scope`:

- **`once`** (the default): approves this action only.
- **`task`**: approves it and adds a `TaskApprovalGrant` to the task of the run that proposed it
  (`400 NOT_A_TASK_ACTION` for other actions, checked before approving). When a later run of
  the same task proposes an action, the runner approves it at once, with a `TASK_APPROVED`
  notice instead of an `approval_request`, when a grant covers it:
  - same `category`;
  - `decision.risk` no higher and `decision.reversibility` no worse
    (`reversible` < `delayed` < `irreversible`) than the approved action's;
  - `decision.trustLevel` (global dial, ladder and the task's effective mode) not below the
    grant's. Lowering any of them voids the grant, so a grant never exceeds the task's
    permission mode or the ladder;
  - policy asked only because of the trust level. Identity changes, held drafts, always-ask
    categories and the external-agent ceiling still ask;
  - the agent proposed it (not an external client), the task is not settled or archived, and
    it is not in plan mode.

  Approved sends still go through the outbox hold. Auto-approvals don't count as the person's
  feedback, so they never train the trust ladder. If the approval fails, the proposal stays
  pending and asks as usual.
- **`always`**: pins the category's trust level with the existing trust pin
  (`PUT /api/trust/:category/pin`) to `auto_accept_edits`, so reversible actions of that
  category run without asking everywhere, and also grants `task`. It pins only when that
  changes the outcome: the action is reversible, policy asked only because of the trust level,
  the global mode is at least `auto_accept_edits` and the ladder is below it. Otherwise it acts as
  `task` and the task gets an `ALWAYS_UNAVAILABLE` notice that says why
  (`approvalScope.applied: "task"`, `code: "ALWAYS_UNAVAILABLE"`). An action outside a task can
  use `always` only when it pins.

The task gets an `APPROVAL_SCOPE` notice for `task` and for a pinned `always`.

## WebSocket

`/ws` streams every `DomainEvent` as raw JSON. Task events:

```ts
{ type: "task.updated"; task: Task }            // any change to the task row (status, watches…)
{ type: "task.run.updated"; run: TaskRun }      // created, running, finished, actionIds linked
{ type: "task.item.appended"; item: TaskItem }  // a new timeline item
```

Clients can apply them directly. `task.revision` and `item.seq` are monotonic. Every v0.4
lifecycle change (seen, mark-unread, reopen, queue edits and holds, limits, generated titles,
renames) is a `task.updated` frame, because the queue, the limit and the seen state ride on the
task row; queued runs and their removal are `task.run.updated` frames. After a
reconnect, refetch `GET /api/tasks/:id` and page items with `afterSeq=<last seen seq>`.
`action.updated` carries an `ActionRecord` after a pending draft is saved (without an
approval or execution). Other `agent.run.*` and `action.*` events continue as before.

## Scheduler

- `JobDefinition.taskId` / `JobState.taskId` bind a job to its routine task, and
  `SchedulerOptions.runOnTask` wraps those runs.
- Job functions pass `ctx.agentRunOptions` to `AgentRuntime.run`.
- User routines choose `runOn: "bound" | "fresh"`; fresh runs create a child task. Webhook
  deliveries use the same schedule-run seam with a framed `ctx.webhookPrompt`, and their
  durable queue owns payload recovery. See [scheduler](scheduler.md#webhook-routines).
- `tasks.maintenance` (every 10 minutes) handles snooze wake-ups, auto-settle, watch expiry,
  due `resume-at-reset` continuations (the durable backstop for their timers) and
  the 24-hour `mail_export` sweep (`<dataDir>/scratch`, also swept at startup). See
  [scheduler](scheduler.md).

## UI

The web UI (`apps/web/src/tasks`, `views/Task.tsx`) is built on this contract:

- **Sidebar.** Pinned, Inbox, Working, Snoozed and Settled (folded), each ordered by
  `returnedAt` (`lastActivityAt` on rows written before v0.4; Snoozed by wake time). Inbox, then working and snoozed, then pinned settled
  tasks are fetched in full, following `nextCursor`; unpinned settled tasks page in 50 at a time
  when the fold opens ("Show more"). A row is one 36 px line: the status mark, the title, an
  Inbox or Routine word, and the pending approval count or the time it came back. The title
  recedes (muted) unless the task needs the person (`needsUser`) or has an unseen outcome
  (`unseenOutcome`, the Done and Woke marks), the server's rule. Its menu pins, marks unread
  (offered when nothing is unseen; `/mark-unread`), snoozes until a preset or a chosen time,
  settles or archives. These changes apply at once and roll back if the server refuses; frames
  arriving meanwhile keep the guess on top. Every one of them toasts with Undo for five seconds,
  also on ⌘Z: pin and unpin reverse each other, mark unread reverses through `/seen`, and settle,
  snooze and archive through `/unsettle`, `/unsnooze` and `/unarchive`, after which the
  `previous` state they answered with is put back (a snooze they replaced is snoozed again while
  its time is ahead, a settle that archive replaced is settled again). A server that answers
  without `previous` gets no Undo. `j`/`k` move between rows (anywhere but the Needs you queue, which keeps its own),
  Enter opens, ⌘1–⌘9 open the first nine tasks of Pinned, Inbox, Working and Snoozed (Settled
  never takes a number), and ⌘K finds tasks.
- **Status marks.** One set (`tasks/TaskGlyph.tsx`, state from `taskState` in `tasks/model.ts`)
  is used by the sidebar, the task header, Needs you and the task list, with the T3 badge words:
  Approval (`needsUser: "approval"`), Input (`"question"`), Waiting (watching a conversation),
  Working (a run is active, or `working` without watches), Limited, Failed (`"failure"`), Woke
  and Done. The state is `taskBadge` from `@passport/types` (so its priority order), with a
  `working` task without watches counted as running and `limited` without `needsUser` read as
  Limited. Woke and Done read `unseenOutcome`.
- **Task view** (`/tasks/:id`). The timeline opens at its newest items: the first page answers
  short tasks; for longer ones the last `seq` is found with one-item `afterSeq` probes (doubling,
  then halving) and the last page is fetched. Older pages load when the top scrolls into view.
  `task.item.appended` extends it; on a gap or a reconnect the client pages forward from the last
  contiguous `seq`. Each run gets a header with its trigger, status and change summary. The
  summary's records (`/api/actions?runId=`) load when it is opened, once per run; `action.*`
  frames patch records in place. Consecutive `tool_call` items of a run collapse into one line
  that names at most two categories, writes first ("Archived 40, read 4 messages and 1 other
  step"). Proposals read "asked to", plan mode "planned to", and failed calls are counted apart.
  Messages use the safe Markdown subset or text. A `render` item displays server-sanitised
  HTML in an opaque `<iframe sandbox="">`, with theme variables, fluid width, a bounded
  content-derived height and Open full size. Rich output is a document block without a card.
  A `RESTARTED` notice
  is a calm block, "Picked up after a restart", with the server's text (what was interrupted,
  what it still watches) beneath; `USAGE_LIMITED` notices read amber, other error codes red.
- **Header.** The title renames in place: click it, Enter saves (`PATCH { title }`), Escape
  keeps it. A title the fast model proposed (`titleGenerated`) reads muted until renamed;
  saving it unchanged accepts it. Opening the page marks the task seen (`POST /seen`) when it
  has an unseen outcome or came back after the last look, and again when it comes back while the
  page is visible; Mark unread while the page is open holds until it closes. A Limited task
  shows the reset time ("Resets today at 3:40 PM", or that it is unknown) and Resume (`/resume`),
  Resume at reset (`/resume-at-reset`, offered while the reset is ahead; afterwards "Resumes on
  its own …") and Snooze until reset (the ordinary snooze, with its Undo). Without a reset time
  only Resume is offered.
- **Approvals.** A pending `approval_request` (in `pendingActionIds`, or with a `proposed`
  record) is the queue's decision card: Approve, Approve for this task, Always (`scope` `once`,
  `task`, `always` on `/approve`), edit a draft, reject. Approve is never offered before the
  ActionRecord is on screen (type, "Sends"/"Can't undo", draft): until `/decisions` answers the
  buttons are disabled with "Loading…", and if it fails the row offers Retry and Needs you
  instead. The composer's approval panel lists every pending action with its type, badge and
  draft recipients, and approves all the reversible ones in one click (`once`). A decision's
  busy state is shared by every control for that action; decided actions leave the panel at
  once. **Review draft** opens a side-by-side conversation and editable body from both a
  timeline approval and Needs you (also its context panel). Save uses the existing approval
  edit validator through the pending-draft route and leaves approval pending; Approve keeps
  the executor path. The **As they will see it** toggle previews the draft and quoted history
  through the shared server sanitiser and sandbox.
- **Composer.** Enter sends in the default mode (`"queue"`) and ⌘Enter in the opposite one
  (`"steer"`); without an active run both queue. Stop calls
  `/interrupt`. Above it, the **queue strip** lists `task.queue` as rows in run order: click a
  row's text to edit it in place (Enter saves through `PATCH …/queue/:runId`, Escape keeps it),
  drag a row or press Alt+↑/↓ on it to reorder (`POST …/queue/reorder` with the full order,
  shown at once), "Steer now" (or "Send now" without a live run) promotes it
  (`…/promote-to-steer`), and × removes it. A refused change (`404`, `409 QUEUE_CHANGED`)
  reloads the queue and says so. After Stop the strip reads "Queue held · Resume"
  (`POST …/queue/resume`). Stop and steer are only offered while a run is active on a `kind: "task"` task;
  messages to inbox and routine tasks queue. The permission picker and the Plan toggle `PATCH`
  the task, and the composer says when the server returned a lower mode than the one asked for.
- **New task** (`/`). The home composer calls `POST /api/tasks` and opens the task. The opened
  message (Needs you) and matter (matter page) are context chips, sent as `emailIds` and
  `matterId`; their subjects and titles never enter the person's message. A server that rejects
  those fields (400) gets the plain ids appended to the message instead. Suggestion chips fill
  the composer; Enter starts the task. The v0.2 queue lives on as **Needs you** (`/needs-you`),
  under the tasks waiting on the person; its badge counts tasks in the account scope. Those
  tasks are grouped by what they wait on, in the order of `views/needs-you-groups.ts`:
  Approvals, Paused at a usage limit (with the reset time and the three recovery actions under
  each row), Failed. A task no group claims (today a private-input `question`) shows under
  "Waiting on you". A new group is one entry in that list (or `registerNeedsYouGroup(group,
  before)`); nothing else changes.
- **Deep links.** `?decision=<actionId>` asks `GET /api/tasks/by-action/:id` and opens
  `/tasks/:id?approval=<actionId>`. When that fails (unknown action, older server) it searches the
  loaded tasks' `pendingActionIds`, then falls back to `/needs-you?decision=<actionId>`.
- **Refreshes.** The first `/ws` connect does not refetch; a reconnect refetches the open views
  and asks every working or seemingly running task for its runs again, so a run that ended
  offline stops showing as running. Window focus refetches only data older than 30 seconds.
- **Keyboard.** Escape outside a text field or dialog closes the details panel (or the overlay
  sidebar on a narrow window); dialogs and popovers close themselves first. ⌘. toggles the
  details panel, ⌘B the sidebar, ⌘, settings, and `/` focuses the composer.
- **Questions and subtasks (v0.4).** Open questions sit above the composer: the question as
  markdown, its options as buttons (each answers with that text) and Dismiss; typing in the
  composer answers them all. Task details show a **Lineage** panel (the parent, or the
  children with their status). The timeline ends with one collapsed line, "Started 3
  subtasks, 2 working", that opens to the list. Subtasks stay out of the sidebar until they
  need the person (`needsUser` set). Needs you shows questions in their own group, "Questions
  for you", with the question text.
- On the demo backend (`501 TASKS_UNAVAILABLE`) the sidebar and home say tasks need
  `passport serve`, and the composer runs the agent once (`POST /api/agent/run`) and shows the
  outcome inline.

### Known limitations (review R5)

- **R5-2:** there is no batched action route (`/api/actions?taskId=` or several `runId`s), so a
  collapsed run header shows "N changes" until it is opened, and each opened run costs one
  request.
- **R5-5:** finding the newest page costs about 2·log₂(items/100) one-item probes, because the
  task carries no last `seq` and the items route has no `beforeSeq`. Loaded items are not
  windowed; scrolling far back keeps every page in memory.
- Archiving a system task is not confirmed. (R5-9, Undo for settle, snooze and archive, is
  resolved: see Sidebar above.)
- **Undo** covers the latest sidebar action only, while its toast shows. Reopening does not bring
  back the watches settle or archive ended, nor release a queue they held (the strip offers
  Resume).
- **Queue strip:** reordering by drag uses HTML5 drag and drop, which touch screens do not
  fire; Alt+↑/↓ on a focused row is the keyboard path. A reorder racing a starting entry answers
  `409` and the strip reloads.
- **Seen:** the page marks a task seen when it opens or the window becomes visible, not when the
  person scrolls to the news; another open tab does not learn about a Mark unread made here
  until the frame arrives.
- **Generated titles** are muted in the task header only; sidebar rows and the palette show them
  like any title.
- **⌘1–⌘9 in a browser tab:** Chrome and Safari keep ⌘1–⌘9 for switching tabs, so the
  shortcut reaches Passport in the Mac app and with Ctrl on other systems, not in a Mac browser
  tab.
- **Command palette:** while searching, results are ranked across groups, so a group heading can
  repeat (Tasks, Matters, Tasks).
- **R5-15:** a decision card on Needs you and the same action in an open task share busy state
  only within one tab.
- **R5-18:** the clamp notice always names the account ladder, even when a parent task caused
  the clamp, and it comes back on reload because it rides in history state.
- **Approve scope:** a server without `scope` on `/approve` ignores it and approves once; the
  UI cannot tell, so "Approve for this task" and "Always" then act like Approve.

## Not yet

- Staged changes, the worktree analogue, are not implemented. Approval stays per action.
- Approval scopes apply to later proposals only: approving with `task` does not approve the
  task's other proposals that are already pending. The proposing tool call returns `proposed`
  even when a grant approves it a moment later; the run's change summary shows the outcome.

## Known limitations (W2A questions and subtasks)

- `mode: "wait"` does not block the tool call: the agent lane runs one run at a time, so a
  parent waiting inside its run would starve its child. The parent ends its turn and wakes with
  the result instead.
- A subtask wake's prompt quotes the completion that started it; completions that joined it
  are read through `task_status` (and, on a resumed session, the "since your last turn" list).
- The subtasks line sits at the end of the timeline rather than where the subtasks were
  started, and the Lineage request is not shared between the panel and the line.
- Subtasks are not hidden from the ⌘K palette, and their pages are not read-only: the person
  can message a subtask directly (T3 points to the parent instead).
- Answering or dismissing the last question clears `needsUser` even while a `request_secret`
  request is open in the same task (secret requests are not listed on the task row); the
  secret card still works, but the task no longer shows Input for it.
- Coalescing relies on the single agent lane; a future parallel lane would need an explicit
  wake generation.
- Settling, archiving or stopping a parent does not stop its subtasks; they finish and leave a
  notification without waking it. Use `task_cancel` (the agent) or open the subtask.

## Known limitations (W1A sessions)

- Session transcripts are kept by the CLI in its own data directory (`~/.claude/projects/…`,
  `~/.codex/sessions/…`), keyed by the `<data-dir>/host-agent` working directory, so resume
  works. They contain tool results, that is mail content. Passport does not delete them; a
  task that is settled or archived does not remove its session.
- A cancelled session is killed rather than drained: a tool call already running in the server
  completes and is recorded, but the model never sees its result. The next run's resume turn
  lists proposals, not every read.
- `llmCalls` counts sessions (one per run, two when a failed resume fell back), not model turns
  inside a session. Claude Code reports a list-price cost that Passport ignores; usage has no
  cost for subscriptions.
- Session triage parity is fixture-based; live model judgments and draft wording are not asserted.
  The structured arrival pipeline remains available for one release (see the migration notes above).

## Known limitations (review R4)

- **R4-8:** there is no separate cap on wakes per watch per day; the loop guard above is the only
  bound. A long, genuinely human back-and-forth that the agent answers with unattended sends
  stops after three exchanges and hands back.
- **R4-23:** replies sent from a send-as alias that is neither an account address nor a
  verified-self person and that the provider files outside Sent can still wake the task (they
  are classified `reply`, so the loop guard applies).
- **R4-29:** `passport sync` in client mode runs its own forced watcher tick next to the server's.
  Arrival dedupe prevents double triage; the cost is duplicate provider reads.
- **R4-32:** explicit triage of an uncached handle caches the provider row without normalising
  it first (`personIds`, `category` and `matterId` fill in on the next read).

## Known limitations (v0.4 lifecycle, server side)

- Queued messages are not on the timeline until they start; the web UI shows them in the queue
  strip above the composer (and as queued runs in task details).
- Limits are detected on task message, watch and wake runs. Routine (`schedule`) runs and
  arrival triage report a limit as an ordinary failure (`JOB_FAILED`, or an arrival retry).
  A limit message without a parsable reset time leaves `resetAt: null`, so only `/resume` and a
  manual snooze are offered.
- Continuations (restart and limit resume) build a fresh prompt from the request or the
  notification that started the run; they do not replay the interrupted run's tool results.
- Reopen does not restore watches that settle or archive ended, nor the snooze that settle
  replaced (follow with `/snooze`). A held queue stays held after reopening.
- A message that was leaving the queue at the exact moment of a crash (after it left
  `Task.queue`, before its run started) is lost; its run ends `failed` (`SERVER_RESTARTED`).
- Title generation runs outside the agent lane, so on a host CLI it can start a second CLI
  process next to an active run.

## Known limitations (W2D rich output and review)

- Opaque sandboxes cannot measure their own height without scripts; the tool estimates within
  80–1200 px, with scrolling and a full-size dialog for long output.
- Draft preview uses the loaded conversation text as quoted history and omits attachments and
  remote assets. It approximates what a recipient reads; client-specific mail layout is not
  reproduced. The 64 KiB preview limit reports oversized content instead of truncating it.
- Review edits only the text body. Saving clears stale HTML and leaves recipients, subject,
  policy and approval status unchanged. Existing one-click approval and edit-and-approve stay.
