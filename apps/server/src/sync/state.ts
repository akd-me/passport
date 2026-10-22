import type { Store } from "@passport/types";

/**
 * Cursors for one account, stored in its single `sync_state` row as `passport-watch-v1:<json>`.
 * `mail` is the watcher's `MailReader.changes` cursor (never a v0.2 sync cursor), `calendar` the
 * bounded calendar sync cursor. `since` is when watching started; `cursorAt` when `mail` was last
 * persisted.
 */
export interface Cursors {
  mail: string | null;
  calendar: string | null;
  since?: string;
  cursorAt?: string;
}
export const prefix = "passport-watch-v1:";
/** v0.2 rows. Their `mail` cursor belongs to the retired mirror and is never reused. */
export const legacyPrefix = "passport-sync-v1:";
export const key = (...parts: string[]) => parts.map(encodeURIComponent).join(":");

export function parseCursors(stored: string | null | undefined): Cursors {
  if (stored?.startsWith(prefix)) {
    return { mail: null, calendar: null, ...JSON.parse(stored.slice(prefix.length)) };
  }
  if (stored?.startsWith(legacyPrefix)) {
    const legacy = JSON.parse(stored.slice(legacyPrefix.length)) as Partial<Cursors>;
    return { mail: null, calendar: legacy.calendar ?? null };
  }
  // Unprefixed v0.1 cursors: start the watcher at "now" and resync the bounded calendar.
  return { mail: null, calendar: null };
}

export async function readCursors(store: Store, accountId: string): Promise<Cursors> {
  return parseCursors((await store.syncState.get(accountId))?.cursor);
}

const chains = new WeakMap<Store, Map<string, Promise<unknown>>>();
/** Read-modify-write of one account's row; the watcher and calendar sync share it. */
export function updateCursors(
  store: Store,
  accountId: string,
  patch: Partial<Cursors>,
): Promise<Cursors> {
  let accounts = chains.get(store);
  if (!accounts) {
    accounts = new Map();
    chains.set(store, accounts);
  }
  const next = (accounts.get(accountId) ?? Promise.resolve()).then(async () => {
    const cursors = { ...(await readCursors(store, accountId)), ...patch };
    await store.syncState.set({
      accountId,
      cursor: prefix + JSON.stringify(cursors),
      updatedAt: new Date().toISOString(),
    });
    return cursors;
  });
  accounts.set(
    accountId,
    next.catch(() => undefined),
  );
  return next;
}
