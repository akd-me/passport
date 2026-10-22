/** Watcher error classification. Provider error text is never persisted, only bounded codes. */

const REAUTHORIZE = new Set([
  "AUTH_FAILED",
  "OAUTH_REFRESH_FAILED",
  "TOKEN_EXPIRED",
  "REAUTHORIZE_REQUIRED",
]);
const MAX_BACKOFF_MS = 15 * 60_000;
const BASE_BACKOFF_MS = 30_000;

export const safeCode = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "WATCH_FAILED";
};
export const needsReauthorization = (code: string) => REAUTHORIZE.has(code);

/** Governor `RATE_LIMITED` (lanes, provider 429/403 quota) and HTTP 429/503. */
export const rateLimited = (error: unknown) => {
  const failure = error as { code?: string; status?: number };
  return (
    [429, 503].includes(failure.status ?? 0) ||
    ["RATE_LIMITED", "HTTP_429", "HTTP_503"].includes(failure.code ?? "")
  );
};

/** 30 s doubling per consecutive limit, at least the governor's `retryAfterSeconds`, ≤ 15 min. */
export function backoffMs(error: unknown, attempt: number): number {
  const hinted = Number((error as { retryAfterSeconds?: number }).retryAfterSeconds ?? 0);
  return Math.min(MAX_BACKOFF_MS, Math.max(hinted * 1000, BASE_BACKOFF_MS * 2 ** (attempt - 1)));
}
