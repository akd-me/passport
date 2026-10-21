import type {
  Account,
  AccountCapabilities,
  AccountCredentials,
  Calendar,
  CalendarEvent,
  CalendarProvider,
  DraftInput,
  Email,
  Mailbox,
  MailChange,
  MailProvider,
  ParticipationStatus,
  SendResult,
  SyncDelta,
  TimeRange,
} from "@passport/types";
import { validateEvent, validateRange } from "./calendar-common.js";
import { assertSend, decodeCursor, encodeCursor, localId, ProviderError } from "./errors.js";
import type { ProviderOptions } from "./http.js";
import { generatePreview, normalizeAddresses, normalizeHeaders, toIso } from "./normalize/index.js";
import { resolveReplyEmail } from "./reply.js";
import { parseAuthenticationResults, verifyHeaders } from "./verification.js";

export const mockCapabilities: AccountCapabilities = {
  mail: true,
  calendar: true,
  contacts: false,
  push: true,
  labels: true,
  submit: true,
};
const folderNames = [
  "Inbox",
  "Archive",
  "Drafts",
  "Sent",
  "Trash",
  "Junk",
  "Newsletters",
  "Receipts",
];
const fixtureEpoch = Date.parse("2026-01-15T09:00:00Z");
const clone = <T>(value: T): T => structuredClone(value);

