import type { AgentRunResult } from "@passport/agent";
import { newId } from "@passport/store";
import {
  type AgentRun,
  type AgentRuntime,
  type CreateTaskInput,
  type EventBus,
  minTrust,
  type Page,
  type PolicyEngine,
  type Store,
  type StoreTasks,
  type Task,
  type TaskDetail,
  type TaskItem,
  type TaskMessage,
  type TaskPatch,
  type TaskQuery,
  type TaskRun,
  type TrustLevel,
  taskTitleFrom,
} from "@passport/types";
import { ApiError } from "../errors.js";
import { type RunCeilings, type RunDescription, TaskRunner } from "./runner.js";
import { idleStatus } from "./status.js";
import { frameUntrusted } from "./untrusted.js";

export interface TaskServiceOptions {
  store: Store;
  bus: EventBus;
  policy: PolicyEngine;
  agent: AgentRuntime;
  ceilings: RunCeilings;
  now?: () => string;
}

const HISTORY_CHARS = 6000;

/** Agent results → TaskRun fields. */
export function describeAgentRun(run: AgentRun): RunDescription {
  const budget = (run as Partial<AgentRunResult>).toolBudget;
  return {
    summary: run.summary,
    error: run.error ?? null,
    usage: budget
      ? {
          llmCalls: budget.llmCalls,
          toolCalls: budget.callsMade,
          inputTokens: budget.inputTokens,
          outputTokens: budget.outputTokens,
        }
      : null,
  };
}

/**
 * Tasks: creation, messages (queue / steer), interrupt and lifecycle. Runs execute through the
 * injected `AgentRuntime` in the interactive lane; see `TaskRunner` for the timeline.
 */
export class TaskService {
  readonly tasks: StoreTasks;
  readonly runner: TaskRunner;
  readonly now: () => string;
  /** Request texts of active message runs, for a steer's restart (R4-19). */
  private readonly requests = new Map<string, string[]>();

  constructor(readonly options: TaskServiceOptions) {
    const tasks = options.store.tasks;
    if (!tasks) {
      throw new ApiError("TASKS_UNAVAILABLE", "This store does not keep tasks", 501);
    }
    this.tasks = tasks;
    this.now = options.now ?? (() => new Date().toISOString());
    this.runner = new TaskRunner(options.store, tasks, options.bus, options.ceilings, this.now);
  }

  close(): void {
    this.runner.close();
  }

  /** Marks runs a previous process left open as failed (T3: "interrupted by a server restart"). */
  async recover(): Promise<void> {
    for (const run of await this.tasks.runs.unfinished()) {
      const done = await this.tasks.runs.update(run.id, {
        status: "failed",
        endedAt: this.now(),
        error: "SERVER_RESTARTED",
      });
      this.options.bus.emit({ type: "task.run.updated", run: done });
      const task = await this.tasks.get(run.taskId);
      if (task?.status === "working") {
        await this.runner.updateTask(task.id, {
          status: idleStatus(task),
          ...(run.trigger.kind === "message" ? { needsUser: "failure" as const } : {}),
        });
      }
    }
  }

  list(q: TaskQuery): Promise<Page<Task>> {
    return this.tasks.list(q);
  }

  async get(id: string): Promise<TaskDetail> {
    return { task: await this.task(id), runs: await this.tasks.runs.list(id, 50) };
  }

  async items(id: string, afterSeq?: number, limit?: number): Promise<TaskItem[]> {
    await this.task(id);
    return this.tasks.items.list({ taskId: id, afterSeq, limit });
  }

  async task(id: string): Promise<Task> {
    const task = await this.tasks.get(id);
    if (!task) {
      throw new ApiError("NOT_FOUND", "Task not found", 404);
    }
    return task;
  }

  /** The requested mode, never above the global trust dial or the parent task's mode. */
  async clampMode(requested: TrustLevel | undefined, parentTaskId?: string | null) {
    const config = await this.options.policy.getConfig();
    let level = minTrust(requested ?? config.globalMode, config.globalMode);
    if (parentTaskId) {
      level = minTrust(level, await this.runner.effectiveMode(await this.task(parentTaskId)));
    }
    return level;
  }

