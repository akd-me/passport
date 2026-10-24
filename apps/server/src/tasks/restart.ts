import type { Task, TaskRun } from "@passport/types";
import { logger } from "../logger.js";
import { continueRun } from "./continuation.js";
import type { TaskQueueService } from "./queue.js";
import type { TaskService } from "./service.js";
import { idleStatus } from "./status.js";
import { quoteHandle } from "./watch-classify.js";
import { type PendingWake, PendingWakes } from "./watch-pending.js";

/** Run kinds that continue after a restart; arrivals and routines have their own retries. */
const CONTINUED = new Set<TaskRun["trigger"]["kind"]>(["message", "watch", "wake"]);

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * Restart continuation (T3 "Limits and restarts"). Runs a previous process left `queued` or
 * `running` are not failed: each message, watch or wake run ends `cancelled`
 * (`SERVER_RESTARTED`), the task gets one `RESTARTED` notice listing what was in flight
 * (interrupted runs, watched conversations, pending wakes), and a continuation run starts with
 * `restartOf` pointing at it. A run that already continued a restart, and arrival or schedule
 * runs, fail as before (`SERVER_RESTARTED`; a message run surfaces `needsUser: "failure"`).
 * Queued follow-ups are not runs yet: they stay in `Task.queue` and drain afterwards.
 */
export interface RecoveryHooks {
  /** A run recovery ended without continuing it: `TaskSubtasks.afterRunEnded` (R1-11). */
  afterRunEnded?: (run: TaskRun) => Promise<void>;
}

export async function recoverRuns(
  service: TaskService,
  queue: TaskQueueService,
  hooks: RecoveryHooks = {},
): Promise<void> {
  const byTask = new Map<string, TaskRun[]>();
  for (const run of await service.tasks.runs.unfinished()) {
    byTask.set(run.taskId, [...(byTask.get(run.taskId) ?? []), run]);
  }
  const wakes = await new PendingWakes(service.options.store.kv).all();
  const ended: TaskRun[] = [];
  for (const [taskId, runs] of byTask) {
    try {
      const last = await recoverTask(service, taskId, runs, wakes);
      if (last) {
        ended.push(last);
      }
    } catch {
      // One task's recovery must not stop the others; its runs stay visible as open.
      logger.warn("Task restart recovery failed");
    }
  }
  // Once every task is recovered: a subtask's end reaches its parent (notification, wake, wait).
  for (const run of ended) {
    await hooks.afterRunEnded?.(run).catch(() => {
      logger.warn("Task restart recovery could not report a subtask's end");
    });
  }
  for (const taskId of byTask.keys()) {
    await queue.drain(taskId).catch(() => {
      logger.warn("Queued task messages could not resume after a restart");
    });
  }
}

async function recoverTask(
  service: TaskService,
  taskId: string,
  runs: TaskRun[],
  wakes: PendingWake[],
): Promise<TaskRun | null> {
  const task = await service.tasks.get(taskId);
  const queued = new Set(task?.queue?.map((entry) => entry.runId));
  const open = runs.filter((run) => !queued.has(run.id));
  const away = !task || task.status === "settled" || task.status === "archived";
  const continued = away ? [] : open.filter(continuable);
  let last: TaskRun | null = null;
  for (const run of open) {
    const ended = await service.tasks.runs.update(run.id, {
      status: continued.includes(run) ? "cancelled" : "failed",
      endedAt: service.now(),
      error: "SERVER_RESTARTED",
    });
    service.options.bus.emit({ type: "task.run.updated", run: ended });
    last = ended;
  }
  if (!task || !open.length) {
    return null;
  }
  const failedMessage = open.some(
    (run) => !continued.includes(run) && run.trigger.kind === "message",
  );
  // As before v0.4 for runs that do not continue: rest the task, flag a lost message run.
  if ((await service.task(taskId)).status === "working" && (!continued.length || failedMessage)) {
    await service.runner.updateTask(taskId, (fresh) => ({
      ...(continued.length ? {} : { status: idleStatus(fresh) }),
      ...(failedMessage ? { needsUser: "failure" as const } : {}),
    }));
  }
  if (!continued.length) {
    // Nothing continues: the last ended run reports the task's end (a continuation's own end does).
    return last;
  }
  const pending = wakes.filter((wake) => wake.taskId === taskId);
  await service.runner.appendItem({
    taskId,
    runId: null,
    kind: "system_notice",
    at: service.now(),
    payload: { text: noticeText(task, continued, pending), code: "RESTARTED" },
  });
  const inFlight = inFlightText(task, pending);
  for (const run of continued) {
    await continueRun(service, run, "restarted", inFlight);
  }
  return null;
}

/** Message runs whose message never started (`itemId` empty) have nothing to continue. */
function continuable(run: TaskRun): boolean {
  if (!CONTINUED.has(run.trigger.kind) || run.restartOf) {
    return false;
  }
  return run.trigger.kind !== "message" || run.trigger.itemId !== "";
}

function noticeText(task: Task, runs: TaskRun[], pending: PendingWake[]): string {
  const kinds = runs.map((run) =>
    run.trigger.kind === "message"
      ? "your request"
      : run.trigger.kind === "watch"
        ? "a watched conversation's wake"
        : "a wake",
  );
  const parts = [
    `Passport restarted while this task was working. Interrupted: ${kinds.join(", ")}.`,
  ];
  if (task.watches.length) {
    parts.push(`Still watching ${plural(task.watches.length, "conversation")}.`);
  }
  if (pending.length) {
    parts.push(`${plural(pending.length, "pending wake")} will still fire.`);
  }
  parts.push(runs.length === 1 ? "Continuing it once." : "Continuing them once.");
  return parts.join(" ");
}

/** What the continuation is told was in flight; handles are JSON-quoted like wake prompts. */
function inFlightText(task: Task, pending: PendingWake[]): string {
  const parts: string[] = [];
  if (task.watches.length) {
    parts.push(
      `watching conversations ${task.watches.map((w) => quoteHandle(w.threadHandle)).join(", ")}`,
    );
  }
  if (pending.length) {
    parts.push(
      `pending wakes (they still fire) on ${pending.map((w) => quoteHandle(w.threadHandle)).join(", ")}`,
    );
  }
  return parts.length ? `In flight when it stopped: ${parts.join("; ")}.` : "";
}
