import type { Store } from "@passport/types";
import { mutateKv } from "./atomic-kv.js";

/**
 * Bounds on the durable arrival queue (R4-11, R4-12). New mail waits in the queue while no model
 * is configured; it must never turn into a backfill when one is configured later.
 */
export const ARRIVAL_LIMITS = {
  /** Newest pending arrivals kept; older ones are dropped with a notice. */
  maxPending: 200,
  /** A never-attempted arrival older than this is dropped instead of triaged. */
  staleMs: 86_400_000,
  /** Drains that may find the message gone at the provider before the arrival is dropped. */
  goneRetries: 1,
} as const;

/** Why arrivals were dropped: `backlog` (cap or 24 h age) or `gone` (deleted at the provider). */
export type DropReason = "backlog" | "gone";
export type DroppedCounts = Record<string, Partial<Record<DropReason, number>>>;

const DROPPED = "arrival:dropped";

/** Adds to the per-account dropped counts reported by the next drain. */
export function recordDropped(store: Store, accountId: string, reason: DropReason, count = 1) {
  if (count <= 0) {
    return;
  }
  mutateKv(store, DROPPED, (current) => {
    const counts: DroppedCounts = JSON.parse(current ?? "{}");
    const account = (counts[accountId] ??= {});
    account[reason] = (account[reason] ?? 0) + count;
    return JSON.stringify(counts);
  });
}

/** Takes (and clears) the dropped counts. */
export function takeDropped(store: Store): DroppedCounts {
  let taken: DroppedCounts = {};
  mutateKv(store, DROPPED, (current) => {
    taken = JSON.parse(current ?? "{}");
    return null;
  });
  return taken;
}

/** Index entries beyond the cap, oldest first (insertion order). */
export function overflow(index: Record<string, string>): Array<[string, string]> {
  const entries = Object.entries(index);
  return entries.slice(0, Math.max(0, entries.length - ARRIVAL_LIMITS.maxPending));
}

/** The person-facing notice for dropped arrivals. */
export function droppedNotice(counts: Partial<Record<DropReason, number>>): string {
  const parts: string[] = [];
  if (counts.backlog) {
    parts.push(
      `${counts.backlog} new ${counts.backlog === 1 ? "message was" : "messages were"} not triaged: they waited too long (more than ${ARRIVAL_LIMITS.maxPending} queued or older than 24 hours, usually because no model was configured)`,
    );
  }
  if (counts.gone) {
    parts.push(
      `${counts.gone} new ${counts.gone === 1 ? "message was" : "messages were"} deleted or moved at the provider before triage`,
    );
  }
  return `${parts.join("; ")}.`;
}
