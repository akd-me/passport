import type {
  AccountCapabilities,
  DraftInput,
  Email,
  Keyword,
  Mailbox,
  MailboxRole,
  MailChange,
  MailProvider,
  SendResult,
  SyncDelta,
  Timestamp,
} from "@passport/types";
import {
  assertSend,
  decodeCursor,
  encodeCursor,
  localId,
  ProviderError,
  required,
} from "./errors.js";
import { HttpConnection, type ProviderOptions } from "./http.js";
import {
  composeMime,
  generatePreview,
  htmlToText,
  normalizeHeaders,
  normalizeMime,
  toIso,
} from "./normalize/index.js";
import { type PassportVerifier, verifyHeaders } from "./verification.js";

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  historyId?: string;
  payload?: GmailPart;
  raw?: string;
}
interface GmailLabel {
  id: string;
  name: string;
  messagesTotal?: number;
  messagesUnread?: number;
}
interface GmailDraft {
  id: string;
  message: GmailMessage;
}
const base = "https://gmail.googleapis.com/gmail/v1/users/me";
const roles: Record<string, MailboxRole> = {
  INBOX: "inbox",
  SENT: "sent",
  DRAFT: "drafts",
  TRASH: "trash",
  SPAM: "junk",
  IMPORTANT: "important",
  ALL: "all",
};
const keywordLabels: Record<string, string> = { $flagged: "STARRED", $junk: "SPAM" };
export const gmailCapabilities: AccountCapabilities = {
  mail: true,
  calendar: false,
  contacts: false,
  push: false,
  labels: true,
  submit: true,
};

function flatten(part?: GmailPart): GmailPart[] {
  return part ? [part, ...(part.parts ?? []).flatMap(flatten)] : [];
}
function isAttachment(part: GmailPart): boolean {
  return Boolean(
    part.filename ||
      part.mimeType === "text/calendar" ||
      part.headers?.some(
        (h) => h.name.toLowerCase() === "content-disposition" && /^attachment/i.test(h.value),
      ) ||
      (part.body?.attachmentId && !["text/plain", "text/html"].includes(part.mimeType ?? "")),
  );
}
function partText(part: GmailPart): string {
  const charset =
    part.headers
      ?.find((h) => h.name.toLowerCase() === "content-type")
      ?.value.match(/charset\s*=\s*"?([^;"\s]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(Buffer.from(part.body?.data ?? "", "base64url"));
  } catch {
    throw new ProviderError("INVALID_ENCODING", "Gmail returned an unsupported body charset");
  }
}

/** Normalize Gmail full/raw payloads, preserving MIME attachment handles and receiver headers. */
export async function normalizeGmail(
  message: GmailMessage,
  accountId: string,
  verifier?: PassportVerifier,
): Promise<Email> {
  const labels = message.labelIds ?? [],
    keywords: Email["keywords"] = {};
  if (!labels.includes("UNREAD")) keywords.$seen = true;
  if (labels.includes("STARRED")) keywords.$flagged = true;
  if (labels.includes("DRAFT")) keywords.$draft = true;
  if (labels.includes("SPAM")) keywords.$junk = true;
  for (const l of labels)
    if (!roles[l] && !["UNREAD", "STARRED"].includes(l)) keywords[`label:${l}`] = true;
  const mailboxIds = labels.filter((l) => !["UNREAD", "STARRED"].includes(l));
  const receivedAt = toIso(message.internalDate ? Number(message.internalDate) : 0);
  if (message.raw)
    return normalizeMime(Buffer.from(message.raw, "base64url"), {
      accountId,
      providerId: message.id,
      threadId: message.threadId,
      mailboxIds,
      keywords,
      receivedAt,
      verifier,
    });
  const headers = normalizeHeaders(message.payload?.headers ?? []);
  // Gmail's full format still exposes RFC 5322 encoded words and address syntax in headers.
  const envelope = await normalizeMime(
    `${(message.payload?.headers ?? []).map((h) => `${h.name}: ${h.value}`).join("\r\n")}\r\n\r\n`,
    { accountId, providerId: message.id },
  );
  const parts = flatten(message.payload);
  const attachments = parts.filter(isAttachment);
  const texts = parts.filter((p) => !attachments.includes(p));
  const html =
    texts
      .filter((p) => p.mimeType === "text/html")
      .map(partText)
      .join("\n") || null;
  const text =
    texts
      .filter((p) => p.mimeType === "text/plain")
      .map(partText)
      .join("\n") || (html ? htmlToText(html) : "");
  return {
    id: localId(accountId, "email", message.id),
    accountId,
    providerId: message.id,
    threadId: localId(accountId, "thread", message.threadId ?? message.id),
    mailboxIds: mailboxIds.map((id) => localId(accountId, "mailbox", id)),
    keywords,
    from: envelope.from,
    to: envelope.to,
    cc: envelope.cc,
    bcc: envelope.bcc,
    replyTo: envelope.replyTo,
    subject: envelope.subject,
    sentAt: envelope.sentAt,
    receivedAt,
    preview: generatePreview(text || htmlToText(message.snippet ?? "")),
    textBody: text,
    htmlBody: html,
    attachments: attachments.map((p, i) => ({
      id: localId(accountId, "attachment", `${message.id}:${p.partId ?? i}`),
      name: p.filename || (p.mimeType === "text/calendar" ? "invite.ics" : "attachment"),
      type: p.mimeType ?? "application/octet-stream",
      size: p.body?.size ?? 0,
      blobId: `gmail:${encodeCursor([message.id, p.body?.attachmentId ?? null, p.partId ?? "", p.mimeType ?? "application/octet-stream"])}`,
      disposition: p.headers?.some(
        (h) => h.name.toLowerCase() === "content-disposition" && /^inline/i.test(h.value),
      )
        ? "inline"
        : "attachment",
      cid: p.headers?.find((h) => h.name.toLowerCase() === "content-id")?.value ?? null,
    })),
    headers,
    size: message.sizeEstimate ?? 0,
    verification: await verifyHeaders(headers, verifier),
    personIds: [],
  };
}

