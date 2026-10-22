import type { ActionQuery, ActionRecord, Email, EmailQuery, Store } from "@passport/types";
import { AgentError } from "./errors.js";

/** Hard ceiling for `allEmails`: the v0.3 store is a cache, not a mirror worth draining. */
export const ALL_EMAILS_MAX = 1_000;

/**
 * Drain a cursor-based email query, stopping at `ALL_EMAILS_MAX` rows with a diagnostic.
 *
 * @deprecated v0.3 reads mail on demand. The runtime no longer scans the store; this remains for
 * tests and the reader-less fallback. Use `store.emails.get` for known ids or a `MailReader`.
 */
export async function allEmails(
  store: Store,
  query: EmailQuery = {},
  log?: (message: string) => void,
): Promise<Email[]> {
  const result: Email[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await store.emails.query({
      ...query,
      limit: Math.min(200, ALL_EMAILS_MAX - result.length),
      cursor,
    });
    result.push(...page.items.slice(0, ALL_EMAILS_MAX - result.length));
    cursor = page.nextCursor ?? undefined;
    if (cursor && result.length >= ALL_EMAILS_MAX) {
      log?.(`Email scan stopped at ${ALL_EMAILS_MAX} rows; remaining store rows were not read`);
      break;
    }
    if (cursor && cursors.has(cursor)) {
      throw new AgentError("Store returned a repeated email cursor", "STORE_CURSOR");
    }
    if (cursor) {
      cursors.add(cursor);
    }
  } while (cursor);
  return result;
}

export async function allActions(store: Store, query: ActionQuery = {}): Promise<ActionRecord[]> {
  const result: ActionRecord[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await store.actions.query({ ...query, limit: 200, cursor });
    result.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor)) {
      throw new AgentError("Store returned a repeated action cursor", "STORE_CURSOR");
    }
    if (cursor) {
      cursors.add(cursor);
    }
  } while (cursor);
  return result;
}

export function normalizeAddress(email: string): string {
  return email.trim().toLowerCase();
}

export function overlaps(
  a: { start: string; end: string },
  b: { start: string; end: string },
): boolean {
  return Date.parse(a.start) < Date.parse(b.end) && Date.parse(a.end) > Date.parse(b.start);
}
