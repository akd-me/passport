/** How a failed watcher tick is classified. Codes are bounded; provider messages never persist. */

/** Revoked or expired grants: pause the account until the user signs in again. */
export const REAUTHORIZE = [
  "AUTH_FAILED",
  "OAUTH_REFRESH_FAILED",
  "TOKEN_EXPIRED",
  "REAUTHORIZE_REQUIRED",
];
/** A cursor the provider rejects is handled like an expired one. */
export const INVALID_CURSOR = ["INVALID_CURSOR", "CURSOR_EXPIRED"];
const MAX_BACKOFF_MS = 15 * 60_000;
const BASE_BACKOFF_MS = 30_000;

export const safeCode = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "WATCH_FAILED";
};

/** Provider or governor throttling: back off the tick, never fail the account. */
export const rateLimited = (error: unknown) => {
  const failure = error as { code?: string; status?: number };
  return (
    [429, 503].includes(failure.status ?? 0) ||
    ["RATE_LIMITED", "HTTP_429", "HTTP_503"].includes(failure.code ?? "")
  );
};

/** 30 s doubling per consecutive limit, at most 15 min; the provider's hint wins when larger. */
export function backoffDelayMs(attempt: number, error: unknown): number {
  const hinted = Number((error as { retryAfterSeconds?: number }).retryAfterSeconds ?? 0);
  return Math.min(MAX_BACKOFF_MS, Math.max(hinted * 1000, BASE_BACKOFF_MS * 2 ** (attempt - 1)));
}
