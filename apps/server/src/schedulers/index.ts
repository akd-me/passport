import type { Backend } from "../backend.js";
import { logger } from "../logger.js";

export interface SchedulerHandle {
  stop(): Promise<void>;
}
/** Owns all timers and abort signals. stop() drains active work before the Store closes. */
export function startSchedulers(backend: Backend): SchedulerHandle {
  const abort = new AbortController(),
    jobs = new Set<Promise<unknown>>(),
    syncing = new Set<string>(),
    pushing = new Set<string>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false,
    accountsBusy = false,
    outboxBusy = false,
    decayBusy = false;
  function track(job: Promise<unknown>) {
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
  }
  const safely = async (name: string, task: () => Promise<unknown>) => {
    try {
      await task();
    } catch {
      if (!stopped)
        logger.warn(`${name} failed; retrying on the next interval`);
    }
  };
  async function sync(id: string) {
    if (syncing.has(id) || stopped) return;
    syncing.add(id);
    try {
      await safely("Account sync", () => backend.syncAccount(id));
    } finally {
      syncing.delete(id);
    }
  }
  async function push(id: string) {
    if (!backend.waitForChanges || pushing.has(id)) return;
    pushing.add(id);
    try {
      while (!stopped) {
        await backend.waitForChanges(id, abort.signal);
        if (!stopped) await sync(id);
        // A misbehaving adapter must not spin if it immediately resolves.
        if (!stopped)
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              abort.signal.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, 1000);
            abort.signal.addEventListener("abort", done, { once: true });
          });
      }
    } catch {
      if (!stopped)
        logger.warn("Push connection ended; interval sync remains active");
    } finally {
      pushing.delete(id);
    }
  }
  async function syncAccounts() {
    if (accountsBusy || stopped) return;
    accountsBusy = true;
    try {
      await safely("Account discovery", async () => {
        const accounts = await backend.store.accounts.list();
        for (const account of accounts) {
          track(sync(account.id));
          if (
            account.capabilities.push &&
            backend.waitForChanges &&
            !pushing.has(account.id)
          )
            track(push(account.id));
        }
      });
    } finally {
      accountsBusy = false;
    }
  }
  const interval = (ms: number, task: () => Promise<void>) => {
    const timer = setInterval(() => {
      if (!stopped) track(task());
    }, ms);
    timer.unref?.();
    timers.push(timer);
  };
  interval(backend.config.syncIntervalSeconds * 1000, syncAccounts);
  interval(30000, async () => {
    if (outboxBusy) return;
    outboxBusy = true;
    try {
      await safely("Outbox release", () => backend.executor.releaseDue());
    } finally {
      outboxBusy = false;
    }
  });
  interval(86400000, async () => {
    if (decayBusy) return;
    decayBusy = true;
    try {
      await safely("Trust decay", () => backend.policy.applyDecay());
    } finally {
      decayBusy = false;
    }
  });
  let reviewBusy = false;
  interval(86400000, async () => {
    if (reviewBusy) return;
    reviewBusy = true;
    try {
      await safely("Matter review", () =>
        backend.agent.run({ kind: "schedule", name: "matter_review" }),
      );
    } finally {
      reviewBusy = false;
    }
  });
  function scheduleDigest() {
    if (stopped) return;
    const next = new Date();
    next.setHours(backend.config.dailyDigestHour, 0, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    const timer = setTimeout(() => {
      if (stopped) return;
      track(
        safely("Daily digest", () =>
          backend.agent.run({ kind: "schedule", name: "daily_digest" }),
        ).then(scheduleDigest),
      );
    }, next.getTime() - Date.now());
    timer.unref?.();
    timers.push(timer);
  }
  scheduleDigest();
  track(syncAccounts());
  return {
    stop: async () => {
      stopped = true;
      abort.abort();
      timers.forEach(clearTimeout);
      await Promise.allSettled([...jobs]);
    },
  };
}
