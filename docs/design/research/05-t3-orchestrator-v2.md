# 05 — T3 Code Orchestrator V2: feature inventory for v0.4

Researched 2026-10-24 against `pingdotgg/t3code` at `d14ace8` (2026-10-23). Sources:
`docs/orchestration-v2/*.md`, `packages/contracts/src/orchestrationV2.ts` (the wire contract),
`packages/contracts/src/orchestratorMcp.ts`, `packages/contracts/src/scheduledTask.ts`,
`apps/server/src/orchestration-v2/*`, `apps/server/src/mcp/toolkits/*`, `docs/user/*.md`, and the
live `mcp__t3-code__*` tool schemas. Release notes: v0.0.46-nightly (2026-10-03, first V2 build),
v0.1.0 (2026-10-15, "Orchestrator V2 is now stable"), v0.1.2 (2026-10-22).

Vocabulary: T3 thread = Passport task; T3 run = one agent pass; T3 delegated task = subtask;
T3 pending request = approval or question; T3 Working section versus inbox = Passport Working
versus Needs you.

## Architecture

```
command -> Orchestrator (pure decision, no I/O) -> domain events + projections + command receipt + outbox effects
        committed in ONE SQLite transaction (EventSink)
EffectWorker -> runs provider side effects after commit -> feeds results back as commands
```

Every stored event has a monotonic `sequence`; clients subscribe with snapshot plus cursor.
Invariants worth copying: app ids are primary and provider ids are references; child execution
completion never closes the parent run; provider switches create explicit handoff artifacts;
tests prefer replay-backed integration fixtures over mocks.

## Data model

```
Project
  AppThread                      (the task)
    Run (ordinal N)              (one user-visible turn)
      RunAttempt[]               (steering restart = new attempt under the same Run)
      ExecutionNode tree         (root_turn, assistant_message, reasoning, plan, todo_list,
                                  tool_call, approval_request, user_input_request, subagent, hook, system)
    ProviderThread handles
    ContextTransfer / ContextHandoff
    Checkpoints
```

Enums: run status `preparing | queued | starting | running | waiting | completed | interrupted |
failed | cancelled | rolled_back`; thread status is `idle` or the latest run's status; runtime
request status `pending | resolved | expired | cancelled` with kinds `command | file-read |
file-change | dynamic_tool_call | user_input | auth_refresh`; actor `user | agent | system`
separate from creation source (`mcp`, `provider`, `server`, …) so agent-authored user-role
messages are distinguishable from human ones.

Thread shell projection (the sidebar record): `status, latestRunId, activeRunId,
blockedOnThreadWait, lastError/Class/Code, usageLimitResetAt, pendingRuntimeRequest {id, kind,
createdAt, blocking}, latestVisibleMessage, latestUserMessageAt, latestUserAuthoredMessageAt,
hasActionableProposedPlan, pendingBackgroundTasks[], goal, lineage {parentThreadId,
relationshipToParent: fork|subagent, rootThreadId}, pullRequests[], settledAt, unsettledAt,
snoozedUntil, limitRecovery {runId, resetAt, autoResume, snooze}, pinnedAt, pinOrderKey,
activeOrderKey, autoSettleDisabledAt, lastVisitedAt, titleRegeneration, createdBy, creationSource`.

## Primitives

### Delegated tasks

`delegate_task({ task, target, title?, role, mode: async|wait, timeoutMs, isolation,
runtimeMode: inherit|lower, interactionMode, clientRequestId })` returns `taskId, childThreadId,
childRunId, status, workState: working | waiting_for_children | result_available,
hasPendingChildRuns, summary, hasPendingQuestion, pendingApproval, waitTimedOut`.

- `completionWake`: `settled_only` (default: no wake while the parent has a live run) or
  `always`. Completions are batched per generation so one wake covers several children.
- Delivery: a `message.dispatch` with `createdBy: "agent"`, `creationSource: "server"`, a
  `notification { source: { kind: "delegated_task", taskIds }, outcome, summary }`, steered
  into an active turn where supported, queued otherwise. At-least-once; message id dedupes.
- A child's pending `user_input` is forwarded to the parent as a message that says how to read
  and answer it; approvals are not forwarded and agents cannot approve their own requests.
- `task_cancel` stops the child like a user Stop and stops grandchildren depth-first after
  commit, because a command holds only its own thread's lock.
- Child threads are read-only in the UI ("Message the parent thread instead"), hidden from
  `⌘K` by default, shown in a lineage view with provider, model, elapsed, and "open parent".

### Queue and steer

Modes `auto | queue | steer | restart`; internal dispatch `defer_start | steer_active |
restart_active | queue_after_active | start_immediately`. If the provider cannot steer natively,
the app interrupts and starts a new `RunAttempt(reason: steering_restart)` under the same run.
Queue entries are runs in `queued`; the queue survives restarts and limits, and is **held** after
Stop until `queue.resume` or a new message. Tools: `t3_queue_list/read/edit/reorder/cancel/
promote_to_steer`. UI: queued rows above the composer with drag, pencil, promote, remove;
`⌘Enter` does the opposite of the default mode for one message; `⌘Shift+Enter` sends the oldest
queued message as a steer; `Option+Up` edits the newest queued message.

