import {
  SUBTASK_LIMITS,
  type Task,
  type TaskDelegateInput,
  type TaskItemInput,
  type TaskLineage,
  type TaskPendingQuestion,
  type TaskRun,
  type TaskSubtaskStatus,
  type TaskToolCaller,
  type TaskWorkState,
} from "@passport/types";
import { ApiError } from "../errors.js";
import type { TaskQuestions } from "./questions.js";
import type { TaskQueueService } from "./queue.js";
import { describeAgentRun, type TaskService } from "./service.js";
import { idleStatus } from "./status.js";
import { clip, frameUntrusted, neutralize, taskLabel } from "./untrusted.js";

/** The wake run reason for subtask completions; one active wake absorbs later ones. */
export const SUBTASK_WAKE = "subtasks";
const RESULT_MAX = 2000;
const SUMMARY_RESULT = 300;

/**
 * Subtasks (T3 `delegate_task`): `task_delegate` starts a child `kind: "task"` with
 * `parentTaskId` and `delegation`, never above the parent's effective mode or accounts and at
 * most two deep. When a child's work ends, the parent gets a `notification` (`source:
 * "subtask"`) and wakes per `completionWake`; completions that arrive before that wake starts
 * join it. A child's question is forwarded to the parent as a notification. Agents have no
 * approval tool, so a child's proposals wait for the person on the child task.
 */
