# Scheduler

Passport's scheduler runs built-in background work and your own recurring agent routines only in the `serve` or `demo` owner process. Stdio MCP and one-shot CLI commands do not start background timers or arrival queues.
Open **Scheduler** (`/scheduler`) to see jobs, their schedules, next-run countdowns, status,
duration, failure details and the last 20 runs. Run now, pause/resume, inspect history, or
create a routine. Changes arrive through the existing WebSocket event stream.

## Built-in jobs

| ID                       | Default schedule                                                | Work                                                                                                |
| ------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `watch:<accountId>`      | Every 30 seconds (`watch.intervalSeconds`), and on every start  | One new-mail check (`MailReader.changes`); label tree + counts on connect and at most every 10 min  |
| `watch:<accountId>:push` | Long poll, reconnect 1 second after completion                  | Optional provider `waitForChanges` (IMAP IDLE); a signal runs `watch:<accountId>` at once           |
| `sync:<accountId>`       | Every 2 minutes (`syncIntervalSeconds`)                         | Bounded calendar sync for accounts with a calendar, plus a first sync on fresh startup              |
| `accounts.refresh`       | Same interval as sync                                           | Discover account additions/removals made outside the HTTP API                                       |
| `agent.arrivals`         | Every 30 seconds                                                | Retry durable arrivals; defer unsynced calendars up to 1 minute                                     |
| `outbox.release`         | Every 30 seconds                                                | Release due held actions through the existing executor                                              |
| `trust.decay`            | Daily 03:00                                                     | Apply trust decay                                                                                   |
| `agent.daily_digest`     | Daily `dailyDigestHour` (`PASSPORT_DIGEST_HOUR`, default 08:00) | Agent daily digest                                                                                  |
| `agent.matter_review`    | Daily 04:00                                                     | Agent matter review                                                                                 |
| `tasks.maintenance`      | Every 10 minutes                                                | Wake snoozed tasks whose time came, auto-settle tasks idle 3 days, end conversation watches older than 14 days ([tasks](tasks.md)) |
| `store.maintenance`      | Sunday 03:30                                                    | Evict cached bodies/envelopes, then optional `maintenance()` or `vacuum()` / `optimizeFts()`         |

Daily/weekly defaults use the machine's local IANA time zone, captured when registered.
All timestamps in persisted job state are ISO-8601 UTC. Built-ins work with both the real
backend and the ephemeral DemoBackend. Demo routine runs use fixtures and the demo action gate.
`store.maintenance` evicts the envelope cache (`evictBodies`: older than 7 days, then LRU beyond
200 MB; `evictEnvelopes`: LRU beyond 100,000 rows) and reports skipped only when the store exposes
neither eviction nor maintenance.

