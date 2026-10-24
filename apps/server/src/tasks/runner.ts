import { newId } from "@passport/store";
import {
  type ActionRecord,
  type AgentRunOptions,
  type AgentRunPriority,
  type EventBus,
  minTrust,
  type Store,
  type StoreTasks,
  type Task,
  type TaskItemInput,
  type TaskOrchestrator,
  type TaskRun,
  type TaskRunTrigger,
  type TaskRunUsage,
  type TaskStatus,
  type ToolCallEvent,
  type TrustLevel,
} from "@passport/types";
import { logger } from "../logger.js";
import { sessionObserver } from "./session.js";
import { stampTask } from "./stamps.js";
import { type RunOutcome, statusAfterRun, statusDuringRun, surface, waitingOn } from "./status.js";
import { clip, costOf, neutralize, summarizeInput, summarizeResult } from "./untrusted.js";

/** Item without its run (the runner fills `runId`). */
export type RunItem = Omit<TaskItemInput, "runId" | "taskId" | "at"> & { at?: string };

export interface RunSpec {
  taskId: string;
  trigger: TaskRunTrigger;
  priority: AgentRunPriority;
  /** Pre-assigned TaskRun id (a user message item already points at it). */
  runId?: string;
  /** The agent runtime's run id; defaults to the TaskRun id. Arrivals use `arrival:<emailId>`. */
  agentRunId?: string;
  cancellable: boolean;
  /** Items appended once the run exists (trigger context such as an arrival notification). */
  items?: RunItem[];
  /** Called once the TaskRun is persisted, before the agent is invoked. */
  onCreated?: (run: TaskRun) => void;
  /** The request texts the run carries (`TaskRun.request`), for a later continuation (R1-17). */
  request?: string[];
  /** The run a restart interrupted and this one continues, written with the insert. */
  restartOf?: string;
  /**
   * A restart continuation or limit resume: not the person's new message, so a snooze they chose
   * stays (R1-16).
   */
  continuation?: boolean;
}

export interface RunDescription {
  summary?: string | null;
  error?: string | null;
  usage?: TaskRunUsage | null;
}

interface ActiveRun {
  run: TaskRun;
  controller: AbortController;
  cancellable: boolean;
  preStatus: TaskStatus;
  startStatus?: TaskStatus;
  produced: boolean;
  /** Cancelled by a steer: the replacement run owns the status. */
  steered: boolean;
  /** A restart continuation or limit resume (`RunSpec.continuation`). */
  continuation: boolean;
  writes: Promise<unknown>;
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const DECIDED = [
  "action.decided",
  "action.held",
  "action.executed",
  "action.failed",
  "action.undone",
] as const;

/**
 * Per-run trust ceilings consulted by the policy engine (`PolicyEngineOptions.ceiling`). The
 * level set at run start is the most a run gets; `live` is read on every decision, so lowering a
 * task's or an ancestor's mode (or switching to plan) reaches a running session at its next
 * action. Raising waits for the next run (R1-9).
 */
export class RunCeilings {
  private readonly levels = new Map<
    string,
    { level: TrustLevel; live?: () => Promise<TrustLevel> }
  >();
  set(agentRunId: string, level: TrustLevel, live?: () => Promise<TrustLevel>): void {
    this.levels.set(agentRunId, { level, ...(live ? { live } : {}) });
  }
  delete(agentRunId: string): void {
    this.levels.delete(agentRunId);
  }
  readonly lookup = async (request: { runId?: string | null }): Promise<TrustLevel | undefined> => {
    const entry = request.runId ? this.levels.get(request.runId) : undefined;
    if (!entry?.live) {
      return entry?.level;
    }
    try {
      return minTrust(entry.level, await entry.live());
    } catch {
      return entry.level;
    }
  };
}

/**
 * Executes agent runs on behalf of a task: persists the TaskRun, records tool calls and model
 * text as items, links ActionRecords by `runId`, tracks pending approvals and applies the status
 * rules when the run ends.
 */
export class TaskRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly byAgent = new Map<string, ActiveRun>();
  private readonly unsubscribe: Array<() => void> = [];
  /** Task-scoped approval grants (`TaskApprovals.autoApprove`): the decided record, or null. */
  autoApprove?: (taskId: string, action: ActionRecord) => Promise<ActionRecord | null>;
  /** v0.4 lifecycle (limits, titles, the follow-up queue): a run ended, before its status rules. */
  onRunEnded?: (run: TaskRun) => Promise<void>;
  /** v0.4 subtasks: a run ended and its status rules applied (not after a steer). */
  afterRunEnded?: (run: TaskRun) => Promise<void>;
  /** v0.4: the host behind ask_user, task_delegate, task_status, task_cancel, task_organize. */
  orchestrator?: TaskOrchestrator;

