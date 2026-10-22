import type { Attachment, EmailAddress, MailEnvelope, MailRow } from "@passport/types";
import { toMailRow } from "@passport/types";
import type { FetchMessageObject, FetchQueryObject, MessageStructureObject } from "imapflow";
import { localId } from "./errors.js";
import {
  imapFlagsToKeywords,
  imapIdentity,
  imapThreadKey,
  normalizeImapSource,
} from "./imap-reader-shared.js";
import type { ImapExtension } from "./imap-reader-support.js";
import { normalizeAddresses, normalizeHeaders, toIso } from "./normalize/index.js";
import type { MatchableEmail } from "./query-match.js";
import { type PassportVerifier, verifyHeaders } from "./verification.js";

/** Header fields fetched with every row (`BODY.PEEK[HEADER.FIELDS (…)]`). */
export const IMAP_ROW_HEADERS = [
  "list-id",
  "list-unsubscribe",
  "message-id",
  "in-reply-to",
  "references",
  "authentication-results",
];

/** Bytes of the body fetched per candidate when a local filter has to match body text. */
export const IMAP_GREP_BYTES = 65_536;
/** Extra header fields fetched for grep, so the body prefix can be MIME-decoded. */
const GREP_HEADERS = ["content-type", "content-transfer-encoding", "mime-version"];

/**
 * `UID FETCH (UID ENVELOPE FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS
 * (…)])`, plus the server thread id / Gmail labels when available. Grep adds the MIME framing
 * headers and `BODY.PEEK[TEXT]<0.65536>`: a bounded body prefix, never the whole message (R1-9).
 */
export function imapRowQuery(ext: ReadonlySet<ImapExtension>, grep = false): FetchQueryObject {
  return {
    uid: true,
    envelope: true,
    flags: true,
    internalDate: true,
    size: true,
    bodyStructure: true,
    headers: grep ? [...IMAP_ROW_HEADERS, ...GREP_HEADERS] : IMAP_ROW_HEADERS,
    ...(ext.has("OBJECTID") || ext.has("X-GM-EXT-1") ? { threadId: true } : {}),
    ...(ext.has("X-GM-EXT-1") ? { labels: true } : {}),
    ...(grep ? { bodyParts: [{ key: "TEXT", maxLength: IMAP_GREP_BYTES }] } : {}),
  };
}

/** Parses a raw header block (`HEADER.FIELDS` response) into name/value pairs. */
export function parseHeaderBlock(
  block: Buffer | undefined,
): Array<{ name: string; value: string }> {
  if (!block) {
    return [];
  }
  return block
    .toString("utf8")
    .replace(/\r?\n[ \t]+/g, " ")
    .split(/\r?\n/)
    .flatMap((line) => {
      const colon = line.indexOf(":");
      return colon > 0
        ? [{ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() }]
        : [];
    });
}

function addresses(list: Array<{ name?: string; address?: string }> | undefined): EmailAddress[] {
  return normalizeAddresses(
    (list ?? []).map((a) => ({ email: a.address ?? "", ...(a.name ? { name: a.name } : {}) })),
  );
}

/** Attachment manifest from BODYSTRUCTURE, in the depth-first order `normalizeMime` uses. */
export function structureAttachments(
  root: MessageStructureObject | undefined,
  accountId: string,
  providerId: string,
): Attachment[] {
  const found: Attachment[] = [];
  const walk = (node: MessageStructureObject) => {
    if (node.childNodes?.length) {
      node.childNodes.forEach(walk);
      return;
    }
    const type = (node.type ?? "").toLowerCase();
    const name = node.dispositionParameters?.filename ?? node.parameters?.name;
    const isBody =
      (type === "text/plain" || type === "text/html") && node.disposition !== "attachment";
    if (isBody || type.startsWith("multipart/")) {
      return;
    }
    const index = found.length;
    found.push({
      id: localId(accountId, "attachment", `${providerId}:${index}`),
      name: name ?? "attachment",
      type,
      size: node.size ?? 0,
      blobId: `mime:${Buffer.from(JSON.stringify([providerId, index])).toString("base64url")}`,
      disposition: node.disposition === "inline" ? "inline" : "attachment",
      cid: node.id ?? null,
    });
  };
  if (root) {
    walk(root);
  }
  return found;
}

function safeIso(value: Date | string | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** A hydrated row: the envelope (with grep text when fetched), its row, and its mailbox. */
export interface ImapRowRecord {
  uid: number;
  path: string;
  envelope: MatchableEmail;
  row: MailRow;
}

/** Builds the envelope and compact row for one fetched message. */
export async function imapRecord(
  message: FetchMessageObject,
  context: {
    accountId: string;
    path: string;
    /** Display name for the row's `labels`. */
    mailboxName: string;
    validity: string;
    verifier?: PassportVerifier | undefined;
  },
): Promise<ImapRowRecord> {
  const { accountId, path, validity } = context;
  const envelope = message.envelope ?? {};
  const providerId = imapIdentity(path, validity, message.uid);
  const headers = normalizeHeaders(parseHeaderBlock(message.headers));
  headers.messageId ??= envelope.messageId ?? null;
  headers.inReplyTo ??= envelope.inReplyTo ?? null;
  let textBody: string | null = null;
  let preview = "";
  const text = [...(message.bodyParts ?? [])].find(([key]) => /^text/i.test(key))?.[1];
  if (text) {
    // Header fields + a truncated body still parse; text past IMAP_GREP_BYTES is not matched.
    const head = message.headers ?? Buffer.alloc(0);
    const gap = head.toString("latin1").endsWith("\r\n\r\n") ? "" : "\r\n";
    const source = Buffer.concat([head, Buffer.from(gap), text]);
    const parsed = await normalizeImapSource({ ...message, source }, { accountId, path, validity });
    textBody = parsed.textBody ?? null;
    preview = parsed.preview;
  }
  const email: MailEnvelope & { textBody: string | null } = {
    id: localId(accountId, "email", providerId),
    accountId,
    providerId,
    threadId: localId(accountId, "thread", imapThreadKey(message.threadId, headers, providerId)),
    mailboxIds: [localId(accountId, "mailbox", path)],
    keywords: imapFlagsToKeywords(message.flags ?? []),
    from: addresses(envelope.from),
    to: addresses(envelope.to),
    cc: addresses(envelope.cc),
    bcc: addresses(envelope.bcc),
    replyTo: addresses(envelope.replyTo),
    subject: envelope.subject ?? "",
    sentAt: safeIso(envelope.date),
    receivedAt: safeIso(message.internalDate) ?? safeIso(envelope.date) ?? toIso(0),
    preview,
    attachments: structureAttachments(message.bodyStructure, accountId, providerId),
    headers,
    size: message.size ?? 0,
    verification: await verifyHeaders(headers, context.verifier),
    personIds: [],
    textBody,
  };
  const row = toMailRow(email, () => context.mailboxName);
  // Keywords that are not system flags, and Gmail labels, read like labels to an agent.
  const extra = [
    ...[...(message.labels ?? [])].map((l) => l.replace(/^\\/, "")),
    ...Object.keys(email.keywords).filter((k) => !k.startsWith("$") && !k.startsWith("\\")),
  ];
  row.labels = [...new Set([...row.labels, ...extra])];
  return { uid: message.uid, path, envelope: email, row };
}

/** Strips grep text before an envelope leaves the reader. */
export function withoutText(email: MatchableEmail): MailEnvelope {
  const { textBody: _text, ...envelope } = email;
  return envelope;
}
