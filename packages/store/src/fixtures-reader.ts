import type {
  Email,
  MailBody,
  MailEnvelope,
  MailReader,
  MailReadOptions,
  ReadValue,
} from "@passport/types";
import { mailHandle } from "@passport/types";
import { email } from "./fixtures.js";

type Call = { method: string; args: unknown[]; opts?: MailReadOptions };

const meta = { source: "provider" as const, cost: { gmailUnits: 5 } };
const unsupported = () => Promise.reject(new Error("not used by the store"));

/** Provider-side message for the fake reader: a full `Email` whose ids are adapter handles. */
export function providerEmail(providerId: string, patch: Partial<Email> = {}): Email {
  return email(mailHandle("account", "email", providerId), {
    providerId,
    threadId: mailHandle("account", "thread", `t-${providerId}`),
    mailboxIds: ["account:mailbox:INBOX"],
    personIds: [],
    category: null,
    textBody: `Body of ${providerId}`,
    htmlBody: `<p>Body of ${providerId}</p>`,
    ...patch,
  });
}

/** A `MailReader` over an in-memory mailbox that records every call. */
export class FakeMailReader implements MailReader {
  readonly calls: Call[] = [];
  readonly messages = new Map<string, Email>();
  failNext: Error | null = null;
  constructor(messages: Email[] = []) {
    for (const message of messages) {
      this.messages.set(message.providerId, message);
    }
  }
  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
  private record(method: string, args: unknown[], opts?: MailReadOptions) {
    this.calls.push({ method, args, ...(opts ? { opts } : {}) });
    const failure = this.failNext;
    this.failNext = null;
    if (failure) {
      throw failure;
    }
  }
  async envelopes(
    providerIds: string[],
    opts?: MailReadOptions,
  ): Promise<ReadValue<Map<string, MailEnvelope | null>>> {
    this.record("envelopes", [providerIds], opts);
    const value = new Map<string, MailEnvelope | null>();
    for (const id of providerIds) {
      const message = this.messages.get(id);
      if (message) {
        const { textBody: _text, htmlBody: _html, ...envelope } = structuredClone(message);
        value.set(id, envelope);
      } else {
        value.set(id, null);
      }
    }
    return { value, ...meta };
  }
  async body(providerId: string, opts?: MailReadOptions): Promise<ReadValue<MailBody>> {
    this.record("body", [providerId], opts);
    const message = this.messages.get(providerId);
    if (!message) {
      throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
    }
    const { textBody, htmlBody, attachments } = structuredClone(message);
    return { value: { textBody, htmlBody, attachments }, ...meta };
  }
  search = unsupported;
  list = unsupported;
  labels = unsupported;
  thread = unsupported;
  countIds = unsupported;
  changes = unsupported;
  async findByRfc822(rfc822Id: string, opts?: MailReadOptions): Promise<ReadValue<string | null>> {
    this.record("findByRfc822", [rfc822Id], opts);
    const match = [...this.messages.values()].find(
      (message) => message.headers.messageId === rfc822Id,
    );
    return { value: match?.providerId ?? null, ...meta };
  }
}