export class GmailMailProvider extends HttpConnection implements MailProvider {
  readonly kind = "gmail" as const;
  readonly capabilities = gmailCapabilities;
  private draftIds = new Map<string, string>();
  private labels: GmailLabel[] = [];
  constructor(options: ProviderOptions = {}) {
    super(options, "google");
  }
  override async disconnect(): Promise<void> {
    this.draftIds.clear();
    this.labels = [];
    await super.disconnect();
  }
  private async getLabels(): Promise<GmailLabel[]> {
    this.labels = (await this.json<{ labels?: GmailLabel[] }>(`${base}/labels`)).labels ?? [];
    return this.labels;
  }
  async createMailbox(name: string): Promise<Mailbox> {
    this.check();
    const label = await this.json<GmailLabel>(
      `${base}/labels`,
      this.body({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
    );
    this.labels.push(label);
    return {
      id: localId(this.account.id, "mailbox", label.id),
      accountId: this.account.id,
      providerId: label.id,
      name: label.name,
      role: roles[label.id] ?? null,
      totalEmails: 0,
      unreadEmails: 0,
    };
  }
  async *sync(
    cursor: string | null,
    opts: { maxEmails?: number; since?: Timestamp } = {},
  ): AsyncIterable<SyncDelta> {
    this.check();
    for (const label of await this.getLabels()) {
      const details = await this.json<GmailLabel>(`${base}/labels/${encodeURIComponent(label.id)}`);
      yield {
        kind: "mailbox",
        op: "upsert",
        mailbox: {
          id: localId(this.account.id, "mailbox", label.id),
          accountId: this.account.id,
          providerId: label.id,
          name: label.name,
          role: roles[label.id] ?? null,
          totalEmails: details.messagesTotal ?? 0,
          unreadEmails: details.messagesUnread ?? 0,
        },
      };
    }
    const pageSize = String(Math.max(1, Math.min(opts.maxEmails ?? 100, 500)));
    let state: string;
    const changed = new Set<string>(),
      deleted = new Set<string>();
    if (cursor) {
      let pageToken: string | undefined;
      state = cursor;
      do {
        const params = new URLSearchParams({
          startHistoryId: cursor,
          maxResults: pageSize,
          ...(pageToken ? { pageToken } : {}),
        });
        let page: {
          historyId: string;
          nextPageToken?: string;
          history?: Array<{
            messages?: Array<{ id: string }>;
            messagesAdded?: Array<{ message: { id: string } }>;
            messagesDeleted?: Array<{ message: { id: string } }>;
            labelsAdded?: Array<{ message: { id: string } }>;
            labelsRemoved?: Array<{ message: { id: string } }>;
          }>;
        };
        try {
          page = await this.json(`${base}/history?${params}`);
        } catch (e) {
          if (e instanceof ProviderError && e.status === 404)
            throw new ProviderError(
              "CURSOR_EXPIRED",
              "Gmail history expired; reset local sync state and run a full sync",
            );
          throw e;
        }
        for (const h of page.history ?? []) {
          for (const m of [
            ...(h.messages ?? []),
            ...(h.messagesAdded ?? []).map((x) => x.message),
            ...(h.labelsAdded ?? []).map((x) => x.message),
            ...(h.labelsRemoved ?? []).map((x) => x.message),
          ]) {
            changed.add(m.id);
            deleted.delete(m.id);
          }
          for (const m of h.messagesDeleted ?? []) {
            deleted.add(m.message.id);
            changed.delete(m.message.id);
          }
        }
        state = required(page.historyId, "Gmail historyId");
        pageToken = page.nextPageToken;
      } while (pageToken);
    } else {
      // Capture the watermark BEFORE listing so arrivals during pagination are replayed next sync.
      state = required(
        (await this.json<{ historyId: string }>(`${base}/profile`)).historyId,
        "Gmail historyId",
      );
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({
          maxResults: pageSize,
          includeSpamTrash: "true",
          ...(pageToken ? { pageToken } : {}),
          ...(opts.since ? { q: `after:${Math.floor(Date.parse(opts.since) / 1000)}` } : {}),
        });
        const page = await this.json<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
          `${base}/messages?${params}`,
        );
        for (const m of page.messages ?? []) changed.add(m.id);
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
    for (const providerId of deleted) yield { kind: "email", op: "delete", providerId };
    for (const id of changed) {
      const email = await this.getEmail(id);
      if (email) yield { kind: "email", op: "upsert", email };
      else yield { kind: "email", op: "delete", providerId: id };
    }
    yield { kind: "cursor", cursor: state };
  }
  async checkConnection(): Promise<void> {
    await this.json(`${base}/profile`);
  }
  async getEmail(providerId: string): Promise<Email | null> {
    let message: GmailMessage;
    try {
      message = await this.json<GmailMessage>(
        `${base}/messages/${encodeURIComponent(providerId)}?format=full`,
      );
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return null;
      throw e;
    }
    for (const part of flatten(message.payload))
      if (!isAttachment(part) && part.body?.attachmentId && part.body.data === undefined) {
        part.body.data = (
          await this.json<{ data: string }>(
            `${base}/messages/${encodeURIComponent(providerId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
          )
        ).data;
        if (typeof part.body.data !== "string")
          throw new ProviderError("INVALID_RESPONSE", "Gmail omitted a referenced text body");
      }
    return normalizeGmail(message, this.account.id, this.options.verifier);
  }
  async getBlob(blobId: string): Promise<{ type: string; data: Uint8Array }> {
    if (blobId.startsWith("mime:")) {
      const { decodeMimeBlob, mimeAttachment } = await import("./normalize/index.js");
      const [id, index] = decodeMimeBlob(blobId);
      const m = await this.json<GmailMessage>(
        `${base}/messages/${encodeURIComponent(id)}?format=raw`,
      );
      return mimeAttachment(Buffer.from(required(m.raw, "raw MIME"), "base64url"), index);
    }
    if (!blobId.startsWith("gmail:"))
      throw new ProviderError("INVALID_BLOB_ID", "Invalid Gmail attachment handle");
    const [id, attachmentId, partId, type] = decodeCursor<[string, string | null, string, string]>(
      blobId.slice(6),
    );
    let data: string | undefined;
    if (attachmentId)
      data = (
        await this.json<{ data: string }>(
          `${base}/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
        )
      ).data;
    else
      data = flatten(
        (await this.json<GmailMessage>(`${base}/messages/${encodeURIComponent(id)}?format=full`))
          .payload,
      ).find((p) => p.partId === partId)?.body?.data;
    if (data === undefined) throw new ProviderError("NOT_FOUND", "Gmail attachment is missing");
    return { type, data: Buffer.from(data, "base64url") };
  }
  private async labelId(name: string): Promise<string> {
    if (!this.labels.length) await this.getLabels();
    const existing = this.labels.find((l) => l.id === name || l.name === name);
    if (existing) return existing.id;
    const label = await this.json<GmailLabel>(`${base}/labels`, this.body({ name }));
    this.labels.push(label);
    return label.id;
  }
  private async keyword(keyword: Keyword): Promise<string> {
    if (keyword.startsWith("label:")) return this.labelId(keyword.slice(6));
    const label = keywordLabels[keyword];
    if (label) return label;
    throw new ProviderError("UNSUPPORTED_KEYWORD", `Gmail cannot directly set keyword ${keyword}`);
  }
  async applyChanges(changes: MailChange[]): Promise<void> {
    for (const c of changes) {
      const add = new Set<string>(),
        remove = new Set<string>();
      if (c.op === "setKeywords") {
        for (const k of c.add ?? [])
          if (k === "$seen") remove.add("UNREAD");
          else if (k === "$notjunk") remove.add("SPAM");
          else add.add(await this.keyword(k));
        for (const k of c.remove ?? [])
          if (k === "$seen") add.add("UNREAD");
          else if (k === "$notjunk") add.add("SPAM");
          else remove.add(await this.keyword(k));
      } else if (c.op === "addToMailbox") add.add(await this.labelId(c.mailboxProviderId));
      else if (c.op === "removeFromMailbox") remove.add(await this.labelId(c.mailboxProviderId));
      for (const id of c.providerIds) {
        if (c.op === "delete") {
          await this.http(`${base}/messages/${encodeURIComponent(id)}/trash`, { method: "POST" });
          continue;
        }
        const removeForId = [...remove];
        if (c.op === "move") {
          const email = await this.getEmail(id);
          if (!email) throw new ProviderError("NOT_FOUND", "Gmail message does not exist");
          const target = await this.labelId(c.toMailboxProviderId);
          add.add(target);
          for (const mailbox of email.mailboxIds) {
            const label = decodeURIComponent(mailbox.split(":mailbox:")[1]!);
            if (![target, "DRAFT", "SENT", "IMPORTANT"].includes(label)) removeForId.push(label);
          }
        }
        await this.http(
          `${base}/messages/${encodeURIComponent(id)}/modify`,
          this.body({ addLabelIds: [...add], removeLabelIds: removeForId }),
        );
      }
    }
  }
  private async rawDraft(draft: DraftInput): Promise<{ raw: string; threadId?: string }> {
    this.check();
    const reply = await this.reply(draft.inReplyToEmailId, (id) => this.getEmail(id));
    const nativeReply = reply ? await this.getEmail(reply.providerId) : null;
    return {
      raw: (await composeMime(this.account, draft, (id) => this.getBlob(id), reply)).toString(
        "base64url",
      ),
      ...(nativeReply
        ? { threadId: decodeURIComponent(nativeReply.threadId.split(":thread:")[1]!) }
        : {}),
    };
  }
  private async fullDraft(d: GmailDraft): Promise<Email> {
    this.draftIds.set(d.message.id, d.id);
    const email = await this.getEmail(d.message.id);
    if (!email) throw new ProviderError("INVALID_RESPONSE", "Gmail draft was not readable");
    return email;
  }
  private async draftId(providerId: string): Promise<string> {
    if (this.draftIds.has(providerId)) return this.draftIds.get(providerId)!;
    let pageToken: string | undefined;
    do {
      const page = await this.json<{ drafts?: GmailDraft[]; nextPageToken?: string }>(
        `${base}/drafts?${new URLSearchParams(pageToken ? { pageToken } : {})}`,
      );
      for (const d of page.drafts ?? []) this.draftIds.set(d.message.id, d.id);
      pageToken = page.nextPageToken;
    } while (pageToken);
    const id = this.draftIds.get(providerId);
    if (!id) throw new ProviderError("NOT_FOUND", "Gmail draft does not exist");
    return id;
  }
  async createDraft(draft: DraftInput): Promise<Email> {
    return this.fullDraft(
      await this.json<GmailDraft>(
        `${base}/drafts`,
        this.body({ message: await this.rawDraft(draft) }),
      ),
    );
  }
  async updateDraft(providerId: string, draft: DraftInput): Promise<Email> {
    const id = await this.draftId(providerId),
      result = await this.json<GmailDraft>(
        `${base}/drafts/${encodeURIComponent(id)}`,
        this.body({ message: await this.rawDraft(draft) }, "PUT"),
      );
    this.draftIds.delete(providerId);
    return this.fullDraft(result);
  }
  async deleteDraft(providerId: string): Promise<void> {
    await this.http(`${base}/drafts/${encodeURIComponent(await this.draftId(providerId))}`, {
      method: "DELETE",
    });
    this.draftIds.delete(providerId);
  }
  async send(input: { draftProviderId?: string; draft?: DraftInput }): Promise<SendResult> {
    assertSend(input);
    const m = input.draftProviderId
      ? await this.json<GmailMessage>(
          `${base}/drafts/send`,
          this.body({ id: await this.draftId(input.draftProviderId) }),
        )
      : await this.json<GmailMessage>(
          `${base}/messages/send`,
          this.body(await this.rawDraft(input.draft!)),
        );
    if (input.draftProviderId) this.draftIds.delete(input.draftProviderId);
    return { providerId: m.id, messageId: null, threadId: m.threadId ?? null };
  }
}
