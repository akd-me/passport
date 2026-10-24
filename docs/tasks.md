# Tasks

A **task** is the unit of agent work in Passport v0.3, the email analogue of a T3 Code thread:
a durable conversation with **runs** (one agent pass each), a timeline of **items** (messages,
tool calls, approvals, notices), and a server-owned lifecycle. Design: `docs/design/on-demand.md`
§3 and §4.3. Types: `packages/types/src/tasks.ts` (re-exported from `@passport/types`).

Vocabulary: "task" is agent work, "conversation" is an email thread, "matter" is unchanged.

## Model

| Type | Fields |
|---|---|
| `Task` | `id`, `title`, `accountIds`, `status` (`inbox` / `working` / `snoozed` / `settled` / `archived`), `pinned`, `snoozedUntil?`, `permissionMode` (`supervised` / `auto_accept_edits` / `auto` / `full_access`), `permissionModePinned?`, `interactionMode` (`default` / `plan`), `createdBy` (`user` / `agent` / `system`), `kind` (`task` / `inbox` / `routine`), `parentTaskId?`, `needsUser` (`null` / `approval` / `question` / `failure`), `pendingActionIds?`, `lastActivityAt`, `createdAt`, `settledAt?`, `watches: ConversationWatch[]`, `jobId?` (routine), `revision?`, `approvalGrants?: TaskApprovalGrant[]` |
| `TaskApprovalGrant` | `category`, `actionId`, `trustLevel`, `risk`, `reversibility`, `grantedAt` (see [Approval scopes](#approval-scopes)) |
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
| `secret_request` | `{ requestId, text, expiresAt }`; private password field, never the value; see [request_secret](tools.md#private-secrets-v04) |
| `system_notice` | `{ text, code? }`: `RUN_CANCELLED`, `RUN_FAILED` or another run error code, `RETRY`, `WATCH_LOOP_GUARD`, `WATCH_EXPIRED`, `ARRIVALS_DROPPED` (inbox tasks), `APPROVAL_SCOPE`, `ALWAYS_UNAVAILABLE`, `TASK_APPROVED` (approval scopes; `TASK_APPROVED` is `untrusted`) |
| `notification` | `{ source: "arrival" \| "watch" \| "schedule" \| "system", summary, row? }`; `row` is a `MailRow`. A task created with `matterId` or `emailIds` gets a `system` one on its first run ("With matter “…” and 2 messages “…”, “…”"; `row` when there is exactly one message) |

**Untrusted data.** Items with `untrusted: true` contain provider-derived strings (subjects,
senders, snippets, tool arguments and results, model text). Their `$`, mention-style `@` and
line-leading `/` carry an invisible U+200B so host agents never treat them as commands (fullwidth
`＄`/`／`/`＠`, Unicode indentation and NEL included; an `@` inside `local@dotted.domain` is
kept). Render them as plain text, never as HTML. Passport's own `assistant_message` and
`question` text is rendered as a markdown subset (structure and emphasis only): no raw HTML, and
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
  composer). Title: the `title` field or the first 60 characters of the message.
- **`inbox`**: one per mail account, created by the system on the first arrival. Every triage
  run of a new message is recorded on it. Each one starts with a `notification` item carrying
  the arrival's `MailRow`, and a retry starts with a `RETRY` notice. Its run's `agentRunId` is
  `arrival:<emailId>`.
- **`routine`**: one per model-backed scheduler job (`agent.daily_digest`,
  `agent.matter_review`, every user routine). The job's `taskId` points at it, and each job run
  is a `schedule` run on it.

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
- **Queue vs steer.** `mode: "queue"` (the default) adds a run after the active one.
  `mode: "steer"` cancels the task's active message runs and starts one new run whose prompt
  holds both the cancelled message and the new one. A queued run leaves the lane immediately.
  A running one stops at its next model or tool call, and the answer of an in-flight model call
  is discarded. Arrival and routine runs can't be cancelled. Steering a system task queues.
- **Interrupt** cancels every cancellable run of the task. Each one ends `cancelled` with a
  `RUN_CANCELLED` notice. A run cancelled by a steer leaves the status to its replacement, so the
  task never bounces through the inbox.
- **Context.** Each message run's prompt includes the task title, up to 16 recent
  user/assistant/notification items (6,000 characters, wrapped as untrusted data), and the
  request.
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

0. The person settled, snoozed or archived the task while the run was active: it stays there. A
   failed run only sets `needsUser: "failure"`.
1. Failed (not arrivals, which `ArrivalQueue` retries): `inbox` with `needsUser: "failure"`.
2. Pending approvals: `inbox` with `needsUser: "approval"`.
3. Another run of the task is still active: `working`.
4. A run started by the person's message: `inbox`, or `working` while it watches a conversation.
5. Snoozed and archived tasks stay where they are through background work.
6. Schedule, watch and wake runs that produced something (ActionRecords or assistant text):
   `inbox` (`working` while watching). Runs that produced nothing go back to where the task was.
7. Arrival triage never moves the task by itself, only through rules 1–2.

`lastActivityAt` ("when it last came back to you") moves only when the task surfaces or the
person acts. Background no-op runs don't count, so auto-settle is not reset by them. A task that
rested in Working (watching) and is handed back to the inbox when a run ends counts as surfacing.

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
- The 5-second undo after settle, snooze or archive is a UI concern: undo with the matching
  opposite call.

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
| `GET /api/tasks` | `status=inbox,working` (comma list), `kind=task,inbox,routine`, `pinned=true\|false`, `limit` (1–500, default 50), `cursor` | `Page<Task>`: `{ items, total, nextCursor }`, ordered by `lastActivityAt` desc |
| `POST /api/tasks` | `{ message, title?, accountIds?, permissionMode?, interactionMode?, parentTaskId?, matterId?, emailIds? }` | `201 { task, run }` (the first run, `queued`) |
| `GET /api/tasks/by-action/:actionId` | | `TaskByAction`: `{ taskId, runId }`; `404 NOT_FOUND` when no task run holds the action |
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
| `POST /api/actions/:id/approve` | `{ request?, scope?: "once" \| "task" \| "always" }` | `ActionRecord`; with `task` or `always` also `approvalScope: ApprovalScopeResult` (`{ requested, applied, taskId?, pinnedLevel?, code? }`). The task's `pendingActionIds` and `needsUser` follow |
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

Clients can apply them directly. `task.revision` and `item.seq` are monotonic. After a
reconnect, refetch `GET /api/tasks/:id` and page items with `afterSeq=<last seen seq>`.
`agent.run.*` and `action.*` events continue as before.

## Scheduler

- `JobDefinition.taskId` / `JobState.taskId` bind a job to its routine task, and
  `SchedulerOptions.runOnTask` wraps those runs.
- Job functions pass `ctx.agentRunOptions` to `AgentRuntime.run`.
- User routines choose `runOn: "bound" | "fresh"`; fresh runs create a child task. Webhook
  deliveries use the same schedule-run seam with a framed `ctx.webhookPrompt`, and their
  durable queue owns payload recovery. See [scheduler](scheduler.md#webhook-routines).
- `tasks.maintenance` (every 10 minutes) handles snooze wake-ups, auto-settle, watch expiry and
  the 24-hour `mail_export` sweep (`<dataDir>/scratch`, also swept at startup). See
  [scheduler](scheduler.md).

## UI

The web UI (`apps/web/src/tasks`, `views/Task.tsx`) is built on this contract:

- **Sidebar.** Pinned, Inbox, Working, Snoozed and Settled (folded), each ordered by
  `lastActivityAt` (Snoozed by wake time). Inbox, then working and snoozed, then pinned settled
  tasks are fetched in full, following `nextCursor`; unpinned settled tasks page in 50 at a time
  when the fold opens ("Show more"). A row shows the title, an Inbox or Routine badge, a status
  mark (running, watching, needs approval, failed), the pending approval count and the account
  dots. Its menu pins, snoozes until a preset or a chosen time, settles or archives. These
  changes apply at once and roll back if the server refuses; frames arriving meanwhile keep the
  guess on top. Pin and unpin toasts offer Undo. `j`/`k` move between rows (anywhere but the
  Needs you queue, which keeps its own), Enter opens, and ⌘K finds tasks.
- **Task view** (`/tasks/:id`). The timeline opens at its newest items: the first page answers
  short tasks; for longer ones the last `seq` is found with one-item `afterSeq` probes (doubling,
  then halving) and the last page is fetched. Older pages load when the top scrolls into view.
  `task.item.appended` extends it; on a gap or a reconnect the client pages forward from the last
  contiguous `seq`. Each run gets a header with its trigger, status and change summary. The
  summary's records (`/api/actions?runId=`) load when it is opened, once per run; `action.*`
  frames patch records in place. Consecutive `tool_call` items of a run collapse into one line
  that names at most two categories, writes first ("Archived 40, read 4 messages and 1 other
  step"). Proposals read "asked to", plan mode "planned to", and failed calls are counted apart.
  Every item is rendered as plain text, whether or not it is `untrusted`.
- **Approvals.** A pending `approval_request` (in `pendingActionIds`, or with a `proposed`
  record) is the queue's decision card: Approve, Approve for this task, Always (`scope` `once`,
  `task`, `always` on `/approve`), edit a draft, reject. Approve is never offered before the
  ActionRecord is on screen (type, "Sends"/"Can't undo", draft): until `/decisions` answers the
  buttons are disabled with "Loading…", and if it fails the row offers Retry and Needs you
  instead. The composer's approval panel lists every pending action with its type, badge and
  draft recipients, and approves all the reversible ones in one click (`once`). A decision's
  busy state is shared by every control for that action; decided actions leave the panel at
  once.
- **Composer.** Enter sends with `mode: "queue"` and ⌘Enter with `"steer"`. Stop calls
  `/interrupt`. Stop and steer are only offered while a run is active on a `kind: "task"` task;
  messages to inbox and routine tasks queue. The permission picker and the Plan toggle `PATCH`
  the task, and the composer says when the server returned a lower mode than the one asked for.
- **New task** (`/`). The home composer calls `POST /api/tasks` and opens the task. The opened
  message (Needs you) and matter (matter page) are context chips, sent as `emailIds` and
  `matterId`; their subjects and titles never enter the person's message. A server that rejects
  those fields (400) gets the plain ids appended to the message instead. Suggestion chips fill
  the composer; Enter starts the task. The v0.2 queue lives on as **Needs you** (`/needs-you`),
  under the tasks waiting on the person; its badge counts tasks in the account scope.
- **Deep links.** `?decision=<actionId>` asks `GET /api/tasks/by-action/:id` and opens
  `/tasks/:id?approval=<actionId>`. When that fails (unknown action, older server) it searches the
  loaded tasks' `pendingActionIds`, then falls back to `/needs-you?decision=<actionId>`.
- **Refreshes.** The first `/ws` connect does not refetch; a reconnect refetches the open views
  and asks every working or seemingly running task for its runs again, so a run that ended
  offline stops showing as running. Window focus refetches only data older than 30 seconds.
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
- **R5-9:** settle, snooze and archive have no Undo (no reopen, unsnooze or unarchive route);
  the toast says where the task went. Archiving a system task is not confirmed.
- **R5-15:** a decision card on Needs you and the same action in an open task share busy state
  only within one tab.
- **R5-18:** the clamp notice always names the account ladder, even when a parent task caused
  the clamp, and it comes back on reload because it rides in history state.
- **Approve scope:** a server without `scope` on `/approve` ignores it and approves once; the
  UI cannot tell, so "Approve for this task" and "Always" then act like Approve.

## Not yet

- General `question` items remain reserved. `request_secret` uses `secret_request` items
  and `needsUser: "question"` for private input; there is no general question tool yet.
- Staged changes, the worktree analogue, are not implemented. Approval stays per action.
- Approval scopes apply to later proposals only: approving with `task` does not approve the
  task's other proposals that are already pending. The proposing tool call returns `proposed`
  even when a grant approves it a moment later; the run's change summary shows the outcome.
- Child tasks: `parentTaskId` is honored for the permission clamp, but no tool spawns a child
  task yet.

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
