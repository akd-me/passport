import { newId } from "@passport/store";
import {
  TASK_LIMITS,
  type Task,
  type TaskMessage,
  type TaskQueue,
  type TaskQueueEntry,
  type TaskRun,
} from "@passport/types";
import { ApiError } from "../errors.js";
import { logger } from "../logger.js";
import type { TaskService } from "./service.js";
import { resolveTaskStatus } from "./status.js";

/** Limited-state recovery the queue needs: a new message resumes a limited task first. */
export interface QueueLimits {
  resumeLocked(task: Task): Promise<unknown>;
}

/**
 * The server-side follow-up queue (T3 "Queue and steer"). A `queue` message sent while the task
 * already has a message run, a non-empty queue, a held queue or a usage limit waits in
 * `Task.queue` with a `queued` TaskRun under the id it will run as; nothing enters the agent lane
 * until the run before it ends. Entries can be edited, reordered, removed or promoted to a steer.
 * `/interrupt`, settle and archive hold the queue (`Task.queueHeld`) until `/queue/resume` or the
 * next message. Every change is a `task.updated` frame because the queue rides on the task.
 */
export class TaskQueueService {
  limits?: QueueLimits;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly service: TaskService) {}

  async get(taskId: string): Promise<TaskQueue> {
    return view(await this.service.task(taskId));
  }

  /**
   * `POST /api/tasks/:id/messages`: the person's message, run now or queued. It answers every
   * pending question (v0.4), or only `answers` when given (the answer route, a parent's reply).
   * `agent` (a parent task's follow-up to its subtask) never releases a queue the person held or
   * resumes a limit: the message then waits in the queue for the person (R1-12).
   */
  send(
    taskId: string,
    message: TaskMessage,
    options: { answers?: string[]; agent?: boolean } = {},
  ): Promise<{ task: Task; run: TaskRun }> {
    return this.locked(taskId, async () => {
      // The person is looking at the task, and a new message releases a held queue.
      let answers: string[] = [];
      let task = await this.update(taskId, (current) => {
        const pending = current.pendingQuestions ?? [];
        const open = pending.map((question) => question.itemId);
        // Only questions still open: a dismiss may have won the race with an answer.
        answers = (options.answers ?? open).filter((itemId) => open.includes(itemId));
        if (options.answers && !answers.length) {
          throw new ApiError(
            "QUESTION_RESOLVED",
            "This question was already answered or dismissed",
            409,
          );
        }
        const left = pending.filter((question) => !answers.includes(question.itemId));
        return {
          ...(options.agent ? {} : { seenAt: this.service.now(), unseenOutcome: null }),
          ...(current.queueHeld && !options.agent ? { queueHeld: false } : {}),
          ...(left.length === pending.length
            ? {}
            : {
                pendingQuestions: left,
                ...resolveTaskStatus(
                  { ...current, pendingQuestions: left },
                  { kind: "question_resolved" },
                ),
              }),
        };
      });
      if (task.limited && !options.agent) {
        await this.limits?.resumeLocked(task);
        task = await this.service.task(taskId);
      }
      const busy =
        this.activeMessageRuns(taskId) > 0 ||
        !!task.queue?.length ||
        (options.agent === true && (!!task.queueHeld || !!task.limited));
      // Only a person's task steers; a steer to an inbox or routine task queues (R5-8).
      const steer = message.mode === "steer" && task.kind === "task" && !options.agent;
      if (steer || !busy) {
        return this.service.sendMessage(taskId, message, undefined, answers);
      }
      const run = await this.enqueue(task, message.text, answers);
      await this.drainLocked(taskId);
      return { task: await this.service.task(taskId), run };
    });
  }

  edit(taskId: string, runId: string, text: string): Promise<TaskQueue> {
    return this.locked(taskId, async () => {
      await this.entry(taskId, runId);
      return view(
        await this.update(taskId, (task) => ({
          queue: (task.queue ?? []).map((e) => (e.runId === runId ? { ...e, text } : e)),
        })),
      );
    });
  }

  /** `runIds` must list exactly the queued entries, in their new order. */
  reorder(taskId: string, runIds: string[]): Promise<TaskQueue> {
    return this.locked(taskId, async () => {
      const task = await this.service.task(taskId);
      const queue = task.queue ?? [];
      const same =
        runIds.length === queue.length &&
        new Set(runIds).size === runIds.length &&
        queue.every((e) => runIds.includes(e.runId));
      if (!same) {
        throw new ApiError("QUEUE_CHANGED", "runIds must list every queued message once", 409);
      }
      const order = new Map(runIds.map((id, index) => [id, index]));
      const sorted = [...queue].sort(
        (a, b) => (order.get(a.runId) ?? 0) - (order.get(b.runId) ?? 0),
      );
      return view(await this.update(taskId, { queue: sorted }));
    });
  }

  /** Removes a queued message; its TaskRun ends `cancelled` (`QUEUE_REMOVED`) without running. */
  remove(taskId: string, runId: string): Promise<TaskQueue> {
    return this.locked(taskId, async () => {
      await this.entry(taskId, runId);
      const task = await this.take(taskId, runId);
      await this.endPlaceholder(runId, "QUEUE_REMOVED");
      return view(task);
    });
  }

  /** Sends a queued message now as a steer (cancels the active message run and restarts). */
  promote(taskId: string, runId: string): Promise<{ task: Task; run: TaskRun }> {
    return this.locked(taskId, async () => {
      const entry = await this.entry(taskId, runId);
      await this.take(taskId, runId);
      return this.service.sendMessage(
        taskId,
        { text: entry.text, mode: "steer" },
        runId,
        entry.answers,
      );
    });
  }

  resume(taskId: string): Promise<TaskQueue> {
    return this.locked(taskId, async () => {
      await this.update(taskId, { queueHeld: false });
      await this.drainLocked(taskId);
      return view(await this.service.task(taskId));
    });
  }

  /**
   * `POST /api/tasks/:id/interrupt`: hold the queue, then stop every cancellable run. The hold is
   * set even with nothing queued: it records the Stop, so subtasks finishing later notify the
   * task without waking it, and an agent's message waits, until the person's next message or
   * `/queue/resume` (R1-13).
   */
  async interrupt(taskId: string): Promise<Task> {
    await this.hold(taskId, true);
    await this.service.interrupt(taskId);
    return this.service.task(taskId);
  }

  /** Holds a non-empty queue (or any, with `always`) so runs ending now do not start the next message. */
  hold(taskId: string, always = false): Promise<void> {
    return this.locked(taskId, async () => {
      const task = await this.service.task(taskId);
      if ((always || task.queue?.length) && !task.queueHeld) {
        await this.update(taskId, { queueHeld: true });
      }
    });
  }

  /** Starts the next queued message when nothing holds the queue and no message run is active. */
  drain(taskId: string): Promise<void> {
    return this.locked(taskId, () => this.drainLocked(taskId));
  }

  /** Runner hook: a message run ended, so the next queued message may start. */
  async onRunEnded(run: TaskRun): Promise<void> {
    if (run.trigger.kind === "message") {
      await this.drain(run.taskId);
    }
  }

  /** Serializes queue changes per task. */
  locked<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(taskId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.chains.set(taskId, settled);
    void settled.finally(() => {
      if (this.chains.get(taskId) === settled) {
        this.chains.delete(taskId);
      }
    });
    return next;
  }

  async drainLocked(taskId: string): Promise<void> {
    const task = await this.service.task(taskId);
    const [entry] = task.queue ?? [];
    const away = task.status === "settled" || task.status === "archived";
    if (!entry || task.queueHeld || task.limited || away || this.activeMessageRuns(taskId)) {
      return;
    }
    await this.take(taskId, entry.runId);
    try {
      await this.service.sendMessage(
        taskId,
        { text: entry.text, mode: "queue" },
        entry.runId,
        entry.answers,
      );
    } catch {
      // The entry already left the queue; end its run so it does not look queued forever.
      logger.warn("Queued task message could not start");
      await this.endPlaceholder(entry.runId, "QUEUE_FAILED").catch(() => undefined);
    }
  }

  private activeMessageRuns(taskId: string): number {
    return this.service.runner.activeRuns(taskId).filter((run) => run.trigger.kind === "message")
      .length;
  }

  private async enqueue(task: Task, text: string, answers: string[] = []): Promise<TaskRun> {
    if ((task.queue?.length ?? 0) >= TASK_LIMITS.queueMax) {
      throw new ApiError("QUEUE_FULL", `At most ${TASK_LIMITS.queueMax} queued messages`, 409);
    }
    const now = this.service.now();
    const id = newId();
    // `itemId` stays empty until the message starts and its `user_message` item exists.
    const run = await this.service.tasks.runs.insert({
      id,
      taskId: task.id,
      status: "queued",
      trigger: { kind: "message", itemId: "", mode: "queue" },
      priority: "interactive",
      agentRunId: id,
      createdAt: now,
      actionIds: [],
    });
    this.service.options.bus.emit({ type: "task.run.updated", run });
    const entry: TaskQueueEntry = {
      runId: id,
      text,
      createdAt: now,
      ...(answers.length ? { answers } : {}),
    };
    await this.update(task.id, (current) => ({ queue: [...(current.queue ?? []), entry] }));
    return run;
  }

  private async entry(taskId: string, runId: string): Promise<TaskQueueEntry> {
    const entry = (await this.service.task(taskId)).queue?.find((e) => e.runId === runId);
    if (!entry) {
      throw new ApiError("NOT_FOUND", "Queued message not found", 404);
    }
    return entry;
  }

  private take(taskId: string, runId: string): Promise<Task> {
    return this.update(taskId, (task) => ({
      queue: (task.queue ?? []).filter((e) => e.runId !== runId),
    }));
  }

  private async endPlaceholder(runId: string, error: string): Promise<void> {
    const run = await this.service.tasks.runs.update(runId, {
      status: "cancelled",
      endedAt: this.service.now(),
      error,
    });
    this.service.options.bus.emit({ type: "task.run.updated", run });
  }

  private update(taskId: string, patch: Partial<Task> | ((task: Task) => Partial<Task>)) {
    return this.service.runner.updateTask(taskId, patch);
  }
}

function view(task: Task): TaskQueue {
  return { taskId: task.id, held: task.queueHeld === true, entries: task.queue ?? [] };
}