  constructor(
    private readonly store: Store,
    readonly tasks: StoreTasks,
    private readonly bus: EventBus,
    private readonly ceilings: RunCeilings,
    private readonly now: () => string,
  ) {
    this.unsubscribe.push(
      bus.on("agent.run.started", ({ runId }) => {
        const active = this.byAgent.get(runId);
        if (active) {
          this.queue(active, () => this.markRunning(active));
        }
      }),
      // The runtime reports the run done before `invoke` settles; from here it is settling (R1-8).
      bus.on("agent.run.finished", ({ runId }) => {
        const active = this.byAgent.get(runId);
        if (active) {
          active.cancellable = false;
        }
      }),
      bus.on("action.proposed", ({ action }) => this.onAction(action)),
      ...DECIDED.map((type) => bus.on(type, ({ action }) => this.onDecided(action))),
    );
  }

  close(): void {
    for (const off of this.unsubscribe.splice(0)) {
      off();
    }
  }

  /** Queued and running runs of a task, oldest first. */
  activeRuns(taskId: string): TaskRun[] {
    return [...this.active.values()].filter((a) => a.run.taskId === taskId).map((a) => a.run);
  }

  /** Cancels a cancellable run: a queued one leaves the lane, a running one stops at its next step. */
  cancel(runId: string, steer = false): boolean {
    const active = this.active.get(runId);
    if (!active?.cancellable) {
      return false;
    }
    active.steered ||= steer;
    active.controller.abort();
    return true;
  }

  async appendItem(item: TaskItemInput) {
    const saved = await this.tasks.items.append(item);
    this.bus.emit({ type: "task.item.appended", item: saved });
    return saved;
  }

  async updateTask(id: string, patch: Partial<Task> | ((task: Task) => Partial<Task>)) {
    const task = await this.tasks.update(id, (current) => stampTask(current, patch));
    this.bus.emit({ type: "task.updated", task });
    return task;
  }

  async execute<T>(
    spec: RunSpec,
    invoke: (options: AgentRunOptions) => Promise<T>,
    describe: (value: T) => RunDescription,
  ): Promise<T> {
    const task = await this.tasks.get(spec.taskId);
    if (!task) {
      throw new Error("Task not found");
    }
    const id = spec.runId ?? newId();
    const run = await this.tasks.runs.insert({
      id,
      taskId: task.id,
      status: "queued",
      trigger: spec.trigger,
      priority: spec.priority,
      agentRunId: spec.agentRunId ?? id,
      createdAt: this.now(),
      actionIds: [],
      ...(spec.request?.length ? { request: spec.request } : {}),
      ...(spec.restartOf ? { restartOf: spec.restartOf } : {}),
    });
    this.bus.emit({ type: "task.run.updated", run });
    spec.onCreated?.(run);
    const active: ActiveRun = {
      run,
      controller: new AbortController(),
      cancellable: spec.cancellable,
      preStatus: task.status,
      produced: false,
      steered: false,
      continuation: spec.continuation === true,
      writes: Promise.resolve(),
    };
    this.active.set(run.id, active);
    this.byAgent.set(run.agentRunId, active);
    try {
      // Inside `try`: a failure here still finishes the run and releases its ceiling (R4-22).
      this.ceilings.set(run.agentRunId, await this.effectiveMode(task), () =>
        this.liveCeiling(task),
      );
      for (const item of spec.items ?? []) {
        await this.appendItem({
          ...item,
          at: item.at ?? this.now(),
          taskId: task.id,
          runId: run.id,
        } as TaskItemInput);
      }
      const started = await this.updateTask(task.id, (current) =>
        statusDuringRun(current, spec.trigger, this.now(), spec.continuation),
      );
      active.startStatus = started.status;
      const options: AgentRunOptions = {
        priority: spec.priority,
        runId: run.agentRunId,
        taskId: task.id,
        signal: active.controller.signal,
        readOnly: task.interactionMode === "plan",
        session: { persist: task.kind === "task" && !task.voiceLearning },
        ...(runAccounts(task) ? { accountIds: runAccounts(task) } : {}),
        ...(task.voiceLearning ? { voiceLearning: task.voiceLearning } : {}),
        ...(this.orchestrator ? { orchestrator: this.orchestrator } : {}),
        observer: {
          toolCall: (event) => this.queue(active, () => this.onToolCall(active, event)),
          assistantMessage: (text) => this.queue(active, () => this.onText(active, text)),
          ...sessionObserver(
            {
              appendItem: (item) => this.appendItem(item),
              updateTask: (id, patch) => this.updateTask(id, patch),
              now: this.now,
            },
            () => active.run,
            (write) => this.queue(active, write),
          ),
        },
      };
      const value = await invoke(options);
      // Settling: a late Stop or steer can no longer cancel a run that already finished (R1-8).
      active.cancellable = false;
      const description = describe(value);
      await this.finish(active, description.error ? "failed" : "completed", description);
      return value;
    } catch (error) {
      active.cancellable = false;
      const code = (error as { code?: unknown })?.code;
      const cancelled = active.controller.signal.aborted || code === "RUN_CANCELLED";
      const safe = typeof code === "string" && SAFE_CODE.test(code) ? code : "RUN_FAILED";
      await this.finish(active, cancelled ? "cancelled" : "failed", { error: safe });
      throw error;
    }
  }

