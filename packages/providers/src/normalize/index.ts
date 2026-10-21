import type {
  Account,
  DraftInput,
  Email,
  EmailAddress,
  EmailHeaders,
  Keyword,
} from "@passport/types";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { localId, ProviderError } from "../errors.js";
import {
  type HeaderInput,
  headerValues,
  type PassportVerifier,
  verifyHeaders,
} from "../verification.js";

export function normalizeAddresses(
  value: string | EmailAddress[] | undefined | null,
): EmailAddress[] {
  if (Array.isArray(value)) {
    return value
      .map((a) => ({
        ...(a.name ? { name: a.name.trim() } : {}),
        email: a.email.trim().toLowerCase(),
      }))
      .filter((a) => a.email);
  }
  if (!value) {
    return [];
  }
  // Split on commas outside quoted display names and angle addresses (also tolerate address groups).
  const pieces = value.match(/(?:"(?:[^"\\]|\\.)*"|<[^>]*>|[^,])+/g) ?? [];
  return pieces.flatMap((piece) => {
    const match = /^(.*?)<([^>]+)>\s*;?$/.exec(piece.trim());
    const email = (match?.[2] ?? piece)
      .trim()
      .replace(/;$/, "")
      .replace(/^[^@<>]*:\s*/, "")
      .toLowerCase();
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(email)) {
      return [];
    }
    const name = match?.[1]
      ?.trim()
      .replace(/^"|"$/g, "")
      .replace(/\\"/g, '"')
      .replace(/^[^:]+:\s*/, "");
    return [{ email, ...(name ? { name } : {}) }];
  });
}

/** All timestamps cross the adapter boundary as ISO UTC. Invalid values fail explicitly. */
export function toIso(value: string | number | Date): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ProviderError("INVALID_DATE", "Provider returned an invalid timestamp");
  }
  return date.toISOString();
}

export function htmlToText(html: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<(br|hr)\b[^>]*\/?\s*>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, key: string) => {
      if (!key.startsWith("#")) {
        return entities[key.toLowerCase()] ?? whole;
      }
      const n =
        key[1]?.toLowerCase() === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function generatePreview(text: string, length = 200): string {
  return [...text.replace(/\s+/g, " ").trim()].slice(0, length).join("");
}

export function parseListUnsubscribe(
  value?: string | null,
  post?: string | null,
): { urls: string[]; emails: string[]; oneClick: boolean } {
  const links = [...(value ?? "").matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim());
  return {
    urls: links.filter((v) => /^https?:\/\//i.test(v)),
    emails: links.filter((v) => /^mailto:/i.test(v)).map((v) => v.slice(7)),
    oneClick: /(?:^|[;\s])List-Unsubscribe=One-Click(?:$|[;\s])/i.test(post ?? ""),
  };
}

export function normalizeHeaders(input: HeaderInput): EmailHeaders {
  const h = headerValues(input),
    get = (k: string) => h[k]?.join("\n") ?? null;
  return {
    messageId: get("message-id"),
    inReplyTo: get("in-reply-to"),
    references: get("references")?.match(/<[^>]+>/g) ?? [],
    listId: get("list-id"),
    listUnsubscribe: get("list-unsubscribe"),
    listUnsubscribePost: get("list-unsubscribe-post"),
    authenticationResults: h["authentication-results"] ?? [],
    extra: Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v.join("\n")])),
  };
}

export interface EmailContext {
  accountId: string;
  providerId: string;
  threadId?: string;
  mailboxIds?: string[];
  keywords?: Partial<Record<Keyword, boolean>>;
  receivedAt?: string;
  verifier?: PassportVerifier;
}

