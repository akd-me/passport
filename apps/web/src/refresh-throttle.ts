/**
 * Coalesces workspace refetches. Every event frame used to schedule a full refetch 120 ms later;
 * with a watcher tick per account every 30 s that becomes a storm. Each event type now has a
 * minimum spacing between the refetches it causes, and quiet watcher ticks cause none.
 */
export interface RefreshEvent {
  type: string;
  added?: number;
  arrivals?: number;
}

const COALESCE_MS = 120;
/** Minimum time between refetches caused by one event type. Unlisted types: coalescing only. */
export const REFRESH_SPACING_MS: Readonly<Record<string, number>> = {
  "account.watch.tick": 10_000,
  "account.watch.backoff": 30_000,
  "account.watch.started": 5_000,
  "account.watch.expired": 5_000,
  "account.watch.failed": 5_000,
  "account.sync.started": 5_000,
  "account.sync.retry": 5_000,
  "account.synced": 5_000,
  "email.received": 1_000,
  "email.updated": 2_000,
};

/** A tick that found nothing changes nothing on screen. */
const quiet = (event: RefreshEvent) =>
  event.type === "account.watch.tick" && !event.added && !event.arrivals;

export function createRefreshThrottle(
  refresh: () => void,
  clock: {
    now: () => number;
    set: (run: () => void, ms: number) => unknown;
    clear: (timer: unknown) => void;
  } = {
    now: Date.now,
    set: (run, ms) => setTimeout(run, ms),
    clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  },
) {
  const last = new Map<string, number>();
  const pendingTypes = new Set<string>();
  let timer: unknown;
  let due: number | undefined;
  const fire = () => {
    const at = clock.now();
    for (const type of pendingTypes) {
      last.set(type, at);
    }
    pendingTypes.clear();
    timer = undefined;
    due = undefined;
    refresh();
  };
  return {
    push(event: RefreshEvent): void {
      if (quiet(event)) {
        return;
      }
      const now = clock.now();
      const spacing = REFRESH_SPACING_MS[event.type] ?? 0;
      const next = Math.max(now + COALESCE_MS, (last.get(event.type) ?? -Infinity) + spacing);
      pendingTypes.add(event.type);
      // Keep an earlier pending refetch; it will carry this type too.
      if (due !== undefined && due <= next) {
        return;
      }
      if (timer !== undefined) {
        clock.clear(timer);
      }
      due = next;
      timer = clock.set(fire, next - now);
    },
    cancel(): void {
      if (timer !== undefined) {
        clock.clear(timer);
      }
      timer = undefined;
      due = undefined;
      pendingTypes.clear();
    },
  };
}
