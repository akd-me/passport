# @passport/scheduler

Persistent, process-local jobs with single-flight execution, bounded history, wall-clock
schedules, abortable timeouts, retry backoff, and graceful shutdown. Runtime dependencies:
`@passport/types` only. Supply `Store.kv` and `EventBus`; the scheduler owns no database.

```ts
import { createScheduler } from "@passport/scheduler";
const scheduler = createScheduler({ store, bus });
await scheduler.register({
  id: "example",
  name: "Example",
  kind: "user",
  schedule: { type: "daily", at: "07:30", timeZone: "America/New_York" },
  run: async ({ signal }) => ({ summary: await doWork(signal) }),
});
await scheduler.start();
await scheduler.runNow("example");
await scheduler.pause("example");
console.log(scheduler.list());
await scheduler.stop(); // then close the store
```

Await `register`, `start`, mutations, `runNow`, and `stop`. `list` and `get` return independent
snapshots synchronously. `update` accepts schedule/enabled/name; `remove` protects system
jobs. `unregister` is reserved for integration-owned lifecycle changes such as account removal.
A handler returns `{ summary?, status?: "ok" | "skipped" | "error" }` or throws. Long-poll
handlers may also return positive `nextRunInMs` to reconnect promptly after completing.

`now` accepts a function returning epoch milliseconds or a Date. Scheduling uses `setTimeout`
and the injected clock, so Vitest fake timers work without a background interval. Stop aborts
handlers and drains them for up to `stopTimeoutMs` (default 5 seconds). Jobs must cooperate
with `ctx.signal`; timed-out work retains its lock until the underlying handler settles.
This is a single-process scheduler, not a distributed lock or exactly-once action protocol.

See [scheduler guide](../../docs/scheduler.md) for retries, DST, persistence, routines and APIs.
Nothing is stubbed. Run `pnpm --filter @passport/scheduler build`, `typecheck`, and `test`.

Webhook schedules validate through `validateSchedule` and have no recurring timer or retries.
The package exports pure request path/filter/template/key helpers and raw-body HMAC verification.
The host supplies `frameUntrusted` to `renderWebhookTemplate` and owns intake/pending persistence.
`runNow(id, { webhookPrompt })` forwards the rendered instruction through `JobContext`.

Each started occurrence persists `activeRun: {runId,occurrenceAt,startedAt}` before invoking
the handler. It clears only when the handler settles, including after a timeout. On restart,
an interrupted occurrence runs once immediately after its timeout expires (immediately for
jobs without a timeout), before the next occurrence is calculated. Paused jobs remain paused.
Completed runs do not replay. Recovery is at least once; handlers must tolerate repeats if
an external effect succeeded before the process stopped.
