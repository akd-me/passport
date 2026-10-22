import type {
  Account,
  AccountCredentials,
  DraftInput,
  Email,
  Mailbox,
  MailChange,
  MailProvider,
  SendResult,
  SyncDelta,
} from "@passport/types";
import { assertSend, decodeCursor, encodeCursor, localId, ProviderError } from "./errors.js";
import type { ProviderOptions } from "./http.js";
import {
  clone,
  createMockEmails,
  fixtureEpoch,
  folderNames,
  mockCapabilities,
  mockFile,
  mockInvite,
} from "./mock-fixtures.js";
import { MockMailReader } from "./mock-reader.js";
import { generatePreview, normalizeAddresses, normalizeHeaders } from "./normalize/index.js";
import type { QuotaGovernor } from "./quota.js";
import { resolveReplyEmail } from "./reply.js";
import { parseAuthenticationResults, verifyHeaders } from "./verification.js";

export interface MockMailOptions
  extends Pick<ProviderOptions, "now" | "verifier" | "resolveEmail"> {
  fixtures?: boolean;
  /**
   * Quota governor for `reader()` calls (configure the account first). Configure it with
   * `"gmail"` limits to exercise RATE_LIMITED paths against the mock's Gmail-priced costs.
   */
  governor?: QuotaGovernor;
}

