import type { Email, MailChanges, MailEnvelope, SyncDelta } from "@passport/types";
import { decodeCursor, encodeCursor, ProviderError } from "./errors.js";

const MAX_LIMIT = 100;

export interface PageCursor {
  account: string;
  kind: "search" | "list";
  key: string;
  offset: number;
}

export const stripBrackets = (value: string) => value.trim().replace(/^</, "").replace(/>$/, "");

/** Slices one page of `matches`; the token is bound to the account, kind and query key. */
export function pageOf(
  accountId: string,
  matches: Email[],
  kind: PageCursor["kind"],
  key: string,
  limit: number,
  pageToken: string | undefined,
): { items: Email[]; nextPageToken?: string; approxTotal: number } {
  let offset = 0;
  if (pageToken) {
    const c = decodeCursor<PageCursor>(pageToken);
    if (
      c.account !== accountId ||
      c.kind !== kind ||
      c.key !== key ||
      !Number.isInteger(c.offset)
    ) {
      throw new ProviderError("INVALID_CURSOR", "Page token belongs to a different query");
    }
    offset = c.offset;
  }
  const size = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
  const items = matches.slice(offset, offset + size);
  const next = offset + items.length;
  return {
    items,
    approxTotal: matches.length,
    ...(next < matches.length
      ? {
          nextPageToken: encodeCursor({
            account: accountId,
            kind,
            key,
            offset: next,
          } satisfies PageCursor),
        }
      : {}),
  };
}

export function mailHandleForFolder(accountId: string, name: string): string {
  return `${accountId}:mailbox:${encodeURIComponent(name)}`;
}

export function withoutBodies(email: Email): MailEnvelope {
  const { textBody: _text, htmlBody: _html, ...envelope } = email;
  return envelope;
}

export function newestPerThread(emails: Email[]): Email[] {
  const seen = new Set<string>();
  return emails.filter((email) => !seen.has(email.threadId) && seen.add(email.threadId));
}

/**
 * Classifies log entries from `start`: the first upsert of an id anywhere in the log is an
 * arrival, later upserts are label changes. Stops after `limit` distinct ids; `next` is the
 * log index to resume from.
 */
export function collectChanges(
  log: ReadonlyArray<Extract<SyncDelta, { kind: "email" }>>,
  start: number,
  limit: number,
): Omit<MailChanges, "cursor" | "expired"> & { next: number } {
  const known = new Set<string>();
  for (const entry of log.slice(0, start)) {
    if (entry.op === "upsert") {
      known.add(entry.email.providerId);
    }
  }
  const added = new Set<string>();
  const changed = new Set<string>();
  const deleted = new Set<string>();
  const touched = () => new Set([...added, ...changed, ...deleted]).size;
  let index = start;
  for (; index < log.length; index++) {
    const entry = log[index];
    if (!entry) {
      break;
    }
    const id = entry.op === "upsert" ? entry.email.providerId : entry.providerId;
    const isNew = !added.has(id) && !changed.has(id) && !deleted.has(id);
    if (isNew && touched() >= limit) {
      break;
    }
    if (entry.op === "delete") {
      added.delete(id);
      changed.delete(id);
      deleted.add(id);
    } else if (!known.has(id)) {
      known.add(id);
      added.add(id);
    } else if (!added.has(id)) {
      deleted.delete(id);
      changed.add(id);
    }
  }
  return {
    added: [...added],
    labelChanged: [...changed],
    deleted: [...deleted],
    next: index,
    ...(index < log.length ? { hasMore: true } : {}),
  };
}
