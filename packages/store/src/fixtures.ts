import type { Account, ActionRecord, CalendarEvent, Email, Matter, Person } from "@passport/types";

export const at = "2026-10-20T12:00:00.000Z";

export function account(id = "account"): Account {
  return { id, kind: "mock", displayName: "Test", emailAddress: `${id}@example.com`,
    capabilities: { mail: true, calendar: true, contacts: true, push: false, labels: true, submit: true },
    settings: { port: 443, tls: true, host: "example.com" }, createdAt: at, updatedAt: at };
}

export function email(id = "email", patch: Partial<Email> = {}): Email {
  return { id, accountId: "account", providerId: `provider-${id}`, threadId: "thread", mailboxIds: ["inbox"],
    keywords: { $seen: true, $flagged: false }, from: [{ name: "Alice Doe", email: "alice@example.com" }],
    to: [{ email: "me@example.com" }], cc: [], bcc: [], replyTo: [], subject: "Travel plans",
    sentAt: at, receivedAt: at, preview: "Mountain expedition", textBody: "A quick brown fox discusses reservations",
    htmlBody: "<p>A quick brown fox</p>", attachments: [{ id: "attachment", name: "map.txt", type: "text/plain", size: 3, blobId: "blob" }],
    headers: { messageId: `<${id}@example.com>`, inReplyTo: null, references: [], extra: { "x-test": "yes" } },
    size: 100, verification: { dkim: "pass", spf: "pass", dmarc: "pass", passport: "green" },
    matterId: null, personIds: ["alice"], category: "scheduling", ...patch };
}

export function person(id = "alice", patch: Partial<Person> = {}): Person {
  return { id, displayName: "Alice Doe", emails: [`${id}@example.com`], primaryEmail: `${id}@example.com`,
    verification: "green", relationship: "known", stats: { sent: 2, received: 3, lastContactAt: at },
    createdAt: at, updatedAt: at, ...patch };
}

export function matter(id = "matter", patch: Partial<Matter> = {}): Matter {
  return { id, title: "Summer trip", summary: "Book the hotel", status: "active", personIds: ["alice"],
    emailIds: ["email"], eventIds: ["event"], createdAt: at, updatedAt: at, ...patch };
}

export function event(id = "event", patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id, accountId: "account", calendarId: "calendar", providerId: `provider-${id}`, title: "Trip briefing",
    start: at, end: "2026-10-20T13:00:00.000Z", allDay: false, status: "confirmed",
    organizer: { name: "Alice", email: "alice@example.com" }, participants: [{ email: "me@example.com", status: "accepted" }],
    matterId: null, updatedAt: at, ...patch };
}

export function action(id = "action", patch: Partial<ActionRecord> = {}): ActionRecord {
  return { id, request: { type: "archive", accountId: "account", params: { emailIds: ["email"] }, reason: "Filed",
    actor: { kind: "agent", id: "assistant" }, category: "triage", runId: "run", matterId: "matter" },
    decision: { outcome: "ask", risk: "low", reversibility: "reversible", trustLevel: "supervised", category: "triage", reason: "Review" },
    status: "proposed", createdAt: at, ...patch };
}
