import { nextOccurrence, SchedulerError } from "./schedule.js";
import { type Entry, iso, type JobRun, type SchedulerOptions } from "./scheduler-state.js";

export function createJobExecutor(
  options: SchedulerOptions,
  context: {
    now(): number;
    persist(e: Entry): Promise<void>;
    record(e: Entry, run: JobRun, error?: string): Promise<void>;
    arm(e: Entry): void;
    retired: Set<Entry>;
  },
) {
  const { now, persist, record, arm, retired } = context;
  function execute(
    e: Entry,
    occurrenceAt = new Date(now()).toISOString(),
    recovering = false,
  ): Promise<JobRun> {
    const startedMs = now();
    const run: JobRun = {
      runId: crypto.randomUUID(),
      startedAt: new Date(startedMs).toISOString(),
      durationMs: 0,
      status: "ok",
    };
    if (e.active || e.work) {
      run.status = "skipped";
      run.summary = "Previous run is still active";
      return record(e, run).then(() => run);
    }
    e.controller = new AbortController();
    const controller = e.controller;
    const hadFailures = e.state.consecutiveFailures > 0;
    e.recoverInterrupted = false;
    e.state.running = true;
    e.state.activeRun = { runId: run.runId, occurrenceAt, startedAt: run.startedAt };
    const active = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await persist(e);
        if (e.removed || e.detached) {
          return run;
        }
        if (controller.signal.aborted) {
          throw new SchedulerError("JOB_ABORTED", "Job aborted before execution");
        }
        options.bus.emit({
          type: "job.started",
          jobId: e.def.id,
          runId: run.runId,
        });
        const work = Promise.resolve().then(() =>
          e.def.run({
            jobId: e.def.id,
            runId: run.runId,
            signal: controller.signal,
            now: () => new Date(now()),
          }),
        );
        e.work = work;
        const workSettled = () => {
          if (e.work === work) {
            e.work = undefined;
          }
          if (!e.detached && !e.removed && e.state.activeRun?.runId === run.runId) {
            e.state.activeRun = null;
            void persist(e).catch(() => {
              // Keep the existing operational log and fallback; never include the caught payload.
              return options.logger?.warn(`Job ${e.def.id} could not clear its active run`);
            });
          }
        };
        void work.then(workSettled, workSettled);
        const result =
          e.def.timeoutMs === undefined
            ? await work
            : await Promise.race([
                work,
                new Promise<never>((_, reject) => {
                  timeout = setTimeout(() => {
                    controller.abort();
                    reject(
                      new SchedulerError("JOB_TIMEOUT", `Job timed out after ${e.def.timeoutMs}ms`),
                    );
                  }, e.def.timeoutMs);
                  e.deadline = timeout;
                  timeout.unref?.();
                }),
              ]);
        run.status = result.status ?? "ok";
        run.summary = result.summary;
        if (run.status === "error") {
          throw new SchedulerError("JOB_FAILED", result.summary ?? "Job failed");
        }
        if (run.status === "ok") {
          e.state.consecutiveFailures = 0;
          if (hadFailures && e.state.enabled) {
            e.state.nextRunAt = iso(nextOccurrence(e.state.schedule, now()));
          }
        }
        if (result.nextRunInMs !== undefined) {
          if (!Number.isSafeInteger(result.nextRunInMs) || result.nextRunInMs < 1) {
            throw new SchedulerError("INVALID_JOB_RESULT", "Invalid nextRunInMs");
          }
          if (e.state.enabled) {
            e.state.nextRunAt = iso(now() + result.nextRunInMs);
          }
        }
      } catch (error) {
        // Keep the existing operational log and fallback; never include the caught payload.

        run.status = "error";
        e.state.consecutiveFailures++;
        e.state.lastError = error instanceof Error ? error.message : "Job failed";
        run.summary = e.state.lastError;
        options.logger?.warn(`Job ${e.def.id} failed (attempt ${e.state.consecutiveFailures})`);
        const retry = e.def.retry ?? {
          maxAttempts: 5,
          baseMs: 1000,
          maxMs: 3600000,
        };
        if (
          e.state.enabled &&
          e.state.schedule.type !== "manual" &&
          e.state.consecutiveFailures % retry.maxAttempts !== 0
        ) {
          const base = Math.min(
            3600000,
            retry.maxMs,
            retry.baseMs * 2 ** Math.min(30, e.state.consecutiveFailures - 1),
          );
          e.state.nextRunAt = iso(
            now() + Math.min(3600000, retry.maxMs, Math.round(base * (1 + Math.random() * 0.2))),
          );
        }
      } finally {
        clearTimeout(timeout);
        e.deadline = undefined;
      }
      run.durationMs = Math.max(0, now() - startedMs);
      e.state.runCount++;
      e.state.running = !!e.work;
      // A manual invocation of a periodic job keeps its future scheduled occurrence.
      if (
        e.state.enabled &&
        ((recovering && run.status !== "error") ||
          !e.state.nextRunAt ||
          Date.parse(e.state.nextRunAt) <= now())
      ) {
        e.state.nextRunAt = iso(nextOccurrence(e.state.schedule, now()));
      }
      await record(e, run, run.status === "error" ? (e.state.lastError ?? undefined) : undefined);
      return run;
    })();
    e.active = active;
    void active.then(
      () => settle(),
      () => settle(),
    );
    function settle() {
      if (e.active === active) {
        e.active = undefined;
      }
      e.state.running = !!e.work;
      if (e.work) {
        const done = () => {
          e.state.running = false;
          retired.delete(e);
        };
        void e.work.then(done, done);
      } else {
        retired.delete(e);
      }
      arm(e);
    }
    return active;
  }
  return execute;
}
