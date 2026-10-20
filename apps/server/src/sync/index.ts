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
      ...email,
      accountId,
      id: await this.identity(
        accountId,
        "email",
        email.providerId,
        email.id,
        existing?.id,
      ),
      threadId: await this.reference(accountId, "thread", email.threadId),
      mailboxIds: await Promise.all(
        email.mailboxIds.map((id) =>
          boxes.some((box) => box.id === id)
            ? id
            : this.reference(accountId, "mailbox", id),
        ),
      ),
      personIds: existing?.personIds ?? [],
      category: existing?.category ?? null,
      matterId: existing?.matterId ?? null,
    };
  }
  async event(accountId: string, event: CalendarEvent): Promise<CalendarEvent> {
    const calendars = await this.store.calendars.list(accountId);
    const id = await this.identity(
      accountId,
      "event",
      event.providerId,
      event.id,
    );
    const existing = await this.store.events.get(id);
    return {
      ...event,
      accountId,
      id,
      calendarId: calendars.some((item) => item.id === event.calendarId)
        ? event.calendarId
        : await this.reference(accountId, "calendar", event.calendarId),
      sourceEmailId: event.sourceEmailId
        ? await this.reference(accountId, "email", event.sourceEmailId)
        : null,
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

  private async clearMail(accountId: string) {
    for (;;) {
      const page = await this.store.emails.query({ accountId, limit: 500 });
      if (!page.items.length) break;
      for (const email of page.items)
        await this.store.threads.upsertMany([
          { id: email.threadId, accountId, emailIds: [] },
        ]);
      await this.store.emails.deleteMany(page.items.map((email) => email.id));
    }
    await this.store.mailboxes.deleteMany(
      (await this.store.mailboxes.list(accountId)).map((box) => box.id),
    );
  }
  private async clearEvents(accountId: string) {
    for (;;) {
      const events = await this.store.events.query({ accountId, limit: 500 });
      if (!events.length) break;
      await this.store.events.deleteMany(events.map((event) => event.id));
    }
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
      // Calendar data must be available before email.received can start scheduling playbooks.
      if (account.capabilities.calendar) {
        const provider = await this.calendarFor(accountId);
        const ingest = async () => {
          for (const calendar of await provider.listCalendars())
            await this.store.calendars.upsertMany([
              await this.calendar(accountId, calendar),
            ]);
          let final: string | null = null;
          for await (const delta of provider.sync(cursors.calendar)) {
            final = delta.kind === "cursor" ? delta.cursor : null;
            if (delta.kind === "event" && delta.op === "upsert")
              await this.store.events.upsertMany([
                await this.event(accountId, delta.event),
              ]);
            if (delta.kind === "event" && delta.op === "delete") {
              const id = await this.store.kv.get(
                key("sync-provider", accountId, "event", delta.providerId),
              );
              if (id) await this.store.events.deleteMany([id]);
            }
          }
          if (final === null)
            throw new ApiError(
              "SYNC_INCOMPLETE",
              "Calendar sync did not finish with a cursor",
            );
          return final;
        };
        try {
          cursors.calendar = await ingest();
        } catch (error) {
          if ((error as { code?: string }).code !== "CURSOR_EXPIRED")
            throw error;
          cursors.calendar = null;
          await persist();
          await this.clearEvents(accountId);
          cursors.calendar = await ingest();
        }
      }
      if (account.capabilities.mail) {
        const provider = await this.mailFor(accountId);
        const ingest = async () => {
          let final: string | null = null;
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
                const existing = await this.store.emails.getByProviderId(
                  accountId,
                  delta.providerId,
                );
                if (existing) {
                  await this.store.emails.deleteMany([existing.id]);
                  const thread = await this.store.threads.get(
                    existing.threadId,
                  );
                  if (thread)
                    await this.store.threads.upsertMany([
                      {
                        ...thread,
                        emailIds: thread.emailIds.filter(
                          (id) => id !== existing.id,
                        ),
                      },
                    ]);
                  this.bus.emit({
                    type: "email.updated",
                    emailId: existing.id,
                  });
                }
              } else {
                const existing = await this.store.emails.getByProviderId(
                  accountId,
                  delta.email.providerId,
                );
                const email = await this.email(accountId, delta.email);
                await this.store.emails.upsertMany([email]);
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
                const seen = key("sync-seen", accountId, email.providerId);
                const isNew = !existing && !(await this.store.kv.get(seen));
                await this.store.kv.set(seen, "1");
                this.bus.emit(
                  isNew
                    ? { type: "email.received", email }
                    : { type: "email.updated", emailId: email.id },
                );
                emailsUpserted++;
              }
            }
            if (delta.kind === "thread") {
              const emailIds = await Promise.all(
                delta.thread.emailIds.map((id) =>
                  this.reference(accountId, "email", id),
                ),
              );
              const present = await Promise.all(
                emailIds.map((id) => this.store.emails.get(id)),
              );
              await this.store.threads.upsertMany([
                {
                  id: await this.reference(
                    accountId,
                    "thread",
                    delta.thread.id,
                  ),
                  accountId,
                  emailIds: present
                    .filter((email): email is Email => email !== null)
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
          return final;
        };
        try {
          cursors.mail = await ingest();
        } catch (error) {
          if ((error as { code?: string }).code !== "CURSOR_EXPIRED")
            throw error;
          cursors.mail = null;
          await persist();
          await this.clearMail(accountId);
          cursors.mail = await ingest();
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
    }
  }
}