/** Forty deterministic messages suitable for triage, trust, scheduling, and unsubscribe tests. */
export function createMockEmails(accountId: string, owner = "alex@example.com"): Email[] {
  const samples: Array<[string, string, string, string]> = [
    ...Array.from({ length: 10 }, (_, i): [string, string, string, string] => [
      "newsletters",
      "dispatch@weekly.example",
      `Systems Weekly #${101 + i}`,
      "This week: practical engineering, open source, and a reading list.",
    ]),
    ...Array.from({ length: 8 }, (_, i): [string, string, string, string] => [
      "receipts",
      "billing@shop.example",
      `Receipt for order #${2400 + i}`,
      `Thank you for your purchase. Total: $${19 + i}.00. Your order is confirmed.`,
    ]),
    ...Array.from({ length: 4 }, (_, i): [string, string, string, string] => [
      "replies_known",
      "sam@example.com",
      `Re: Garden project ${i + 1}`,
      "Thanks Alex! I reviewed the plan. Let's use the smaller design we discussed.",
    ]),
    [
      "replies_stranger",
      "pat@unknown.example",
      "An introduction",
      "We have not met. Could you share your team's plans for next quarter?",
    ],
    [
      "replies_stranger",
      "sales@unknown.example",
      "Quick product introduction",
      "I found your public project and wanted to introduce our service. May I send details?",
    ],
    ...Array.from({ length: 3 }, (_, i): [string, string, string, string] => [
      "other",
      "jordan@recruiting.example",
      `Engineering role ${i + 1}`,
      "I'm recruiting for an engineering team. Would you be open to a conversation?",
    ]),
    ...Array.from({ length: 4 }, (_, i): [string, string, string, string] => [
      "notifications",
      "notifications@code.example",
      `Build ${310 + i} completed`,
      "All checks passed. View the build report in your project dashboard.",
    ]),
    ...[
      "Can we meet Tuesday?",
      "Re: Can we meet Tuesday?",
      "Re: Can we meet Tuesday?",
      "Confirmed: Tuesday at 2",
    ].map((s, i): [string, string, string, string] => [
      "scheduling",
      "sam@example.com",
      s,
      [
        "Are you free at 2pm UTC?",
        "2pm works. Shall we use the usual room?",
        "Yes, see you there.",
        "Calendar invitation follows.",
      ][i]!,
    ]),
    ...Array.from({ length: 3 }, (_, i): [string, string, string, string] => [
      "scheduling",
      "sam@example.com",
      `Invitation: Design review ${i + 1}`,
      "Please join the design review. The attached calendar invitation has the details.",
    ]),
    [
      "other",
      "verified@service.example",
      "Authenticated delivery",
      "This message has a receiver-reported DKIM pass.",
    ],
    [
      "other",
      "spoof@service.example",
      "Suspicious delivery",
      "This message has a receiver-reported DKIM fail.",
    ],
  ];
  return samples.map(([category, from, subject, text], index) => {
    const providerId = `fixture-${String(index + 1).padStart(2, "0")}`,
      date = new Date(fixtureEpoch + index * 3600_000).toISOString();
    const headers = normalizeHeaders({
      "message-id": `<${providerId}@mock.passport>`,
      date,
      from,
      to: owner,
      "authentication-results": `mx.mock; dkim=${index === 39 ? "fail" : "pass"} header.d=${from.split("@")[1]}; spf=pass; dmarc=${index === 39 ? "fail" : "pass"}`,
      ...(category === "newsletters"
        ? {
            "list-id": "Systems Weekly <weekly.example>",
            "list-unsubscribe":
              "<https://weekly.example/unsubscribe>, <mailto:leave@weekly.example>",
            "list-unsubscribe-post": "List-Unsubscribe=One-Click",
          }
        : {}),
      ...(category === "replies_known" || (index >= 31 && index <= 34)
        ? {
            "in-reply-to": "<garden-start@mock.passport>",
            references: "<garden-start@mock.passport>",
          }
        : {}),
      ...(index === 38 ? { "x-passport-signature": "stub-fixture-not-a-verified-signature" } : {}),
    });
    const invite = index >= 35 && index <= 37;
    return {
      id: localId(accountId, "email", providerId),
      accountId,
      providerId,
      threadId: localId(
        accountId,
        "thread",
        category === "replies_known"
          ? "garden"
          : index >= 31 && index <= 34
            ? "scheduling"
            : providerId,
      ),
      mailboxIds: [
        localId(
          accountId,
          "mailbox",
          index < 10 ? "Newsletters" : index < 18 ? "Receipts" : "Inbox",
        ),
      ],
      keywords: index % 3 === 0 ? { $seen: true } : {},
      from: [
        { email: from, name: from === "sam@example.com" ? "Sam Rivera" : from.split("@")[0]! },
      ],
      to: [{ email: owner }],
      cc: [],
      bcc: [],
      replyTo: [],
      subject,
      sentAt: date,
      receivedAt: date,
      preview: generatePreview(text),
      textBody: text,
      htmlBody: `<p>${text}</p>`,
      headers,
      size: Buffer.byteLength(text) + 500,
      personIds: [],
      verification: parseAuthenticationResults(headers),
      attachments: invite
        ? [
            {
              id: localId(accountId, "attachment", providerId),
              name: "invite.ics",
              type: "text/calendar",
              size: Buffer.byteLength(mockInvite(providerId)),
              blobId: `mock-invite:${providerId}`,
              disposition: "attachment",
            },
          ]
        : [],
    };
  });
}

function mockInvite(uid: string): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Passport//Mock//EN\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:${uid}@mock.passport\r\nDTSTAMP:20260115T090000Z\r\nDTSTART:20260120T140000Z\r\nDTEND:20260120T143000Z\r\nSUMMARY:Design review\r\nORGANIZER:mailto:sam@example.com\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:alex@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
}

interface MockMailOptions extends Pick<ProviderOptions, "now" | "verifier" | "resolveEmail"> {
  fixtures?: boolean;
}

