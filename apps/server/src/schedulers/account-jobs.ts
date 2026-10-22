import type { JobDefinition } from "@passport/scheduler";
import type { Account } from "@passport/types";
import type { Backend } from "../backend.js";
import { watchIntervalSeconds } from "../onboarding/config.js";

/** New-mail watcher job for one account. */
export const watchJobId = (accountId: string) => `watch:${accountId}`;

/** Bounded calendar sync (`sync:<accountId>`), every `syncIntervalSeconds`. */
export function calendarSyncJob(backend: Backend, account: Account): JobDefinition {
  return {
    id: `sync:${account.id}`,
    name: `Sync ${account.displayName} calendar`,
    kind: "system",
    schedule: { type: "interval", everyMs: backend.config.syncIntervalSeconds * 1000 },
    run: async () => {
      await (backend.syncCalendar
        ? backend.syncCalendar(account.id)
        : backend.syncAccount(account.id));
      return { summary: "Calendar synchronized" };
    },
    timeoutMs: 300000,
  };
}

/** `watch:<accountId>`: one `MailReader.changes` tick every `watch.intervalSeconds` (30 s). */
export function watchJob(backend: Backend, account: Account): JobDefinition | null {
  const watchAccount = backend.watchAccount?.bind(backend);
  if (!account.capabilities.mail || !watchAccount) {
    return null;
  }
  return {
    id: watchJobId(account.id),
    name: `Watch ${account.displayName} for new mail`,
    kind: "system",
    schedule: { type: "interval", everyMs: watchIntervalSeconds(backend.config) * 1000 },
    concurrency: "single",
    run: async () => ({ summary: (await watchAccount(account.id)).summary }),
    timeoutMs: 120000,
  };
}

/** `watch:<accountId>:push`: a bounded long poll (IMAP IDLE) that triggers an immediate tick. */
export function pushJob(
  backend: Backend,
  account: Account,
  tickNow: () => Promise<void>,
): JobDefinition {
  const everyMs = watchIntervalSeconds(backend.config) * 1000;
  return {
    id: `${watchJobId(account.id)}:push`,
    name: `Listen for ${account.displayName} changes`,
    kind: "system",
    schedule: { type: "interval", everyMs },
    run: async ({ signal }) => {
      // Bound each long poll; all recurring scheduling belongs to the scheduler.
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort!: () => void;
      const ended = new Promise<boolean>((resolve) => {
        abort = () => {
          controller.abort();
          resolve(false);
        };
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(abort, everyMs);
        timer.unref?.();
        if (signal.aborted) {
          abort();
        }
      });
      try {
        const changed = await Promise.race([
          backend.waitForChanges!(account.id, controller.signal).then(
            () => !controller.signal.aborted,
          ),
          ended,
        ]);
        if (changed && !signal.aborted) {
          await tickNow();
        }
        return {
          summary: changed ? "Provider signaled changes" : "Long poll ended",
          nextRunInMs: 1000,
        };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        controller.abort();
      }
    },
  };
}
