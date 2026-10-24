import {
  type AgentRun,
  type AgentRunOptions,
  type AgentRuntime,
  type Task,
  type TaskLimitSource,
  type TaskRun,
  taskWaitingOn,
} from "@passport/types";
import { ApiError } from "../errors.js";
import { logger } from "../logger.js";
import { continueRun } from "./continuation.js";
import type { TaskQueueService } from "./queue.js";
import type { TaskService } from "./service.js";
import { isLimitCode } from "./status.js";

export interface DetectedLimit {
  resetAt: string | null;
  source: TaskLimitSource;
}

const RESUMABLE = new Set<TaskRun["trigger"]["kind"]>(["message", "watch", "wake"]);
const LIMIT_TEXT = /usage limit|rate limit|limit reached|hit your limit|quota|too many requests/i;
const MAX_RESET_MS = 31 * 86_400_000;
/** Longest single timer; later resets are re-armed when it fires (setTimeout caps near 24.8 d). */
const MAX_TIMER_MS = 86_400_000;
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
/** Millisecond units, checked before the first-letter lookup (else "340ms" reads as minutes). */
const MS_UNIT = /^(ms|msecs?|millis(econds?)?|milliseconds?)$/;

/** A run stopped at a usage limit; `code` becomes the run's error (`needsUser: "limited"`). */
export class UsageLimitedError extends Error {
  readonly code = "USAGE_LIMITED";
  constructor(readonly limit: DetectedLimit) {
    super("Usage limit reached");
  }
}

/**
 * Usage limits from the host CLI error surface (`HOST_AGENT_RATE_LIMIT`, or a CLI failure whose
 * text says so, e.g. Claude Code's "usage limit reached|<epoch>") and API providers' HTTP 429.
 */
export function detectLimit(error: unknown, now: string): DetectedLimit | null {
  if (error instanceof UsageLimitedError) {
    return error.limit;
  }
  const { code, status, message } = (error ?? {}) as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
  };
  const text = typeof message === "string" ? message : "";
  let source: TaskLimitSource | null = null;
  if (code === "LLM_HTTP" && status === 429) {
    source = "provider";
  } else if (code === "HOST_AGENT_RATE_LIMIT") {
    source = "host_agent";
  } else if (typeof code === "string" && code.startsWith("HOST_AGENT") && LIMIT_TEXT.test(text)) {
    source = "host_agent";
  }
  return source ? { source, resetAt: parseResetAt(text, now) } : null;
}

