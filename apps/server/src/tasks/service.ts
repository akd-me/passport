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
  type TaskByAction,
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
import { contextItems, taskByAction } from "./context.js";
import { answeredRequest } from "./questions.js";
import { type RunCeilings, type RunDescription, TaskRunner } from "./runner.js";
import { taskSessionOptions } from "./session.js";
import { resolveTaskStatus } from "./status.js";
import { frameUntrusted, taskLabel } from "./untrusted.js";

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

  /**
   * Creates a task and its first run; `done` settles when that run ends. `system` carries
   * server-owned fields (a fixed id, voice learning, a subtask's `delegation`).
   */
  async create(
    input: CreateTaskInput,
    system: Pick<Partial<Task>, "id" | "voiceLearning" | "delegation"> = {},
  ): Promise<{ task: Task; run: TaskRun; done: Promise<AgentRun> }> {
    const now = this.now();
    const accountIds = input.accountIds?.length
      ? input.accountIds
      : (await this.options.store.accounts.list()).map((account) => account.id);
    const task = await this.tasks.insert({
      id: system.id ?? newId(),
      ...(system.voiceLearning ? { voiceLearning: system.voiceLearning } : {}),
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
      ...(system.delegation ? { delegation: system.delegation } : {}),
    });
    this.options.bus.emit({ type: "task.updated", task });
    const started = await this.message(task, { text: input.message, mode: "queue" }, input);
    return { task: await this.task(task.id), ...started };
  }

  /**
   * A follow-up: `queue` runs after the active run; `steer` restarts it with both messages.
   * `runId` starts a queued entry under the TaskRun id it was given (`TaskQueue`). `answers`
   * lists the `question` items the message answers (v0.4).
   */
  async sendMessage(id: string, message: TaskMessage, runId?: string, answers?: string[]) {
    const task = await this.task(id);
    if (task.kind !== "task" && message.mode === "steer") {
      message = { ...message, mode: "queue" };
    }
    const { run } = await this.message(task, message, {}, runId, answers);
    return { task: await this.task(id), run };
  }

  private async message(
    task: Task,
    message: TaskMessage,
    context: Pick<CreateTaskInput, "emailIds" | "matterId"> = {},
    presetRunId?: string,
    answers?: string[],
  ) {
    const mode = message.mode ?? "queue";
    let steered: string[] = [];
    if (mode === "steer") {
      steered = await this.cancelForSteer(task.id);
    }
    const runId = presetRunId ?? newId();
    const item = await this.runner.appendItem({
      taskId: task.id,
      runId,
      kind: "user_message",
      at: this.now(),
      payload: { text: message.text, ...(answers?.length ? { answers } : {}) },
    });
    const request = answers?.length
      ? await answeredRequest(this.tasks, task, answers, message.text)
      : message.text;
    const texts = [...steered, request];
    this.requests.set(runId, texts);
    const instruction = await this.instruction(task, texts, item.seq);
    const session = this.sessionOptions(task.id, { texts, beforeSeq: item.seq });
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
        request: texts,
        items: await contextItems(this.options.store, context),
      },
      (options) =>
        this.options.agent.run(
          {
            kind: "manual",
            instruction,
            ...(context.emailIds?.length ? { emailIds: context.emailIds } : {}),
            ...(context.matterId ? { matterId: context.matterId } : {}),
          },
          { ...options, session },
        ),
      describeAgentRun,
    );
    // Callers that do not await `done` still see the outcome on the run and the timeline.
    done.catch(() => undefined).finally(() => this.requests.delete(runId));
    const run = await Promise.race([persisted, done.then(() => null)]);
    return { run: run ?? (await persisted), done };
  }

  /** How a run of this task resumes its provider session (W1A); see `session.ts`. */
  sessionOptions(taskId: string, request: Parameters<typeof taskSessionOptions>[3]) {
    return taskSessionOptions(this.options.store, this.tasks, taskId, request);
  }

  /** The task and run behind an action (`GET /api/tasks/by-action/:actionId`). */
  byAction(actionId: string): Promise<TaskByAction> {
    return taskByAction(this.options.store, this.tasks, actionId);
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
    const history = await this.history(task, beforeSeq);
    const from = task.delegation
      ? "The request from your parent task (another Passport agent working for the same person)"
      : "The person's request";
    const parts = [
      `You are working on ${taskLabel(task)}.`,
      task.delegation
        ? "This task is a subtask: your parent task's agent delegated it and reads your final reply. Ask it, not the person, with ask_user."
        : "",
      task.interactionMode === "plan"
        ? "Plan mode: investigate with read tools and answer with a concrete numbered proposal list. Write tools do not execute in this mode."
        : "",
      history,
      texts.length > 1
        ? `${from} (${task.delegation ? "added to" : "they added to it"} while you worked):\n${texts.join("\n\n")}`
        : `${from}:\n${texts[0] ?? ""}`,
    ];
    return parts.filter(Boolean).join("\n\n");
  }

  /**
   * Up to 16 recent user, assistant and notification items before `beforeSeq`, framed as
   * untrusted data ("Earlier in this task"), or "" when there are none. Continuations reuse it.
   */
  async history(task: Task, beforeSeq: number): Promise<string> {
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
    return history ? `Earlier in this task:\n${frameUntrusted("task-history", history)}` : "";
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
    return this.runner.updateTask(id, (current) => ({
      status: "settled",
      settledAt: this.now(),
      watches: [],
      snoozedUntil: null,
      ...noAutoResume(current),
    }));
  }

  async archive(id: string): Promise<Task> {
    await this.interrupt(id);
    return this.runner.updateTask(id, (current) => ({
      status: "archived",
      watches: [],
      snoozedUntil: null,
      ...noAutoResume(current),
    }));
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

  /**
   * Auto-settle idle inbox tasks and wake snoozed ones whose time came. Each write re-checks the
   * task it read, so a person's change in between wins, and a wake goes through the status rules
   * (`reopened`: Working while it watches or waits on subtasks) (R1-27).
   */
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
      let woke = false;
      await this.runner.updateTask(id, (current) => {
        woke =
          current.status === "snoozed" && !!current.snoozedUntil && current.snoozedUntil <= now;
        return woke
          ? {
              ...resolveTaskStatus(current, {
                kind: "reopened",
                activeRuns: this.runner.activeRuns(id).length,
                now,
              }),
              unseenOutcome: "woke" as const,
            }
          : {};
      });
      woken += woke ? 1 : 0;
    }
    const cutoff = new Date(Date.parse(now) - 3 * 86_400_000).toISOString();
    do {
      const page = await this.tasks.list({ status: ["inbox"], limit: 200, cursor });
      for (const task of page.items) {
        const idle = task.lastActivityAt < cutoff && !task.pinned && !task.needsUser;
        if (idle && !this.runner.activeRuns(task.id).length) {
          let done = false;
          await this.runner.updateTask(task.id, (current) => {
            done =
              current.status === "inbox" &&
              !current.pinned &&
              !current.needsUser &&
              current.lastActivityAt < cutoff;
            return done ? { status: "settled" as const, settledAt: now } : {};
          });
          settled += done ? 1 : 0;
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { settled, woken };
  }
}

/** Settle and archive end a pending resume-at-reset: the timer must not bring the task back (R1-15). */
function noAutoResume(task: Task): Partial<Task> {
  return task.limited?.autoResume ? { limited: { ...task.limited, autoResume: false } } : {};
}
