import type { Account, ActionRecord, CalendarEvent, DraftInput, Email, Mailbox, Matter, Person } from "@passport/types";

export const at = "2026-10-20T12:00:00.000Z";
export function account(patch: Partial<Account> = {}): Account {
  return { id: "account-1", kind: "mock", displayName: "Personal", emailAddress: "me@example.com",
    capabilities: { mail: true, calendar: true, contacts: true, push: false, labels: true, submit: true },
    settings: {}, createdAt: at, updatedAt: at, ...patch };
}
export function mailbox(patch: Partial<Mailbox> = {}): Mailbox {
  return { id: "inbox-1", accountId: "account-1", providerId: "inbox", name: "Inbox", role: "inbox", totalEmails: 1, unreadEmails: 1, ...patch };
}
export function person(patch: Partial<Person> = {}): Person {
  return { id: "person-1", displayName: "Ada", emails: ["ada@example.com"], primaryEmail: "ada@example.com", verification: "green", relationship: "known",
    stats: { sent: 3, received: 5, lastContactAt: at }, createdAt: at, updatedAt: at, ...patch };
}
export function email(patch: Partial<Email> = {}): Email {
  return { id: "email-1", accountId: "account-1", providerId: "message-1", threadId: "thread-1", mailboxIds: ["inbox-1"], keywords: {},
    from: [{ name: "Ada", email: "ada@example.com" }], to: [{ email: "me@example.com" }], cc: [], bcc: [], replyTo: [],
    subject: "Project update", receivedAt: at, sentAt: at, preview: "The project is ready", textBody: "The project is ready.\nCan we meet?",
    attachments: [], headers: { messageId: "<message-1@example.com>", inReplyTo: null, references: [] }, size: 100,
    verification: { dkim: "pass", spf: "pass", dmarc: "pass", passport: "green" }, personIds: ["person-1"], ...patch };
}
export function matter(patch: Partial<Matter> = {}): Matter {
  return { id: "matter-1", title: "Launch", summary: "Launch planning", status: "active", personIds: ["person-1"], emailIds: ["email-1"], eventIds: ["event-1"],
    createdAt: at, updatedAt: at, ...patch };
}
export function event(patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: "event-1", accountId: "account-1", calendarId: "calendar-1", providerId: "provider-event-1", title: "Launch meeting",
    start: "2026-10-21T13:00:00.000Z", end: "2026-10-21T14:00:00.000Z", allDay: false, status: "confirmed",
    organizer: { email: "ada@example.com" }, participants: [{ email: "me@example.com", status: "needs-action" }], updatedAt: at, ...patch };
}
export function draft(patch: Partial<DraftInput> = {}): DraftInput {
  return { accountId: "account-1", to: [{ email: "ada@example.com" }], subject: "Hello", textBody: "Hello Ada", ...patch };
}
export function action(patch: Partial<ActionRecord> = {}): ActionRecord {
  return { id: "action-fixture", request: { type: "archive", accountId: "account-1", params: { emailIds: ["email-1"] }, reason: "Triage", actor: { kind: "external-agent", id: "test-client" }, category: "triage" },
    decision: { outcome: "allow", risk: "low", reversibility: "reversible", trustLevel: "auto_accept_edits", category: "triage", reason: "Reversible edit allowed" },
    status: "executed", createdAt: at, ...patch };
}
