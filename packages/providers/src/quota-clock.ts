/** Time source for `QuotaGovernor`. Inject `ManualClock` in tests for deterministic waits. */
export interface QuotaClock {
  /** Milliseconds since the epoch. */
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** Wall clock; timers are unref'd so a pending quota wait never keeps the process alive. */
export const systemClock: QuotaClock = {
  now: () => Date.now(),
  setTimer: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

interface ManualTimer {
  id: number;
  at: number;
  callback: () => void;
}

/** Test clock: time moves only through `advance`, which fires due timers in order. */
export class ManualClock implements QuotaClock {
  private timers: ManualTimer[] = [];
  private nextId = 1;
  constructor(private time = 0) {}
  now(): number {
    return this.time;
  }
  setTimer(callback: () => void, ms: number): unknown {
    const timer = { id: this.nextId++, at: this.time + Math.max(0, ms), callback };
    this.timers.push(timer);
    return timer.id;
  }
  clearTimer(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }
  /** Number of timers still scheduled. */
  get pending(): number {
    return this.timers.length;
  }
  /**
   * Moves time forward by `ms`, firing every timer that falls due (including timers scheduled by
   * those callbacks) and settling promise callbacks after each one.
   */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) {
        break;
      }
      this.timers = this.timers.filter((timer) => timer !== due);
      this.time = Math.max(this.time, due.at);
      due.callback();
      await settle();
    }
    this.time = target;
    await settle();
  }
}

/** Lets resolved promises run their continuations. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
