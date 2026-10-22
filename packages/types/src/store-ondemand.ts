/**
 * Additive contract (v0.3): `Store.emails` as a read-through envelope cache instead of a mirror.
 * See `docs/design/on-demand.md` §4.2 and research report 03 §3.2 / §4.2 ("Migration seam").
 *
 * Semantics (SQLite store, once `setMailReaderResolver` has been called):
 *  - `emails.get(id)` / `getByProviderId` read the local row first. Its mutable state (keywords,
 *    mailboxIds) is revalidated through `MailReader.envelopes` when `fresh` is set or when the
 *    row's labels are older than the account's last watcher tick (kv `watcher-tick:<accountId>`,
 *    an ISO timestamp the server writes only when a change cursor expired or was rejected, i.e.
 *    when label changes may have been lost; see `watcherTickKey`).
 *  - A miss whose id is a mail handle (`mailHandle(account, "email", providerId)`) is looked up
 *    by `(account, providerId)`, then fetched with `MailReader.envelopes` and cached. Rows created
 *    this way use the handle as their `Email.id` and the provider's thread handle as `threadId`;
 *    there is no ULID remapping. Rows written by the v0.2 mirror keep their ULIDs.
 *  - Bodies are a cache: `includeBodies: true` fetches `MailReader.body` when no body is cached;
 *    `includeBodies` omitted returns cached bodies only (never a provider call).
 *  - With no resolver, or when the resolver returns `null`, everything behaves as the v0.2 mirror.
 *  - Revalidation failures fall back to the cached row unless `fresh` was requested, in which
 *    case the provider error propagates. A provider `null` envelope tombstones the row
 *    (`keywords.$deleted = true`), exactly like the v0.2 sync did.
 *  - `EmailQuery.text` searches cached envelopes (subject, from, preview) only. Bodies are not
 *    indexed; provider search is the primary search path.
 *
 * Re-exported from `./index.ts`; import from the package root only.
 */

import type { Id, Mailbox, Timestamp } from "./index.js";
import type { MailLabel } from "./mail-row.js";
import type { MailReaderResolver, QuotaLane } from "./ondemand.js";

/** kv key holding the ISO time of the account's last change-watcher tick. */
export function watcherTickKey(accountId: Id): string {
  return `watcher-tick:${accountId}`;
}

/** Options for `Store.emails.get` and `Store.emails.getByProviderId`. */
export interface EmailGetOptions {
  /**
   * `true` returns bodies, fetching them from the provider when none are cached. `false` omits
   * them. Omitted: `get` returns cached bodies only; `getByProviderId` behaves as `true` without
   * a provider fetch (v0.2 behaviour).
   */
  includeBodies?: boolean;
  /**
   * Revalidate mutable state (keywords, mailboxIds) from the provider before returning. Used for
   * executor pre-images so inverses are computed from current provider state.
   */
  fresh?: boolean;
  /** Governor lane for any provider read. Defaults to the reader's default (`"interactive"`). */
  lane?: QuotaLane;
  /** Never call the provider: return the cached row (or null) as the v0.2 mirror did. */
  cacheOnly?: boolean;
}

/** Cache bookkeeping for one email row (side columns, not part of `Email`). */
export interface EnvelopeFreshness {
  /** Last time keywords / mailboxIds were confirmed with the provider; null = unknown. */
  labelsFreshAt: Timestamp | null;
  /** Last local read or write (LRU key). */
  touchedAt: Timestamp | null;
  /** When the cached bodies were fetched; null = no body cached. */
  bodyFetchedAt: Timestamp | null;
}

export interface EvictBodiesOptions {
  /** Drop bodies fetched longer ago than this. Default 7 days. */
  olderThanMs?: number;
  /** Then drop least-recently-touched bodies until the cache is at most this size. Default 200 MB. */
  maxBytes?: number;
}

export interface EvictEnvelopesOptions {
  /** Keep at most this many rows, by most recent `touchedAt`. Default 100,000. */
  keep?: number;
}

export interface EvictionResult {
  /** Rows whose bodies (or envelopes) were removed. */
  evicted: number;
  /** Body bytes still cached after `evictBodies` (0 for `evictEnvelopes`). */
  remainingBytes: number;
}

/** Envelope-cache maintenance on `Store.emails`. Optional so other Store implementations still conform. */
export interface StoreEmailsOnDemand {
  /** Bump the LRU stamp of the given rows. `get` does this automatically; `query` does not. */
  touch?(ids: Id[]): Promise<void>;
  /** Read the cache bookkeeping for one row, or null when the row is not cached. */
  freshness?(id: Id): Promise<EnvelopeFreshness | null>;
  /**
   * TTL then LRU eviction of cached bodies. Drafts keep their bodies (sending needs them).
   * Envelopes stay; a later `get(id, { includeBodies: true })` refetches.
   */
  evictBodies?(opts?: EvictBodiesOptions): Promise<EvictionResult>;
  /**
   * LRU eviction of whole rows beyond `keep`. Rows linked to a matter and drafts are never
   * evicted. Read-through refills evicted rows on the next `get` by handle.
   */
  evictEnvelopes?(opts?: EvictEnvelopesOptions): Promise<EvictionResult>;
}

export interface RefreshLabelsOptions {
  /** Delete cached mailboxes of the account whose provider id is not in `labels`. Default false. */
  prune?: boolean;
}

/** `mail_labels` output cached into `Store.mailboxes`. */
export interface StoreMailboxesOnDemand {
  /**
   * Upserts one mailbox per label, matched by `(accountId, label.id)`. Existing rows keep their
   * id; new rows use the adapter mailbox id `${accountId}:mailbox:${encodeURIComponent(label.id)}`.
   * Counts are replaced only when the label carries them; a label without `role` keeps the cached
   * role (destination guards rely on trash / junk roles). Returns the account's mailboxes.
   */
  refreshFromLabels?(
    accountId: Id,
    labels: MailLabel[],
    opts?: RefreshLabelsOptions,
  ): Promise<Mailbox[]>;
}

/** Top-level on-demand hooks on `Store`. */
export interface StoreOnDemand {
  /**
   * Enables read-through: the store asks the resolver for an account's `MailReader` on misses,
   * stale rows and body requests. Call once from the composition root.
   */
  setMailReaderResolver?(resolver: MailReaderResolver): void;
}
