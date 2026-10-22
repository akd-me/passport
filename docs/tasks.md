# Tasks

A **task** is the unit of agent work in Passport v0.3, the email analogue of a T3 Code thread:
a durable conversation with **runs** (one agent pass each), a timeline of **items** (messages,
tool calls, approvals, notices), and a server-owned lifecycle. Design: `docs/design/on-demand.md`
§3 and §4.3. Types: `packages/types/src/tasks.ts` (re-exported from `@passport/types`).

Vocabulary: "task" is agent work, "conversation" is an email thread, "matter" is unchanged.

## Model

| Type | Fields |
|---|---|
| `Task` | `id`, `title`, `accountIds`, `status` (`inbox` / `working` / `snoozed` / `settled` / `archived`), `pinned`, `snoozedUntil?`, `permissionMode` (`supervised` / `auto_accept_edits` / `auto` / `full_access`), `permissionModePinned?`, `interactionMode` (`default` / `plan`), `createdBy` (`user` / `agent` / `system`), `kind` (`task` / `inbox` / `routine`), `parentTaskId?`, `needsUser` (`null` / `approval` / `question` / `failure`), `pendingActionIds?`, `lastActivityAt`, `createdAt`, `settledAt?`, `watches: ConversationWatch[]`, `jobId?` (routine), `revision?` |
| `ConversationWatch` | `threadHandle`, `account`, `since`, `lastWakeAt?`, `consecutiveWakes` |
| `TaskRun` | `id`, `taskId`, `status` (`queued` / `running` / `waiting` / `completed` / `failed` / `cancelled`), `trigger`, `priority` (`interactive` / `background`), `agentRunId`, `createdAt`, `startedAt?`, `endedAt?`, `summary?`, `actionIds`, `usage?` (`llmCalls`, `toolCalls`, `inputTokens`, `outputTokens`), `error?` (a stable code) |
| `TaskRunTrigger` | `{ kind: "message", itemId, mode }` · `{ kind: "arrival", emailId }` · `{ kind: "schedule", jobId, name }` · `{ kind: "watch", threadHandle, emailId }` · `{ kind: "wake", reason }` |
| `TaskItem` | `id`, `runId` (null for lifecycle notices), `taskId`, `seq` (per task, from 1), `kind`, `at`, `payload`, `untrusted?` |

Item payloads by `kind`:

| kind | payload |
|---|---|
| `user_message` | `{ text }` |
| `assistant_message` | `{ text }` (model output; `untrusted: true` because it may quote mail) |
| `tool_call` | `{ name, inputSummary, resultSummary, cost?, durationMs, isError, planned? }`; summaries are redacted (bodies, secrets, token-shaped strings) and at most 200 characters |
| `approval_request` | `{ actionId, summary }`; approve or reject with `/api/actions/:id/{approve,reject}` |
| `question` | `{ text }` (reserved: nothing emits it yet) |
| `system_notice` | `{ text, code? }`: `RUN_CANCELLED`, `RUN_FAILED` or another run error code, `RETRY`, `WATCH_LOOP_GUARD` |
| `notification` | `{ source: "arrival" \| "watch" \| "schedule" \| "system", summary, row? }`; `row` is a `MailRow` |

**Untrusted data.** Items with `untrusted: true` contain provider-derived strings (subjects,
senders, snippets, tool arguments and results, model text). Their `$`, mention-style `@` and
line-leading `/` carry an invisible U+200B so host agents never treat them as commands. Render
them as plain text, never as HTML or markdown links that auto-load.

**`waiting`** is reserved. Passport runs never block on an approval: a proposal becomes an
`approval_request` item, and the run carries on and completes.

## Kinds

- **`task`**: started from the composer (`POST /api/tasks`, or `/api/agent/run` for the v0.2
  composer). Title: the `title` field or the first 60 characters of the message.
