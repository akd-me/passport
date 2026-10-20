# Scheduler

Passport's scheduler runs built-in background work and your own recurring agent routines only in the `serve` or `demo` owner process. Stdio MCP and one-shot CLI commands do not start background timers or arrival queues.
Open **Scheduler** (`/scheduler`) to see jobs, their schedules, next-run countdowns, status,
duration, failure details and the last 20 runs. Run now, pause/resume, inspect history, or
create a routine. Changes arrive through the existing WebSocket event stream.

## Built-in jobs

| ID                       | Default schedule                                                | Work                                                                                                |
| ------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `sync:<accountId>`       | Every 2 minutes (`syncIntervalSeconds`)                         | Incremental account sync, plus a first sync on fresh startup                                        |
| `sync:<accountId>:watch` | Long poll, reconnect 1 second after completion                  | Optional provider `waitForChanges`; notifications run the account sync job                          |
| `accounts.refresh`       | Same interval as sync                                           | Discover account additions/removals made outside the HTTP API                                       |
| `agent.arrivals` | Every 30 seconds | Retry durable arrivals; defer unsynced calendars up to 10 minutes |
| `outbox.release`         | Every 30 seconds                                                | Release due held actions through the existing executor                                              |
| `trust.decay`            | Daily 03:00                                                     | Apply trust decay                                                                                   |
| `agent.daily_digest`     | Daily `dailyDigestHour` (`PASSPORT_DIGEST_HOUR`, default 08:00) | Agent daily digest                                                                                  |
| `agent.matter_review`    | Daily 04:00                                                     | Agent matter review                                                                                 |
| `store.maintenance`      | Sunday 03:30                                                    | Call optional store `maintenance()`, or `vacuum()` / `optimizeFts()`; record skipped if unavailable |

Daily/weekly defaults use the machine's local IANA time zone, captured when registered.
All timestamps in persisted job state are ISO-8601 UTC. Built-ins work with both the real
backend and the ephemeral DemoBackend. Demo routine runs use fixtures and the demo action gate.
The default SQLite Store currently exposes no maintenance hook, so that job reports skipped.

Push jobs run alongside regular polling, preserving fallback sync if the push connection
fails. Each long poll is bounded by the configured sync interval and receives a linked
abort signal. A provider must settle on abort. Notifications and manual sync execution
share the same account job's single-flight lock; notifications honor a paused sync job.
Account API writes reconcile immediately;
`account.synced` events and `accounts.refresh` catch other changes. Integrators can call the
scheduler handle's `registerAccount(accountId)` / `unregisterAccount(accountId)` hooks.

## Agent routines

A routine stores a name, schedule, and instruction. For example, every weekday at 07:30:
“Triage anything new, then prepare my day's digest.” The scheduler calls
`agent.run({ kind: "manual", instruction })`. The runtime's existing tools and policy engine
control every action. A routine cannot grant itself permissions or bypass the outbox.

The form supports interval, daily and weekly schedules, a named time zone, and three example
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

Example schedules:

```json
{ "type": "interval", "everyMs": 120000, "jitterMs": 10000 }
{ "type": "daily", "at": "07:30", "timeZone": "America/New_York" }
{ "type": "weekly", "days": [1, 2, 3, 4, 5], "at": "07:30", "timeZone": "America/New_York" }
{ "type": "manual" }
```

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
