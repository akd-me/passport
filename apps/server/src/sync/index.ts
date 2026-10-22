import type { CalendarEvent, CalendarProvider, Email, EventBus, Store } from "@passport/types";
import { ApiError, required } from "../errors.js";
import { createSyncIdentity } from "./identity.js";
import { key, readCursors, updateCursors } from "./state.js";

/**
 * Provider-to-local identity mapping and the bounded calendar sync. Mail is no longer mirrored:
 * new mail is followed by `MailWatcher` (`../watch/`), everything else is read on demand.
 */
export class SyncService {
  private readonly identities: ReturnType<typeof createSyncIdentity>;
  private active = new Map<string, Promise<void>>();
  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly calendarFor: (id: string) => Promise<CalendarProvider>,
  ) {
    this.identities = createSyncIdentity(store);
  }

  /** Also normalizes executor provider results and watcher envelopes before they are cached. */
  email(accountId: string, email: Email): Promise<Email> {
    return this.identities.email(accountId, email);
  }
  event(accountId: string, event: CalendarEvent): Promise<CalendarEvent> {
    return this.identities.event(accountId, event);
  }

  syncAccount(accountId: string): Promise<void> {
    const current = this.active.get(accountId);
    if (current) {
      return current;
    }
    const job = this.sync(accountId).finally(() => this.active.delete(accountId));
    this.active.set(accountId, job);
    return job;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.active.values()]);
  }

  private async reconcileEvents(accountId: string, seen: Set<string>) {
    const events = await this.store.events.query({ accountId, limit: 2147483647 });
    await this.store.events.deleteMany(
      events.filter((event) => !seen.has(event.providerId)).map((event) => event.id),
    );
  }

  private async sync(accountId: string) {
    const account = required(await this.store.accounts.get(accountId), "Account");
    if (!account.capabilities.calendar) {
      return;
    }
    let cursor = (await readCursors(this.store, accountId)).calendar;
    try {
      await this.store.kv.set(`sync-in-progress:${accountId}`, "1");
      // Durable intent also survives a crash/partial failed pass. Only a fully
      // ingested snapshot can clear it and establish availability again.
      await this.store.kv.set(`calendar-sync-in-progress:${accountId}`, "1");
      const provider = await this.calendarFor(accountId);
      const reconcileKey = key("sync-reconcile", accountId, "calendar");
      let reconcile = !!(await this.store.kv.get(reconcileKey));
      if (reconcile) {
        cursor = null;
        await updateCursors(this.store, accountId, { calendar: null });
      }
      const ingest = async () => {
        const seen = new Set<string>(),
          deleted = new Set<string>();
        for (const calendar of await provider.listCalendars()) {
          await this.store.calendars.upsertMany([
            await this.identities.calendar(accountId, calendar),
          ]);
        }
        let final: string | null = null;
        for await (const delta of provider.sync(cursor)) {
          final = delta.kind === "cursor" ? delta.cursor : null;
          if (delta.kind === "event" && delta.op === "upsert") {
            seen.add(delta.event.providerId);
            deleted.delete(delta.event.providerId);
            await this.store.events.upsertMany([await this.event(accountId, delta.event)]);
          }
          if (delta.kind === "event" && delta.op === "delete") {
            deleted.add(delta.providerId);
            seen.delete(delta.providerId);
          }
        }
        if (final === null) {
          throw new ApiError("SYNC_INCOMPLETE", "Calendar sync did not finish with a cursor");
        }
        if (reconcile) {
          await this.reconcileEvents(accountId, seen);
        }
        const events = await this.store.events.query({ accountId, limit: 2147483647 });
        await this.store.events.deleteMany(
          events.filter((event) => deleted.has(event.providerId)).map((event) => event.id),
        );
        return final;
      };
      try {
        cursor = await ingest();
      } catch (error) {
        // An expired calendar cursor requires full reconciliation; other provider errors propagate.

        if ((error as { code?: string }).code !== "CURSOR_EXPIRED") {
          throw error;
        }
        cursor = null;
        reconcile = true;
        await this.store.kv.set(reconcileKey, "1");
        await updateCursors(this.store, accountId, { calendar: null });
        cursor = await ingest();
      }
      await updateCursors(this.store, accountId, { calendar: cursor });
      if (reconcile) {
        await this.store.kv.delete(reconcileKey);
      }
      // A combined mail/calendar account keeps an explicit calendar-only completion checkpoint.
      await this.store.kv.set(
        `calendar-sync:${accountId}`,
        JSON.stringify({ syncState: { cursor }, lastSyncAt: new Date().toISOString() }),
      );
      await this.store.kv.delete(`calendar-sync-in-progress:${accountId}`);
      const at = new Date().toISOString();
      await this.store.accounts.upsert({
        ...required(await this.store.accounts.get(accountId), "Account"),
        updatedAt: at,
        lastSyncAt: at,
        lastSyncError: null,
      });
      this.bus.emit({ type: "account.synced", accountId, at, emailsUpserted: 0 });
    } catch (error) {
      // Provider errors can contain private data; persist only a bounded machine code.
      const code = (error as { code?: unknown }).code;
      const safeCode =
        typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "SYNC_FAILED";
      await this.store.accounts.upsert({
        ...required(await this.store.accounts.get(accountId), "Account"),
        updatedAt: new Date().toISOString(),
        lastSyncError: safeCode,
      });
      throw error;
    } finally {
      await this.store.kv.delete(`sync-in-progress:${accountId}`);
    }
  }
}
