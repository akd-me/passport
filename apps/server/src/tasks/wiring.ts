import type {
  ActionExecutor,
  AgentRuntime,
  Email,
  EventBus,
  PolicyEngine,
  Store,
} from "@passport/types";
import { logger } from "../logger.js";
import { TaskApprovals } from "./approvals.js";
import { TaskLifecycle } from "./lifecycle.js";
import { LimitLog, limitAware, TaskLimits } from "./limits.js";
import { taskOrchestrator } from "./orchestrator.js";
import { TaskOrganizer } from "./organize.js";
import { TaskQuestions } from "./questions.js";
import { TaskQueueService } from "./queue.js";
import { recoverRuns } from "./restart.js";
import type { RunCeilings } from "./runner.js";
import { TaskService } from "./service.js";
import { TaskSubtasks } from "./subtasks.js";
import { TaskTitles, type TitleModel } from "./titles.js";
import { TaskTriggers } from "./triggers.js";
import { TaskWatchMonitor } from "./watches.js";

export { LaneQueue, runPriority } from "./lanes.js";
export { RunCeilings } from "./runner.js";

/** Everything the composition root, routes and scheduler need from tasks. */
export interface TaskSystem {
  readonly service: TaskService;
  readonly triggers: TaskTriggers;
  readonly watches: TaskWatchMonitor;
  /** Approval scopes; absent without an executor (tests that drive the service alone). */
  readonly approvals?: TaskApprovals;
  /** v0.4: seen / mark-unread, settle-snooze-archive with `previous`, reopen routes. */
  readonly lifecycle: TaskLifecycle;
  /** v0.4: the follow-up queue (`/api/tasks/:id/queue`). */
  readonly queue: TaskQueueService;
  /** v0.4: the Limited state and its recovery. */
  readonly limits: TaskLimits;
  /** v0.4: fast-model titles after the first run. */
  readonly titles: TaskTitles;
  /** v0.4 (W2A): `ask_user` questions and their answer and dismiss routes. */
  readonly questions: TaskQuestions;
  /** v0.4 (W2A): subtasks (`task_delegate`, `task_status`, `task_cancel`) and the lineage. */
  readonly subtasks: TaskSubtasks;
  /** `tasks.maintenance` job: snooze wake-ups, 3-day auto-settle, 14-day watch expiry. */
  maintain(): Promise<string>;
  close(): Promise<void>;
}

/** The watcher hook: `MailWatcher.onAdded(listener)` reports messages each tick added. */
export interface AddedMailSource {
  onAdded(listener: (accountId: string, emails: Email[]) => void): () => void;
}

export function createTaskSystem(input: {
  store: Store;
  bus: EventBus;
  policy: PolicyEngine;
  agent: AgentRuntime;
  ceilings: RunCeilings;
  /** Enables approval scopes (`TaskApprovals`). */
  executor?: ActionExecutor;
  watcher?: AddedMailSource;
  now?: () => string;
  coalesceMs?: number;
  /** Fast-model completions for generated titles; without it titles come from the message. */
  titleModel?: TitleModel;
}): TaskSystem {
  const limitLog = new LimitLog();
  const now = input.now ?? (() => new Date().toISOString());
  const agent = limitAware(input.agent, limitLog, now);
  const service = new TaskService({ ...input, agent });
  const triggers = new TaskTriggers(service);
  const watches = new TaskWatchMonitor(service, agent, input.coalesceMs);
  const queue = new TaskQueueService(service);
  const limits = new TaskLimits(service, queue, limitLog);
  queue.limits = limits;
  const titles = new TaskTitles(service, input.titleModel);
  const lifecycle = new TaskLifecycle(service, queue);
  const questions = new TaskQuestions(service, queue);
  const subtasks = new TaskSubtasks(service, queue);
  questions.forwarding = subtasks;
  subtasks.questions = questions;
  service.runner.orchestrator = taskOrchestrator({
    questions,
    subtasks,
    organizer: new TaskOrganizer(service, lifecycle),
  });
  service.runner.afterRunEnded = (run) => subtasks.afterRunEnded(run);
  service.runner.onRunEnded = async (run) => {
    try {
      await limits.onRunEnded(run);
      titles.onRunEnded(run);
      await queue.onRunEnded(run);
    } catch {
      // The run itself is recorded; a missed limit or queue step is retried by the next event.
      logger.warn("Task run lifecycle hooks failed");
    }
  };
  const approvals = input.executor ? new TaskApprovals(service, input.executor) : undefined;
  if (approvals) {
    service.runner.autoApprove = (taskId, action) => approvals.autoApprove(taskId, action);
  }
  const off = input.watcher?.onAdded((accountId, emails) =>
    watches.observeLater(accountId, emails),
  );
  const recovered = recoverRuns(service, queue)
    .then(() => limits.maintain())
    .catch(() => {
      // Stale runs stay visible as open; the next maintenance pass does not depend on them.
      logger.warn("Task run recovery failed");
    });
  // Coalesced wakes a previous process persisted fire once recovery has settled their tasks.
  void recovered.then(() => watches.resume());
  return {
    service,
    triggers,
    watches,
    approvals,
    lifecycle,
    queue,
    limits,
    titles,
    questions,
    subtasks,
    async maintain() {
      await recovered;
      const { settled, woken } = await service.maintain();
      const expired = await watches.expire();
      const resumed = await limits.maintain();
      return `${woken} woken, ${settled} settled, ${expired} watches expired, ${resumed} resumed after a limit`;
    },
    async close() {
      off?.();
      limits.close();
      await watches.close();
      await watches.idle();
      await titles.idle();
      service.close();
      await recovered;
    },
  };
}
