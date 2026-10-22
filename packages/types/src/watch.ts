/**
 * Additive contract (v0.3): new-mail watcher events. The watcher replaces the mail half of the
 * v0.2 sync service: it follows `MailReader.changes` from a cursor taken at connect time and
 * never backfills. Re-exported from `./index.ts`; part of `DomainEvent`.
 */

import type { Id, Timestamp } from "./index.js";

export type WatchEvent =
  /** The first tick took a cursor at "now". `since` is when watching started. */
  | { type: "account.watch.started"; accountId: Id; since: Timestamp }
  /** One successful tick. `arrivals` counts messages queued for triage. */
  | {
      type: "account.watch.tick";
      accountId: Id;
      at: Timestamp;
      added: number;
      arrivals: number;
    }
  /** The provider expired the cursor; labels were marked stale and recent inbox mail swept. */
  | { type: "account.watch.expired"; accountId: Id; at: Timestamp; swept: number; arrivals: number }
  /** Rate limited; the next tick waits at least `retryAfterSeconds`. Never fails the account. */
  | { type: "account.watch.backoff"; accountId: Id; retryAfterSeconds: number }
  /** A tick failed with a bounded machine code (`REAUTHORIZE_REQUIRED` pauses the watcher). */
  | { type: "account.watch.failed"; accountId: Id; error: string };