export async function normalizeMime(
  source: Uint8Array | string,
  context: EmailContext,
): Promise<Email> {
  const buffer = typeof source === "string" ? Buffer.from(source) : Buffer.from(source);
  const parsed = await simpleParser(buffer, { skipHtmlToText: true, skipTextToHtml: true });
  const headers = normalizeHeaders(
    parsed.headerLines.map((h) => ({
      name: h.key,
      value: h.line.slice(h.line.indexOf(":") + 1).trim(),
    })),
  );
  const addr = (v: typeof parsed.from) =>
    normalizeAddresses(
      v?.value.map((a) => ({ email: a.address ?? "", ...(a.name ? { name: a.name } : {}) })),
    );
  const many = (v: typeof parsed.to) => (Array.isArray(v) ? v.flatMap(addr) : addr(v));
  const html = typeof parsed.html === "string" ? parsed.html : null;
  const text = parsed.text ?? (html ? htmlToText(html) : "");
  return {
    id: localId(context.accountId, "email", context.providerId),
    accountId: context.accountId,
    providerId: context.providerId,
    threadId: localId(
      context.accountId,
      "thread",
      context.threadId ??
        headers.references[0] ??
        headers.inReplyTo ??
        headers.messageId ??
        context.providerId,
    ),
    mailboxIds: (context.mailboxIds ?? []).map((id) => localId(context.accountId, "mailbox", id)),
    keywords: context.keywords ?? {},
    from: addr(parsed.from),
    to: many(parsed.to),
    cc: many(parsed.cc),
    bcc: many(parsed.bcc),
    replyTo: addr(parsed.replyTo),
    subject: parsed.subject ?? "",
    sentAt: parsed.date ? toIso(parsed.date) : null,
    receivedAt: toIso(context.receivedAt ?? parsed.date ?? "1970-01-01T00:00:00Z"),
    preview: generatePreview(text),
    textBody: text,
    htmlBody: html,
    attachments: parsed.attachments.map((a, index) => ({
      id: localId(context.accountId, "attachment", `${context.providerId}:${index}`),
      name: a.filename ?? "attachment",
      type: a.contentType,
      size: a.size,
      blobId: `mime:${Buffer.from(JSON.stringify([context.providerId, index])).toString("base64url")}`,
      disposition: a.contentDisposition === "inline" ? "inline" : "attachment",
      cid: a.contentId ?? null,
    })),
    headers,
    size: buffer.length,
    verification: await verifyHeaders(headers, context.verifier),
    personIds: [],
  };
}

export async function mimeAttachment(
  source: Uint8Array,
  index: number,
): Promise<{ type: string; data: Uint8Array }> {
  const parsed = await simpleParser(Buffer.from(source));
  const a = parsed.attachments[index];
  if (!a) {
    throw new ProviderError("NOT_FOUND", "Attachment does not exist");
  }
  return { type: a.contentType, data: a.content };
}

export function decodeMimeBlob(blobId: string): [string, number] {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(blobId.replace(/^mime:/, ""), "base64url").toString(),
    );
    if (
      Array.isArray(value) &&
      typeof value[0] === "string" &&
      Number.isInteger(value[1]) &&
      value[1] >= 0
    ) {
      return [value[0], value[1]];
    }
  } catch {
    /* Report a safe, stable error below. */
  }
  throw new ProviderError("INVALID_BLOB_ID", "Invalid MIME blob handle");
}

export async function composeMime(
  account: Account,
  draft: DraftInput,
  getBlob: (id: string) => Promise<{ data: Uint8Array }>,
  reply?: Email | null,
): Promise<Buffer> {
  if (draft.accountId !== account.id) {
    throw new ProviderError("ACCOUNT_MISMATCH", "Draft belongs to a different account");
  }
  const attachments = await Promise.all(
    (draft.attachments ?? []).map(async (a) => ({
      filename: a.name,
      contentType: a.type,
      content: Buffer.from((await getBlob(a.blobId)).data),
    })),
  );
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "windows",
  });
  const message = await transport.sendMail({
    from: account.emailAddress,
    to: draft.to.map((a) => ({ name: a.name ?? "", address: a.email })),
    cc: draft.cc?.map((a) => ({ name: a.name ?? "", address: a.email })),
    bcc: draft.bcc?.map((a) => ({ name: a.name ?? "", address: a.email })),
    subject: draft.subject,
    text: draft.textBody,
    ...(draft.htmlBody ? { html: draft.htmlBody } : {}),
    attachments,
    ...(reply?.headers.messageId
      ? {
          inReplyTo: reply.headers.messageId,
          references: [...reply.headers.references, reply.headers.messageId].join(" "),
        }
      : {}),
  });
  if (!Buffer.isBuffer(message.message)) {
    throw new ProviderError("MIME_COMPOSE_FAILED", "MIME composer did not return a buffer");
  }
  return message.message;
}
