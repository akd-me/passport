import type {
  Account,
  AccountCapabilities,
  AccountCredentials,
  DraftInput,
  Email,
  EmailAddress,
  Mailbox,
  MailboxRole,
  MailChange,
  MailProvider,
  SendResult,
  SyncDelta,
} from "@passport/types";
import { assertSend, localId, ProviderError, required } from "./errors.js";
import { HttpConnection, type ProviderOptions } from "./http.js";
import {
  generatePreview,
  htmlToText,
  normalizeAddresses,
  normalizeHeaders,
  toIso,
} from "./normalize/index.js";
import { type PassportVerifier, verifyHeaders } from "./verification.js";

const core = "urn:ietf:params:jmap:core",
  mail = "urn:ietf:params:jmap:mail",
  submission = "urn:ietf:params:jmap:submission";
interface JmapBodyPart {
  partId?: string;
  blobId?: string;
  name?: string | null;
  type?: string;
  size?: number;
  disposition?: string | null;
  cid?: string | null;
}
export interface JmapEmail {
  id: string;
  threadId?: string;
  mailboxIds?: Record<string, boolean>;
  keywords?: Record<string, boolean>;
  from?: EmailAddress[];
  to?: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  subject?: string;
  sentAt?: string | null;
  receivedAt?: string;
  preview?: string;
  size?: number;
  headers?: Array<{ name: string; value: string }>;
  messageId?: string[];
  inReplyTo?: string[];
  references?: string[];
  textBody?: JmapBodyPart[];
  htmlBody?: JmapBodyPart[];
  attachments?: JmapBodyPart[];
  bodyValues?: Record<string, { value: string; isTruncated?: boolean }>;
}
interface JmapSession {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  capabilities: Record<string, unknown>;
  primaryAccounts: Record<string, string>;
  accounts: Record<string, { name: string; accountCapabilities: Record<string, unknown> }>;
}
interface JmapMailbox {
  id: string;
  name: string;
  role?: MailboxRole;
  parentId?: string | null;
  totalEmails?: number;
  unreadEmails?: number;
}
interface SetResult {
  created?: Record<string, { id: string }>;
  notCreated?: Record<string, unknown>;
  notUpdated?: Record<string, unknown>;
  notDestroyed?: Record<string, unknown>;
}
export const jmapCapabilities: AccountCapabilities = {
  mail: true,
  calendar: false,
  contacts: false,
  push: false,
  labels: true,
  submit: true,
};

export async function normalizeJmap(
  message: JmapEmail,
  accountId: string,
  verifier?: PassportVerifier,
): Promise<Email> {
  const headers = normalizeHeaders(message.headers ?? []);
  headers.messageId ??= message.messageId?.[0]
    ? `<${message.messageId[0]!.replace(/^<|>$/g, "")}>`
    : null;
  headers.inReplyTo ??= message.inReplyTo?.[0]
    ? `<${message.inReplyTo[0]!.replace(/^<|>$/g, "")}>`
    : null;
  if (!headers.references.length)
    headers.references = (message.references ?? []).map((v) => `<${v.replace(/^<|>$/g, "")}>`);
  const body = (parts: JmapBodyPart[] = []) =>
    parts.map((p) => message.bodyValues?.[p.partId ?? ""]?.value ?? "").join("\n");
  const html = body(message.htmlBody) || null,
    text = body(message.textBody) || (html ? htmlToText(html) : "");
  return {
    id: localId(accountId, "email", message.id),
    accountId,
    providerId: message.id,
    threadId: localId(accountId, "thread", message.threadId ?? message.id),
    mailboxIds: Object.keys(message.mailboxIds ?? {})
      .filter((k) => message.mailboxIds![k])
      .map((k) => localId(accountId, "mailbox", k)),
    keywords: Object.fromEntries(Object.entries(message.keywords ?? {}).filter(([, v]) => v)),
    from: normalizeAddresses(message.from),
    to: normalizeAddresses(message.to),
    cc: normalizeAddresses(message.cc),
    bcc: normalizeAddresses(message.bcc),
    replyTo: normalizeAddresses(message.replyTo),
    subject: message.subject ?? "",
    sentAt: message.sentAt ? toIso(message.sentAt) : null,
    receivedAt: toIso(message.receivedAt ?? message.sentAt ?? 0),
    preview: generatePreview(text || message.preview || ""),
    textBody: text,
    htmlBody: html,
    attachments: (message.attachments ?? []).map((a, i) => ({
      id: localId(accountId, "attachment", `${message.id}:${a.partId ?? i}`),
      name: a.name ?? "attachment",
      type: a.type ?? "application/octet-stream",
      size: a.size ?? 0,
      blobId: required(a.blobId, "JMAP blobId"),
      disposition: a.disposition === "inline" ? "inline" : "attachment",
      cid: a.cid ?? null,
    })),
    headers,
    size: message.size ?? 0,
    verification: await verifyHeaders(headers, verifier),
    personIds: [],
  };
}

