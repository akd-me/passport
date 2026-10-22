import type { Email, EmailAddress, ReadMeta } from "@passport/types";
import { compactRecipients, formatMailAddress, parseMailHandle } from "@passport/types";
import type { Context } from "./context.js";
import {
  MAIL_ID_KEYS,
  mailboxLabel,
  mergeMeta,
  neutralize,
  neutralizeDeep,
  onDemand,
  resolveMailTarget,
  safeMessageId,
  UNTRUSTED_NOTICE,
} from "./ondemand-support.js";
import { emailView, stripTrackingPixels, ToolError } from "./presentation.js";
import { collapseQuoted, htmlToText, stripQuoteMarkers } from "./quoted.js";
import { PROVIDER_READ } from "./reads-ondemand.js";
import { register } from "./register.js";
import { limitResponse } from "./response-budget.js";
import { schema as z } from "./schema.js";
import * as o from "./schemas-ondemand.js";
import type { ToolResult } from "./types.js";

/** Messages shown in full by default; earlier ones become one-line headers. */
export const FULL_MESSAGES = 5;
export const MAX_READ_LENGTH = 60_000;

export interface ReadInput {
  id: string;
  view: "thread" | "message";
  format: "text" | "html" | "headers";
  quoted: "collapse" | "full";
  offset: number;
  length: number;
  messagesFrom?: number;
}

/** Fetches a message (with body) or a whole thread through the account's reader. */
export async function loadMail(
  ctx: Context,
  id: string,
  view: "thread" | "message",
  format: "text" | "html" = "text",
): Promise<{ accountId: string; emails: Email[]; metas: ReadMeta[] }> {
  const target = await resolveMailTarget(ctx, id);
  const reader = await ctx.reader(target.accountId);
  if (view === "message") {
    const providerId = target.providerId;
    if (!providerId) {
      throw new ToolError("INVALID_INPUT", 'view:"message" needs a message id, not a thread id.');
    }
    const [envelopes, body] = await Promise.all([
      reader.envelopes([providerId]),
      reader.body(providerId),
    ]);
    const envelope = envelopes.value.get(providerId);
    if (!envelope) {
      throw new ToolError("NOT_FOUND", "Message, thread or label not found.");
    }
    return {
      accountId: target.accountId,
      emails: [{ ...envelope, ...body.value }],
      metas: [envelopes, body],
    };
  }
  const metas: ReadMeta[] = [];
  let threadPid = target.threadProviderId;
  if (!threadPid && target.providerId) {
    const envelopes = await reader.envelopes([target.providerId]);
    metas.push(envelopes);
    const envelope = envelopes.value.get(target.providerId);
    threadPid = envelope ? parseMailHandle(envelope.threadId)?.providerId : undefined;
  }
  if (!threadPid) {
    throw new ToolError("NOT_FOUND", "Message, thread or label not found.");
  }
  const thread = await reader.thread(threadPid, { format });
  return { accountId: target.accountId, emails: thread.value, metas: [...metas, thread] };
}

/** Plain text of a message with quoted history collapsed (or kept), sigils neutralised. */
export function messageText(email: Email, quoted: "collapse" | "full"): string {
  const raw = email.textBody ?? (email.htmlBody ? htmlToText(email.htmlBody) : "");
  return neutralize(quoted === "collapse" ? collapseQuoted(raw).text : stripQuoteMarkers(raw));
}

const people = (addresses: readonly EmailAddress[]) => compactRecipients(addresses).map(neutralize);

function messageHead(email: Email) {
  const v = email.verification;
  return {
    id: email.id,
    rfc822Id: safeMessageId(email.headers.messageId),
    date: email.receivedAt,
    from: neutralize(email.from[0] ? formatMailAddress(email.from[0]) : ""),
    to: people(email.to),
    cc: people(email.cc),
    subject: neutralize(email.subject),
    labels: email.mailboxIds.map((id) => neutralize(mailboxLabel(id))),
    unread: !email.keywords.$seen,
    flagged: Boolean(email.keywords.$flagged),
    auth: { dmarc: v.dmarc, dkim: v.dkim, spf: v.spf, passport: v.passport },
    // `index` and `attachmentId` are what mail_attachment_read accepts; inline parts (embedded
    // images) have no index and follow the attachments.
    attachments: [
      ...email.attachments
        .filter((attachment) => attachment.disposition !== "inline")
        .map((attachment, index) => ({
          index,
          attachmentId: attachment.id,
          name: neutralize(attachment.name),
          type: attachment.type,
          size: attachment.size,
        })),
      ...email.attachments
        .filter((attachment) => attachment.disposition === "inline")
        .map((attachment) => ({
          attachmentId: attachment.id,
          name: neutralize(attachment.name),
          type: attachment.type,
          size: attachment.size,
          inline: true,
        })),
    ],
    listUnsubscribe: Boolean(email.headers.listUnsubscribe),
  };
}

/**
 * A window that starts mid-line on an un-neutralised `/` or `@` would hand the agent a fresh
 * `/command` or `@mention`; such a window begins at the previous non-blank character instead
 * (at most 64 characters back). The window end, and so `continueFrom`, is unchanged.
 */
