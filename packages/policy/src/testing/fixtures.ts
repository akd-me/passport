import type {
  AccountCapabilities,
  ActionCategory,
  ActionParams,
  ActionRecord,
  ActionRequest,
  ActionType,
  CalendarEvent,
  CalendarProvider,
  DraftInput,
  Email,
  MailChange,
  MailChangeResult,
  MailProvider,
  Matter,
  Person,
  SendResult,
  TrustState,
} from "@passport/types";
import { type ActionExecutorOptions, createActionExecutor } from "../executor.js";
import { createPolicyEngine } from "../policy.js";
import { createMemoryEventBus, createMemoryStore } from "./memory-store.js";

export const at = "2026-10-20T12:00:00.000Z";
const capabilities: AccountCapabilities = {
  mail: true,
  calendar: true,
  contacts: false,
  push: false,
  labels: true,
  submit: true,
};
export const draft: DraftInput = {
  accountId: "account",
  to: [{ email: "friend@example.com" }],
  subject: "Hello",
  textBody: "How are you?",
};
export const email = (patch: Partial<Email> = {}): Email => ({
  id: "email",
  accountId: "account",
  providerId: "remote-email",
  threadId: "thread",
  mailboxIds: ["inbox", "tag"],
  keywords: {},
  from: [{ email: "friend@example.com" }],
  to: [{ email: "me@example.com" }],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "Hello",
  sentAt: null,
  receivedAt: at,
  preview: "How are you?",
  textBody: "How are you?",
  attachments: [],
  headers: { messageId: null, inReplyTo: null, references: [] },
  size: 10,
  verification: { dkim: "pass", spf: "pass", dmarc: "pass", passport: "green" },
  personIds: [],
  ...patch,
});
export const person = (patch: Partial<Person> = {}): Person => ({
  id: "person",
  displayName: "Friend",
  emails: ["friend@example.com"],
  primaryEmail: "friend@example.com",
  verification: "green",
  relationship: "known",
  stats: { sent: 0, received: 0, lastContactAt: null },
  createdAt: at,
  updatedAt: at,
  ...patch,
});
export const matter = (patch: Partial<Matter> = {}): Matter => ({
  id: "matter",
  title: "Trip",
  summary: "",
  status: "active",
  personIds: [],
  emailIds: [],
  eventIds: [],
  createdAt: at,
  updatedAt: at,
  ...patch,
});
export const calendarEvent = (patch: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "event",
  providerId: "remote-event",
  accountId: "account",
  calendarId: "calendar",
  title: "Lunch",
  start: at,
  end: "2026-10-20T13:00:00.000Z",
  allDay: false,
  status: "confirmed",
  participants: [],
  updatedAt: at,
  ...patch,
});
export const trustState = (patch: Partial<TrustState> = {}): TrustState => ({
  category: "other",
  level: "auto",
  score: 0.95,
  stage: "autonomous",
  approvals: 15,
  approvalsUnchanged: 15,
  edits: 0,
  rejections: 0,
  lastActivityAt: at,
  ...patch,
});
export function request<T extends ActionType>(
  type: T,
  params: ActionParams[T],
  patch: Partial<ActionRequest<T>> = {},
): ActionRequest<T> {
  return {
    type,
    params,
    accountId: "account",
    reason: "Test operation",
    actor: { kind: "agent", id: "test" },
    category: "other",
    ...patch,
  };
}
export const action = (id: string, category: ActionCategory = "other"): ActionRecord => ({
  id,
  request: request("archive", { emailIds: ["email"] }, { category }),
  decision: {
    outcome: "ask",
    risk: "low",
    reversibility: "reversible",
    trustLevel: "supervised",
    category,
    reason: "Test",
  },
  status: "proposed",
  createdAt: at,
});