  /** The task's mode, never above its ancestors' (design §5). */
  async effectiveMode(task: Task): Promise<TrustLevel> {
    let level = task.permissionMode;
    let parentId = task.parentTaskId;
    for (let depth = 0; parentId && depth < 8; depth++) {
      const parent = await this.tasks.get(parentId);
      if (!parent) {
        break;
      }
      level = minTrust(level, parent.permissionMode);
      parentId = parent.parentTaskId;
    }
    return level;
  }

  /**
   * The ceiling now: the task's effective mode as it is, and the lowest level once the person
   * switched a running task to plan mode (its writes then ask instead of executing).
   */
  private async liveCeiling(started: Task): Promise<TrustLevel> {
    const task = await this.tasks.get(started.id);
    if (!task) {
      return started.permissionMode;
    }
    if (task.interactionMode === "plan" && started.interactionMode !== "plan") {
      return "supervised";
    }
    return this.effectiveMode(task);
  }

  private queue(active: ActiveRun, write: () => Promise<unknown>): void {
    active.writes = active.writes.then(write).catch(() => {
      // Timeline writes are best effort; the run and its ActionRecords stay authoritative.
      logger.warn("Task timeline write failed");
    });
  }

  private async markRunning(active: ActiveRun) {
    if (active.run.status !== "queued") {
      return;
    }
    active.run = await this.tasks.runs.update(active.run.id, {
      status: "running",
      startedAt: this.now(),
    });
    this.bus.emit({ type: "task.run.updated", run: active.run });
  }

  private async onToolCall(active: ActiveRun, event: ToolCallEvent) {
    await this.markRunning(active);
    const cost = costOf(event.result);
    if (event.name === "render" && event.result.status === "rendered") {
      active.produced = true;
    }
    await this.appendItem({
      taskId: active.run.taskId,
      runId: active.run.id,
      kind: "tool_call",
      at: this.now(),
      untrusted: true,
      payload: {
        name: event.name,
        inputSummary: summarizeInput(event.input),
        resultSummary: summarizeResult(event.result),
        ...(cost ? { cost } : {}),
        durationMs: event.durationMs,
        isError: event.result.isError === true,
        ...(event.planned ? { planned: true } : {}),
      },
    });
  }

  private async onText(active: ActiveRun, text: string) {
    await this.markRunning(active);
    active.produced = true;
    await this.appendItem({
      taskId: active.run.taskId,
      runId: active.run.id,
      kind: "assistant_message",
      at: this.now(),
      untrusted: true,
      payload: { text: neutralize(text.slice(0, 20_000)) },
    });
  }

  /** A proposal from one of this host's task runs: link it and ask the person. */
  private onAction(action: ActionRecord) {
    const active = action.request.runId ? this.byAgent.get(action.request.runId) : undefined;
    if (active) {
      this.queue(active, async () => {
        const decided = await this.autoApprove?.(active.run.taskId, action);
        await this.link(active.run.taskId, active.run.id, [decided ?? action]);
      });
    }
  }