/** Default fixture clock: one hour after the newest fixture message. */
const defaultClock = fixtureEpoch + 40 * 3600_000;

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
  private clock = defaultClock;
  private mailReader?: MockMailReader;
  constructor(private readonly options: MockMailOptions = {}) {}
  /**
   * Sets the fixture clock used by `reader()` for `newer_than:` / `older_than:` and change-cursor
   * expiry. Ignored when `options.now` is supplied.
   */
  setNow(value: Date | string | number): void {
    this.clock = new Date(value).getTime();
  }
  /** Current fixture time. */
  now(): Date {
    return this.options.now?.() ?? new Date(this.clock);
  }
  /**
   * On-demand reader over this mailbox (one instance per provider). Calls are priced in Gmail
   * units and recorded in `costLog`.
   */
  reader(): MockMailReader {
    this.mailReader ??= new MockMailReader({
      account: () => this.check(),
      emails: () => this.emails.values(),
      get: (providerId) => this.emails.get(providerId),
      folders: () => this.folderNames,
      log: () => this.changes,
      blob: (blobId) => this.findBlob(blobId),
      now: () => this.now(),
      verify: async (email) => {
        if (this.options.verifier) {
          email.verification = await verifyHeaders(email.headers, this.options.verifier);
        }
        return email;
      },
      ...(this.options.governor ? { governor: this.options.governor } : {}),
    });
    return this.mailReader;
  }
  get sentMail(): readonly Email[] {
    return clone(this.sent);
  }
  async connect(account: Account, _credentials: AccountCredentials = {}): Promise<void> {
    if (this.account && this.account.id !== account.id) {
      throw new ProviderError("ACCOUNT_MISMATCH", "Use a separate mock instance per account");
    }
    const first = !this.account;
    this.account = clone(account);
    this.connected = true;
    if (first && this.options.fixtures !== false) {
      for (const email of createMockEmails(account.id, account.emailAddress)) {
        this.store(email);
      }
    }
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.wake();
  }
  private check(): Account {
    if (!this.account || !this.connected) {
      throw new ProviderError("NOT_CONNECTED", "Connect the mock provider first");
    }
    return this.account;
  }
  private wake(): void {
    for (const done of [...this.waiters]) {
      done();
    }
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
    if (!this.folderNames.includes(name)) {
      this.folderNames.push(name);
    }
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
      ) {
        throw new ProviderError("INVALID_CURSOR", "Mock cursor does not belong to this mailbox");
      }
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
      if (delta.kind === "email" && delta.op === "upsert" && this.options.verifier) {
        delta.email.verification = await verifyHeaders(delta.email.headers, this.options.verifier);
      }
      yield delta;
    }
    const threads = new Map<string, string[]>();
    for (const e of emails) {
      (threads.get(e.threadId) ?? (threads.set(e.threadId, []), threads.get(e.threadId)!)).push(
        e.id,
      );
    }
    for (const [id, emailIds] of threads) {
      yield { kind: "thread", op: "upsert", thread: { id, accountId: account.id, emailIds } };
    }
    yield { kind: "cursor", cursor: encodeCursor({ account: account.id, revision: end }) };
  }
  async getEmail(providerId: string): Promise<Email | null> {
    this.check();
    const email = clone(this.emails.get(providerId) ?? null);
    if (email && this.options.verifier) {
      email.verification = await verifyHeaders(email.headers, this.options.verifier);
    }
    return email;
  }
  async getBlob(blobId: string): Promise<{ type: string; data: Uint8Array }> {
    this.check();
    const found = this.findBlob(blobId);
    if (!found) {
      throw new ProviderError("NOT_FOUND", "Mock attachment does not exist");
    }
    return found;
  }
  /** Uploaded blobs, invites and fixture files that some message still references. */
  private findBlob(blobId: string): { type: string; data: Uint8Array } | undefined {
    const stored = this.blobs.get(blobId);
    if (stored) {
      return clone(stored);
    }
    const invite = blobId.startsWith("mock-invite:");
    const providerId = invite
      ? blobId.slice("mock-invite:".length)
      : (/^mock-file:(.+):[^:]+$/.exec(blobId)?.[1] ?? "");
    if (!this.emails.get(providerId)?.attachments.some((a) => a.blobId === blobId)) {
      return undefined;
    }
    return invite
      ? { type: "text/calendar", data: Buffer.from(mockInvite(providerId)) }
      : mockFile(blobId);
  }
  async applyChanges(changes: MailChange[]): Promise<void> {
    const account = this.check();
    for (const change of changes) {
      for (const id of change.providerIds) {
        const email = this.emails.get(id);
        if (!email) {
          throw new ProviderError("NOT_FOUND", "Mock email does not exist");
        }
        const next = clone(email);
        if (change.op === "setKeywords") {
          for (const k of change.add ?? []) {
            next.keywords[k] = true;
          }
          for (const k of change.remove ?? []) {
            delete next.keywords[k];
          }
        } else if (change.op === "move") {
          next.mailboxIds = [localId(account.id, "mailbox", change.toMailboxProviderId)];
        } else if (change.op === "delete") {
          next.mailboxIds = [localId(account.id, "mailbox", "Trash")];
        } else if (change.op === "addToMailbox") {
          next.mailboxIds = [
            ...new Set([
              ...next.mailboxIds,
              localId(account.id, "mailbox", change.mailboxProviderId),
            ]),
          ];
        } else {
          next.mailboxIds = next.mailboxIds.filter(
            (id) => id !== localId(account.id, "mailbox", change.mailboxProviderId),
          );
        }
        this.store(next);
      }
    }
  }
  private async draftEmail(draft: DraftInput, providerId: string): Promise<Email> {
    const account = this.check();
    if (draft.accountId !== account.id) {
      throw new ProviderError("ACCOUNT_MISMATCH", "Draft belongs to a different account");
    }
    const reply = await resolveReplyEmail(
      account.id,
      draft.inReplyToEmailId,
      (id) => this.getEmail(id),
      this.options.resolveEmail,
    );
    // Store thread IDs have also been remapped; retain the provider's native thread here.
    const nativeReply = reply ? await this.getEmail(reply.providerId) : null;
    if (reply && !nativeReply) {
      throw new ProviderError("NOT_FOUND", "Mock reply email does not exist");
    }
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
    for (const a of email.attachments) {
      a.size = (await this.getBlob(a.blobId)).data.byteLength;
    }
    return this.store(email);
  }
  async updateDraft(providerId: string, draft: DraftInput): Promise<Email> {
    if (!this.emails.get(providerId)?.keywords.$draft) {
      throw new ProviderError("NOT_FOUND", "Mock draft does not exist");
    }
    const email = await this.draftEmail(draft, providerId);
    for (const a of email.attachments) {
      a.size = (await this.getBlob(a.blobId)).data.byteLength;
    }
    return this.store(email);
  }
  async deleteDraft(providerId: string): Promise<void> {
    this.check();
    if (!this.emails.get(providerId)?.keywords.$draft) {
      throw new ProviderError("NOT_FOUND", "Mock draft does not exist");
    }
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
    if (!email?.keywords.$draft) {
      throw new ProviderError("NOT_FOUND", "Mock draft does not exist");
    }
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
    if (signal.aborted) {
      return;
    }
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