- **`inbox`**: one per mail account, created by the system on the first arrival. Every triage
  run of a new message is recorded on it. Each one starts with a `notification` item carrying
  the arrival's `MailRow`, and a retry starts with a `RETRY` notice. Its run's `agentRunId` is
  `arrival:<emailId>`.
- **`routine`**: one per model-backed scheduler job (`agent.daily_digest`,
  `agent.matter_review`, every user routine). The job's `taskId` points at it, and each job run
  is a `schedule` run on it.

System tasks (`inbox`, `routine`) follow the global trust dial: before each run their
`permissionMode` is refreshed to the dial, unless the person set one with `PATCH`
(`permissionModePinned`).

## Runs

- **Lanes.** User messages run in the interactive lane. Arrivals, routines and watch wakes run
  in the background lane. An interactive run starts before any waiting background run, and
  nothing preempts the run in progress.
- **Queue vs steer.** `mode: "queue"` (the default) adds a run after the active one.
  `mode: "steer"` cancels the task's active message runs and starts one new run whose prompt
  holds both the cancelled message and the new one. A queued run leaves the lane immediately.
  A running one stops at its next model or tool call, and the answer of an in-flight model call
  is discarded. Arrival and routine runs can't be cancelled. Steering a system task queues.
- **Interrupt** cancels every cancellable run of the task. Each one ends `cancelled` with a
  `RUN_CANCELLED` notice.
- **Context.** Each message run's prompt includes the task title, up to 16 recent
  user/assistant/notification items (6,000 characters, wrapped as untrusted data), and the
  request.
- **Plan mode** (`interactionMode: "plan"`). Write tools don't execute. They return
  `{ status: "planned" }`, appear as `tool_call` items with `planned: true`, and the model is asked
  for a numbered proposal list.
- **Change summary.** `run.actionIds` lists every ActionRecord whose `request.runId` equals the
  run's `agentRunId`. Fetch `/api/actions?runId=<agentRunId>` for the records and their undo.
- **Permission clamp.** A task's mode is clamped to the global trust dial at creation and on
  `PATCH`, and a child task's mode to its parent's. During a run, the policy engine also caps
  every action of that run at the task's effective mode (the minimum over the parent chain). It
  can only lower the level the trust ladder would give.
- **Restart.** Runs left `queued` or `running` by a previous process are marked `failed`
  (`SERVER_RESTARTED`). An interrupted message run surfaces the task with `needsUser: "failure"`.

## Status rules

While a run is active the task is `working`. Two exceptions: snoozed and archived tasks stay
hidden, and an inbox task already waiting on the person stays in the inbox. A user message also
un-snoozes and un-settles the task and clears a previous failure.

A proposal surfaces the task as soon as it appears: `status: "inbox"`,
`needsUser: "approval"`, and the action id is added to `pendingActionIds`. Deciding the action
anywhere removes it from the list, and `needsUser` clears once the list is empty.

When a run ends, the first matching rule applies:

1. Failed (not arrivals, which `ArrivalQueue` retries): `inbox` with `needsUser: "failure"`.
2. Pending approvals: `inbox` with `needsUser: "approval"`.
3. Another run of the task is still active: `working`.
4. A run started by the person's message: `inbox`, or `working` while it watches a conversation.
5. Snoozed and archived tasks stay where they are through background work.
6. Schedule, watch and wake runs that produced something (ActionRecords or assistant text):
   `inbox` (`working` while watching). Runs that produced nothing go back to where the task was.
7. Arrival triage never moves the task by itself, only through rules 1–2.

`lastActivityAt` ("when it last came back to you") moves only when the task surfaces or the
person acts. Background no-op runs don't count, so auto-settle is not reset by them.

Lifecycle:

- **Snooze** hides the task until `snoozedUntil`. The `tasks.maintenance` job (every 10 minutes)
  returns it to `inbox` when that time passes. An approval, a failure or a user message brings it
  back sooner.
