import { newId } from "@passport/store";
import type {
  Calendar,
  CalendarEvent,
  CalendarProvider,
  Email,
  EventBus,
  Mailbox,
  MailProvider,
  Store,
} from "@passport/types";
import { ApiError, required } from "../errors.js";
import { persistArrival } from "../arrivals.js";

interface Cursors {
  mail: string | null;
  calendar: string | null;
}
const prefix = "passport-sync-v1:";
const key = (...parts: string[]) => parts.map(encodeURIComponent).join(":");

/** Owns provider-to-local identity mapping and durable, restartable ingestion. */
export class SyncService {
  private active = new Map<string, Promise<void>>();
  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly mailFor: (id: string) => Promise<MailProvider>,
    private readonly calendarFor: (id: string) => Promise<CalendarProvider>,
  ) {}

  private async reference(
    accountId: string,
    kind: string,
    nativeId: string,
  ): Promise<string> {
    const alias = key("sync-id", accountId, kind, nativeId);
    let id = await this.store.kv.get(alias);
    if (!id) {
      id = newId();
      await this.store.kv.set(alias, id);
    }
    return id;
  }
  private async identity(
    accountId: string,
    kind: string,
    providerId: string,
    nativeId: string,
    existingId?: string,
  ): Promise<string> {
    const canonical = key("sync-provider", accountId, kind, providerId);
    const id =
      existingId ??
      (await this.store.kv.get(canonical)) ??
      (await this.reference(accountId, kind, nativeId));
    await this.store.kv.set(canonical, id);
    await this.store.kv.set(key("sync-id", accountId, kind, nativeId), id);
    return id;
  }
  private async mailbox(accountId: string, box: Mailbox): Promise<Mailbox> {
    const existing = (await this.store.mailboxes.list(accountId)).find(
      (item) => item.providerId === box.providerId,
    );
    return {
      ...box,
      accountId,
      id: await this.identity(
        accountId,
        "mailbox",
        box.providerId,
        box.id,
        existing?.id,
      ),
      parentId: box.parentId
        ? await this.reference(accountId, "mailbox", box.parentId)
        : null,
    };
  }
  /** Also normalizes executor provider results before they are mirrored to Store. */
  async email(accountId: string, email: Email): Promise<Email> {
    const existing = await this.store.emails.getByProviderId(
      accountId,
      email.providerId,
    );
    const boxes = await this.store.mailboxes.list(accountId);
    return {
      // Only provider-owned fields may replace an existing record. In particular,
      // providers cannot reset annotations made by local agents or humans.
      ...(existing ?? { personIds: [], category: null, matterId: null }),
      accountId,
      id: await this.identity(
        accountId,
        "email",
        email.providerId,
        email.id,
        existing?.id,
      ),
      providerId: email.providerId,
      threadId: await this.reference(accountId, "thread", email.threadId),
      mailboxIds: await Promise.all(
        email.mailboxIds.map((id) =>
          boxes.some((box) => box.id === id)
            ? id
            : this.reference(accountId, "mailbox", id),
        ),
      ),
      keywords: email.keywords,
      from: email.from,
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      replyTo: email.replyTo,
      subject: email.subject,
      sentAt: email.sentAt,
      receivedAt: email.receivedAt,
      preview: email.preview,
      textBody:
        email.textBody === undefined ? existing?.textBody : email.textBody,
      htmlBody:
        email.htmlBody === undefined ? existing?.htmlBody : email.htmlBody,
      attachments: email.attachments,
      headers: email.headers,
      size: email.size,
      verification: email.verification,
      provenance: email.provenance,
    };
  }
  async event(accountId: string, event: CalendarEvent): Promise<CalendarEvent> {
    const calendars = await this.store.calendars.list(accountId);
    // Server-local lookup until Store has getByProviderId for calendar events.
    const byProvider = (await this.store.events.query({ accountId, limit: 2147483647 }))
      .find(item => item.providerId === event.providerId);
    const id = await this.identity(
      accountId,
      "event",
      event.providerId,
      event.id,
      byProvider?.id,
    );
    const existing = await this.store.events.get(id);
    return {
      ...event,
      accountId,
      id,
      calendarId: calendars.some((item) => item.id === event.calendarId)
        ? event.calendarId
        : await this.reference(accountId, "calendar", event.calendarId),
      sourceEmailId: existing?.sourceEmailId ?? (event.sourceEmailId
        ? await this.reference(accountId, "email", event.sourceEmailId)
        : null),
      matterId: existing?.matterId ?? null,
    };
  }
  private async calendar(
    accountId: string,
    calendar: Calendar,
  ): Promise<Calendar> {
    const existing = (await this.store.calendars.list(accountId)).find(
      (item) => item.providerId === calendar.providerId,
    );
    return {
      ...calendar,
      accountId,
      id: await this.identity(
        accountId,
        "calendar",
        calendar.providerId,
        calendar.id,
        existing?.id,
      ),
    };
  }
  syncAccount(accountId: string): Promise<void> {
    const current = this.active.get(accountId);
    if (current) return current;
    const job = this.sync(accountId).finally(() =>
      this.active.delete(accountId),
    );
    this.active.set(accountId, job);
    return job;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.active.values()]);
  }

  private async markDeleted(email: Email) {
    if (email.keywords.$deleted) return;
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
      for (const email of page.items)
        if (!seen.has(email.providerId)) await this.markDeleted(email);
      cursor = page.nextCursor;
    } while (cursor);
  }
  private async reconcileEvents(accountId: string, seen: Set<string>) {
    const events = await this.store.events.query({ accountId, limit: 2147483647 });
    await this.store.events.deleteMany(events.filter(event => !seen.has(event.providerId)).map(event => event.id));
  }
  private async isArrival(email: Email): Promise<boolean> {
    if (email.keywords.$draft) return false;
    const roles = (await this.store.mailboxes.list(email.accountId))
      .filter(box => email.mailboxIds.includes(box.id)).map(box => box.role);
    if (roles.includes("drafts") || roles.includes("sent")) return false;
    const self = new Set((await this.store.accounts.list()).map(account => account.emailAddress.trim().toLowerCase()));
    for (const person of await this.store.people.list({ relationship: "self", limit: 2147483647 }))
      if (person.verifiedSelf) for (const address of person.emails) self.add(address.trim().toLowerCase());
    return roles.includes("inbox") || !email.from.some(address => self.has(address.email.trim().toLowerCase()));
  }
  private async sync(accountId: string) {
    const account = required(
      await this.store.accounts.get(accountId),
      "Account",
    );
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
          const seen = new Set<string>(), deleted = new Set<string>();
          for (const calendar of await provider.listCalendars())
            await this.store.calendars.upsertMany([
              await this.calendar(accountId, calendar),
            ]);
          let final: string | null = null;
          for await (const delta of provider.sync(cursors.calendar)) {
            final = delta.kind === "cursor" ? delta.cursor : null;
            if (delta.kind === "event" && delta.op === "upsert") {
              seen.add(delta.event.providerId);
              deleted.delete(delta.event.providerId);
              await this.store.events.upsertMany([
                await this.event(accountId, delta.event),
              ]);
            }
            if (delta.kind === "event" && delta.op === "delete") {
              deleted.add(delta.providerId);
              seen.delete(delta.providerId);
            }
          }
          if (final === null)
            throw new ApiError(
              "SYNC_INCOMPLETE",
              "Calendar sync did not finish with a cursor",
            );
          if (reconcile) await this.reconcileEvents(accountId, seen);
          const events = await this.store.events.query({ accountId, limit: 2147483647 });
          await this.store.events.deleteMany(events.filter(event => deleted.has(event.providerId)).map(event => event.id));
          return final;
        };
        try {
          cursors.calendar = await ingest();
        } catch (error) {
          if ((error as { code?: string }).code !== "CURSOR_EXPIRED")
            throw error;
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
        await this.store.kv.set(`calendar-sync:${accountId}`, JSON.stringify({
          syncState: { cursor: cursors.calendar }, lastSyncAt: new Date().toISOString(),
        }));
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
              if (delta.op === "upsert")
                await this.store.mailboxes.upsertMany([
                  await this.mailbox(accountId, delta.mailbox),
                ]);
              else
                await this.store.mailboxes.deleteMany([
                  await this.reference(accountId, "mailbox", delta.id),
                ]);
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
                const arrival = isNew && await this.isArrival(email);
                if (arrival) await persistArrival(this.store, email);
                await this.store.emails.upsertMany([email]);
                if (existing && existing.threadId !== email.threadId) {
                  const previous = await this.store.threads.get(
                    existing.threadId,
                  );
                  if (previous)
                    await this.store.threads.upsertMany([
                      {
                        ...previous,
                        emailIds: previous.emailIds.filter(
                          (id) => id !== email.id,
                        ),
                      },
                    ]);
                }
                const thread = await this.store.threads.get(email.threadId);
                await this.store.threads.upsertMany([
                  {
                    id: email.threadId,
                    accountId,
                    emailIds: [
                      ...new Set([...(thread?.emailIds ?? []), email.id]),
                    ],
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
              const id = await this.reference(
                accountId,
                "thread",
                delta.thread.id,
              );
              const existing = await this.store.threads.get(id);
              const emailIds = await Promise.all(
                delta.thread.emailIds.map((id) =>
                  this.reference(accountId, "email", id),
                ),
              );
              const present = await Promise.all(
                [...new Set([...emailIds, ...(existing?.emailIds ?? [])])].map(
                  (id) => this.store.emails.get(id),
                ),
              );
              await this.store.threads.upsertMany([
                {
                  id,
                  accountId,
                  emailIds: present
                    .filter(
                      (email): email is Email =>
                        email !== null && email.threadId === id,
                    )
                    .map((email) => email.id),
                },
              ]);
            }
          }
          if (final === null)
            throw new ApiError(
              "SYNC_INCOMPLETE",
              "Mail sync did not finish with a cursor",
            );
          // A partial full snapshot never removes or tombstones unseen mail.
          if (reconcile) await this.reconcileMail(accountId, seen);
          for (const providerId of deleted) {
            const email = await this.store.emails.getByProviderId(
              accountId,
              providerId,
            );
            if (email) await this.markDeleted(email);
          }
          return final;
        };
        try {
          cursors.mail = await ingest();
        } catch (error) {
          if ((error as { code?: string }).code !== "CURSOR_EXPIRED")
            throw error;
          reconcile = true;
          await this.store.kv.set(reconcileKey, "1");
          cursors.mail = null;
          await persist();
          cursors.mail = await ingest();
        }
        // Commit the cursor before clearing recovery intent. A crash between these
        // writes safely repeats a full reconciliation from null.
        await persist();
        if (reconcile) await this.store.kv.delete(reconcileKey);
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
      // Provider errors can contain private data; persist only a bounded machine code.
      const code = (error as { code?: unknown }).code;
      const safeCode =
        typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
          ? code
          : "SYNC_FAILED";
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
