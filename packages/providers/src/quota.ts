import type { MailProviderKind, QuotaLane, ReadCost } from "@passport/types";
import { ProviderError, RateLimitedError } from "./errors.js";
import { type QuotaClock, systemClock } from "./quota-clock.js";
import {
  BACKGROUND_SHARE,
  INTERACTIVE_MAX_WAIT_MS,
  QUOTA_PRESETS,
  type QuotaConfig,
  type ThrottleSignal,
} from "./quota-presets.js";

/** Granted quota. Call `release()` when the provider call finishes (success or failure). */
export interface QuotaLease {
  readonly accountId: string;
  readonly lane: QuotaLane;
  readonly cost: number;
  /** Time spent waiting in the governor queue. */
  readonly waitedMs: number;
  /** Frees the concurrency slot. Idempotent. Spent units are not refunded. */
  release(): void;
}

export interface AcquireOptions {
  signal?: AbortSignal;
  /**
   * Fail with `RateLimitedError` instead of waiting longer than this. Defaults to
   * `INTERACTIVE_MAX_WAIT_MS` for the interactive lane and unbounded for the others.
   */
  maxWaitMs?: number;
}

export interface QuotaGovernorOptions {
  clock?: QuotaClock;
}

const LANES: readonly QuotaLane[] = ["interactive", "arrivals", "background"];
const EPSILON = 1e-9;
/** Graph says to slow down from 0.9 of its limit; we halve refill for one minute. */
const THROTTLE_SLOWDOWN_AT = 0.9;
const THROTTLE_SLOWDOWN_MS = 60_000;

interface Waiter {
  lane: QuotaLane;
  cost: number;
  enqueuedAt: number;
  resolve: (lease: QuotaLease) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

interface Bucket {
  accountId: string;
  config: QuotaConfig;
  tokens: number;
  updatedAt: number;
  inFlight: number;
  blockedUntil: number;
  slowUntil: number;
  /** Units the non-interactive lanes may still spend during the current interactive wait. */
  shareCredit: number;
  queues: Record<QuotaLane, Waiter[]>;
  timer?: unknown;
}

/**
 * Per-account token bucket with three priority lanes (interactive > arrivals > background).
 *
 * - Units are deducted when a lease is granted; `maxInFlight` counts unreleased leases.
 * - Lanes are FIFO; arrivals always go before background. While an interactive call waits, the
 *   other lanes may spend only `BACKGROUND_SHARE` of the units refilled during the wait.
 * - A request larger than the bucket waits for a full bucket and then runs into debt.
 * - `report()` reacts to provider signals; `snapshot()` feeds `ReadCost`.
 *
 * Deterministic given an injected clock (`ManualClock` in tests).
 */
export class QuotaGovernor {
  private readonly clock: QuotaClock;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: QuotaGovernorOptions = {}) {
    this.clock = options.clock ?? systemClock;
  }

  /** Sets (or replaces) the limits for an account. Spent budget carries over on reconfigure. */
  configure(accountId: string, limits: MailProviderKind | QuotaConfig): void {
    const config = typeof limits === "string" ? QUOTA_PRESETS[limits] : limits;
    const existing = this.buckets.get(accountId);
    if (existing) {
      this.refill(existing);
      existing.config = { ...config };
      existing.tokens = Math.min(existing.tokens, config.capacity);
      this.pump(existing);
      return;
    }
    this.buckets.set(accountId, {
      accountId,
      config: { ...config },
      tokens: config.capacity,
      updatedAt: this.clock.now(),
      inFlight: 0,
      blockedUntil: 0,
      slowUntil: 0,
      shareCredit: 0,
      queues: { interactive: [], arrivals: [], background: [] },
    });
  }

  isConfigured(accountId: string): boolean {
    return this.buckets.has(accountId);
  }

  /** Forgets an account; queued waiters are rejected with `QUOTA_NOT_CONFIGURED`. */
  remove(accountId: string): void {
    const bucket = this.buckets.get(accountId);
    if (!bucket) {
      return;
    }
    this.buckets.delete(accountId);
    this.clearTimer(bucket);
    for (const lane of LANES) {
      for (const waiter of bucket.queues[lane].splice(0)) {
        waiter.cleanup();
        waiter.reject(notConfigured());
      }
    }
  }

