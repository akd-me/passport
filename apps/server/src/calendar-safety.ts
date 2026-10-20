import type { Account, ActionParams, EventBus, Store } from "@passport/types";
import { expandRecurringEvents } from "./calendar-recurrence.js";
import { ApiError } from "./errors.js";

async function relevantCalendars(store: Store, accountId: string): Promise<Account[]> {
  const accounts = await store.accounts.list();
  const mail = accounts.find(account => account.id === accountId);
  return accounts.filter(account => account.capabilities.calendar &&
    (account.id === accountId || account.settings.mailAccountId === accountId ||
      account.emailAddress.toLowerCase() === mail?.emailAddress.toLowerCase()));
}
export async function calendarsReady(store: Store, accountId: string): Promise<boolean> {
  for (const account of await relevantCalendars(store, accountId)) {
    if (await store.kv.get(["sync-reconcile", account.id, "calendar"].map(encodeURIComponent).join(":"))) return false;
    const checkpoint = await store.kv.get(`calendar-sync:${account.id}`);
    if (checkpoint) {
      const calendar = JSON.parse(checkpoint);
      if (calendar.syncState?.cursor && calendar.lastSyncAt) continue;
    }
    const state = await store.syncState.get(account.id);
    if (!account.lastSyncAt || !state?.cursor) return false;
    if (state.cursor.startsWith("passport-sync-v1:") && !JSON.parse(state.cursor.slice("passport-sync-v1:".length)).calendar) return false;
  }
  return true;
}

/** Validate on the held-action claim, immediately before executor dispatch. */
export function calendarSafeStore(store: Store, bus: EventBus, isRelease: () => boolean): Store {
  return {
    ...store,
    actions: {
      ...store.actions,
      async claim(id, from, to, at) {
        const action = await store.actions.get(id);
        if (isRelease() && from === "held" && action?.status === "held" && action.request.type === "calendar_propose") {
          const { slots } = action.request.params as ActionParams["calendar_propose"];
          let conflict = false;
          let unverified = false;
          for (const account of await relevantCalendars(store, action.request.accountId)) {
            for (const slot of slots) {
              const events = await store.events.query({ accountId: account.id, range: slot, includeRecurring: true, limit: 2147483647 });
              try { conflict ||= expandRecurringEvents(events, slot).length > 0; }
              catch (error) {
                if (!(error instanceof ApiError)) throw error;
                unverified = true;
              }
            }
          }
          if (conflict || unverified) {
            const reason = conflict ? "AVAILABILITY_CHANGED" : "AVAILABILITY_UNVERIFIED";
            if (!await store.actions.claim!(id, from, to, at)) return null;
            const proposed = await store.actions.update(id, {
              status: "proposed", holdUntil: null, error: reason,
              request: { ...action.request, reason: `${action.request.reason}\n${reason}` },
              decision: { ...action.decision, outcome: "ask", reason, holdUntil: null },
            });
            bus.emit({ type: "action.proposed", action: proposed });
            return null;
          }
        }
        return store.actions.claim!(id, from, to, at);
      },
    },
  };
}