/** In-memory provider; injectEmail and sentMail are intentionally public integration-test helpers. */
export class MockMailProvider implements MailProvider {
  readonly kind = "mock" as const;
  readonly capabilities = mockCapabilities;
  private account?: Account;
  private connected = false;
  private emails = new Map<string, Email>();
  private changes: Array<Extract<SyncDelta, { kind: "email" }>> = [];
  private waiters = new Set<() => void>();
  private sent: Email[] = [];
  private blobs = new Map<string, { type: string; data: Uint8Array }>();
  private sequence = 0;
  private folderNames = [...folderNames];
  constructor(private readonly options: MockMailOptions = {}) {}
  get sentMail(): readonly Email[] {
    return clone(this.sent);
  }
  async connect(account: Account, _credentials: AccountCredentials = {}): Promise<void> {
    if (this.account && this.account.id !== account.id)
      throw new ProviderError("ACCOUNT_MISMATCH", "Use a separate mock instance per account");
    const first = !this.account;
    this.account = clone(account);
    this.connected = true;
    if (first && this.options.fixtures !== false)
      for (const email of createMockEmails(account.id, account.emailAddress)) this.store(email);
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.wake();
  }
  private check(): Account {
    if (!this.account || !this.connected)
      throw new ProviderError("NOT_CONNECTED", "Connect the mock provider first");
    return this.account;
  }
  private wake(): void {
    for (const done of [...this.waiters]) done();
  }
  private store(email: Email): Email {
    this.emails.set(email.providerId, clone(email));
    this.changes.push({ kind: "email", op: "upsert", email: clone(email) });
    this.wake();
    return clone(email);
  }
  /** Adds a message and wakes waitForChanges. Omitted fields get deterministic fixture defaults. */
  injectEmail(input: Partial<Email> = {}): Email {
    const account = this.check(),
      providerId = input.providerId ?? `injected-${++this.sequence}`;
    const base = createMockEmails(account.id, account.emailAddress)[18]!;
    const date = (
      this.options.now?.() ?? new Date(fixtureEpoch + this.sequence * 1000)
    ).toISOString();
    const text = input.textBody ?? "A new message for the test inbox.";
    return this.store({
      ...base,
      subject: "New message",
      textBody: text,
      htmlBody: null,
      preview: generatePreview(text),
      receivedAt: date,
      sentAt: date,
      ...clone(input),
      accountId: account.id,
      providerId,
      id: localId(account.id, "email", providerId),
      threadId: input.threadId ?? localId(account.id, "thread", providerId),
    });
  }
  /** Adds bytes for an attachment in a test draft or injected message. */
  injectBlob(data: Uint8Array, type = "application/octet-stream"): string {
    this.check();
    const id = `mock-blob:${++this.sequence}`;
    this.blobs.set(id, { type, data: new Uint8Array(data) });
    return id;
  }
  async createMailbox(name: string): Promise<Mailbox> {
    const account = this.check();
    if (!this.folderNames.includes(name)) this.folderNames.push(name);
    return {
      id: localId(account.id, "mailbox", name),
      accountId: account.id,
      providerId: name,
      name,
      role: null,
      totalEmails: 0,
      unreadEmails: 0,
    };
  }
  async *sync(cursor: string | null): AsyncIterable<SyncDelta> {
    const account = this.check(),
      end = this.changes.length;
    let start = 0;
    if (cursor) {
      const c = decodeCursor<{ account: string; revision: number }>(cursor);
      if (
        c.account !== account.id ||
        !Number.isInteger(c.revision) ||
        c.revision < 0 ||
        c.revision > end
      )
        throw new ProviderError("INVALID_CURSOR", "Mock cursor does not belong to this mailbox");
      start = c.revision;
    }
    const emails = clone([...this.emails.values()]);
    for (const name of this.folderNames) {
      const id = localId(account.id, "mailbox", name),
        members = emails.filter((e) => e.mailboxIds.includes(id));
      const roles = {
        Inbox: "inbox",
        Archive: "archive",
        Drafts: "drafts",
        Sent: "sent",
        Trash: "trash",
        Junk: "junk",
      } as const;
      yield {
        kind: "mailbox",
        op: "upsert",
        mailbox: {
          id,
          accountId: account.id,
          providerId: name,
          name,
          role: roles[name as keyof typeof roles] ?? null,
          totalEmails: members.length,
          unreadEmails: members.filter((e) => !e.keywords.$seen).length,
        },
      };
    }
    const deltas = cursor
      ? clone(this.changes.slice(start, end))
      : emails.map((email) => ({ kind: "email", op: "upsert", email }) as const);
    for (const delta of deltas) {
      if (delta.kind === "email" && delta.op === "upsert" && this.options.verifier)
        delta.email.verification = await verifyHeaders(delta.email.headers, this.options.verifier);
      yield delta;
    }
    const threads = new Map<string, string[]>();
    for (const e of emails)
      (threads.get(e.threadId) ?? (threads.set(e.threadId, []), threads.get(e.threadId)!)).push(
        e.id,
      );
    for (const [id, emailIds] of threads)
      yield { kind: "thread", op: "upsert", thread: { id, accountId: account.id, emailIds } };
    yield { kind: "cursor", cursor: encodeCursor({ account: account.id, revision: end }) };
  }
  async getEmail(providerId: string): Promise<Email | null> {
    this.check();
    const email = clone(this.emails.get(providerId) ?? null);
    if (email && this.options.verifier)
      email.verification = await verifyHeaders(email.headers, this.options.verifier);
    return email;
  }
  async getBlob(blobId: string): Promise<{ type: string; data: Uint8Array }> {
    this.check();
    const stored = this.blobs.get(blobId);
    if (stored) return clone(stored);
    const email = this.emails.get(blobId.replace(/^mock-invite:/, ""));
    if (!blobId.startsWith("mock-invite:") || !email?.attachments.some((a) => a.blobId === blobId))
      throw new ProviderError("NOT_FOUND", "Mock attachment does not exist");
    return { type: "text/calendar", data: Buffer.from(mockInvite(email.providerId)) };
  }
  async applyChanges(changes: MailChange[]): Promise<void> {
    const account = this.check();
    for (const change of changes)
      for (const id of change.providerIds) {
        const email = this.emails.get(id);
        if (!email) throw new ProviderError("NOT_FOUND", "Mock email does not exist");
        const next = clone(email);
        if (change.op === "setKeywords") {
          for (const k of change.add ?? []) next.keywords[k] = true;
          for (const k of change.remove ?? []) delete next.keywords[k];
        } else if (change.op === "move")
          next.mailboxIds = [localId(account.id, "mailbox", change.toMailboxProviderId)];
        else if (change.op === "delete")
          next.mailboxIds = [localId(account.id, "mailbox", "Trash")];
        else if (change.op === "addToMailbox")
          next.mailboxIds = [
            ...new Set([
              ...next.mailboxIds,
              localId(account.id, "mailbox", change.mailboxProviderId),
            ]),
          ];
        else
          next.mailboxIds = next.mailboxIds.filter(
            (id) => id !== localId(account.id, "mailbox", change.mailboxProviderId),
          );
        this.store(next);
      }
  }
  private async draftEmail(draft: DraftInput, providerId: string): Promise<Email> {
    const account = this.check();
    if (draft.accountId !== account.id)
      throw new ProviderError("ACCOUNT_MISMATCH", "Draft belongs to a different account");
    const reply = await resolveReplyEmail(
      account.id,
      draft.inReplyToEmailId,
      (id) => this.getEmail(id),
      this.options.resolveEmail,
    );
    // Store thread IDs have also been remapped; retain the provider's native thread here.
    const nativeReply = reply ? await this.getEmail(reply.providerId) : null;
    if (reply && !nativeReply)
      throw new ProviderError("NOT_FOUND", "Mock reply email does not exist");
    return {
      ...createMockEmails(account.id, account.emailAddress)[0]!,
      id: localId(account.id, "email", providerId),
      providerId,
      threadId: nativeReply?.threadId ?? localId(account.id, "thread", providerId),
      mailboxIds: [localId(account.id, "mailbox", "Drafts")],
      keywords: { $draft: true, $seen: true },
      from: [{ email: account.emailAddress }],
      to: normalizeAddresses(draft.to),
      cc: normalizeAddresses(draft.cc),
      bcc: normalizeAddresses(draft.bcc),
      replyTo: [],
      subject: draft.subject,
      textBody: draft.textBody,
      htmlBody: draft.htmlBody ?? null,
      preview: generatePreview(draft.textBody),
      headers: normalizeHeaders({
        "message-id": `<${providerId}@mock.passport>`,
        ...(reply?.headers.messageId
          ? {
              "in-reply-to": reply.headers.messageId,
              references: [...reply.headers.references, reply.headers.messageId].join(" "),
            }
          : {}),
      }),
      verification: parseAuthenticationResults({}),
      receivedAt: (this.options.now?.() ?? new Date(fixtureEpoch)).toISOString(),
      sentAt: null,
      attachments: (draft.attachments ?? []).map((a, i) => ({
        ...a,
        id: localId(account.id, "attachment", `${providerId}:${i}`),
        size: 0,
      })),
    };
  }
  async createDraft(draft: DraftInput): Promise<Email> {
    const email = await this.draftEmail(draft, `draft-${++this.sequence}`);
    for (const a of email.attachments) a.size = (await this.getBlob(a.blobId)).data.byteLength;
    return this.store(email);
  }
  async updateDraft(providerId: string, draft: DraftInput): Promise<Email> {
    if (!this.emails.get(providerId)?.keywords.$draft)
      throw new ProviderError("NOT_FOUND", "Mock draft does not exist");
    const email = await this.draftEmail(draft, providerId);
    for (const a of email.attachments) a.size = (await this.getBlob(a.blobId)).data.byteLength;
    return this.store(email);
  }
  async deleteDraft(providerId: string): Promise<void> {
    this.check();
    if (!this.emails.get(providerId)?.keywords.$draft)
      throw new ProviderError("NOT_FOUND", "Mock draft does not exist");
    this.emails.delete(providerId);
    this.changes.push({ kind: "email", op: "delete", providerId });
    this.wake();
  }
  async send(input: { draftProviderId?: string; draft?: DraftInput }): Promise<SendResult> {
    assertSend(input);
    const account = this.check();
    const email = input.draft
      ? await this.createDraft(input.draft)
      : await this.getEmail(input.draftProviderId!);
    if (!email?.keywords.$draft) throw new ProviderError("NOT_FOUND", "Mock draft does not exist");
    delete email.keywords.$draft;
    email.mailboxIds = [localId(account.id, "mailbox", "Sent")];
    email.sentAt = (this.options.now?.() ?? new Date(fixtureEpoch)).toISOString();
    this.sent.push(clone(email));
    this.store(email);
    return {
      providerId: email.providerId,
      messageId: email.headers.messageId,
      threadId: email.threadId,
    };
  }
  async waitForChanges(signal: AbortSignal): Promise<void> {
    this.check();
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}

export type CalendarDelta =
  | { kind: "event"; op: "upsert"; event: CalendarEvent }
  | { kind: "event"; op: "delete"; providerId: string }
  | { kind: "cursor"; cursor: string };
export type EventInput = Omit<CalendarEvent, "id" | "providerId" | "updatedAt">;

/** In-memory calendar with deterministic events and revision cursors. */
export class MockCalendarProvider implements CalendarProvider {
  readonly kind = "mock" as const;
  private account?: Account;
  private connected = false;
  private events = new Map<string, CalendarEvent>();
  private changes: CalendarDelta[] = [];
  private sequence = 0;
  private folderNames = [...folderNames];
  async connect(account: Account, _credentials: AccountCredentials = {}): Promise<void> {
    if (this.account && this.account.id !== account.id)
      throw new ProviderError("ACCOUNT_MISMATCH", "Use a separate mock instance per account");
    const first = !this.account;
    this.account = clone(account);
    this.connected = true;
    if (first)
      for (let i = 0; i < 6; i++)
        await this.createEvent({
          accountId: account.id,
          calendarId: localId(account.id, "calendar", "primary"),
          title: [
            "Design review",
            "Coffee with Sam",
            "Planning",
            "Dentist",
            "Reading group",
            "Project demo",
          ][i]!,
          start: new Date(fixtureEpoch + i * 86400_000).toISOString(),
          end: new Date(fixtureEpoch + i * 86400_000 + 3600_000).toISOString(),
          allDay: false,
          status: "confirmed",
          participants: [{ email: account.emailAddress, status: "accepted" }],
          myStatus: "accepted",
        });
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  private check(): Account {
    if (!this.account || !this.connected)
      throw new ProviderError("NOT_CONNECTED", "Connect the mock calendar first");
    return this.account;
  }
  async listCalendars(): Promise<Calendar[]> {
    const a = this.check();
    return [
      {
        id: localId(a.id, "calendar", "primary"),
        accountId: a.id,
        providerId: "primary",
        name: "Personal",
        isPrimary: true,
        timeZone: "UTC",
      },
    ];
  }
  async *sync(cursor: string | null, _range?: TimeRange): AsyncIterable<CalendarDelta> {
    const a = this.check(),
      end = this.changes.length;
    const c = cursor
      ? decodeCursor<{ account: string; revision: number }>(cursor)
      : { account: a.id, revision: 0 };
    if (c.account !== a.id || !Number.isInteger(c.revision) || c.revision < 0 || c.revision > end)
      throw new ProviderError("INVALID_CURSOR", "Invalid mock calendar cursor");
    const events = cursor
      ? this.changes.slice(c.revision, end)
      : [...this.events.values()].map((event) => ({ kind: "event", op: "upsert", event }) as const);
    // Sync a complete collection; moving an event out of a display window must reach the store.
    for (const delta of clone(events)) yield delta;
    yield { kind: "cursor", cursor: encodeCursor({ account: a.id, revision: end }) };
  }
  async createEvent(input: EventInput): Promise<CalendarEvent> {
    const a = this.check();
    if (input.accountId !== a.id)
      throw new ProviderError("ACCOUNT_MISMATCH", "Event belongs to another account");
    validateEvent(input);
    const providerId = `event-${++this.sequence}`,
      event: CalendarEvent = {
        ...clone(input),
        id: localId(a.id, "event", providerId),
        providerId,
        start: toIso(input.start),
        end: toIso(input.end),
        updatedAt: new Date(fixtureEpoch + this.sequence * 1000).toISOString(),
      };
    this.events.set(providerId, event);
    this.changes.push({ kind: "event", op: "upsert", event: clone(event) });
    return clone(event);
  }
  async updateEvent(providerId: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent> {
    this.check();
    const previous = this.events.get(providerId);
    if (!previous) throw new ProviderError("NOT_FOUND", "Mock event does not exist");
    const event = {
      ...previous,
      ...clone(patch),
      id: previous.id,
      accountId: previous.accountId,
      providerId,
      updatedAt: new Date(fixtureEpoch + ++this.sequence * 1000).toISOString(),
    };
    validateEvent(event);
    event.start = toIso(event.start);
    event.end = toIso(event.end);
    this.events.set(providerId, event);
    this.changes.push({ kind: "event", op: "upsert", event: clone(event) });
    return clone(event);
  }
  async deleteEvent(providerId: string): Promise<void> {
    this.check();
    if (!this.events.delete(providerId))
      throw new ProviderError("NOT_FOUND", "Mock event does not exist");
    this.changes.push({ kind: "event", op: "delete", providerId });
  }
  async respond(providerId: string, status: ParticipationStatus): Promise<void> {
    const a = this.check(),
      event = this.events.get(providerId);
    if (!event) throw new ProviderError("NOT_FOUND", "Mock event does not exist");
    await this.updateEvent(providerId, {
      myStatus: status,
      participants: event.participants.map((p) =>
        p.email.toLowerCase() === a.emailAddress.toLowerCase() ? { ...p, status } : p,
      ),
    });
  }
  async freeBusy(range: TimeRange): Promise<TimeRange[]> {
    this.check();
    validateRange(range);
    return [...this.events.values()]
      .filter((e) => e.status !== "cancelled" && e.myStatus !== "declined" && overlaps(e, range))
      .map((e) => ({
        start: e.start > range.start ? e.start : range.start,
        end: e.end < range.end ? e.end : range.end,
      }));
  }
}

export function overlaps(event: TimeRange, range: TimeRange): boolean {
  return (
    Date.parse(event.start) < Date.parse(range.end) &&
    Date.parse(event.end) > Date.parse(range.start)
  );
}