  /**
   * Waits for `cost` units and a concurrency slot in `lane`. Rejects with `RateLimitedError` when
   * the wait would exceed `maxWaitMs`, `ProviderError("ABORTED")` when the signal aborts, and
   * `ProviderError("QUOTA_NOT_CONFIGURED")` for unknown accounts.
   */
  acquire(
    accountId: string,
    lane: QuotaLane,
    cost: number,
    options: AcquireOptions = {},
  ): Promise<QuotaLease> {
    const bucket = this.buckets.get(accountId);
    if (!bucket) {
      return Promise.reject(notConfigured());
    }
    if (!Number.isFinite(cost) || cost < 0) {
      return Promise.reject(
        new ProviderError("INVALID_COST", "Quota cost must be a finite number"),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(aborted());
    }
    const maxWaitMs =
      options.maxWaitMs ?? (lane === "interactive" ? INTERACTIVE_MAX_WAIT_MS : Infinity);
    this.refill(bucket);
    const estimate = this.estimateWaitMs(bucket, lane, cost);
    if (estimate > maxWaitMs) {
      return Promise.reject(this.limited(bucket, estimate));
    }
    return new Promise<QuotaLease>((resolve, reject) => {
      let deadline: unknown;
      const onAbort = () => {
        this.dequeue(bucket, waiter);
        reject(aborted());
      };
      const waiter: Waiter = {
        lane,
        cost,
        enqueuedAt: this.clock.now(),
        resolve,
        reject,
        cleanup: () => {
          options.signal?.removeEventListener("abort", onAbort);
          if (deadline !== undefined) {
            this.clock.clearTimer(deadline);
          }
        },
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      bucket.queues[lane].push(waiter);
      this.pump(bucket);
      if (!bucket.queues[lane].includes(waiter) || !Number.isFinite(maxWaitMs)) {
        return;
      }
      deadline = this.clock.setTimer(() => {
        this.dequeue(bucket, waiter);
        this.refill(bucket);
        reject(this.limited(bucket, Math.max(1, this.estimateWaitMs(bucket, lane, cost))));
      }, maxWaitMs);
    });
  }

  /**
   * Applies provider throttling signals. `retryAfterSeconds` empties the bucket and blocks every
   * lane until it elapses. `throttlePercentage ≥ 0.9` caps the bucket at the provider's remaining
   * share and halves refill for a minute; below 0.9 restores full speed. Unknown accounts are
   * ignored so adapters can report unconditionally.
   */
  report(accountId: string, signal: ThrottleSignal): void {
    const bucket = this.buckets.get(accountId);
    if (!bucket) {
      return;
    }
    this.refill(bucket);
    const now = this.clock.now();
    const finite = Number.isFinite(bucket.config.capacity);
    if (signal.retryAfterSeconds !== undefined && signal.retryAfterSeconds > 0) {
      bucket.blockedUntil = Math.max(bucket.blockedUntil, now + signal.retryAfterSeconds * 1000);
      if (finite) {
        bucket.tokens = Math.min(bucket.tokens, 0);
      }
    }
    if (signal.throttlePercentage !== undefined) {
      if (signal.throttlePercentage >= THROTTLE_SLOWDOWN_AT) {
        bucket.slowUntil = now + THROTTLE_SLOWDOWN_MS;
        if (finite) {
          const left = Math.max(0, 1 - signal.throttlePercentage);
          bucket.tokens = Math.min(bucket.tokens, bucket.config.capacity * left);
        }
      } else {
        bucket.slowUntil = 0;
      }
    }
    this.pump(bucket);
  }

  /** Budget left and when it is fully restored. Empty for unlimited buckets or unknown accounts. */
  snapshot(accountId: string): Pick<ReadCost, "budgetRemaining" | "windowResetsAt"> {
    const bucket = this.buckets.get(accountId);
    if (!bucket || !Number.isFinite(bucket.config.capacity)) {
      return {};
    }
    this.refill(bucket);
    const now = this.clock.now();
    const start = Math.max(now, bucket.blockedUntil);
    const missing = Math.max(0, bucket.config.capacity - bucket.tokens);
    const fullAt = start + Math.ceil((missing / this.rate(bucket, start)) * 1000);
    return {
      budgetRemaining: Math.max(0, Math.floor(bucket.tokens + EPSILON)),
      windowResetsAt: new Date(fullAt).toISOString(),
    };
  }

  private rate(bucket: Bucket, at: number): number {
    return bucket.config.refillPerSecond * (at < bucket.slowUntil ? 0.5 : 1);
  }

  /** Call before changing the interactive queue: share credit accrues only while it waits. */
  private refill(bucket: Bucket): void {
    const now = this.clock.now();
    const from = Math.max(bucket.updatedAt, bucket.blockedUntil);
    if (Number.isFinite(bucket.config.capacity) && now > from) {
      const added = ((now - from) * this.rate(bucket, from)) / 1000;
      bucket.tokens = Math.min(bucket.config.capacity, bucket.tokens + added);
      if (bucket.queues.interactive.length > 0) {
        bucket.shareCredit = Math.min(
          this.shareCap(bucket),
          bucket.shareCredit + added * BACKGROUND_SHARE,
        );
      }
    }
    bucket.updatedAt = now;
  }

  private shareCap(bucket: Bucket): number {
    return bucket.config.capacity * BACKGROUND_SHARE;
  }

  /** Milliseconds until `waiter` has enough units (0 when it can run now, ignoring slots). */
  private wait(bucket: Bucket, waiter: Waiter, now: number): number {
    if (!Number.isFinite(bucket.config.capacity)) {
      return 0;
    }
    const rate = this.rate(bucket, now);
    const cost = Math.min(waiter.cost, bucket.config.capacity);
    const tokenWait = Math.max(0, cost - bucket.tokens - EPSILON) / rate;
    if (waiter.lane === "interactive" || bucket.queues.interactive.length === 0) {
      return Math.ceil(tokenWait * 1000);
    }
    const share = Math.min(cost, this.shareCap(bucket));
    const creditWait =
      Math.max(0, share - bucket.shareCredit - EPSILON) / (rate * BACKGROUND_SHARE);
    return Math.ceil(Math.max(tokenWait, creditWait) * 1000);
  }

  private pump(bucket: Bucket): void {
    this.refill(bucket);
    this.clearTimer(bucket);
    const now = this.clock.now();
    let wakeInMs = Infinity;
    for (let granted = true; granted; ) {
      granted = false;
      if (now < bucket.blockedUntil || bucket.inFlight >= bucket.config.maxInFlight) {
        break;
      }
      for (const lane of LANES) {
        const head = bucket.queues[lane][0];
        if (!head) {
          continue;
        }
        const waitMs = this.wait(bucket, head, now);
        if (waitMs === 0) {
          this.grant(bucket, head);
          granted = true;
          break;
        }
        wakeInMs = Math.min(wakeInMs, waitMs);
        if (lane !== "interactive") {
          // Arrivals always run before background; only interactive can be passed.
          break;
        }
      }
    }
    const waiting = LANES.some((lane) => bucket.queues[lane].length > 0);
    if (!waiting) {
      return;
    }
    if (now < bucket.blockedUntil) {
      wakeInMs = bucket.blockedUntil - now;
    }
    if (Number.isFinite(wakeInMs)) {
      bucket.timer = this.clock.setTimer(
        () => {
          bucket.timer = undefined;
          this.pump(bucket);
        },
        Math.max(1, wakeInMs),
      );
    }
  }

  private grant(bucket: Bucket, waiter: Waiter): void {
    bucket.queues[waiter.lane].shift();
    waiter.cleanup();
    if (Number.isFinite(bucket.config.capacity)) {
      bucket.tokens -= waiter.cost;
    }
    if (waiter.lane !== "interactive") {
      bucket.shareCredit = Math.max(0, bucket.shareCredit - waiter.cost);
    }
    if (bucket.queues.interactive.length === 0) {
      bucket.shareCredit = 0;
    }
    bucket.inFlight += 1;
    let released = false;
    waiter.resolve({
      accountId: bucket.accountId,
      lane: waiter.lane,
      cost: waiter.cost,
      waitedMs: this.clock.now() - waiter.enqueuedAt,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        bucket.inFlight -= 1;
        if (this.buckets.get(bucket.accountId) === bucket) {
          this.pump(bucket);
        }
      },
    });
  }

  private dequeue(bucket: Bucket, waiter: Waiter): void {
    this.refill(bucket);
    const queue = bucket.queues[waiter.lane];
    const index = queue.indexOf(waiter);
    if (index >= 0) {
      queue.splice(index, 1);
    }
    waiter.cleanup();
    if (bucket.queues.interactive.length === 0) {
      bucket.shareCredit = 0;
    }
    // A departing interactive waiter may lift the share limit on the other lanes.
    if (this.buckets.get(bucket.accountId) === bucket) {
      this.pump(bucket);
    }
  }

  /** Lower-bound wait for a new request: block time plus refill for everything queued ahead. */
  private estimateWaitMs(bucket: Bucket, lane: QuotaLane, cost: number): number {
    const now = this.clock.now();
    const blocked = Math.max(0, bucket.blockedUntil - now);
    if (!Number.isFinite(bucket.config.capacity)) {
      return blocked;
    }
    const ahead = LANES.slice(0, LANES.indexOf(lane) + 1)
      .flatMap((l) => bucket.queues[l])
      .reduce((sum, waiter) => sum + Math.min(waiter.cost, bucket.config.capacity), 0);
    const demand = ahead + Math.min(cost, bucket.config.capacity);
    const available = blocked > 0 ? Math.min(bucket.tokens, 0) : bucket.tokens;
    const missing = Math.max(0, demand - available - EPSILON);
    return blocked + (missing / this.rate(bucket, now + blocked)) * 1000;
  }

  private limited(bucket: Bucket, waitMs: number): RateLimitedError {
    return new RateLimitedError(Math.max(1, Math.ceil(waitMs / 1000)), bucket.config.scope);
  }

  private clearTimer(bucket: Bucket): void {
    if (bucket.timer !== undefined) {
      this.clock.clearTimer(bucket.timer);
      bucket.timer = undefined;
    }
  }
}

function notConfigured(): ProviderError {
  return new ProviderError(
    "QUOTA_NOT_CONFIGURED",
    "Configure quota limits for this account before reading",
  );
}

function aborted(): ProviderError {
  return new ProviderError("ABORTED", "The quota wait was cancelled");
}