export class JmapMailProvider extends HttpConnection implements MailProvider {
  readonly kind = "jmap" as const;
  readonly capabilities = jmapCapabilities;
  private session?: JmapSession;
  private remoteAccountId = "";
  constructor(options: ProviderOptions = {}) {
    super(options);
  }
  override async connect(account: Account, credentials: AccountCredentials): Promise<void> {
    await super.connect(account, credentials);
    try {
      const url = new URL(
        String(
          account.settings.sessionUrl ??
            `https://${required(account.settings.host, "host or sessionUrl")}/.well-known/jmap`,
        ),
      );
      if (url.protocol !== "https:")
        throw new ProviderError("CONFIG_INVALID", "JMAP sessionUrl must use HTTPS");
      this.session = await this.json<JmapSession>(url.href);
      if (!this.session.capabilities?.[mail])
        throw new ProviderError("UNSUPPORTED_CAPABILITY", "Server does not support JMAP Mail");
      this.remoteAccountId = String(
        account.settings.jmapAccountId ?? this.session.primaryAccounts[mail] ?? "",
      );
      if (
        !this.remoteAccountId ||
        !this.session.accounts[this.remoteAccountId]?.accountCapabilities[mail]
      )
        throw new ProviderError("CONFIG_INVALID", "JMAP Mail account was not found");
      // Session URLs may legitimately point at a separate API/download host, but always require TLS.
      for (const value of [this.session.apiUrl, this.session.downloadUrl, this.session.uploadUrl])
        if (!value?.startsWith("https://"))
          throw new ProviderError("INVALID_RESPONSE", "JMAP endpoint must use HTTPS");
    } catch (e) {
      await this.disconnect();
      throw e;
    }
  }
  override async disconnect(): Promise<void> {
    this.session = undefined;
    this.remoteAccountId = "";
    await super.disconnect();
  }
  private async call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    this.check();
    if (!this.session) throw new ProviderError("NOT_CONNECTED", "JMAP session is unavailable");
    const using = [
      core,
      mail,
      ...(method.startsWith("EmailSubmission/") || method.startsWith("Identity/")
        ? [submission]
        : []),
    ];
    if (using.includes(submission) && !this.session.capabilities[submission])
      throw new ProviderError("UNSUPPORTED_CAPABILITY", "Server does not support JMAP submission");
    const response = await this.json<{
      methodResponses: Array<[string, T & { type?: string }, string]>;
    }>(
      this.session.apiUrl,
      this.body({
        using,
        methodCalls: [[method, { accountId: this.remoteAccountId, ...args }, "0"]],
      }),
    );
    const item = response.methodResponses?.find((r) => r[2] === "0");
    if (!item)
      throw new ProviderError("INVALID_RESPONSE", "JMAP response is missing the requested method");
    if (item[0] === "error")
      throw new ProviderError(
        item[1].type === "cannotCalculateChanges" ? "CURSOR_EXPIRED" : "JMAP_METHOD_ERROR",
        `JMAP ${method} failed${item[1].type === "cannotCalculateChanges" ? "; reset local sync state and run a full sync" : ""}`,
      );
    if (item[0] !== method)
      throw new ProviderError("INVALID_RESPONSE", "JMAP returned an unexpected method");
    const result = item[1] as T & SetResult;
    if (
      Object.keys(result.notCreated ?? {}).length ||
      Object.keys(result.notUpdated ?? {}).length ||
      Object.keys(result.notDestroyed ?? {}).length
    )
      throw new ProviderError("JMAP_SET_FAILED", `JMAP ${method} rejected one or more mutations`);
    return result;
  }
  private async mailboxes(): Promise<JmapMailbox[]> {
    return (await this.call<{ list: JmapMailbox[] }>("Mailbox/get")).list;
  }
  async createMailbox(name: string): Promise<Mailbox> {
    const result = await this.call<SetResult>("Mailbox/set", { create: { label: { name } } });
    const id = required(result.created?.label?.id, "JMAP created mailbox id");
    return {
      id: localId(this.account.id, "mailbox", id),
      accountId: this.account.id,
      providerId: id,
      name,
      role: null,
      totalEmails: 0,
      unreadEmails: 0,
    };
  }
  async *sync(cursor: string | null, opts: { maxEmails?: number } = {}): AsyncIterable<SyncDelta> {
    for (const m of await this.mailboxes())
      yield {
        kind: "mailbox",
        op: "upsert",
        mailbox: {
          id: localId(this.account.id, "mailbox", m.id),
          accountId: this.account.id,
          providerId: m.id,
          name: m.name,
          role: m.role ?? null,
          parentId: m.parentId ? localId(this.account.id, "mailbox", m.parentId) : null,
          totalEmails: m.totalEmails ?? 0,
          unreadEmails: m.unreadEmails ?? 0,
        },
      };
    let state: string;
    const changed = new Set<string>(),
      deleted = new Set<string>();
    if (cursor) {
      state = cursor;
      let more: boolean;
      do {
        const page = await this.call<{
          newState: string;
          hasMoreChanges: boolean;
          created: string[];
          updated: string[];
          destroyed: string[];
        }>("Email/changes", { sinceState: state, maxChanges: Math.max(1, opts.maxEmails ?? 100) });
        for (const id of [...page.created, ...page.updated]) {
          changed.add(id);
          deleted.delete(id);
        }
        for (const id of page.destroyed) {
          changed.delete(id);
          deleted.add(id);
        }
        state = required(page.newState, "JMAP state");
        more = page.hasMoreChanges;
      } while (more);
    } else {
      state = required(
        (await this.call<{ state: string }>("Email/get", { ids: [] })).state,
        "JMAP state",
      );
      let position = 0,
        total: number;
      do {
        const page = await this.call<{ ids: string[]; total: number }>("Email/query", {
          position,
          limit: Math.max(1, opts.maxEmails ?? 100),
          calculateTotal: true,
        });
        for (const id of page.ids) changed.add(id);
        total = page.total;
        position += page.ids.length;
        if (!page.ids.length && position < total)
          throw new ProviderError("INVALID_RESPONSE", "JMAP query pagination made no progress");
      } while (position < total);
    }
    for (const providerId of deleted) yield { kind: "email", op: "delete", providerId };
    for (const id of changed) {
      const email = await this.getEmail(id);
      if (email) yield { kind: "email", op: "upsert", email };
      else yield { kind: "email", op: "delete", providerId: id };
    }
    yield { kind: "cursor", cursor: state };
  }
  async getEmail(providerId: string): Promise<Email | null> {
    const p = await this.call<{ list: JmapEmail[] }>("Email/get", {
      ids: [providerId],
      properties: [
        "id",
        "threadId",
        "mailboxIds",
        "keywords",
        "from",
        "to",
        "cc",
        "bcc",
        "replyTo",
        "subject",
        "sentAt",
        "receivedAt",
        "preview",
        "size",
        "headers",
        "messageId",
        "inReplyTo",
        "references",
        "textBody",
        "htmlBody",
        "attachments",
        "bodyValues",
      ],
      fetchTextBodyValues: true,
      fetchHTMLBodyValues: true,
    });
    return p.list[0] ? normalizeJmap(p.list[0], this.account.id, this.options.verifier) : null;
  }
  async getBlob(blobId: string): Promise<{ type: string; data: Uint8Array }> {
    this.check();
    if (!this.session) throw new ProviderError("NOT_CONNECTED", "JMAP session is unavailable");
    const values: Record<string, string> = {
      accountId: this.remoteAccountId,
      blobId,
      name: "attachment",
      type: "application/octet-stream",
    };
    const url = this.session.downloadUrl.replace(
      /\{(accountId|blobId|name|type)\}/g,
      (_, key: string) => encodeURIComponent(values[key]!),
    );
    const response = await this.http(url);
    return {
      type: response.headers.get("content-type") ?? "application/octet-stream",
      data: new Uint8Array(await response.arrayBuffer()),
    };
  }
  async applyChanges(changes: MailChange[]): Promise<void> {
    const escape = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
    for (const c of changes) {
      const update: Record<string, Record<string, unknown>> = {};
      const trash =
        c.op === "delete" ? (await this.mailboxes()).find((m) => m.role === "trash") : undefined;
      if (c.op === "delete" && !trash)
        throw new ProviderError(
          "MAILBOX_NOT_FOUND",
          "JMAP has no trash mailbox; refusing to permanently destroy mail",
        );
      for (const id of c.providerIds) {
        const patch: Record<string, unknown> = {};
        if (c.op === "setKeywords") {
          for (const k of c.add ?? []) patch[`keywords/${escape(k)}`] = true;
          for (const k of c.remove ?? []) patch[`keywords/${escape(k)}`] = null;
        } else if (c.op === "move" || c.op === "delete")
          patch.mailboxIds = { [c.op === "move" ? c.toMailboxProviderId : trash!.id]: true };
        else
          patch[`mailboxIds/${escape(c.mailboxProviderId)}`] =
            c.op === "addToMailbox" ? true : null;
        update[id] = patch;
      }
      if (Object.keys(update).length) await this.call("Email/set", { update });
    }
  }
  async createDraft(draft: DraftInput): Promise<Email> {
    this.check();
    if (draft.accountId !== this.account.id)
      throw new ProviderError("ACCOUNT_MISMATCH", "Draft belongs to another account");
    const drafts = (await this.mailboxes()).find((m) => m.role === "drafts");
    if (!drafts) throw new ProviderError("MAILBOX_NOT_FOUND", "JMAP has no drafts mailbox");
    const reply = await this.reply(draft.inReplyToEmailId, (id) => this.getEmail(id));
    const created = await this.call<SetResult>("Email/set", {
      create: {
        draft: {
          mailboxIds: { [drafts.id]: true },
          keywords: { $draft: true, $seen: true },
          from: [{ email: this.account.emailAddress }],
          to: draft.to,
          cc: draft.cc ?? [],
          bcc: draft.bcc ?? [],
          subject: draft.subject,
          textBody: [{ partId: "text", type: "text/plain" }],
          ...(draft.htmlBody ? { htmlBody: [{ partId: "html", type: "text/html" }] } : {}),
          bodyValues: {
            text: { value: draft.textBody },
            ...(draft.htmlBody ? { html: { value: draft.htmlBody } } : {}),
          },
          attachments: (draft.attachments ?? []).map((a) => ({
            blobId: a.blobId,
            name: a.name,
            type: a.type,
            disposition: "attachment",
          })),
          ...(reply?.headers.messageId
            ? {
                inReplyTo: [reply.headers.messageId.replace(/^<|>$/g, "")],
                references: [...reply.headers.references, reply.headers.messageId].map((v) =>
                  v.replace(/^<|>$/g, ""),
                ),
              }
            : {}),
        },
      },
    });
    const email = await this.getEmail(required(created.created?.draft?.id, "created draft ID"));
    if (!email) throw new ProviderError("INVALID_RESPONSE", "JMAP created draft is missing");
    return email;
  }
  async updateDraft(providerId: string, draft: DraftInput): Promise<Email> {
    // JMAP message bodies are immutable. Replacement returns a new providerId; callers must upsert it.
    if (!(await this.getEmail(providerId))?.keywords.$draft)
      throw new ProviderError("NOT_A_DRAFT", "JMAP message is not a draft");
    const replacement = await this.createDraft(draft);
    await this.deleteDraft(providerId);
    return replacement;
  }
  async deleteDraft(providerId: string): Promise<void> {
    if (!(await this.getEmail(providerId))?.keywords.$draft)
      throw new ProviderError("NOT_A_DRAFT", "JMAP message is not a draft");
    await this.call("Email/set", { destroy: [providerId] });
  }
  async send(input: { draftProviderId?: string; draft?: DraftInput }): Promise<SendResult> {
    assertSend(input);
    const email = input.draft
      ? await this.createDraft(input.draft)
      : await this.getEmail(input.draftProviderId!);
    if (!email?.keywords.$draft)
      throw new ProviderError("NOT_A_DRAFT", "JMAP draft does not exist");
    const identities = await this.call<{ list: Array<{ id: string; email: string }> }>(
      "Identity/get",
    );
    const identity = identities.list.find(
      (i) => i.email.toLowerCase() === this.account.emailAddress.toLowerCase(),
    );
    if (!identity)
      throw new ProviderError(
        "IDENTITY_NOT_FOUND",
        "JMAP submission identity does not match the account",
      );
    const sent = (await this.mailboxes()).find((m) => m.role === "sent"),
      update: Record<string, unknown> = { "keywords/$draft": null };
    if (sent) update.mailboxIds = { [sent.id]: true };
    await this.call("EmailSubmission/set", {
      create: { send: { emailId: email.providerId, identityId: identity.id } },
      onSuccessUpdateEmail: { "#send": update },
    });
    return {
      providerId: email.providerId,
      messageId: email.headers.messageId,
      threadId: email.threadId,
    };
  }
}