  /** Creates a task and its first run; `done` settles when that run ends. */
  async create(
    input: CreateTaskInput,
  ): Promise<{ task: Task; run: TaskRun; done: Promise<AgentRun> }> {
    const now = this.now();
    const accountIds = input.accountIds?.length
      ? input.accountIds
      : (await this.options.store.accounts.list()).map((account) => account.id);
    const task = await this.tasks.insert({
      id: newId(),
      title: input.title?.trim() ? taskTitleFrom(input.title) : taskTitleFrom(input.message),
      accountIds,
      status: "working",
      pinned: false,
      permissionMode: await this.clampMode(input.permissionMode, input.parentTaskId),
      interactionMode: input.interactionMode ?? "default",
      createdBy: input.createdBy ?? "user",
      kind: "task",
      parentTaskId: input.parentTaskId ?? null,
      needsUser: null,
      lastActivityAt: now,
      createdAt: now,
      watches: [],
      pendingActionIds: [],
    });
    this.options.bus.emit({ type: "task.updated", task });
    const started = await this.message(task, { text: input.message, mode: "queue" }, input);
    return { task: await this.task(task.id), ...started };
  }

  /** A follow-up: `queue` runs after the active run; `steer` restarts it with both messages. */
  async sendMessage(id: string, message: TaskMessage) {
    const task = await this.task(id);
    if (task.kind !== "task" && message.mode === "steer") {
      message = { ...message, mode: "queue" };
    }
    const { run } = await this.message(task, message);
    return { task: await this.task(id), run };
  }

  private async message(
    task: Task,
    message: TaskMessage,
    context: Pick<CreateTaskInput, "emailIds" | "matterId"> = {},
  ) {
    const mode = message.mode ?? "queue";
    let steered: string[] = [];
    if (mode === "steer") {
      steered = await this.cancelForSteer(task.id);
    }
    const runId = newId();
    const item = await this.runner.appendItem({
      taskId: task.id,
      runId,
      kind: "user_message",
      at: this.now(),
      payload: { text: message.text },
    });
    const texts = [...steered, message.text];
    this.requests.set(runId, texts);
    const instruction = await this.instruction(task, texts, item.seq);
    let created!: (run: TaskRun) => void;
    const persisted = new Promise<TaskRun>((resolve) => {
      created = resolve;
    });
    const done = this.runner.execute(
      {
        taskId: task.id,
        trigger: { kind: "message", itemId: item.id, mode },
        priority: "interactive",
        runId,
        cancellable: true,
        onCreated: created,
      },
      (options) =>
        this.options.agent.run(
          {
            kind: "manual",
            instruction,
            ...(context.emailIds?.length ? { emailIds: context.emailIds } : {}),
            ...(context.matterId ? { matterId: context.matterId } : {}),
          },
          options,
        ),
      describeAgentRun,
    );
    // Callers that do not await `done` still see the outcome on the run and the timeline.
    done.catch(() => undefined).finally(() => this.requests.delete(runId));
    const run = await Promise.race([persisted, done.then(() => null)]);
    return { run: run ?? (await persisted), done };
  }

  /** Cancels the task's cancellable message runs; returns their messages for the restart. */
  private async cancelForSteer(taskId: string): Promise<string[]> {
    const texts: string[] = [];
    for (const run of this.runner.activeRuns(taskId)) {
      if (run.trigger.kind !== "message" || !this.runner.cancel(run.id, true)) {
        continue;
      }
      texts.push(...(this.requests.get(run.id) ?? []));
    }
    return texts;
  }

  private async instruction(task: Task, texts: string[], beforeSeq: number): Promise<string> {
    const recent = (
      await this.tasks.items.recent(
        task.id,
        ["user_message", "assistant_message", "notification"],
        16,
      )
    )
      .filter((item) => item.seq < beforeSeq)
      .reverse();
    let history = "";
    for (const item of recent) {
      const line =
        item.kind === "user_message"
          ? `Person: ${item.payload.text}`
          : item.kind === "assistant_message"
            ? `You: ${item.payload.text}`
            : item.kind === "notification"
              ? `Notification: ${item.payload.summary}`
              : "";
      history = `${history}${line}\n`.slice(-HISTORY_CHARS);
    }
    const parts = [
      `You are working on the task "${task.title}" (task id ${task.id}).`,
      task.interactionMode === "plan"
        ? "Plan mode: investigate with read tools and answer with a concrete numbered proposal list. Write tools do not execute in this mode."
        : "",
      history ? `Earlier in this task:\n${frameUntrusted("task-history", history)}` : "",
      texts.length > 1
        ? `The person's request (they added to it while you worked):\n${texts.join("\n\n")}`
        : `The person's request:\n${texts[0] ?? ""}`,
    ];
    return parts.filter(Boolean).join("\n\n");
  }

