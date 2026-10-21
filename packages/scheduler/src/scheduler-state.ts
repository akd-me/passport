import type { EventBus, Store } from "@passport/types";
import type { Schedule } from "./schedule.js";
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
export interface Entry {
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
export const clone = <T>(value: T): T => structuredClone(value);
export const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
export const MAX_DELAY = 2 ** 31 - 1;
export type SchedulerOptions = {
  store: Pick<Store, "kv">;
  bus: EventBus;
  now?: () => number | Date;
  logger?: { warn(message: string): void };
  stopTimeoutMs?: number;
};
