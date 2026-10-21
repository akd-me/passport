import type { EventBus, Store } from "@passport/types";
import { nextOccurrence, type Schedule, SchedulerError, validateSchedule } from "./schedule.js";

export type { Schedule } from "./schedule.js";
export {
  nextOccurrence,
  SchedulerError,
  validateSchedule,
} from "./schedule.js";

export type JobStatus = "ok" | "error" | "skipped";
export interface JobResult {
  status?: JobStatus;
  summary?: string;
  /** Long-poll jobs may reconnect shortly after completion instead of waiting for the next tick. */
  nextRunInMs?: number;
}
export interface JobContext {
  jobId: string;
  runId: string;
  signal: AbortSignal;
  now(): Date;
}
export interface JobDefinition {
  id: string;
  name: string;
  kind: "system" | "user";
  schedule: Schedule;
  run(ctx: JobContext): Promise<JobResult>;
  concurrency?: "single";
  timeoutMs?: number;
  retry?: { maxAttempts: number; baseMs: number; maxMs: number };
}
export interface JobRun {
  runId: string;
  startedAt: string;
  durationMs: number;
  status: JobStatus;
  summary?: string;
}
export interface JobState {
  id: string;
  name: string;
  kind: "system" | "user";
  schedule: Schedule;
  enabled: boolean;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastStatus: JobStatus | null;
  lastError: string | null;
  nextRunAt: string | null;
  consecutiveFailures: number;
  runCount: number;
  history: JobRun[];
  running: boolean;
  /** Durable occurrence claim, retained across interrupted processes. */
  activeRun?: { runId: string; occurrenceAt: string; startedAt: string } | null;
}
export interface Scheduler {
  register(def: JobDefinition): Promise<JobState>;
  start(): Promise<void>;
  stop(): Promise<void>;
  list(): JobState[];
  get(id: string): JobState | undefined;
  runNow(id: string): Promise<JobRun>;
  pause(id: string): Promise<JobState>;
  resume(id: string): Promise<JobState>;
  update(
    id: string,
    patch: { schedule?: Schedule; enabled?: boolean; name?: string },
  ): Promise<JobState>;
  /** Only user jobs can be removed. Server account lifecycle uses unregister instead. */
  remove(id: string): Promise<void>;
  unregister(id: string): Promise<void>;
}
interface Entry {
  def: JobDefinition;
  state: JobState;
  ready: Promise<void>;
  writes: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  deadline?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
  active?: Promise<JobRun>;
  work?: Promise<unknown>;
  detached?: boolean;
  removed?: boolean;
  recoverInterrupted?: boolean;
}
const clone = <T>(value: T): T => structuredClone(value);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const MAX_DELAY = 2 ** 31 - 1;
/** Persistent, process-local scheduler. Await registrations before starting. */
export function createScheduler(options: {
  store: Pick<Store, "kv">;
  bus: EventBus;
  now?: () => number | Date;
  logger?: { warn(message: string): void };
  stopTimeoutMs?: number;
}): Scheduler {
  const entries = new Map<string, Entry>();
  const retired = new Set<Entry>();
  const now = () => Number(options.now?.() ?? Date.now());
  let started = false;
  let stopping: Promise<void> | undefined;
  function find(id: string) {
    const e = entries.get(id);
    if (!e || e.removed) throw new SchedulerError("JOB_NOT_FOUND", "Job not found");
    return e;
  }
  function persist(e: Entry) {
    if (e.removed || e.detached) return e.writes;
    const json = JSON.stringify({ ...e.state, running: false });
    const write = e.writes.then(() => options.store.kv.set(`job:${e.def.id}`, json));
    e.writes = write.catch(() => {});
    return write;
  }
  function clear(e: Entry) {
    clearTimeout(e.timer);
    e.timer = undefined;
  }
  function arm(e: Entry) {
    clear(e);
    if (!started || e.removed || !e.state.enabled) return;
    const interrupted =
      e.recoverInterrupted && e.state.activeRun && !e.active && !e.work
        ? e.state.activeRun
        : undefined;
    if (!interrupted && !e.state.nextRunAt) return;
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
        if (!interrupted) e.state.nextRunAt = iso(nextOccurrence(e.state.schedule, now(), due));
        void execute(e, new Date(due).toISOString(), !!interrupted).catch(() =>
          options.logger?.warn(`Job ${e.def.id} could not persist its run`),
        );
        if (!interrupted) arm(e);
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
    if (e.removed || e.detached) return;
    Object.assign(e.state, {
      lastRunAt: run.startedAt,
      lastDurationMs: run.durationMs,
      lastStatus: run.status,
    });
    if (run.status !== "skipped") e.state.lastError = error ?? null;
    e.state.history = [...e.state.history, run].slice(-20);
    await persist(e);
    finished(e, run);
  }
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
        if (e.removed || e.detached) return run;
        if (controller.signal.aborted)
          throw new SchedulerError("JOB_ABORTED", "Job aborted before execution");
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
          if (e.work === work) e.work = undefined;
          if (!e.detached && !e.removed && e.state.activeRun?.runId === run.runId) {
            e.state.activeRun = null;
            void persist(e).catch(() =>
              options.logger?.warn(`Job ${e.def.id} could not clear its active run`),
            );
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
        if (run.status === "error")
          throw new SchedulerError("JOB_FAILED", result.summary ?? "Job failed");
        if (run.status === "ok") {
          e.state.consecutiveFailures = 0;
          if (hadFailures && e.state.enabled)
            e.state.nextRunAt = iso(nextOccurrence(e.state.schedule, now()));
        }
        if (result.nextRunInMs !== undefined) {
          if (!Number.isSafeInteger(result.nextRunInMs) || result.nextRunInMs < 1)
            throw new SchedulerError("INVALID_JOB_RESULT", "Invalid nextRunInMs");
          if (e.state.enabled) e.state.nextRunAt = iso(now() + result.nextRunInMs);
        }
      } catch (error) {
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
      )
        e.state.nextRunAt = iso(nextOccurrence(e.state.schedule, now()));
      await record(e, run, run.status === "error" ? (e.state.lastError ?? undefined) : undefined);
      return run;
    })();
    e.active = active;
    void active.then(
      () => settle(),
      () => settle(),
    );
    function settle() {
      if (e.active === active) e.active = undefined;
      e.state.running = !!e.work;
      if (e.work) {
        const done = () => {
          e.state.running = false;
          retired.delete(e);
        };
        void e.work.then(done, done);
      } else retired.delete(e);
      arm(e);
    }
    return active;
  }
  const scheduler: Scheduler = {
    async register(def) {
      if (entries.has(def.id)) throw new SchedulerError("JOB_EXISTS", "Job is already registered");
      if ([...retired].some((e) => e.def.id === def.id))
        throw new SchedulerError("JOB_STILL_RUNNING", "The removed job's handler is still running");
      if (
        !def.id ||
        !def.name ||
        !["system", "user"].includes(def.kind) ||
        (def.concurrency !== undefined && def.concurrency !== "single")
      )
        throw new SchedulerError("INVALID_JOB", "Invalid job definition");
      if (
        def.timeoutMs !== undefined &&
        (!Number.isSafeInteger(def.timeoutMs) || def.timeoutMs < 1 || def.timeoutMs > MAX_DELAY)
      )
        throw new SchedulerError("INVALID_JOB", "Invalid timeout");
      if (
        def.retry &&
        (!Number.isSafeInteger(def.retry.maxAttempts) ||
          def.retry.maxAttempts < 1 ||
          !Number.isSafeInteger(def.retry.baseMs) ||
          def.retry.baseMs < 1 ||
          !Number.isSafeInteger(def.retry.maxMs) ||
          def.retry.maxMs < def.retry.baseMs)
      )
        throw new SchedulerError("INVALID_JOB", "Invalid retry policy");
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
          });
          e.recoverInterrupted = !!state.activeRun;
          if (!state.enabled) state.nextRunAt = null;
        }
        await persist(e);
        options.bus.emit({ type: "job.updated", jobId: def.id });
        arm(e);
      })();
      try {
        await e.ready;
      } catch (error) {
        entries.delete(def.id);
        throw error;
      }
      return clone(state);
    },
    async start() {
      if (stopping) await stopping;
      await Promise.all([...entries.values()].map((e) => e.ready));
      if (started) return;
      for (const e of entries.values()) {
        if (e.detached && (e.active || e.work))
          throw new SchedulerError(
            "JOB_STILL_RUNNING",
            "A previous handler is still running after shutdown",
          );
        e.detached = false;
        if (!e.active && !e.work) e.recoverInterrupted = !!e.state.activeRun;
      }
      started = true;
      for (const e of entries.values()) arm(e);
    },
    stop() {
      if (stopping) return stopping;
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
        for (const e of current) if (e.active || e.work) e.detached = true;
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
      if (stopping) throw new SchedulerError("SCHEDULER_STOPPING", "Scheduler is stopping");
      return execute(e);
    },
    pause: (id) => scheduler.update(id, { enabled: false }),
    resume: (id) => scheduler.update(id, { enabled: true }),
    async update(id, patch) {
      const e = find(id);
      await e.ready;
      if (patch.enabled !== undefined && typeof patch.enabled !== "boolean")
        throw new SchedulerError("INVALID_JOB", "enabled must be boolean");
      const schedule = patch.schedule === undefined ? undefined : validateSchedule(patch.schedule);
      if (patch.name !== undefined && (typeof patch.name !== "string" || !patch.name.trim()))
        throw new SchedulerError("INVALID_JOB", "name is required");
      if (schedule) e.state.schedule = schedule;
      if (patch.name !== undefined) {
        e.state.name = patch.name;
        e.def.name = patch.name;
      }
      if (patch.enabled !== undefined) e.state.enabled = patch.enabled;
      e.state.nextRunAt = e.state.enabled ? iso(nextOccurrence(e.state.schedule, now())) : null;
      clear(e);
      await persist(e);
      arm(e);
      options.bus.emit({ type: "job.updated", jobId: id });
      return clone(e.state);
    },
    async remove(id) {
      const e = find(id);
      if (e.def.kind !== "user")
        throw new SchedulerError("SYSTEM_JOB", "System jobs cannot be deleted");
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
      if (e.active || e.work) retired.add(e);
      await e.writes;
      await options.store.kv.delete(`job:${id}`);
      options.bus.emit({ type: "job.updated", jobId: id });
    },
  };
  return scheduler;
}