  /** Stops every cancellable run of the task. */
  async interrupt(id: string): Promise<Task> {
    const task = await this.task(id);
    for (const run of this.runner.activeRuns(id)) {
      this.runner.cancel(run.id);
    }
    return task;
  }

  async snooze(id: string, until: string): Promise<Task> {
    if (!Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.parse(this.now())) {
      throw new ApiError("INVALID_FIELD", "until must be a future ISO timestamp");
    }
    await this.task(id);
    return this.runner.updateTask(id, {
      status: "snoozed",
      snoozedUntil: new Date(until).toISOString(),
    });
  }

  /**
   * Settle and archive end conversation watches (T3: a settled thread stops monitoring) and stop
   * the task's cancellable runs; the person's choice outlasts the runs that end (R4-9).
   */
  async settle(id: string): Promise<Task> {
    await this.interrupt(id);
    return this.runner.updateTask(id, {
      status: "settled",
      settledAt: this.now(),
      watches: [],
      snoozedUntil: null,
    });
  }

  async archive(id: string): Promise<Task> {
    await this.interrupt(id);
    return this.runner.updateTask(id, { status: "archived", watches: [], snoozedUntil: null });
  }

  async pin(id: string, pinned: boolean): Promise<Task> {
    await this.task(id);
    return this.runner.updateTask(id, { pinned });
  }

  async unwatch(id: string, threadHandle?: string): Promise<Task> {
    await this.task(id);
    const running = this.runner.activeRuns(id).length > 0;
    return this.runner.updateTask(id, (task) => {
      const watches = threadHandle
        ? task.watches.filter((w) => w.threadHandle !== threadHandle)
        : [];
      const back = !running && task.status === "working" && !watches.length;
      return { watches, ...(back ? { status: "inbox" as const, lastActivityAt: this.now() } : {}) };
    });
  }

  async patch(id: string, patch: TaskPatch): Promise<Task> {
    const task = await this.task(id);
    const permissionMode =
      patch.permissionMode === undefined
        ? undefined
        : await this.clampMode(patch.permissionMode, task.parentTaskId);
    return this.runner.updateTask(id, {
      ...(patch.title === undefined ? {} : { title: taskTitleFrom(patch.title) }),
      ...(permissionMode ? { permissionMode, permissionModePinned: true } : {}),
      ...(patch.interactionMode ? { interactionMode: patch.interactionMode } : {}),
    });
  }

  /** Auto-settle idle inbox tasks and wake snoozed ones whose time came. */
  async maintain(): Promise<{ settled: number; woken: number }> {
    const now = this.now();
    let settled = 0;
    let woken = 0;
    let cursor: string | null | undefined;
    const due: string[] = [];
    do {
      const page = await this.tasks.list({ status: ["snoozed"], limit: 200, cursor });
      for (const task of page.items) {
        if (task.snoozedUntil && task.snoozedUntil <= now) {
          due.push(task.id);
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    for (const id of due) {
      await this.runner.updateTask(id, {
        status: "inbox",
        snoozedUntil: null,
        lastActivityAt: now,
      });
      woken++;
    }
    const cutoff = new Date(Date.parse(now) - 3 * 86_400_000).toISOString();
    do {
      const page = await this.tasks.list({ status: ["inbox"], limit: 200, cursor });
      for (const task of page.items) {
        const idle = task.lastActivityAt < cutoff && !task.pinned && !task.needsUser;
        if (idle && !this.runner.activeRuns(task.id).length) {
          await this.runner.updateTask(task.id, { status: "settled", settledAt: now });
          settled++;
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { settled, woken };
  }
}