- **Settle** and **archive** end every conversation watch.
- **Auto-settle.** Tasks in `inbox` that are idle for 3 days, not pinned, and with no
  `needsUser` move to `settled`.
- The 5-second undo after settle, snooze or archive is a UI concern: undo with the matching
  opposite call.

## Conversation watches

`watch_conversation({ threadHandle, account? })` and `unwatch_conversation({ threadHandle? })`
are registry tools, available to the built-in agent and over MCP. The task comes from the
trusted call context (`ToolContext.taskId`). Calls without one, such as from external MCP
clients, return `TASK_REQUIRED`. Each task keeps at most 20 watches.

While a task watches, it rests in `working`. After each tick, the new-mail watcher reports every
added message. A message on a watched thread wakes the task when all of these hold:

- it was received strictly after the watch's `since`;
- it is not from the person (the account's addresses or verified-self people);
- its Message-ID (or its id) was not seen for this task in the last 7 days (replay key).

Replies on one thread within 120 seconds coalesce into one wake that uses the latest message.
A wake appends a `notification` (`source: "watch"`, `row`) and starts a background `watch` run.
The wake is classified from headers first (`Auto-Submitted`, `X-Autoreply`, `Precedence`),
then from sender and subject:

- `bounce`: from `mailer-daemon@` or `postmaster@`, or a delivery-failure subject.
- `auto_reply`: an automatic header, or an "Automatic reply" or "Out of office" subject.
- `reply`: anything else.

**Loop guard.** Auto-replies count toward a limit, and so do wakes whose run created no
ActionRecords. A real reply resets the count. At 3 the watch stops, with a `WATCH_LOOP_GUARD`
notice, and the task returns to the inbox.

**Expiry.** A watch older than 14 days ends with one `wake` run (`reason: "watch_expired"`) so
the agent can follow up or hand back.

## HTTP API

Every route requires the bearer token. Errors use the standard body
`{ "error": { "code", "message" } }`. On the demo backend every task route answers
`501 TASKS_UNAVAILABLE`.

| Method and path | Body / query | Response |
|---|---|---|
| `GET /api/tasks` | `status=inbox,working` (comma list), `kind=task,inbox,routine`, `pinned=true\|false`, `limit` (1–500, default 50), `cursor` | `Page<Task>`: `{ items, total, nextCursor }`, ordered by `lastActivityAt` desc |
| `POST /api/tasks` | `{ message, title?, accountIds?, permissionMode?, interactionMode?, parentTaskId? }` | `201 { task, run }` (the first run, `queued`) |
| `GET /api/tasks/:id` | | `TaskDetail`: `{ task, runs }` (runs newest first, at most 50) |
| `GET /api/tasks/:id/items` | `afterSeq` (default 0), `limit` (default 100) | `{ items, lastSeq }` (ascending `seq`) |
| `POST /api/tasks/:id/messages` | `{ text, mode?: "queue" \| "steer" }` | `202 { task, run }` |
| `POST /api/tasks/:id/interrupt` | | `Task` |
| `POST /api/tasks/:id/snooze` | `{ until }` (future ISO time) | `Task` |
| `POST /api/tasks/:id/settle` | | `Task` |
| `POST /api/tasks/:id/archive` | | `Task` |
| `POST /api/tasks/:id/pin` · `/unpin` | | `Task` |
| `POST /api/tasks/:id/unwatch` | `{ threadHandle? }` (omit to stop every watch) | `Task` |
| `PATCH /api/tasks/:id` | `{ title?, permissionMode?, interactionMode? }` | `Task` (mode clamped) |
| `POST /api/actions/:id/approve` · `/reject` | unchanged | `ActionRecord`; the task's `pendingActionIds` and `needsUser` follow |
| `POST /api/agent/run` | unchanged v0.2 body `{ instruction?, emailIds?, matterId? }` | the finished `AgentRun` plus `taskId`; a `kind: "task"` task is created per call |

Text limits: `message` and `text` are 1–20,000 characters, and `title` 1–200 (stored at most
60). Unknown body fields are rejected with `400 INVALID_FIELD`.

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

## WebSocket

`/ws` streams every `DomainEvent` as raw JSON. Task events:

```ts
{ type: "task.updated"; task: Task }            // any change to the task row (status, watches…)
{ type: "task.run.updated"; run: TaskRun }      // created, running, finished, actionIds linked
{ type: "task.item.appended"; item: TaskItem }  // a new timeline item
```

Clients can apply them directly. `task.revision` and `item.seq` are monotonic. After a
reconnect, refetch `GET /api/tasks/:id` and page items with `afterSeq=<last seen seq>`.
`agent.run.*` and `action.*` events continue as before.

## Scheduler

- `JobDefinition.taskId` / `JobState.taskId` bind a job to its routine task, and
  `SchedulerOptions.runOnTask` wraps those runs.
- Job functions pass `ctx.agentRunOptions` to `AgentRuntime.run`.
- `tasks.maintenance` (every 10 minutes) handles snooze wake-ups, auto-settle and watch expiry.
  See [scheduler](scheduler.md).

## UI

The web UI (`apps/web/src/tasks`, `views/Task.tsx`) is built on this contract:

- **Sidebar.** Pinned, Inbox, Working, Snoozed and Settled (folded), each ordered by
  `lastActivityAt`. A row shows the title, an Inbox or Routine badge, a status mark (running,
  watching, needs approval, failed), the pending approval count and the account dots. Its menu
  pins, snoozes until a preset or a chosen time, settles or archives. These changes apply at once
  and roll back if the server refuses. `j`/`k` move between rows, Enter opens, and ⌘K finds tasks.
- **Task view** (`/tasks/:id`). Items are paged with `afterSeq` and extended by
  `task.item.appended`. On a gap or a reconnect the client pages again from the last contiguous
  `seq`. Each run gets a header with its trigger, status and change summary (counts by action type
  from `/api/actions?runId=`, each record with its undo). Consecutive `tool_call` items of a run
  collapse into one line that names at most two categories, writes first ("Archived 40, read 4
  messages and 1 other step"). Proposals read "asked to", plan mode "planned to", and failed calls
  are counted apart. Every item is rendered as plain text, whether or not it is `untrusted`.
- **Approvals.** A pending `approval_request` is the queue's decision card (approve, edit a
  draft, reject). The composer's approval panel lists every `pendingActionIds` entry and approves
  all the reversible ones in one click.
- **Composer.** Enter sends with `mode: "queue"` and ⌘Enter with `"steer"`. Stop calls
  `/interrupt`. The permission picker and the Plan toggle `PATCH` the task, and the composer says
  when the server returned a lower mode than the one asked for.
- **New task** (`/`). The home composer calls `POST /api/tasks` and opens the task. Matter or
  message context is appended to the message, because the route accepts no `matterId` or
  `emailIds`. The v0.2 queue lives on as **Needs you** (`/needs-you`), under the tasks waiting on
  the person.
- **Deep links.** `?decision=<actionId>` opens the loaded task whose `pendingActionIds` holds the
  action (`/tasks/:id?approval=<actionId>`). When no loaded task holds it, it falls back to
  `/needs-you?decision=<actionId>`.
- On the demo backend (`501 TASKS_UNAVAILABLE`) the sidebar and home say tasks need
  `passport serve`.

## Not yet

- `question` items and `needsUser: "question"` are reserved. No tool asks the person yet.
- Staged changes, the worktree analogue, are not implemented. Approval stays per action.
- Approval choices "accept for this task" and "always" are not task-scoped yet. "Always" maps to
  the existing trust pin (`PUT /api/trust/:category/pin`).
- Child tasks: `parentTaskId` is honored for the permission clamp, but no tool spawns a child
  task yet.
