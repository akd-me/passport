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
import type { RunCeilings } from "./runner.js";
import { TaskService } from "./service.js";
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
}): TaskSystem {
  const service = new TaskService(input);
  const triggers = new TaskTriggers(service);
  const watches = new TaskWatchMonitor(service, input.agent, input.coalesceMs);
  const approvals = input.executor ? new TaskApprovals(service, input.executor) : undefined;
  if (approvals) {
    service.runner.autoApprove = (taskId, action) => approvals.autoApprove(taskId, action);
  }
  const off = input.watcher?.onAdded((accountId, emails) =>
    watches.observeLater(accountId, emails),
  );
  const recovered = service.recover().catch(() => {
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
    async maintain() {
      await recovered;
      const { settled, woken } = await service.maintain();
      const expired = await watches.expire();
      return `${woken} woken, ${settled} settled, ${expired} watches expired`;
    },
    async close() {
      off?.();
      await watches.close();
      await watches.idle();
      service.close();
      await recovered;
    },
  };
}
