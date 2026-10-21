import type {
  CalendarEvent,
  CalendarProvider,
  Email,
  EventBus,
  MailProvider,
  Store,
} from "@passport/types";
import { persistArrival } from "../arrivals.js";
import { ApiError, required } from "../errors.js";
import { createSyncIdentity } from "./identity.js";
import { type Cursors, key, prefix } from "./state.js";

/** Owns provider-to-local identity mapping and durable, restartable ingestion. */
export class SyncService {
  private readonly identities: ReturnType<typeof createSyncIdentity>;
  private active = new Map<string, Promise<void>>();
  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly mailFor: (id: string) => Promise<MailProvider>,
    private readonly calendarFor: (id: string) => Promise<CalendarProvider>,
  ) {
    this.identities = createSyncIdentity(store);
  }

  /** Also normalizes executor provider results before they are mirrored to Store. */
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

  private async markDeleted(email: Email) {
    if (email.keywords.$deleted) {
      return;
    }
    await this.store.emails.patchMany([email.id], {
      keywords: { ...email.keywords, $deleted: true },
    });
    // Keep the email, its matter history and its thread available locally.
    this.bus.emit({ type: "email.updated", emailId: email.id });
  }
  /** Windowed onboarding snapshots cannot prove older mail has disappeared. */
  protected mailSnapshotSince(_accountId: string): string | undefined {
    return undefined;
  }
  private async reconcileMail(accountId: string, seen: Set<string>) {
    let cursor: string | null | undefined;
    do {
      const page = await this.store.emails.query({
        accountId,
        limit: 500,
        cursor,
        after: this.mailSnapshotSince(accountId),
      });
      for (const email of page.items) {
        if (!seen.has(email.providerId)) {
          await this.markDeleted(email);
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  private async reconcileEvents(accountId: string, seen: Set<string>) {
    const events = await this.store.events.query({ accountId, limit: 2147483647 });
    await this.store.events.deleteMany(
      events.filter((event) => !seen.has(event.providerId)).map((event) => event.id),
    );
  }

  private async sync(accountId: string) {
    const account = required(await this.store.accounts.get(accountId), "Account");
    const stored = (await this.store.syncState.get(accountId))?.cursor;
    const cursors: Cursors = stored?.startsWith(prefix)
      ? JSON.parse(stored.slice(prefix.length))
      : {
          mail: account.capabilities.mail ? (stored ?? null) : null,
          calendar: !account.capabilities.mail ? (stored ?? null) : null,
        };
    const persist = () =>
      this.store.syncState.set({
        accountId,
        cursor: prefix + JSON.stringify(cursors),
        updatedAt: new Date().toISOString(),
      });
    let emailsUpserted = 0;
    try {
      await this.store.kv.set(`sync-in-progress:${accountId}`, "1");
      // Calendar data must be available before email.received can start scheduling playbooks.
      if (account.capabilities.calendar) {
        // Durable intent also survives a crash/partial failed pass. Only a fully
        // ingested snapshot can clear it and establish availability again.
        await this.store.kv.set(`calendar-sync-in-progress:${accountId}`, "1");
        const provider = await this.calendarFor(accountId);
        const reconcileKey = key("sync-reconcile", accountId, "calendar");
        let reconcile = !!(await this.store.kv.get(reconcileKey));
        if (reconcile) {
          cursors.calendar = null;
          await persist();
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
          for await (const delta of provider.sync(cursors.calendar)) {
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
          cursors.calendar = await ingest();
        } catch (error) {
          // An expired calendar cursor requires full reconciliation; other provider errors propagate.

          if ((error as { code?: string }).code !== "CURSOR_EXPIRED") {
            throw error;
          }
          cursors.calendar = null;
          reconcile = true;
          await this.store.kv.set(reconcileKey, "1");
          await persist();
          cursors.calendar = await ingest();
        }
        if (reconcile) {
          await persist();
          await this.store.kv.delete(reconcileKey);
        }
        // A combined mail/calendar account can finish its calendar before mail
        // emits arrivals. Keep an explicit calendar-only completion checkpoint.
        await this.store.kv.set(
          `calendar-sync:${accountId}`,
          JSON.stringify({
            syncState: { cursor: cursors.calendar },
            lastSyncAt: new Date().toISOString(),
          }),
        );
        await this.store.kv.delete(`calendar-sync-in-progress:${accountId}`);
      }
      if (account.capabilities.mail) {
        const provider = await this.mailFor(accountId);
        const reconcileKey = key("sync-reconcile", accountId, "mail");
        let reconcile = !!(await this.store.kv.get(reconcileKey));
        if (reconcile) {
          cursors.mail = null;
          await persist();
        }
        const ingest = async () => {
          let final: string | null = null;
          const seen = new Set<string>();
          const deleted = new Set<string>();
          for await (const delta of provider.sync(cursors.mail)) {
            final = delta.kind === "cursor" ? delta.cursor : null;
            if (delta.kind === "mailbox") {
              if (delta.op === "upsert") {
                await this.store.mailboxes.upsertMany([
                  await this.identities.mailbox(accountId, delta.mailbox),
                ]);
              } else {
                await this.store.mailboxes.deleteMany([
                  await this.identities.reference(accountId, "mailbox", delta.id),
                ]);
              }
            }
            if (delta.kind === "email") {
              if (delta.op === "delete") {
                deleted.add(delta.providerId);
                seen.delete(delta.providerId);
              } else {
                seen.add(delta.email.providerId);
                deleted.delete(delta.email.providerId);
                const existing = await this.store.emails.getByProviderId(
                  accountId,
                  delta.email.providerId,
                );
                const email = await this.email(accountId, delta.email);
                const seenKey = key("sync-seen", accountId, email.providerId);
                const isNew = !existing && !(await this.store.kv.get(seenKey));
                const arrival = isNew && (await this.identities.isArrival(email));
                if (arrival) {
                  await persistArrival(this.store, email);
                }
                await this.store.emails.upsertMany([email]);
                if (existing && existing.threadId !== email.threadId) {
                  const previous = await this.store.threads.get(existing.threadId);
                  if (previous) {
                    await this.store.threads.upsertMany([
                      {
                        ...previous,
                        emailIds: previous.emailIds.filter((id) => id !== email.id),
                      },
                    ]);
                  }
                }
                const thread = await this.store.threads.get(email.threadId);
                await this.store.threads.upsertMany([
                  {
                    id: email.threadId,
                    accountId,
                    emailIds: [...new Set([...(thread?.emailIds ?? []), email.id])],
                  },
                ]);
                await this.store.kv.set(seenKey, "1");
                this.bus.emit(
                  arrival
                    ? { type: "email.received", email }
                    : { type: "email.updated", emailId: email.id },
                );
                emailsUpserted++;
              }
            }
            if (delta.kind === "thread") {
              const id = await this.identities.reference(accountId, "thread", delta.thread.id);
              const existing = await this.store.threads.get(id);
              const emailIds = await Promise.all(
                delta.thread.emailIds.map((id) =>
                  this.identities.reference(accountId, "email", id),
                ),
              );
              const present = await Promise.all(
                [...new Set([...emailIds, ...(existing?.emailIds ?? [])])].map((id) =>
                  this.store.emails.get(id),
                ),
              );
              await this.store.threads.upsertMany([
                {
                  id,
                  accountId,
                  emailIds: present
                    .filter((email): email is Email => email !== null && email.threadId === id)
                    .map((email) => email.id),
                },
              ]);
            }
          }
          if (final === null) {
            throw new ApiError("SYNC_INCOMPLETE", "Mail sync did not finish with a cursor");
          }
          // A partial full snapshot never removes or tombstones unseen mail.
          if (reconcile) {
            await this.reconcileMail(accountId, seen);
          }
          for (const providerId of deleted) {
            const email = await this.store.emails.getByProviderId(accountId, providerId);
            if (email) {
              await this.markDeleted(email);
            }
          }
          return final;
        };
        try {
          cursors.mail = await ingest();
        } catch (error) {
          // An expired mail cursor requires full reconciliation; other provider errors propagate.

          if ((error as { code?: string }).code !== "CURSOR_EXPIRED") {
            throw error;
          }
          reconcile = true;
          await this.store.kv.set(reconcileKey, "1");
          cursors.mail = null;
          await persist();
          cursors.mail = await ingest();
        }
        // Commit the cursor before clearing recovery intent. A crash between these
        // writes safely repeats a full reconciliation from null.
        await persist();
        if (reconcile) {
          await this.store.kv.delete(reconcileKey);
        }
      }
      await persist();
      const at = new Date().toISOString();
      await this.store.accounts.upsert({
        ...required(await this.store.accounts.get(accountId), "Account"),
        updatedAt: at,
        lastSyncAt: at,
        lastSyncError: null,
      });
      this.bus.emit({ type: "account.synced", accountId, at, emailsUpserted });
    } catch (error) {
      // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

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