### Pending requests

`RuntimeRequest { kind, status, blocking, responseCapability: live | message | not_resumable,
decision?, feedback?, answers? }`. Questions can be answered by agents through
`t3_pending_request_respond`; approvals only by the person. The composer stays usable during an
approval: sending declines and redirects. Sidebar priority: approval > input > waiting (thread
wait) > working > waiting (idle) > limited/failed > ready. Pending requests block auto-settle; a
snoozed thread wakes early only for a request or a failure.

### Scheduled tasks

`ScheduledTask { id, title, prompt, enabled, schedule, projectId, threadId | null,
workspaceStrategy, modelSelection, runtimeMode, interactionMode, createdBy, nextRunAt,
lastRunAt, lastRunStatus: never|running|succeeded|failed, lastRunError, runCount, webhook? }`.

Schedules: `interval { everyMs ≥ 60000 }`, `fixed_time { timeOfDay, weekdays? }`, `webhook {
signature? { header, encoding: hex|base64, prefix, secretRef }, maxDeliveryAgeMinutes ≤ 1440,
dedupe { replayKey (7 days), coalesceKey, coalesceWindowSeconds 10–3600 default 120 },
filters[≤16] { path: body.*|headers.*|query.* with [] fan-out, op: equals|notEquals|startsWith|
in|exists } }`. Prompt templating `{{body.x}}`, `{{headers.x}}`, `{{query.x}}`, `{{body}}`,
`{{request}}`, framed as untrusted. Delivery log outcomes: `accepted | dispatch_failed |
duplicate | coalesced | rejected_signature | disabled | rate_limited | expired | filtered`.
`bindToCurrentThread` posts each run into the bound thread (queued behind active work) or
launches a fresh thread per run. Overlap guard: a running task skips the tick. Missed
`fixed_time` runs are skipped, not back-filled. UI: Settings → Scheduled tasks and a per-thread
Automations panel.

### Secrets

`request_secret` shows a private card; the value is stored server-side under a one-use
`SecretRef` and never returned to the model; statuses `saved | declined | timed_out | cancelled`;
`clientRequestId` reuse shows one card on retry.

### Watches

`watch_pull_request`: a server-owned reactor polls every two minutes and wakes the thread on
checks failed, required checks passed, someone else's comment or review, no checks after 15
minutes, or conflict. Ends on merge, close, 10 comment-only wakes in a row, 8 failed reads, Stop,
settle or archive. The wake is a notification message with source `monitor`. "While T3 Code
watches, the thread stays in the user's Working list, not their inbox. When you hand the work
back, call unwatch first so the thread returns to their inbox." Passport's
`watch_conversation` already mirrors this.

### Rich output

`html_preview { html, width, appearance }` returns a PNG, content height and console output;
`html_render { html, title, height }` shows the page inline above the final reply, themed with
injected CSS variables, `vh` rejected, fluid width, no outer card. The user can tap to full
screen and send notes back with the next message.

### Working versus inbox

`isThreadWorking` is false when there is a pending approval, pending input or a child's pending
request, false when the runtime is inactive, false when a plan-mode thread has an actionable
plan; otherwise true while the latest run is `preparing | queued | starting | running |
waiting`. The active list is ordered by when each thread last came back to you (created,
unsettled, run requested or completed, observed return); a tracker records the moment a thread
goes from working to not working. Badges: Goal, Working, Waiting, Approval, Input, Limited,
Failed, Woke (the thread woke itself and you have not visited since), Done (unseen completion).
Rows recede when nothing is new. Sections `pinned | active | working | snoozed | settled`; drag
between sections; server-persisted order; five-second undo with `⌘Z`.

### Limits and restarts

A thread stopped by a subscription limit shows Limited with the reset time and offers Resume,
Resume at reset (a scheduled continuation) and Snooze until reset; queued messages are held and
run after the continuation. After a server restart, `run.background-work-cancelled` lists what
died (subagents, shells, monitors) and the thread continues with that note instead of failing.

### Goals, usage, options

`/goal <definition of done>` keeps the agent working across turns with status `active | paused |
blocked | usage_limited | budget_limited | complete`. Per-turn token usage drives a context meter;
a Usage page aggregates provider logs. Model options are descriptor-driven (`effort`, `fastMode`
for Claude; `reasoningEffort`, `serviceTier` for Codex).

### Hosting the CLIs

Claude runs through the Claude Agent SDK with the T3 MCP server injected and
`allowedTools: mcp__t3-code__*`; Codex runs through `codex app-server` JSON-RPC with
`mcp_servers.t3-code.url` and a bearer in an environment variable. Each provider session gets a
scoped, expiring MCP credential. Outside agents connect over MCP with OAuth and a pairing code and
inherit an approved mode ceiling. A `t3 thread start | send --wait | show | list` CLI exists;
exit code 2 means the agent is waiting for an answer in the app.

## Not found

No RFC outside the repo; no separate queue-entry entity; no T3-authored workflow engine (it only
projects Claude Code's Workflow tool); no per-thread dollar cost in projections; no cron
expressions.
