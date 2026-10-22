import type { AgentRuntime, Email, EventBus, PolicyEngine, Store } from "@passport/types";
import { logger } from "../logger.js";
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
  watcher?: AddedMailSource;
  now?: () => string;
  coalesceMs?: number;
}): TaskSystem {
  const service = new TaskService(input);
  const triggers = new TaskTriggers(service);
  const watches = new TaskWatchMonitor(service, input.agent, input.coalesceMs);
  const off = input.watcher?.onAdded((accountId, emails) => {
    void watches.observe(accountId, emails).catch(() => {
      // Watch matching is best effort per tick; the arrival path is unaffected.
      logger.warn("Conversation watch matching failed");
    });
  });
  const recovered = service.recover().catch(() => {
    // Stale runs stay visible as open; the next maintenance pass does not depend on them.
    logger.warn("Task run recovery failed");
  });
  return {
    service,
    triggers,
    watches,
    async maintain() {
      await recovered;
      const { settled, woken } = await service.maintain();
      const expired = await watches.expire();
      return `${woken} woken, ${settled} settled, ${expired} watches expired`;
    },
    async close() {
      off?.();
      watches.close();
      service.close();
      await recovered;
    },
  };
}