class FakeMailProvider implements MailProvider {
  readonly kind = "mock" as const;
  readonly capabilities: AccountCapabilities;
  constructor(labels = true) {
    this.capabilities = { ...capabilities, labels };
  }
  changes: MailChange[][] = [];
  sends: Array<Parameters<MailProvider["send"]>[0]> = [];
  drafts: Array<{ operation: string; providerId?: string; draft?: DraftInput }> = [];
  failure: Error | null = null;
  count = 0;
  sentEmail: Email | null = null;
  createMailbox?: MailProvider["createMailbox"];
  async connect() {}
  async disconnect() {}
  async *sync() {
    yield { kind: "cursor" as const, cursor: "test" };
  }
  async getEmail() {
    return this.sentEmail;
  }
  async getBlob() {
    return { type: "text/plain", data: new Uint8Array() };
  }
  async applyChanges(changes: MailChange[]): Promise<void | MailChangeResult[]> {
    this.changes.push(structuredClone(changes));
    if (this.failure) {
      throw this.failure;
    }
  }
  async createDraft(input: DraftInput) {
    this.drafts.push({ operation: "create", draft: input });
    return email({
      ...input,
      attachments: [],
      id: `draft-${++this.count}`,
      providerId: `remote-draft-${this.count}`,
      keywords: { $draft: true },
      mailboxIds: ["drafts"],
    });
  }
  async updateDraft(providerId: string, input: DraftInput) {
    this.drafts.push({ operation: "update", providerId, draft: input });
    return email({ ...input, attachments: [], providerId, keywords: { $draft: true } });
  }
  async deleteDraft(providerId: string) {
    this.drafts.push({ operation: "delete", providerId });
  }
  async send(input: Parameters<MailProvider["send"]>[0]): Promise<SendResult> {
    this.sends.push(structuredClone(input));
    if (this.failure) {
      throw this.failure;
    }
    return { providerId: `sent-${++this.count}`, messageId: "<sent@example.com>" };
  }
}
class FakeCalendarProvider implements CalendarProvider {
  readonly kind = "mock" as const;
  calls: Array<{ operation: string; providerId?: string; value?: unknown }> = [];
  async connect() {}
  async disconnect() {}
  async listCalendars() {
    return [];
  }
  async *sync() {
    yield { kind: "cursor" as const, cursor: "test" };
  }
  async createEvent(value: Parameters<CalendarProvider["createEvent"]>[0]) {
    this.calls.push({ operation: "create", value });
    return calendarEvent(value);
  }
  async updateEvent(providerId: string, value: Partial<CalendarEvent>) {
    this.calls.push({ operation: "update", providerId, value });
    return calendarEvent(value);
  }
  async deleteEvent(providerId: string) {
    this.calls.push({ operation: "delete", providerId });
  }
  async respond(
    providerId: string,
    status: Parameters<CalendarProvider["respond"]>[1],
    comment?: string,
  ) {
    this.calls.push({ operation: "respond", providerId, value: { status, comment } });
  }
  async freeBusy() {
    return [];
  }
}

export async function setup({
  labels = true,
  ...options
}: Pick<ActionExecutorOptions, "fetch" | "resolveDns"> & { labels?: boolean } = {}) {
  const store = createMemoryStore(),
    bus = createMemoryEventBus();
  let time = at;
  const now = () => time;
  const policy = createPolicyEngine({ store, bus, now });
  const mail = new FakeMailProvider(labels),
    calendar = new FakeCalendarProvider();
  const executor = createActionExecutor({
    store,
    bus,
    policy,
    now,
    mailProviderFor: () => mail,
    calendarProviderFor: () => calendar,
    resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
    ...options,
  });
  await store.accounts.upsert({
    id: "account",
    kind: "mock",
    displayName: "Test",
    emailAddress: "me@example.com",
    capabilities: mail.capabilities,
    settings: {},
    createdAt: at,
    updatedAt: at,
  });
  await store.emails.upsertMany([email()]);
  await store.mailboxes.upsertMany(
    ["inbox", "archive", "trash", "drafts", "sent", "tag"].map((id) => ({
      id,
      accountId: "account",
      providerId: `remote-${id}`,
      name: id,
      role: id === "tag" ? null : (id as "inbox"),
      totalEmails: 0,
      unreadEmails: 0,
    })),
  );
  await store.trust.upsert(trustState({ pinnedLevel: "full_access" }));
  await policy.setConfig({ globalMode: "full_access", externalAgentCeiling: "full_access" });
  return {
    store,
    bus,
    policy,
    mail,
    calendar,
    executor,
    now,
    setTime: (value: string) => {
      time = value;
    },
  };
}
