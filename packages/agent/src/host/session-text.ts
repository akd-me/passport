/** Failure wording both host CLIs use, classified without forwarding the raw text. */

/** The CLI cannot find the session it was asked to resume (Claude Code, Codex wording). */
export const SESSION_MISSING_TEXT =
  /no conversation found with session id|no rollout found|thread\/resume failed|session not found/i;
/** A usage or rate limit, as both CLIs word it. */
export const LIMIT_TEXT =
  /usage limit|rate limit|limit reached|hit your limit|quota|too many requests/i;

/**
 * The reset time a limit message states, reduced to a form that is safe to forward (digits and
 * unit words only): an epoch after `|`, an ISO timestamp, or "in 2 hours 5 minutes".
 */
export function limitReset(text: string): string {
  const epoch = /\|\s*(\d{10}|\d{13})\b/.exec(text)?.[1];
  if (epoch) {
    return `|${epoch}`;
  }
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/.exec(
    text,
  )?.[0];
  if (iso) {
    return ` (resets ${iso})`;
  }
  const relative =
    /\b(?:in|after)\s+((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[dhms])\b[\s,]*(?:and\s+)?)+)/i.exec(
      text,
    )?.[1];
  return relative ? ` (try again in ${relative.trim().replace(/[\s,]+/g, " ")})` : "";
}