export class TaskSubtasks {
  questions?: TaskQuestions;
  /** Completions per parent, one at a time, so a second one finds the first one's wake. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Delegations per parent, one at a time, so parallel tool calls respect the limits (R1-35). */
  private readonly delegations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly service: TaskService,
    private readonly queue: TaskQueueService,
  ) {}

  delegate(caller: TaskToolCaller, input: TaskDelegateInput): Promise<TaskSubtaskStatus> {
    return serial(this.delegations, caller.taskId, () => this.delegateLocked(caller, input));
  }

  private async delegateLocked(
    caller: TaskToolCaller,
    input: TaskDelegateInput,
  ): Promise<TaskSubtaskStatus> {
    const parent = await this.service.task(caller.taskId);
    // Defence in depth for R1-1: mail-driven and scheduled runs never start or steer subtasks.
    const trigger = (await this.runOf(caller))?.trigger.kind;
    if (parent.kind === "inbox" || trigger === "arrival" || trigger === "schedule") {
      throw new ApiError(
        "DELEGATE_UNAVAILABLE",
        "Arrival triage and scheduled runs cannot start subtasks; do the work in this run.",
        409,
      );
    }
    if (parent.status === "settled" || parent.status === "archived") {
      throw new ApiError(
        "TASK_SETTLED",
        "The person settled or archived this task; it cannot start subtasks.",
        409,
      );
    }
    if (input.taskId) {
      return this.followUp(parent, input.taskId, input);
    }
    // The real ancestry, not only `delegation.depth`: fresh routine children and tasks created
    // with `parentTaskId` count too (R1-14).
    const depth = Math.max(await this.ancestors(parent), parent.delegation?.depth ?? 0) + 1;
    if (depth > SUBTASK_LIMITS.maxDepth) {
      throw new ApiError(
        "DEPTH_LIMIT",
        `Subtasks nest at most ${SUBTASK_LIMITS.maxDepth} deep; do this part yourself.`,
        409,
      );
    }
    const active = (await this.children(parent.id)).filter((child) => this.working(child));
    if (active.length >= SUBTASK_LIMITS.maxActive) {
      throw new ApiError(
        "SUBTASK_LIMIT",
        `At most ${SUBTASK_LIMITS.maxActive} subtasks may work at once; wait for some to finish.`,
        409,
      );
    }
    const accountIds = input.accountIds ?? parent.accountIds;
    if (accountIds.some((id) => !parent.accountIds.includes(id))) {
      throw new ApiError("ACCOUNT_MISMATCH", "A subtask can only use this task's accounts.", 400);
    }
    const requested = input.permissionMode === "inherit" ? undefined : input.permissionMode;
    const { task } = await this.service.create(
      {
        message: input.message,
        ...(input.title ? { title: neutralize(input.title) } : {}),
        accountIds,
        // `clampMode` keeps it at or below the parent's effective mode and the trust dial.
        permissionMode: await this.service.clampMode(requested, parent.id),
        interactionMode: parent.interactionMode,
        parentTaskId: parent.id,
        createdBy: "agent",
      },
      {
        delegation: {
          parentRunId: (await this.runOf(caller))?.id ?? null,
          mode: input.mode,
          completionWake: input.completionWake,
          depth,
          delegatedAt: this.service.now(),
        },
      },
    );
    if (input.mode === "wait") {
      await this.service.runner.updateTask(parent.id, (current) => ({
        waitingOnTaskIds: [...new Set([...(current.waitingOnTaskIds ?? []), task.id])],
      }));
    }
    return this.describe(await this.service.task(task.id));
  }

  /** The caller's subtasks (newest first), or one of them. */
  async status(caller: TaskToolCaller, childId?: string): Promise<TaskSubtaskStatus[]> {
    const parent = await this.service.task(caller.taskId);
    if (childId) {
      return [await this.describe(await this.childOf(parent, childId))];
    }
    return Promise.all((await this.children(parent.id)).map((child) => this.describe(child)));
  }

  /**
   * Stops a subtask like the person's Stop (its queue is held), its own subtasks first, and drops
   * its open questions. Its end does not wake the parent; proposals stay for the person.
   */
  async cancel(caller: TaskToolCaller, childId: string): Promise<TaskSubtaskStatus> {
    const parent = await this.service.task(caller.taskId);
    const child = await this.childOf(parent, childId);
    await this.stopTree(child, parent.id);
    return this.describe(await this.service.task(child.id));
  }

  /** `GET /api/tasks/:id/lineage`: the parent and the children, for the Lineage panel. */
  async lineage(taskId: string): Promise<TaskLineage> {
    const task = await this.service.task(taskId);
    const parent = task.parentTaskId ? await this.service.tasks.get(task.parentTaskId) : null;
    const children = (await this.service.tasks.list({ parentTaskId: task.id, limit: 50 })).items;
    return {
      taskId: task.id,
      parent,
      children: await Promise.all(
        children.map(async (child) => ({
          task: child,
          activeRuns: this.service.runner.activeRuns(child.id).length,
          lastRunStatus: (await this.service.tasks.runs.list(child.id, 1))[0]?.status ?? null,
        })),
      ),
    };
  }

  /** A subtask asked: tell the parent (never the person); the parent wakes when the child stops. */
  async forwardQuestion(child: Task, question: TaskPendingQuestion): Promise<void> {
    if (!child.parentTaskId) {
      return;
    }
    const options = question.options?.length
      ? ` Options: ${question.options.map((o) => JSON.stringify(o)).join(", ")}.`
      : "";
    await this.service.runner.appendItem(
      this.notification(
        child.parentTaskId,
        child,
        `Subtask “${clip(child.title, 80)}” asks: ${JSON.stringify(question.text)}.${options} Answer with task_delegate and its taskId.`,
      ),
    );
  }

  /** Runner hook (`afterRunEnded`): a subtask's work ended, so its parent hears of it. */
  async afterRunEnded(run: TaskRun): Promise<void> {
    const child = await this.service.tasks.get(run.taskId);
    if (!child?.delegation || !child.parentTaskId) {
      return;
    }
    const parentId = child.parentTaskId;
    const previous = this.chains.get(parentId) ?? Promise.resolve();
    const next = previous.then(() => this.completed(child.id, parentId, run));
    const settled = next.catch(() => undefined);
    this.chains.set(parentId, settled);
    void settled.finally(() => {
      if (this.chains.get(parentId) === settled) {
        this.chains.delete(parentId);
      }
    });
    await next;
  }

  private async completed(childId: string, parentId: string, run: TaskRun): Promise<void> {
    const child = await this.service.tasks.get(childId);
    if (!child?.delegation || this.working(child)) {
      return;
    }
    const parent = await this.service.tasks.get(parentId);
    if (!parent) {
      return;
    }
    const wasWaiting = parent.waitingOnTaskIds?.includes(child.id) ?? false;
    if (wasWaiting) {
      await this.service.runner.updateTask(parent.id, (current) => ({
        waitingOnTaskIds: (current.waitingOnTaskIds ?? []).filter((id) => id !== child.id),
      }));
    }
    if (child.delegation.cancelledByParent) {
      return;
    }
    const question = (child.pendingQuestions?.length ?? 0) > 0;
    // The question itself was forwarded when it was asked.
    const summary = question ? null : clip(await this.outcome(child, run), 600);
    // The person put the child away or stopped it: the parent hears of it but is not woken to
    // undo that (R1-12). A parent the person stopped, settled or archived, or that is stopped at
    // a usage limit, is not woken either (R1-13).
    const childAway =
      run.status === "cancelled" ||
      child.status === "settled" ||
      child.status === "archived" ||
      child.queueHeld === true;
    const parentAway =
      parent.status === "settled" ||
      parent.status === "archived" ||
      parent.queueHeld === true ||
      !!parent.limited;
    const wake =
      !childAway &&
      !parentAway &&
      (question ||
        wasWaiting ||
        child.delegation.completionWake === "always" ||
        !(await this.children(parent.id)).some((other) => this.working(other)));
    if (wake) {
      await this.wake(parent, child, summary);
      return;
    }
    if (summary) {
      await this.service.runner.appendItem(this.notification(parent.id, child, summary));
    }
    if (wasWaiting) {
      // Not woken: a parent that rested in Working for this child comes back to the inbox.
      await this.service.runner.updateTask(parent.id, (current) =>
        current.status === "working" &&
        !this.service.runner.activeRuns(parent.id).length &&
        idleStatus(current) === "inbox"
          ? { status: "inbox" as const, lastActivityAt: this.service.now() }
          : {},
      );
    }
  }

  /**
   * Starts the parent's wake run, or joins the subtask wake already active. The agent lane runs
   * one run at a time, so a wake that is running now started after this child's run ended: its
   * `task_status` call (the wake prompt asks for one) already sees this result.
   */
  private async wake(parent: Task, child: Task, summary: string | null): Promise<void> {
    const active = this.service.runner
      .activeRuns(parent.id)
      .find((run) => run.trigger.kind === "wake" && run.trigger.reason === SUBTASK_WAKE);
    if (active) {
      if (summary) {
        await this.service.runner.appendItem({
          ...this.notification(parent.id, child, summary),
          runId: active.id,
        });
      }
      return;
    }
    const instruction = [
      `You are working on ${taskLabel(parent)}.`,
      "Your subtasks reported back. Call task_status for every subtask's current result, answer any question with task_delegate and its taskId, then continue the request or hand back to the person.",
      summary ? frameUntrusted("subtask-report", summary) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    let created!: (run: TaskRun) => void;
    const persisted = new Promise<TaskRun>((resolve) => {
      created = resolve;
    });
    const done = this.service.runner.execute(
      {
        taskId: parent.id,
        trigger: { kind: "wake", reason: SUBTASK_WAKE },
        priority: "background",
        cancellable: true,
        onCreated: created,
        ...(summary
          ? {
              items: [
                {
                  kind: "notification" as const,
                  untrusted: true,
                  payload: { source: "subtask" as const, summary, subtaskId: child.id },
                },
              ],
            }
          : {}),
      },
      (options) =>
        this.service.options.agent.run(
          { kind: "manual", instruction },
          {
            ...options,
            priority: "background",
            session: {
              ...this.service.sessionOptions(parent.id, { instruction }),
              ...options.session,
            },
          },
        ),
      describeAgentRun,
    );
    // The outcome is on the run and the timeline.
    done.catch(() => undefined);
    // Registered as active before the next completion looks for it.
    await Promise.race([
      persisted,
      done.then(
        () => null,
        () => null,
      ),
    ]);
  }

  private notification(parentId: string, child: Task, summary: string): TaskItemInput {
    return {
      taskId: parentId,
      runId: null,
      kind: "notification",
      at: this.service.now(),
      untrusted: true,
      payload: { source: "subtask", summary: clip(summary, 600), subtaskId: child.id },
    };
  }

  /** One line for the parent: how the child's run ended and its reply. */
  private async outcome(child: Task, run: TaskRun): Promise<string> {
    const name = `Subtask “${clip(child.title, 80)}”`;
    const approvals = child.pendingActionIds?.length ?? 0;
    const waits =
      approvals > 0
        ? ` ${approvals === 1 ? "1 proposal waits" : `${approvals} proposals wait`} for the person.`
        : "";
    if (run.status === "cancelled") {
      return `${name} was stopped.${waits}`;
    }
    if (run.status === "failed") {
      return child.needsUser === "limited"
        ? `${name} stopped at a usage limit.${waits}`
        : `${name} failed (${run.error ?? "RUN_FAILED"}).${waits}`;
    }
    const reply = await this.reply(child.id);
    return `${name} finished${reply ? `: ${clip(reply, SUMMARY_RESULT)}` : "."}${waits}`;
  }

  async describe(child: Task): Promise<TaskSubtaskStatus> {
    const activeRuns = this.service.runner.activeRuns(child.id).length;
    const [last] = await this.service.tasks.runs.list(child.id, 1);
    const question = child.pendingQuestions?.[0];
    const reply = await this.reply(child.id);
    return {
      taskId: child.id,
      title: child.title,
      workState: this.workState(child, activeRuns, last),
      status: child.status,
      needsUser: child.needsUser,
      mode: child.delegation?.mode ?? "async",
      completionWake: child.delegation?.completionWake ?? "settled_only",
      activeRuns,
      queued: child.queue?.length ?? 0,
      pendingApprovals: child.pendingActionIds?.length ?? 0,
      pendingQuestion: question
        ? {
            itemId: question.itemId,
            text: question.text,
            ...(question.options ? { options: question.options } : {}),
          }
        : null,
      lastRun: last
        ? {
            id: last.id,
            status: last.status,
            error: last.error ?? null,
            endedAt: last.endedAt ?? null,
          }
        : null,
      result: reply ? clip(reply, RESULT_MAX) : null,
    };
  }

  private workState(child: Task, activeRuns: number, last?: TaskRun): TaskWorkState {
    if (child.pendingQuestions?.length) {
      return "question";
    }
    if (activeRuns > 0 || (child.queue?.length && !child.queueHeld)) {
      return "working";
    }
    if (child.needsUser) {
      return "needs_person";
    }
    if (child.delegation?.cancelledByParent || last?.status === "cancelled") {
      return "cancelled";
    }
    return last?.status === "failed" ? "failed" : "result_available";
  }

  /** A run is queued or running, or a follow-up waits to start. */
  private working(task: Task): boolean {
    const queued = !!task.queue?.length && !task.queueHeld;
    return this.service.runner.activeRuns(task.id).length > 0 || queued;
  }

  private async reply(taskId: string): Promise<string | null> {
    const [item] = await this.service.tasks.items.recent(taskId, ["assistant_message"], 1);
    return item?.kind === "assistant_message" ? item.payload.text : null;
  }

  /** Delegated children of a task, newest first. */
  private async children(parentId: string): Promise<Task[]> {
    const page = await this.service.tasks.list({ parentTaskId: parentId, limit: 200 });
    return page.items.filter((task) => task.delegation);
  }

  private async childOf(parent: Task, childId: string): Promise<Task> {
    const child = await this.service.tasks.get(childId);
    if (!child?.delegation || child.parentTaskId !== parent.id) {
      throw new ApiError("NOT_A_SUBTASK", "That task is not a subtask of this task.", 404);
    }
    return child;
  }

  /** A follow-up to an existing subtask; it answers the subtask's pending question. */
  private async followUp(
    parent: Task,
    childId: string,
    input: TaskDelegateInput,
  ): Promise<TaskSubtaskStatus> {
    const child = await this.childOf(parent, childId);
    if (child.status === "settled" || child.status === "archived") {
      throw new ApiError(
        "TASK_SETTLED",
        "The person settled or archived that subtask; it takes no more messages.",
        409,
      );
    }
    if (child.delegation?.cancelledByParent) {
      // This task's own task_cancel held the child's queue; its follow-up releases that hold.
      await this.service.runner.updateTask(child.id, (current) => ({
        delegation: current.delegation ? { ...current.delegation, cancelledByParent: false } : null,
        ...(current.queueHeld ? { queueHeld: false } : {}),
      }));
    }
    // A hold or a limit the person owns stays: the message waits for them (R1-12).
    await this.queue.send(child.id, { text: input.message, mode: "queue" }, { agent: true });
    if (input.mode === "wait") {
      await this.service.runner.updateTask(parent.id, (current) => ({
        waitingOnTaskIds: [...new Set([...(current.waitingOnTaskIds ?? []), child.id])],
      }));
    }
    return this.describe(await this.service.task(child.id));
  }

  /** Depth-first: grandchildren stop before their parent. */
  private async stopTree(child: Task, parentId: string): Promise<void> {
    for (const grandchild of await this.children(child.id)) {
      await this.stopTree(grandchild, child.id);
    }
    await this.service.runner.updateTask(child.id, (current) => ({
      delegation: current.delegation ? { ...current.delegation, cancelledByParent: true } : null,
    }));
    const open = (child.pendingQuestions ?? []).map((question) => question.itemId);
    if (open.length && this.questions) {
      await this.questions.resolve(child.id, open);
    }
    await this.service.runner.updateTask(parentId, (current) =>
      current.waitingOnTaskIds?.includes(child.id)
        ? { waitingOnTaskIds: current.waitingOnTaskIds.filter((id) => id !== child.id) }
        : {},
    );
    await this.queue.interrupt(child.id);
  }

  private async runOf(caller: TaskToolCaller): Promise<TaskRun | null> {
    return caller.runId ? this.service.tasks.runs.byAgentRunId(caller.runId) : null;
  }

  /** How many tasks are above this one (bounded, like `effectiveMode`). */
  private async ancestors(task: Task): Promise<number> {
    let count = 0;
    let parentId = task.parentTaskId;
    while (parentId && count < 8) {
      const parent = await this.service.tasks.get(parentId);
      if (!parent) {
        break;
      }
      count++;
      parentId = parent.parentTaskId;
    }
    return count;
  }
}

/** Runs `work` after the previous work queued under `key` settled. */
function serial<T>(
  chains: Map<string, Promise<unknown>>,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.catch(() => undefined);
  chains.set(key, settled);
  void settled.finally(() => {
    if (chains.get(key) === settled) {
      chains.delete(key);
    }
  });
  return next;
}
