import type { Account, CalendarEvent, Email, Matter, Person, TrustState } from "@passport/types";

export const TEST_NOW = "2026-10-20T14:00:00.000Z";

export function accountFixture(patch: Partial<Account> = {}): Account {
  return {
    id: "account-1",
    kind: "mock",
    displayName: "Personal",
    emailAddress: "me@example.com",
    capabilities: {
      mail: true,
      calendar: true,
      contacts: true,
      push: false,
      labels: true,
      submit: true,
    },
    settings: {},
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...patch,
  };
}

export function emailFixture(patch: Partial<Email> = {}): Email {
  return {
    id: "email-1",
    accountId: "account-1",
    providerId: "provider-1",
    threadId: "thread-1",
    mailboxIds: ["inbox"],
    keywords: {},
    from: [{ name: "Alice", email: "alice@example.com" }],
    to: [{ email: "me@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: "A quick question",
    sentAt: TEST_NOW,
    receivedAt: TEST_NOW,
    preview: "Could you take a look?",
    textBody: "Could you take a look at the proposal?",
    attachments: [],
    headers: { messageId: "<email-1@example.com>", inReplyTo: null, references: [] },
    size: 100,
    verification: { dkim: "pass", spf: "pass", dmarc: "pass", passport: "green" },
    personIds: [],
    ...patch,
  };
}

export function personFixture(patch: Partial<Person> = {}): Person {
  return {
    id: "person-alice",
    displayName: "Alice",
    emails: ["alice@example.com"],
    primaryEmail: "alice@example.com",
    verification: "green",
    relationship: "known",
    stats: { sent: 1, received: 1, lastContactAt: "2026-10-01T00:00:00.000Z" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...patch,
  };
}

export function matterFixture(patch: Partial<Matter> = {}): Matter {
  return {
    id: "matter-1",
    title: "Launch",
    summary: "Discussing the launch",
    kind: "project",
    status: "active",
    personIds: [],
    emailIds: [],
    eventIds: [],
    nextStep: "Review the plan",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...patch,
  };
}

export function eventFixture(patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "event-1",
    accountId: "account-1",
    calendarId: "calendar-1",
    providerId: "provider-event-1",
    title: "Planning meeting",
    start: "2026-10-21T15:00:00.000Z",
    end: "2026-10-21T16:00:00.000Z",
    allDay: false,
    status: "confirmed",
    participants: [{ email: "me@example.com", status: "needs-action" }],
    myStatus: "needs-action",
    sourceEmailId: "email-1",
    updatedAt: TEST_NOW,
    ...patch,
  };
}

export function trustFixture(patch: Partial<TrustState> = {}): TrustState {
  return {
    category: "newsletters",
    level: "auto_accept_edits",
    score: 0.2,
    stage: "learning",
    approvals: 1,
    approvalsUnchanged: 1,
    edits: 0,
    rejections: 0,
    lastActivityAt: TEST_NOW,
    ...patch,
  };
}

export const newMatterOutput = {
  matterId: null,
  title: "Correspondence",
  kind: "personal",
  summary: "Alice asks for a review.",
  nextStep: "Decide whether to respond.",
};
