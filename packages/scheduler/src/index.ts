import { nextOccurrence, SchedulerError, validateSchedule } from "./schedule.js";
import { createJobExecutor } from "./scheduler-execution.js";
import {
  clone,
  type Entry,
  iso,
  type JobRun,
  type JobState,
  MAX_DELAY,
  type Scheduler,
  type SchedulerOptions,
} from "./scheduler-state.js";

export type { Schedule } from "./schedule.js";
export { nextOccurrence, SchedulerError, validateSchedule } from "./schedule.js";
export type {
  JobContext,
  JobDefinition,
  JobResult,
  JobRun,
  JobState,
  JobStatus,
  Scheduler,
} from "./scheduler-state.js";

/** Persistent, process-local scheduler. Await registrations before starting. */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const entries = new Map<string, Entry>();
  const retired = new Set<Entry>();
  const now = () => Number(options.now?.() ?? Date.now());
  let started = false;
  let stopping: Promise<void> | undefined;
  function find(id: string) {
    const e = entries.get(id);
    if (!e || e.removed) {
      throw new SchedulerError("JOB_NOT_FOUND", "Job not found");
    }
    return e;
  }
  function persist(e: Entry) {
    if (e.removed || e.detached) {
      return e.writes;
    }
    const json = JSON.stringify({ ...e.state, running: false });
    const write = e.writes.then(() => options.store.kv.set(`job:${e.def.id}`, json));
    e.writes = write.catch(() => {
      // Job state persistence failed; keeping the write queue available.
      options.logger?.warn("Job state persistence failed; keeping the write queue available");
    });
    return write;
  }
  function clear(e: Entry) {
    clearTimeout(e.timer);
    e.timer = undefined;
  }
  function arm(e: Entry) {
    clear(e);
    if (!started || e.removed || !e.state.enabled) {
      return;
    }
    const interrupted =
      e.recoverInterrupted && e.state.activeRun && !e.active && !e.work
        ? e.state.activeRun
        : undefined;
    if (!interrupted && !e.state.nextRunAt) {
      return;
    }
    const dueAt = interrupted
      ? Math.max(now(), Date.parse(interrupted.startedAt) + (e.def.timeoutMs ?? 0))
      : Date.parse(e.state.nextRunAt!);
    const delay = dueAt - now();
    e.timer = setTimeout(
      () => {
        e.timer = undefined;
        if (dueAt > now()) {
          arm(e);
          return;
        }
        const due = interrupted
          ? Date.parse(interrupted.occurrenceAt)
          : Date.parse(e.state.nextRunAt!);
        if (!interrupted) {
          e.state.nextRunAt = iso(nextOccurrence(e.state.schedule, now(), due));
        }
        void execute(e, new Date(due).toISOString(), !!interrupted).catch(() => {
          // Keep the existing operational log and fallback; never include the caught payload.
          return options.logger?.warn(`Job ${e.def.id} could not persist its run`);
        });
        if (!interrupted) {
          arm(e);
        }
      },
      Math.max(0, Math.min(MAX_DELAY, delay)),
    );
    e.timer.unref?.();
  }
  function finished(e: Entry, run: JobRun) {
    options.bus.emit({
      type: "job.finished",
      jobId: e.def.id,
      runId: run.runId,
      status: run.status,
      durationMs: run.durationMs,
      summary: run.summary,
    });
  }
  async function record(e: Entry, run: JobRun, error?: string) {
    if (e.removed || e.detached) {
      return;
    }
    Object.assign(e.state, {
      lastRunAt: run.startedAt,
      lastDurationMs: run.durationMs,
      lastStatus: run.status,
    });
    if (run.status !== "skipped") {
      e.state.lastError = error ?? null;
    }
    e.state.history = [...e.state.history, run].slice(-20);
    await persist(e);
    finished(e, run);
  }
  const execute = createJobExecutor(options, { now, persist, record, arm, retired });
  const scheduler: Scheduler = {
    async register(def) {
      if (entries.has(def.id)) {
        throw new SchedulerError("JOB_EXISTS", "Job is already registered");
      }
      if ([...retired].some((e) => e.def.id === def.id)) {
        throw new SchedulerError("JOB_STILL_RUNNING", "The removed job's handler is still running");
      }
      if (
        !def.id ||
        !def.name ||
        !["system", "user"].includes(def.kind) ||
        (def.concurrency !== undefined && def.concurrency !== "single")
      ) {
        throw new SchedulerError("INVALID_JOB", "Invalid job definition");
      }
      if (
        def.timeoutMs !== undefined &&
        (!Number.isSafeInteger(def.timeoutMs) || def.timeoutMs < 1 || def.timeoutMs > MAX_DELAY)
      ) {
        throw new SchedulerError("INVALID_JOB", "Invalid timeout");
      }
      if (
        def.retry &&
        (!Number.isSafeInteger(def.retry.maxAttempts) ||
          def.retry.maxAttempts < 1 ||
          !Number.isSafeInteger(def.retry.baseMs) ||
          def.retry.baseMs < 1 ||
          !Number.isSafeInteger(def.retry.maxMs) ||
          def.retry.maxMs < def.retry.baseMs)
      ) {
        throw new SchedulerError("INVALID_JOB", "Invalid retry policy");
      }
      const schedule = validateSchedule(def.schedule);
      const state: JobState = {
        id: def.id,
        name: def.name,
        kind: def.kind,
        schedule,
        enabled: true,
        lastRunAt: null,
        lastDurationMs: null,
        lastStatus: null,
        lastError: null,
        nextRunAt: iso(nextOccurrence(schedule, now())),
        consecutiveFailures: 0,
        runCount: 0,
        history: [],
        running: false,
        activeRun: null,
        ...(def.taskId ? { taskId: def.taskId } : {}),
      };
      const e: Entry = {
        def: {
          ...def,
          schedule,
          retry: def.retry ? { ...def.retry } : undefined,
        },
        state,
        ready: Promise.resolve(),
        writes: Promise.resolve(),
      };
      entries.set(def.id, e);
      e.ready = (async () => {
        const stored = await options.store.kv.get(`job:${def.id}`);
        if (stored) {
          const saved = JSON.parse(stored) as JobState;
          Object.assign(state, saved, {
            id: def.id,
            name: def.name,
            kind: def.kind,
            schedule: validateSchedule(saved.schedule),
            running: false,
            taskId: def.taskId,
          });
          e.recoverInterrupted = !!state.activeRun;
          if (!state.enabled) {
            state.nextRunAt = null;
          }
        }
        await persist(e);
        options.bus.emit({ type: "job.updated", jobId: def.id });
        arm(e);
      })();
      try {
        await e.ready;
      } catch (error) {
        // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

        entries.delete(def.id);
        throw error;
      }
      return clone(state);
    },
    async start() {
      if (stopping) {
        await stopping;
      }
      await Promise.all([...entries.values()].map((e) => e.ready));
      if (started) {
        return;
      }
      for (const e of entries.values()) {
        if (e.detached && (e.active || e.work)) {
          throw new SchedulerError(
            "JOB_STILL_RUNNING",
            "A previous handler is still running after shutdown",
          );
        }
        e.detached = false;
        if (!e.active && !e.work) {
          e.recoverInterrupted = !!e.state.activeRun;
        }
      }
      started = true;
      for (const e of entries.values()) {
        arm(e);
      }
    },
    stop() {
      if (stopping) {
        return stopping;
      }
      started = false;
      const current = [...new Set([...entries.values(), ...retired])];
      for (const e of current) {
        clear(e);
        clearTimeout(e.deadline);
        e.controller?.abort();
      }
      stopping = (async () => {
        await Promise.allSettled(current.map((e) => e.ready));
        let limit: ReturnType<typeof setTimeout> | undefined;
        const drained = Promise.allSettled(
          current.flatMap((e) =>
            [e.active, e.work].filter((p): p is Promise<JobRun> | Promise<unknown> => !!p),
          ),
        );
        await Promise.race([
          drained,
          new Promise<void>((resolve) => {
            limit = setTimeout(resolve, options.stopTimeoutMs ?? 5000);
          }),
        ]);
        clearTimeout(limit);
        for (const e of current) {
          if (e.active || e.work) {
            e.detached = true;
          }
        }
        await Promise.allSettled(current.map((e) => e.writes));
      })().finally(() => {
        stopping = undefined;
      });
      return stopping;
    },
    list: () => [...entries.values()].map((e) => clone(e.state)),
    get: (id) => (entries.has(id) ? clone(find(id).state) : undefined),
    async runNow(id) {
      const e = find(id);
      await e.ready;
      if (stopping) {
        throw new SchedulerError("SCHEDULER_STOPPING", "Scheduler is stopping");
      }
      return execute(e);
    },
    pause: (id) => scheduler.update(id, { enabled: false }),
    resume: (id) => scheduler.update(id, { enabled: true }),
    async update(id, patch) {
      const e = find(id);
      await e.ready;
      if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
        throw new SchedulerError("INVALID_JOB", "enabled must be boolean");
      }
      const schedule = patch.schedule === undefined ? undefined : validateSchedule(patch.schedule);
      if (patch.name !== undefined && (typeof patch.name !== "string" || !patch.name.trim())) {
        throw new SchedulerError("INVALID_JOB", "name is required");
      }
      if (schedule) {
        e.state.schedule = schedule;
      }
      if (patch.name !== undefined) {
        e.state.name = patch.name;
        e.def.name = patch.name;
      }
      if (patch.enabled !== undefined) {
        e.state.enabled = patch.enabled;
      }
      e.state.nextRunAt = e.state.enabled ? iso(nextOccurrence(e.state.schedule, now())) : null;
      clear(e);
      await persist(e);
      arm(e);
      options.bus.emit({ type: "job.updated", jobId: id });
      return clone(e.state);
    },
    async remove(id) {
      const e = find(id);
      if (e.def.kind !== "user") {
        throw new SchedulerError("SYSTEM_JOB", "System jobs cannot be deleted");
      }
      await scheduler.unregister(id);
    },
    async unregister(id) {
      const e = find(id);
      await e.ready;
      e.removed = true;
      clear(e);
      clearTimeout(e.deadline);
      e.controller?.abort();
      entries.delete(id);
      if (e.active || e.work) {
        retired.add(e);
      }
      await e.writes;
      await options.store.kv.delete(`job:${id}`);
      options.bus.emit({ type: "job.updated", jobId: id });
    },
  };
  return scheduler;
}
