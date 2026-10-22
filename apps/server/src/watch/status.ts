import { type Account, type MailLabel, type Store, watcherTickKey } from "@passport/types";
import { readCursors } from "../sync/state.js";

/** ISO time of the last successful tick. The store reads it to decide cached-label staleness. */
export { watcherTickKey };
/** `LabelSummary` from the last `labels(counts)` refresh. */
export const labelsKey = (accountId: string) => `watch-labels:${accountId}`;
/** `WatchState` while the watcher is backing off, failing, or unsupported. Absent when healthy. */
export const stateKey = (accountId: string) => `watch-state:${accountId}`;

export type WatchStatusName =
  | "starting"
  | "watching"
  | "backoff"
  | "stale"
  | "error"
  | "unsupported"
  | "needs-sign-in";

export interface WatchState {
  status: "backoff" | "error" | "unsupported";
  error?: string;
  retryAt?: string;
}
export interface LabelSummary {
  at: string;
  inbox: { total: number; unread: number } | null;
}
/** `GET /api/accounts` → `watch`. Times are ISO UTC; null until the first tick. */
export interface WatchStatus {
  since: string | null;
  lastTickAt: string | null;
  cursorAgeSeconds: number | null;
  status: WatchStatusName;
  error?: string;
  retryAt?: string;
}

export function summarizeLabels(labels: readonly MailLabel[], at: string): LabelSummary {
  const inbox = labels.find((label) => label.role === "inbox");
  return { at, inbox: inbox?.counts ?? null };
}

export async function inboxCount(store: Store, accountId: string): Promise<number | null> {
  const saved = await store.kv.get(labelsKey(accountId));
  return saved ? ((JSON.parse(saved) as LabelSummary).inbox?.total ?? null) : null;
}

const needsSignIn = (account: Account) =>
  account.settings.reauthorizationRequired === true ||
  account.lastSyncError === "REAUTHORIZE_REQUIRED";

/** Watcher health derived from durable state only (works for any process and the demo). */
export async function readWatchStatus(
  store: Store,
  account: Account,
  intervalSeconds: number,
  now = Date.now(),
): Promise<WatchStatus | null> {
  if (!account.capabilities.mail) {
    return null;
  }
  const cursors = await readCursors(store, account.id);
  const lastTickAt = await store.kv.get(watcherTickKey(account.id));
  const saved = await store.kv.get(stateKey(account.id));
  const state: WatchState | null = saved ? JSON.parse(saved) : null;
  const cursorAt = cursors.mail ? (cursors.cursorAt ?? cursors.since ?? null) : null;
  const base = {
    since: cursors.mail ? (cursors.since ?? null) : null,
    lastTickAt,
    cursorAgeSeconds: cursorAt
      ? Math.max(0, Math.round((now - Date.parse(cursorAt)) / 1000))
      : null,
  };
  let status: WatchStatusName;
  if (needsSignIn(account)) {
    status = "needs-sign-in";
  } else if (state?.status === "unsupported") {
    status = "unsupported";
  } else if (state?.status === "backoff" && state.retryAt && Date.parse(state.retryAt) > now) {
    status = "backoff";
  } else if (state?.status === "error") {
    status = "error";
  } else if (!base.since || !lastTickAt) {
    status = "starting";
  } else if (now - Date.parse(lastTickAt) > Math.max(300, intervalSeconds * 3) * 1000) {
    status = "stale";
  } else {
    status = "watching";
  }
  return {
    ...base,
    status,
    ...(state?.error ? { error: state.error } : {}),
    ...(state?.retryAt ? { retryAt: state.retryAt } : {}),
  };
}