function contextStart(text: string, from: number): number {
  if (from <= 0 || !/^[/@\uFF0F\uFF20](?!\u200b)/.test(text.slice(from, from + 2))) {
    return from;
  }
  let start = from - 1;
  while (start > 0 && from - start < 64 && /[^\S\r\n]/.test(text[start] ?? "")) {
    start--;
  }
  return start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? "") ? start - 1 : start;
}

/** Avoids ending a window between the halves of a surrogate pair. */
function safeEnd(text: string, end: number): number {
  return end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")
    ? end - 1
    : end;
}

/**
 * Builds the `mail_read` result: chronological messages, the last five (or those from
 * `messagesFrom`) in full and earlier ones as one-line headers. `offset`/`length` window the
 * concatenated bodies of the full messages (UTF-16 units); continue with `continueFrom`.
 */
export function readMail(ctx: Context, input: ReadInput): Promise<ToolResult> {
  return onDemand(async () => {
    const { emails, metas } = await loadMail(
      ctx,
      input.id,
      input.view,
      input.format === "html" ? "html" : "text",
    );
    const fullFrom =
      input.messagesFrom !== undefined
        ? Math.min(input.messagesFrom, emails.length)
        : Math.max(0, emails.length - FULL_MESSAGES);
    const key = input.format === "html" ? "htmlBody" : "text";
    const bodies = emails
      .slice(fullFrom)
      .map((email) =>
        input.format === "headers"
          ? null
          : input.format === "html"
            ? neutralize(stripTrackingPixels(email.htmlBody ?? "") || (email.textBody ?? ""))
            : messageText(email, input.quoted),
      );
    const windowEnd = input.offset + input.length;
    let position = 0;
    const messages = emails.slice(fullFrom).map((email, index) => {
      const head: Record<string, unknown> = messageHead(email);
      const body = bodies[index];
      if (input.format === "headers") {
        head.headers = {
          inReplyTo: safeMessageId(email.headers.inReplyTo),
          references: email.headers.references.flatMap((id) => safeMessageId(id) ?? []),
          listId: email.headers.listId ? neutralize(email.headers.listId) : null,
          authenticationResults: (email.headers.authenticationResults ?? []).map(neutralize),
        };
        return head;
      }
      const text = body ?? "";
      const start = position;
      position += text.length;
      const from = Math.max(input.offset, start);
      const to = Math.min(windowEnd, position);
      if (from > to || (from === to && text.length > 0)) {
        head.omitted = true;
        return head;
      }
      const end = safeEnd(text, to - start);
      const begin = contextStart(text, from - start);
      head.offset = start + begin;
      head[key] = text.slice(begin, end);
      if (start + end < position) {
        head.truncated = true;
        head.continueFrom = start + end;
      }
      return head;
    });
    const first = emails[0];
    const participants = [
      ...new Map(
        emails
          .flatMap((email) => [...email.from, ...email.to, ...email.cc])
          .map((address) => [address.email.toLowerCase(), formatMailAddress(address)]),
      ).values(),
    ];
    const result: Record<string, unknown> = {
      ...(input.view === "thread" && first
        ? {
            thread: {
              id: first.threadId,
              subject: neutralize(first.subject),
              messageCount: emails.length,
              participants: participants.slice(0, 20).map(neutralize),
            },
          }
        : {}),
      ...(fullFrom > 0
        ? {
            earlier: emails.slice(0, fullFrom).map((email) => ({
              id: email.id,
              header: neutralize(
                `${email.receivedAt.slice(0, 16).replace("T", " ")} · ${email.from[0] ? formatMailAddress(email.from[0]) : ""} · ${email.subject}`,
              ),
            })),
            messagesFrom: fullFrom,
          }
        : {}),
      messages,
      truncated: false,
      continueFrom: null,
      nextPageToken: null,
      ...mergeMeta(metas),
      untrusted: UNTRUSTED_NOTICE,
    };
    const limited = limitResponse(result, ctx.deps.responseByteBudget) as Record<string, unknown>;
    const continues = (limited.messages as Array<Record<string, unknown>>)
      .map((message) => message.continueFrom)
      .filter((value): value is number => typeof value === "number");
    if (input.format !== "headers" && windowEnd < position) {
      continues.push(windowEnd);
    }
    limited.truncated = continues.length > 0;
    limited.continueFrom = continues.length ? Math.min(...continues) : null;
    return limited;
  });
}

/** `emailView` with every provider string neutralised (ids kept); the legacy summarize alias. */
export function safeEmailView(email: Email, full = false) {
  return neutralizeDeep(emailView(email, full), MAIL_ID_KEYS);
}

export function registerMailRead(ctx: Context) {
  register(
    ctx,
    "mail_read",
    'Read a thread (default) or one message as clean text. Quoted history is collapsed (quoted:"full" expands it). Long threads show the last 5 messages in full and earlier ones as one-line headers; messagesFrom picks the first full message. offset/length window the bodies; continue with continueFrom. Lists attachments. Gmail: ~120 units per thread, ~80 per message (envelope + body).',
    {
      id: o.handle,
      view: z.enum(["thread", "message"]).default("thread"),
      format: z.enum(["text", "html", "headers"]).default("text"),
      quoted: z.enum(["collapse", "full"]).default("collapse"),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      length: z.number().int().min(1).max(MAX_READ_LENGTH).default(16_000),
      messagesFrom: z.number().int().min(0).max(10_000).optional(),
    },
    false,
    async (input, call) => readMail(call, input),
    PROVIDER_READ,
  );
}
