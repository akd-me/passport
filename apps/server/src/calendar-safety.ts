import type { Account, ActionParams, EventBus, Store } from "@passport/types";
import { expandRecurringEvents } from "./calendar-recurrence.js";
import { ApiError } from "./errors.js";

async function relevantCalendars(store: Store, accountId: string): Promise<Account[]> {
  const accounts = await store.accounts.list();
  const mail = accounts.find((account) => account.id === accountId);
  return accounts.filter(
    (account) =>
      account.capabilities.calendar &&
      (account.id === accountId ||
        account.settings.mailAccountId === accountId ||
        account.emailAddress.toLowerCase() === mail?.emailAddress.toLowerCase()),
  );
}
export async function calendarsReady(
  store: Store,
  accountId: string,
  maxAgeMinutes?: number,
): Promise<boolean> {
  const accounts =
    maxAgeMinutes === undefined
      ? await relevantCalendars(store, accountId)
      : (await store.accounts.list()).filter((account) => account.capabilities.calendar);
  if (maxAgeMinutes !== undefined && !accounts.length) return false;
  const fresh = (at: string | null | undefined) =>
    !!at &&
    Number.isFinite(Date.parse(at)) &&
    (maxAgeMinutes === undefined || Date.now() - Date.parse(at) <= maxAgeMinutes * 60000);
  for (const account of accounts) {
    if (maxAgeMinutes !== undefined && (await store.kv.get(`sync-in-progress:${account.id}`)))
      return false;
    if (await store.kv.get(`calendar-sync-in-progress:${account.id}`)) return false;
    if (
      await store.kv.get(
        ["sync-reconcile", account.id, "calendar"].map(encodeURIComponent).join(":"),
      )
    )
      return false;
    const checkpoint = await store.kv.get(`calendar-sync:${account.id}`);
    if (checkpoint) {
      const calendar = JSON.parse(checkpoint);
      if (calendar.syncState?.cursor && fresh(calendar.lastSyncAt)) continue;
      return false;
    }
    const state = await store.syncState.get(account.id);
    if (!fresh(account.lastSyncAt) || !state?.cursor) return false;
    if (
      state.cursor.startsWith("passport-sync-v1:") &&
      !JSON.parse(state.cursor.slice("passport-sync-v1:".length)).calendar
    )
      return false;
  }
  return true;
}

/** Validate on the held-action claim, immediately before executor dispatch. */
export function calendarSafeStore(
  store: Store,
  bus: EventBus,
  isRelease: () => boolean,
  maxAgeMinutes = () => 10,
): Store {
  return {
    ...store,
    actions: {
      ...store.actions,
      async claim(id, from, to, at) {
        const action = await store.actions.get(id);
        if (
          isRelease() &&
          from === "held" &&
          action?.status === "held" &&
          action.request.type === "calendar_propose"
        ) {
          if (!(await calendarsReady(store, action.request.accountId, maxAgeMinutes()))) {
            if (!(await store.actions.claim!(id, from, to, at))) return null;
            const key = `calendar-hold-extensions:${id}`;
            const extensions = Number((await store.kv.get(key)) ?? 0);
            if (extensions < 3) {
              await store.kv.set(key, String(extensions + 1));
              const holdUntil = new Date(Date.now() + 30000).toISOString();
              const extended = await store.actions.update(id, {
                status: "held",
                holdUntil,
                decision: { ...action.decision, holdUntil },
              });
              bus.emit({ type: "action.held", action: extended });
            } else {
              const reason = "AVAILABILITY_UNVERIFIED";
              const proposed = await store.actions.update(id, {
                status: "proposed",
                holdUntil: null,
                error: reason,
                request: { ...action.request, reason: `${action.request.reason}\n${reason}` },
                decision: { ...action.decision, outcome: "ask", reason, holdUntil: null },
              });
              bus.emit({ type: "action.proposed", action: proposed });
            }
            return null;
          }
          const { slots } = action.request.params as ActionParams["calendar_propose"];
          let conflict = false;
          let unverified = false;
          for (const account of (await store.accounts.list()).filter(
            (account) => account.capabilities.calendar,
          )) {
            for (const slot of slots) {
              const events = await store.events.query({
                accountId: account.id,
                range: slot,
                includeRecurring: true,
                limit: 2147483647,
              });
              try {
                conflict ||= expandRecurringEvents(events, slot).length > 0;
              } catch (error) {
                if (!(error instanceof ApiError)) throw error;
                unverified = true;
              }
            }
          }
          if (conflict || unverified) {
            const reason = conflict ? "AVAILABILITY_CHANGED" : "AVAILABILITY_UNVERIFIED";
            if (!(await store.actions.claim!(id, from, to, at))) return null;
            const proposed = await store.actions.update(id, {
              status: "proposed",
              holdUntil: null,
              error: reason,
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