The watcher never backfills: the first `watch:<accountId>` run ever only takes a cursor at "now".
A rate-limited check backs off (30 seconds doubling to 15 minutes, or the provider's hint) and
completes with a backoff summary; it never fails the job or the account. Push jobs run
alongside the 30-second checks, so new mail is still found if the push connection fails. Each long
poll is bounded by the watch interval and receives a linked abort signal. A provider must settle on
abort. Push signals and **Check now** share the watch job's single-flight lock; signals honor a
paused watch job. Account API writes reconcile immediately; `account.synced` and
`account.watch.started` events and `accounts.refresh` catch other changes. Integrators can call the
scheduler handle's `registerAccount(accountId)` / `unregisterAccount(accountId)` hooks.

## Agent routines

A routine stores a name, schedule, and instruction. For example, every weekday at 07:30:
“Triage anything new, then prepare my day's digest.” The scheduler calls
`agent.run({ kind: "manual", instruction })` in the background lane.

Each routine, and each of the model-backed built-ins `agent.daily_digest` and
`agent.matter_review`, is bound to its own `kind: "routine"` [task](tasks.md). The job's
`taskId` (in `GET /api/jobs` and `JobState`) points at it. Every run is recorded on that task as a
`schedule` run, with its tool calls, model text and the ActionRecords it created. A run that
produced something brings the task back to the inbox, and a failure surfaces it with
`needsUser: "failure"`. In `@passport/scheduler` this is `JobDefinition.taskId` plus the
`SchedulerOptions.runOnTask(taskId, ctx, run)` seam. The host records the run and passes
`ctx.agentRunOptions`, which the job forwards to `AgentRuntime.run`. Deleting a routine keeps
its task and timeline. The runtime's existing tools and policy engine
control every action. A routine cannot grant itself permissions or bypass the outbox.

The form supports interval, daily, weekly and webhook schedules, a named time zone, and three example
instructions. Weekly `days` use Sunday = 0 through Saturday = 6. The API also supports manual
schedules. Missing time zones resolve to the host's local zone. Invalid times, zones, weekdays,
intervals and unknown fields are rejected. Pause stops automatic scheduling; Run now also
works for paused jobs. Pausing or deleting a routine does not reverse actions already submitted.

```sh
passport jobs list
passport jobs run agent.daily_digest
passport jobs pause outbox.release
passport jobs resume outbox.release
passport jobs add-routine --name "Morning triage" --daily 07:30 \
  --time-zone America/New_York \
  --instruction "Triage anything new, then prepare my day's digest"
```

Add `--demo` for an isolated, temporary demo. Commands use the running real server at the
configured host/port when available, so pause/resume immediately affect its timers. With the
server offline, they operate on the local store without starting recurring timers; changes
are loaded on the next server startup. The CLI authenticates with `PASSPORT_API_TOKEN` or `<data-dir>/api-token`; a 401 fails with instructions. Direct-store fallback is announced and requires both an unreachable server and an absent/stale owner lock. A live owner with an unreachable server is an error.

`<data-dir>/owner.lock` records PID, start time and a 10-second heartbeat. A live lock prevents another `serve`/`demo`; it expires after 60 seconds without a heartbeat or when its PID exits. Shutdown removes only its own lock. Arrivals additionally use SQLite compare-and-set claims, renewed every 10 seconds, and stable `arrival:<emailId>` run IDs. Existing logged Actions or a completed run checkpoint acknowledge a retry without re-running inference.

## API

| Method | Path                    | Input/result                                                                                          |
| ------ | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| GET    | `/api/jobs`             | Array of states with definitions; routine instructions included for user jobs                         |
| POST   | `/api/jobs`             | `{ name, schedule, routine: { instruction } }`; returns created job (201)                             |
| PATCH  | `/api/jobs/:id`         | `{ schedule?, enabled?, name?, routine?: { instruction } }`; name/instruction edits only for routines |
| DELETE | `/api/jobs/:id`         | Remove a user routine; built-in deletion returns 409                                                  |
| POST   | `/api/jobs/:id/run`     | Run once, return the run record (including an error or skipped result)                                |
| POST   | `/api/jobs/:id/pause`   | Disable automatic runs                                                                                |
| POST   | `/api/jobs/:id/resume`  | Enable and compute the next future occurrence                                                         |
| GET    | `/api/jobs/:id/history` | Last 20 runs, oldest first                                                                            |
| GET    | `/api/jobs/:id/deliveries` | Last 50 webhook deliveries, oldest first |
| POST   | `/api/jobs/:id/rotate-token` | Rotate the capability URL; returns `{ webhookUrl }` |
| POST   | `/api/hooks/:token` | Public webhook intake; no bearer required |

Example schedules:

```json
{ "type": "interval", "everyMs": 120000, "jitterMs": 10000 }
{ "type": "daily", "at": "07:30", "timeZone": "America/New_York" }
{ "type": "weekly", "days": [1, 2, 3, 4, 5], "at": "07:30", "timeZone": "America/New_York" }
{ "type": "manual" }
```

User routines accept an optional top-level `runOn: "bound" | "fresh"` on creation and
PATCH (default `"bound"`). Bound runs append a `schedule` run to the routine's task.
Fresh runs create a new `kind: "task"` task whose `parentTaskId` is the routine task,
with the parent's accounts and interaction mode and permissions clamped to the parent and
global dial. Approval grants, watches and provider sessions are not copied. The task details
**Automations** panel shows last run, status, next run, Run now and Pause/Resume.
The routine's history view includes its **Deliveries** list.

## Webhook routines

```json
{
  "name": "Review incoming issues",
  "runOn": "fresh",
  "schedule": {
    "type": "webhook",
    "signature": {
      "header": "x-hub-signature-256",
      "encoding": "hex",
      "prefix": "sha256=",
      "secretRef": "secret:<one-use reference from request_secret>"
    },
    "maxDeliveryAgeMinutes": 60,
    "dedupe": {
      "replayKey": "{{headers.x-github-delivery}}",
      "coalesceKey": "{{body.issue.number}}",
      "coalesceWindowSeconds": 120
    },
    "filters": [
      { "path": "headers.x-github-event", "op": "equals", "value": "issues" },
      { "path": "body.issue.labels[].name", "op": "in", "value": ["urgent", "bug"] }
    ]
  },
  "routine": { "instruction": "Review this issue for me: {{body.issue}}" }
}
```

Creation/listing returns a relative `webhookUrl` with a random 256-bit token unique to the
routine. Use the server's externally reachable HTTPS origin with that path. Rotation immediately
revokes the old token; pause rejects incoming deliveries. Administration, delivery history and
rotation require normal authentication. Hook POSTs retain Host and Origin checks and accept
bodies up to 256 KiB. Per routine, at most 10 new dispatch windows and 60 coalesced updates
are admitted per minute, with a separate 10-rejection limit and a 70-request ceiling.
Limits survive restart; HTTP 429 includes `Retry-After: 60`.

Signatures are HMAC-SHA256 over the **exact raw request bytes**. Encoding is `hex` or padded
`base64`; `prefix` is optional (empty by default). Digest comparison is constant time.
Enter the secret through [request_secret](tools.md#private-secrets-v04); its one-use reference
is consumed when installed and the signer stays encrypted. PATCH may retain the same installed
reference; changing it requires a new reference. Schedules never accept a raw signing secret.

Replay and coalesce keys are templates containing request placeholders, hashed per routine.
Replay keys live for seven days, independently of the bounded delivery log. Missing/null
key values bypass that key. A coalesce key opens a fixed window of 10–3600 seconds (default 120)
from the **first** delivery. Later deliveries replace the payload without extending the window.
Replay keys, pending windows, rendered prompts, URL tokens, rate state and logs survive restart.
An overdue window runs once with its latest payload; paused/deleted routines do not dispatch it.
Webhook jobs have no recurring timer or automatic job retries.

`maxDeliveryAgeMinutes` is an integer from 1 to 1440. Direct delivery is received now.
Relays may supply `x-t3-relay-received-at` (or `x-webhook-timestamp`) as ISO-8601,
Unix seconds or milliseconds; future timestamps are clamped to now and invalid timestamps
fall back to now. Older deliveries are logged as expired. Pending windows also check their
server receipt time before dispatch after downtime.

Up to 16 filters must all match. Paths begin with `body.`, `headers.` or `query.`;
headers are case insensitive. `[]` fans out over arrays, including nested arrays.
Scalars compare as strings: `equals`, `startsWith` and `in` match any resolved value;
`notEquals` requires none to match; `exists` requires a non-null resolved value.
Missing ordinary paths fail comparisons. `in` accepts 1–100 scalars.
Prototype properties cannot be addressed.

Instructions substitute `{{body.x}}`, `{{headers.x}}`, `{{query.x}}`, `{{body}}`
(the raw body) and `{{request}}` (the request with a redacted route). JSON and form bodies
support paths; other bodies remain text. Every inserted value goes through `frameUntrusted`,
including command neutralization and randomized tags. Authentication/signing headers and
credential-like query parameters are removed or redacted before rendering. Each substitution
is bounded to 64,000 characters, with a 262,144-character total payload-text budget.

Deliveries retain `id, jobId, receivedAt, outcome, prompt?`. Outcomes:
`accepted | dispatch_failed | duplicate | coalesced | rejected_signature | disabled | rate_limited | expired | filtered`.
Accepted/coalesced return HTTP 202 after persistence, before execution.
Duplicate/filtered/expired return 200, invalid signatures 401, disabled routines 410.
The first delivery's outcome changes to `dispatch_failed` if dispatch fails or overlaps an
active job. Expanded rendered instructions are plain text. The latest 50 entries are retained.

### Known limitations

- Passport provides the local route; remote delivery needs your own HTTPS tunnel/reverse proxy
  and an allowed Host. There is no built-in relay or offline HTTP queue.
- Dispatch is at least once across a crash between the run and its acknowledgement, as for
  existing jobs; executor/action semantics still govern effects.
- Relay timestamps are sender metadata, not freshness proofs. HMAC authenticates the body;
  use replay keys for signed senders that redeliver an event.

## Execution, retries and downtime

Each job has one timer calculated from its schedule. Interval ticks follow scheduled times
rather than adding the handler duration. A tick or Run now during active work records a
`skipped` history entry and emits `job.finished`; it does not start another handler.
`runCount` counts completed handler attempts, including handler-reported skips, but excludes
overlap skips. History entries include runId, startedAt, durationMs, status and summary.

Failures update lastError/consecutiveFailures and retry with exponential backoff plus 0–20%
jitter. Defaults are 5 attempts, a 1-second base and a 1-hour maximum; outbox uses a 30-second
base. No delay exceeds one hour or the job's configured maxMs. After each maxAttempts-sized
failure batch, the job returns to its regular schedule. A success resets failures and clears
lastError. Manual-only jobs have no automatic retries. Jobs stay visible and enabled after
errors. Enabled/schedule changes compute a fresh future occurrence.

State lives under `job:<id>` in Store.kv, including enabled/schedule overrides, last run,
nextRunAt, failure count, runCount and the last 20 history entries. Routine definitions live
in `scheduler:routines` because the KV interface has no key enumeration. On restart, register
the same job IDs before starting. If persisted nextRunAt is overdue, run once immediately,
then compute a future occurrence; downtime never produces N catch-up runs. An in-flight
attempt interrupted by a process crash is recovered through that same overdue occurrence.
This does not promise exactly-once effects: existing action/executor semantics still apply.

Daily/weekly jobs follow local wall time through DST. A nonexistent spring-forward time runs
at the first valid minute after the gap. A repeated fall-back time uses its first occurrence
and runs only once that day. Weekly jobs follow local weekdays.

Handlers receive `{ jobId, runId, signal, now }`. A timeout aborts the signal and records an
error. A handler ignoring abort retains its execution lock until it actually settles, even
if its timeout result has already been recorded. Shutdown aborts handlers, clears timers and
waits up to 5 seconds for active work before detaching it. Integrations should honor the
signal to finish cleanly; AgentRuntime currently has no cancellation argument, so an agent
run can finish after the scheduler's timeout. The real backend drains its agent queue before
closing persistence.

## Events and package API

The shared DomainEvent union has three appended members: `job.started` (jobId/runId),
`job.finished` (jobId/runId/status/durationMs/optional summary), and `job.updated` (jobId).
Existing event members retain their names and shapes.

`@passport/scheduler` depends only on `@passport/types` and receives `store`, `bus`, optional
`now` and `logger`. It exports `createScheduler`, schedule validation/calculation helpers,
`SchedulerError`, and job/schedule types. Await registration, mutations and lifecycle methods;
`list()` and `get(id)` return independent state snapshots. `remove` protects system jobs;
`unregister` supports integration-owned lifecycle changes. The injected clock and one-shot
timers support deterministic fake-timer tests.