/** The reset time a limit message states: an epoch after `|`, an ISO time, or "in 2h 5m". */
export function parseResetAt(text: string, now: string): string | null {
  const base = Date.parse(now);
  const candidates: number[] = [];
  const epoch = /\|\s*(\d{10}|\d{13})\b/.exec(text);
  if (epoch?.[1]) {
    const value = Number(epoch[1]);
    candidates.push(epoch[1].length === 10 ? value * 1000 : value);
  }
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/.exec(text);
  if (iso) {
    candidates.push(Date.parse(iso[0]));
  }
  const relative = /\b(?:in|after)\s+((?:\d+\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (relative?.[1]) {
    let total = 0;
    for (const [, amount, unit = ""] of relative[1].matchAll(/(\d+)\s*([a-z]+)/gi)) {
      const lower = unit.toLowerCase();
      if (MS_UNIT.test(lower)) {
        total += Number(amount);
        continue;
      }
      const key = lower.startsWith("mo") ? "" : lower.charAt(0);
      total += Number(amount) * (UNIT_MS[key] ?? Number.NaN);
    }
    candidates.push(base + total);
  }
  const at = candidates.find((ms) => Number.isFinite(ms) && ms > base && ms - base <= MAX_RESET_MS);
  return at === undefined ? null : new Date(at).toISOString();
}

/** Limits detected per agent run id, read back when the TaskRun ends. */
export class LimitLog {
  private readonly limits = new Map<string, DetectedLimit>();
  set(agentRunId: string, limit: DetectedLimit): void {
    this.limits.set(agentRunId, limit);
  }
  take(agentRunId: string): DetectedLimit | undefined {
    const limit = this.limits.get(agentRunId);
    this.limits.delete(agentRunId);
    return limit;
  }
}

/** Wraps the task agent so a usage-limit failure ends the run as `USAGE_LIMITED`. */
export function limitAware(agent: AgentRuntime, log: LimitLog, now: () => string): AgentRuntime {
  return {
    getUserProfile: () => agent.getUserProfile(),
    setUserProfile: (markdown) => agent.setUserProfile(markdown),
    run: async (trigger, options?: AgentRunOptions): Promise<AgentRun> => {
      try {
        return await agent.run(trigger, options);
      } catch (error) {
        const limit = detectLimit(error, now());
        if (!limit) {
          throw error;
        }
        if (options?.runId) {
          log.set(options.runId, limit);
        }
        throw new UsageLimitedError(limit);
      }
    },
  };
}

/**
 * The Limited state (T3 "Limits and restarts"): a run that hit a usage limit records
 * `Task.limited` and surfaces with `needsUser: "limited"`. `resume` continues the stopped run
 * now; `resumeAtReset` continues it at `resetAt` (a timer, with `tasks.maintenance` as the
 * durable backstop); snoozing until the reset is the ordinary snooze. The queue waits meanwhile.
 */
export class TaskLimits {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(
    private readonly service: TaskService,
    private readonly queue: TaskQueueService,
    private readonly log: LimitLog,
  ) {}

  /** Runner hook, before the status rules: record the limit on the task. */
  async onRunEnded(run: TaskRun): Promise<void> {
    // Arrivals retry on their own and routines report `JOB_FAILED`; only these runs continue.
    if (!RESUMABLE.has(run.trigger.kind) || !isLimitCode(run.error)) {
      return;
    }
    const limit = this.log.take(run.agentRunId) ?? { resetAt: null, source: "host_agent" };
    await this.service.runner.updateTask(run.taskId, {
      limited: { runId: run.id, ...limit, autoResume: false, at: this.service.now() },
    });
  }

  /** `POST /api/tasks/:id/resume`: continue the stopped run now, then the queue. */
  resume(taskId: string): Promise<{ task: Task; run: TaskRun | null }> {
    return this.queue.locked(taskId, async () => {
      const run = await this.resumeLocked(await this.service.task(taskId));
      await this.queue.drainLocked(taskId);
      return { task: await this.service.task(taskId), run };
    });
  }

  /** Clears the limit and starts the continuation; the caller holds the queue lock. */
  async resumeLocked(task: Task): Promise<TaskRun | null> {
    const limited = task.limited;
    if (!limited) {
      throw new ApiError("NOT_LIMITED", "The task is not stopped at a usage limit", 409);
    }
    this.disarm(task.id);
    await this.service.runner.updateTask(task.id, (current) => ({
      limited: null,
      // Pending approvals or questions keep the task waiting on the person (R1-26).
      ...(current.needsUser === "limited" ? { needsUser: taskWaitingOn(current) } : {}),
    }));
    const previous = await this.service.tasks.runs.get(limited.runId);
    if (!previous) {
      return null;
    }
    const { run } = await continueRun(this.service, previous, "limit");
    return run;
  }

  /** `POST /api/tasks/:id/resume-at-reset`: continue the stopped run when the limit resets. */
  async resumeAtReset(taskId: string): Promise<Task> {
    const task = await this.service.task(taskId);
    if (!task.limited) {
      throw new ApiError("NOT_LIMITED", "The task is not stopped at a usage limit", 409);
    }
    const { resetAt } = task.limited;
    if (!resetAt) {
      throw new ApiError("RESET_UNKNOWN", "The limit did not say when it resets", 409);
    }
    const limited = { ...task.limited, autoResume: true };
    const updated = await this.service.runner.updateTask(taskId, { limited });
    this.arm(taskId, resetAt);
    return updated;
  }

  /**
   * `tasks.maintenance` and startup: continue due auto-resumes and re-arm the timers a previous
   * process set. Returns how many runs it continued.
   */
  async maintain(): Promise<number> {
    let resumed = 0;
    const now = Date.parse(this.service.now());
    let cursor: string | null | undefined;
    const due: string[] = [];
    do {
      const page = await this.service.tasks.list({
        status: ["inbox", "snoozed", "working"],
        limit: 200,
        cursor,
      });
      for (const task of page.items) {
        const limited = task.limited;
        if (!limited?.autoResume || !limited.resetAt) {
          continue;
        }
        if (Date.parse(limited.resetAt) <= now) {
          due.push(task.id);
        } else if (!this.timers.has(task.id)) {
          this.arm(task.id, limited.resetAt);
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    for (const id of due) {
      if (await this.autoResume(id)) {
        resumed++;
      }
    }
    return resumed;
  }

  close(): void {
    this.closed = true;
    for (const id of [...this.timers.keys()]) {
      this.disarm(id);
    }
  }

  private arm(taskId: string, resetAt: string): void {
    this.disarm(taskId);
    if (this.closed) {
      return;
    }
    const wait = Math.max(0, Date.parse(resetAt) - Date.parse(this.service.now()));
    const timer = setTimeout(
      () => {
        this.timers.delete(taskId);
        if (wait > MAX_TIMER_MS) {
          this.arm(taskId, resetAt);
          return;
        }
        void this.autoResume(taskId);
      },
      Math.min(wait, MAX_TIMER_MS),
    );
    timer.unref?.();
    this.timers.set(taskId, timer);
  }

  private disarm(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
  }

  private async autoResume(taskId: string): Promise<boolean> {
    try {
      return await this.queue.locked(taskId, async () => {
        const task = await this.service.tasks.get(taskId);
        const limited = task?.limited;
        const due = limited?.autoResume && limited.resetAt && limited.resetAt <= this.service.now();
        // A task the person put away is not brought back by the timer (R1-15).
        const away = task?.status === "settled" || task?.status === "archived";
        if (!task || !due || away) {
          return false;
        }
        await this.resumeLocked(task);
        await this.queue.drainLocked(taskId);
        return true;
      });
    } catch {
      // The task stays limited with its recovery actions; the next maintenance pass retries.
      logger.warn("Task auto-resume after a usage limit failed");
      return false;
    }
  }
}
