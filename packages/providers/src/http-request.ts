import type { QuotaLane, RateLimitScope } from "@passport/types";
import { ProviderError, RateLimitedError } from "./errors.js";
import { INTERACTIVE_MAX_WAIT_MS, type ThrottleSignal } from "./quota-presets.js";

/**
 * Wait time one reader call may still spend on governor queues and throttle backoff. Shared by
 * every request of the call, so the interactive ceiling covers the whole call (R1-2).
 */
export interface WaitBudget {
  remainingMs: number;
}

/** A fresh `INTERACTIVE_MAX_WAIT_MS` budget for the interactive lane; other lanes are unbounded. */
export function waitBudget(lane: QuotaLane): WaitBudget | undefined {
  return lane === "interactive" ? { remainingMs: INTERACTIVE_MAX_WAIT_MS } : undefined;
}

/** Retry behaviour and throttling hooks for one request. */
export interface RetryOptions {
  lane?: QuotaLane;
  scope?: RateLimitScope;
  onThrottle?: (signal: ThrottleSignal) => void;
  /** Shared per-call wait budget; replaces the per-request interactive ceiling. */
  budget?: WaitBudget | undefined;
  /** A read-only POST (Graph `$batch`, Gmail batch of GETs) that may be replayed like a GET. */
  idempotent?: boolean | undefined;
}

/** Network timeout per attempt; never covers governor queue time (R1-8). */
const NETWORK_TIMEOUT_MS = 30_000;

// Per-user quotas (e.g. Gmail's 6,000 units/minute) reset within a minute; the
// backoff schedule spans one window so a long sync slows down instead of failing.
const rateLimitDelaysMs = [2_000, 4_000, 8_000, 16_000, 32_000];

/** Google reports per-user quota exhaustion as 403 rather than 429. */
async function isRateLimited(response: Response): Promise<boolean> {
  if (response.status === 429) {
    return true;
  }
  if (response.status !== 403) {
    return false;
  }
  try {
    return /"(?:rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT_EXCEEDED)"/.test(
      await response.clone().text(),
    );
  } catch {
    return false;
  }
}

/** The server's Retry-After in milliseconds, or NaN when absent or unparseable. */
function retryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? NaN : Number(header);
  if (Number.isFinite(seconds)) {
    return seconds * 1000;
  }
  return header === null ? NaN : Date.parse(header) - Date.now();
}

function retryDelay(response: Response, backoff: number): number {
  const server = retryAfterMs(response);
  return Math.min(60_000, Math.max(backoff, Number.isFinite(server) ? server : 0));
}

/** Graph's early warning, reported to the governor before a 429 happens. */
function reportThrottleHeader(response: Response, options: RetryOptions): void {
  const header = response.headers.get("x-ms-throttle-limit-percentage");
  const percentage = header === null ? NaN : Number(header);
  if (Number.isFinite(percentage)) {
    options.onThrottle?.({ throttlePercentage: percentage });
  }
}

/**
 * Sleeps before retrying a throttled response and returns the delay, or returns null when the
 * caller should fail with the v0.2 error. The interactive lane throws `RateLimitedError` instead
 * once the next wait would push its total past `INTERACTIVE_MAX_WAIT_MS`.
 */
async function retryThrottled(
  response: Response,
  state: {
    attempt: number;
    retries: number;
    waitedMs: number;
    sleep: ((ms: number) => Promise<void>) | undefined;
    signal: AbortSignal | null | undefined;
  },
  options: RetryOptions,
): Promise<number | null> {
  const delay = retryDelay(response, rateLimitDelaysMs[state.attempt] ?? 60_000);
  options.onThrottle?.({ retryAfterSeconds: delay / 1000 });
  const interactive = options.lane === "interactive" || options.budget !== undefined;
  const withinBudget = options.budget
    ? delay <= options.budget.remainingMs
    : !interactive || state.waitedMs + delay <= INTERACTIVE_MAX_WAIT_MS;
  if (state.sleep && state.attempt < state.retries && withinBudget) {
    await response.body?.cancel();
    await abortableSleep(state.sleep, delay, state.signal);
    if (options.budget) {
      options.budget.remainingMs -= delay;
    }
    return delay;
  }
  if (!interactive) {
    return null;
  }
  const hinted = retryAfterMs(response);
  await response.body?.cancel();
  throw new RateLimitedError(
    Math.max(1, Math.ceil((Number.isFinite(hinted) ? hinted : delay) / 1000)),
    options.scope ?? "provider:http",
    response.status,
  );
}

/** `sleep(ms)` that rejects with `ABORTED` as soon as `signal` aborts (R1-8). */
async function abortableSleep(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  if (!signal) {
    return sleep(ms);
  }
  if (signal.aborted) {
    throw aborted();
  }
  let onAbort = () => {};
  const abort = new Promise<never>((_, reject) => {
    onAbort = () => reject(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), abort]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function aborted(): ProviderError {
  return new ProviderError("ABORTED", "The read was cancelled");
}

/**
 * With sleep, rate-limited reads are retried; mutations are never replayed. The interactive lane
 * stops once the next wait would push the total past `INTERACTIVE_MAX_WAIT_MS`.
 */
export async function request(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit = {},
  sleep?: (ms: number) => Promise<void>,
  options: RetryOptions = {},
): Promise<Response> {
  const replayable = (init.method ?? "GET").toUpperCase() === "GET" || options.idempotent;
  const retries = sleep && replayable ? rateLimitDelaysMs.length : 0;
  let waitedMs = 0;
  for (let attempt = 0; ; attempt++) {
    // The caller's signal cancels; the timeout is per attempt and starts only now (R1-8).
    const timeout = AbortSignal.timeout(NETWORK_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetcher(url, {
        ...init,
        redirect: "error",
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
    } catch {
      // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

      if (init.signal?.aborted) {
        throw aborted();
      }
      throw new ProviderError("NETWORK_ERROR", "Provider request failed or timed out");
    }
    reportThrottleHeader(response, options);
    if (response.ok) {
      return response;
    }
    const throttled = await isRateLimited(response);
    if (throttled) {
      const slept = await retryThrottled(
        response,
        { attempt, retries, waitedMs, sleep, signal: init.signal },
        options,
      );
      if (slept !== null) {
        waitedMs += slept;
        continue;
      }
    }
    throw new ProviderError(
      response.status === 401
        ? "AUTH_FAILED"
        : throttled
          ? "RATE_LIMITED"
          : `HTTP_${response.status}`,
      `Provider request failed (HTTP ${response.status})`,
      response.status,
    );
  }
}
