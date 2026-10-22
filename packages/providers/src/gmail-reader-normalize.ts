import type { Attachment, Email, MailboxRole } from "@passport/types";
import { encodeCursor, localId, ProviderError } from "./errors.js";
import {
  generatePreview,
  htmlToText,
  normalizeHeaders,
  normalizeMime,
  toIso,
} from "./normalize/index.js";
import { type PassportVerifier, verifyHeaders } from "./verification.js";

/**
 * Gmail message shapes and the MIME normalizer shared by `GmailMailProvider` (sync, getEmail)
 * and `GmailMailReader` (on-demand reads).
 */

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
export interface GmailLabel {
  id: string;
  name: string;
  type?: "system" | "user";
  messagesTotal?: number;
  messagesUnread?: number;
}

export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Gmail system label ids that correspond to a `MailboxRole`. */
export const GMAIL_LABEL_ROLES: Readonly<Record<string, MailboxRole>> = {
  INBOX: "inbox",
  SENT: "sent",
  DRAFT: "drafts",
  TRASH: "trash",
  SPAM: "junk",
  IMPORTANT: "important",
  ALL: "all",
};

export function flattenParts(part?: GmailPart): GmailPart[] {
  return part ? [part, ...(part.parts ?? []).flatMap(flattenParts)] : [];
}
/** True for parts `normalizeGmail` lists as attachments (everything but the text bodies). */
export function isAttachment(part: GmailPart): boolean {
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
    // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

    throw new ProviderError("INVALID_ENCODING", "Gmail returned an unsupported body charset");
  }
}

/** Text parts Gmail externalized behind an `attachmentId` (large bodies in `format=full`). */
export function externalizedTextParts(
  message: GmailMessage,
): Array<GmailPart & { body: { attachmentId: string } }> {
  return flattenParts(message.payload).filter(
    (part): part is GmailPart & { body: { attachmentId: string } } =>
      !isAttachment(part) &&
      typeof part.body?.attachmentId === "string" &&
      part.body.data === undefined,
  );
}

/**
 * Fills every externalized text body in place using `fetchData(attachmentId)` (the
 * `messages.attachments.get` payload). Throws `INVALID_RESPONSE` when Gmail omits one.
 */
export async function hydrateTextParts(
  message: GmailMessage,
  fetchData: (attachmentId: string) => Promise<{ data?: unknown }>,
): Promise<void> {
  for (const part of externalizedTextParts(message)) {
    const { data } = await fetchData(part.body.attachmentId);
    if (typeof data !== "string") {
      throw new ProviderError("INVALID_RESPONSE", "Gmail omitted a referenced text body");
    }
    part.body.data = data;
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
  if (!labels.includes("UNREAD")) {
    keywords.$seen = true;
  }
  if (labels.includes("STARRED")) {
    keywords.$flagged = true;
  }
  if (labels.includes("DRAFT")) {
    keywords.$draft = true;
  }
  if (labels.includes("SPAM")) {
    keywords.$junk = true;
  }
  for (const l of labels) {
    if (!GMAIL_LABEL_ROLES[l] && !["UNREAD", "STARRED"].includes(l)) {
      keywords[`label:${l}`] = true;
    }
  }
  const mailboxIds = labels.filter((l) => !["UNREAD", "STARRED"].includes(l));
  const receivedAt = toIso(message.internalDate ? Number(message.internalDate) : 0);
  if (message.raw) {
    return normalizeMime(Buffer.from(message.raw, "base64url"), {
      accountId,
      providerId: message.id,
      threadId: message.threadId,
      mailboxIds,
      keywords,
      receivedAt,
      verifier,
    });
  }
  const headers = normalizeHeaders(message.payload?.headers ?? []);
  // Gmail's full format still exposes RFC 5322 encoded words and address syntax in headers.
  const envelope = await normalizeMime(
    `${(message.payload?.headers ?? []).map((h) => `${h.name}: ${h.value}`).join("\r\n")}\r\n\r\n`,
    { accountId, providerId: message.id },
  );
  const parts = flattenParts(message.payload);
  const texts = parts.filter((p) => !isAttachment(p));
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
    attachments: gmailAttachments(message, accountId).map((entry) => entry.attachment),
    headers,
    size: message.sizeEstimate ?? 0,
    verification: await verifyHeaders(headers, verifier),
    personIds: [],
  };
}

/**
 * The attachment manifest of a `format=full` message, in MIME order, each with the part it came
 * from. `normalizeGmail` lists exactly these; `GmailMailReader.attachment` downloads them.
 */
export function gmailAttachments(
  message: GmailMessage,
  accountId: string,
): Array<{ attachment: Attachment; part: GmailPart }> {
  return flattenParts(message.payload)
    .filter(isAttachment)
    .map((p, i) => ({
      part: p,
      attachment: {
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
      },
    }));
}
