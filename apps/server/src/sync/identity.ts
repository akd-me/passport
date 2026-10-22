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
  /** v0.2 rows keep their mapped ULIDs; new mail rows use the adapter's handle (`fallback`). */
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
  async function identity(
    accountId: string,
    kind: string,
    providerId: string,
    nativeId: string,
    existingId?: string,
  ): Promise<string> {
    const canonical = key("sync-provider", accountId, kind, providerId);
    const id =
      existingId ??
      (await store.kv.get(canonical)) ??
      (await reference(
        accountId,
        kind,
        nativeId,
        kind === "email" ? mailHandle(accountId, "email", providerId) : undefined,
      ));
    await store.kv.set(canonical, id);
    await store.kv.set(key("sync-id", accountId, kind, nativeId), id);
    return id;
  }
  async function email(accountId: string, email: Email): Promise<Email> {
    const existing = await store.emails.getByProviderId(accountId, email.providerId);
    const boxes = await store.mailboxes.list(accountId);
    return {
      // Only provider-owned fields may replace an existing record. In particular,
      // providers cannot reset annotations made by local agents or humans.
      ...(existing ?? { personIds: [], category: null, matterId: null }),
      accountId,
      id: await identity(accountId, "email", email.providerId, email.id, existing?.id),
      providerId: email.providerId,
      threadId: await reference(accountId, "thread", email.threadId, email.threadId),
      mailboxIds: await Promise.all(
        email.mailboxIds.map((id) =>
          boxes.some((box) => box.id === id) ? id : reference(accountId, "mailbox", id, id),
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
  return { reference, identity, email, event, calendar };
}
