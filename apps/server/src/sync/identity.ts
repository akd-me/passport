import { newId } from "@passport/store";
import {
  type Calendar,
  type CalendarEvent,
  type Email,
  mailHandle,
  type Store,
} from "@passport/types";
import { key } from "./state.js";

export function createSyncIdentity(store: Store) {
  /** Calendar ids and events keep mapped ULIDs (`fallback` reuses the adapter id instead). */
  async function reference(
    accountId: string,
    kind: string,
    nativeId: string,
    fallback?: string,
  ): Promise<string> {
    const alias = key("sync-id", accountId, kind, nativeId);
    let id = await store.kv.get(alias);
    if (!id) {
      id = fallback ?? newId();
      await store.kv.set(alias, id);
    }
    return id;
  }
  /** A v0.2 alias when one exists, else the adapter id itself; never writes (no per-row kv). */
  async function lookup(accountId: string, kind: string, nativeId: string): Promise<string> {
    return (await store.kv.get(key("sync-id", accountId, kind, nativeId))) ?? nativeId;
  }
  /** v0.2 rows keep their ULID; new rows use the handle with no alias bookkeeping. */
  async function emailId(accountId: string, email: Email, existing: Email | null) {
    return (
      existing?.id ??
      (await store.kv.get(key("sync-provider", accountId, "email", email.providerId))) ??
      (await store.kv.get(key("sync-id", accountId, "email", email.id))) ??
      mailHandle(accountId, "email", email.providerId)
    );
  }
  async function identity(
    accountId: string,
    kind: string,
    providerId: string,
    nativeId: string,
    existingId?: string,
  ): Promise<string> {
    const canonical = key("sync-provider", accountId, kind, providerId);
    const id =
      existingId ?? (await store.kv.get(canonical)) ?? (await reference(accountId, kind, nativeId));
    await store.kv.set(canonical, id);
    await store.kv.set(key("sync-id", accountId, kind, nativeId), id);
    return id;
  }
  async function email(accountId: string, email: Email): Promise<Email> {
    // Cache only: normalizing a provider envelope must never cost another provider read.
    const existing = await store.emails.getByProviderId(accountId, email.providerId, {
      cacheOnly: true,
    });
    const boxes = await store.mailboxes.list(accountId);
    return {
      // Only provider-owned fields may replace an existing record. In particular,
      // providers cannot reset annotations made by local agents or humans.
      ...(existing ?? { personIds: [], category: null, matterId: null }),
      accountId,
      id: await emailId(accountId, email, existing),
      providerId: email.providerId,
      threadId: await lookup(accountId, "thread", email.threadId),
      mailboxIds: await Promise.all(
        email.mailboxIds.map((id) =>
          boxes.some((box) => box.id === id) ? id : lookup(accountId, "mailbox", id),
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
      textBody: email.textBody === undefined ? existing?.textBody : email.textBody,
      htmlBody: email.htmlBody === undefined ? existing?.htmlBody : email.htmlBody,
      attachments: email.attachments,
      headers: email.headers,
      size: email.size,
      verification: email.verification,
      provenance: email.provenance,
    };
  }
  async function event(accountId: string, event: CalendarEvent): Promise<CalendarEvent> {
    const calendars = await store.calendars.list(accountId);
    // Server-local lookup until Store has getByProviderId for calendar events.
    const byProvider = (await store.events.query({ accountId, limit: 2147483647 })).find(
      (item) => item.providerId === event.providerId,
    );
    const id = await identity(accountId, "event", event.providerId, event.id, byProvider?.id);
    const existing = await store.events.get(id);
    return {
      ...event,
      accountId,
      id,
      calendarId: calendars.some((item) => item.id === event.calendarId)
        ? event.calendarId
        : await reference(accountId, "calendar", event.calendarId),
      sourceEmailId:
        existing?.sourceEmailId ??
        (event.sourceEmailId
          ? await reference(accountId, "email", event.sourceEmailId, event.sourceEmailId)
          : null),
      matterId: existing?.matterId ?? null,
    };
  }
  async function calendar(accountId: string, calendar: Calendar): Promise<Calendar> {
    const existing = (await store.calendars.list(accountId)).find(
      (item) => item.providerId === calendar.providerId,
    );
    return {
      ...calendar,
      accountId,
      id: await identity(accountId, "calendar", calendar.providerId, calendar.id, existing?.id),
    };
  }
  return { reference, lookup, identity, email, event, calendar };
}
