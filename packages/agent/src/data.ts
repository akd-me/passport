import type { ActionQuery, ActionRecord, Email, EmailQuery, Store } from "@passport/types";
import { AgentError } from "./errors.js";

/** Drain cursor-based queries; never silently truncate a digest or relationship history. */
export async function allEmails(store: Store, query: EmailQuery = {}): Promise<Email[]> {
  const result: Email[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await store.emails.query({ ...query, limit: 200, cursor });
    result.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor)) throw new AgentError("Store returned a repeated email cursor", "STORE_CURSOR");
    if (cursor) cursors.add(cursor);
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
    if (cursor && cursors.has(cursor)) throw new AgentError("Store returned a repeated action cursor", "STORE_CURSOR");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return result;
}

export function normalizeAddress(email: string): string { return email.trim().toLowerCase(); }

export function overlaps(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return Date.parse(a.start) < Date.parse(b.end) && Date.parse(a.end) > Date.parse(b.start);
}
