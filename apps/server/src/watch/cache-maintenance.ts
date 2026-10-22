import type { Store } from "@passport/types";

const KEY = "email-cache-maintained-at";
/** Body TTL/LRU and envelope LRU eviction run at most this often (process-wide). */
export const CACHE_MAINTENANCE_EVERY_MS = 60 * 60 * 1000;

/** Enforces the envelope cache bounds (store defaults: 7 days / 200 MB bodies, 100k rows). */
export async function maintainEmailCache(store: Store, now: number): Promise<void> {
  const last = await store.kv.get(KEY);
  if (last && now - Date.parse(last) < CACHE_MAINTENANCE_EVERY_MS) {
    return;
  }
  await store.kv.set(KEY, new Date(now).toISOString());
  await store.emails.evictBodies?.();
  await store.emails.evictEnvelopes?.();
}