  private async link(taskId: string, runId: string, actions: ActionRecord[]) {
    const run = await this.tasks.runs.update(runId, (current) => ({
      actionIds: [...new Set([...current.actionIds, ...actions.map((a) => a.id)])],
    }));
    this.bus.emit({ type: "task.run.updated", run });
    const active = this.active.get(runId);
    if (active) {
      active.run = run;
    }
    const task = await this.tasks.get(taskId);
    const fresh = actions.filter(
      (a) => a.status === "proposed" && !task?.pendingActionIds?.includes(a.id),
    );
    for (const action of fresh) {
      await this.appendItem({
        taskId,
        runId,
        kind: "approval_request",
        at: this.now(),
        untrusted: true,
        payload: { actionId: action.id, summary: clip(neutralize(action.request.reason)) },
      });
    }
    if (fresh.length) {
      await this.updateTask(taskId, (current) => {
        const pendingActionIds = [
          ...new Set([...(current.pendingActionIds ?? []), ...fresh.map((a) => a.id)]),
        ];
        // Settled or archived by the person: record the approval without un-settling (R4-9).
        return current.status === "settled" || current.status === "archived"
          ? { pendingActionIds, needsUser: "approval" as const }
          : { ...surface("approval", this.now()), pendingActionIds };
      });
    }
  }

  /** A decided proposal leaves the approval panel; the task keeps its place in the inbox. */
  private onDecided(action: ActionRecord) {
    if (action.status === "proposed" || !action.request.runId) {
      return;
    }
    void (async () => {
      const run = await this.tasks.runs.byAgentRunId(action.request.runId!);
      const task = run ? await this.tasks.get(run.taskId) : null;
      if (!task?.pendingActionIds?.includes(action.id)) {
        return;
      }
      await this.updateTask(task.id, (current) => {
        const pending = (current.pendingActionIds ?? []).filter((id) => id !== action.id);
        // The last decided approval hands over to a pending question, if any (v0.4).
        const next = waitingOn({ ...current, pendingActionIds: pending });
        return {
          pendingActionIds: pending,
          ...(pending.length || current.needsUser !== "approval" ? {} : { needsUser: next }),
        };
      });
    })().catch(() => {
      // The approval itself succeeded; only the task badge is stale until the next change.
      logger.warn("Task approval bookkeeping failed");
    });
  }

  private async finish(active: ActiveRun, status: TaskRun["status"], description: RunDescription) {
    await active.writes;
    const { run } = active;
    const actions = (await this.store.actions.query({ runId: run.agentRunId, limit: 500 })).items;
    await this.link(run.taskId, run.id, actions);
    const done = await this.tasks.runs.update(run.id, {
      status,
      startedAt: active.run.startedAt ?? this.now(),
      endedAt: this.now(),
      summary: description.summary ? neutralize(description.summary.slice(0, 2000)) : null,
      usage: description.usage ?? null,
      error: description.error ?? null,
    });
    this.bus.emit({ type: "task.run.updated", run: done });
    this.active.delete(run.id);
    if (this.byAgent.get(run.agentRunId) === active) {
      this.byAgent.delete(run.agentRunId);
      this.ceilings.delete(run.agentRunId);
    }
    if (status !== "completed") {
      const text =
        status === "cancelled" ? "Stopped." : `Run failed (${description.error ?? "RUN_FAILED"}).`;
      await this.appendItem({
        taskId: run.taskId,
        runId: run.id,
        kind: "system_notice",
        at: this.now(),
        payload: {
          text,
          code: status === "cancelled" ? "RUN_CANCELLED" : (description.error ?? "RUN_FAILED"),
        },
      });
    }
    if (active.steered) {
      // The steer's replacement run is starting; moving the task now would bounce it (R4-20).
      return;
    }
    await this.onRunEnded?.(done);
    const outcome: RunOutcome = {
      trigger: run.trigger,
      preStatus: active.preStatus,
      ...(active.startStatus ? { startStatus: active.startStatus } : {}),
      failed: status === "failed",
      cancelled: status === "cancelled",
      ...(active.continuation ? { continuation: true } : {}),
      produced: active.produced || done.actionIds.length > 0,
      otherActiveRuns: this.activeRuns(run.taskId).length,
      now: this.now(),
      error: done.error ?? null,
    };
    await this.updateTask(run.taskId, (task) => statusAfterRun(task, outcome));
    try {
      await this.afterRunEnded?.(done);
    } catch {
      // The run is finished and recorded; only a subtask notification or wake is missed.
      logger.warn("Task after-run hook failed");
    }
  }
}

/**
 * The accounts a run's tools may use (`AgentRunOptions.accountIds`, R1-10): the task's own.
 * Routine tasks and their fresh per-run children follow every connected account, so they are not
 * limited to the accounts that existed when the routine was created; neither is a task without
 * accounts.
 */
function runAccounts(task: Task): string[] | undefined {
  const freshRoutineChild = task.createdBy === "system" && !!task.parentTaskId && !task.delegation;
  if (!task.accountIds.length || task.kind === "routine" || freshRoutineChild) {
    return undefined;
  }
  return task.accountIds;
}
