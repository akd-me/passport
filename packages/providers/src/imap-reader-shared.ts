import type { Email, MailboxRole } from "@passport/types";
import type { FetchMessageObject } from "imapflow";
import { decodeCursor, encodeCursor, ProviderError } from "./errors.js";
import { normalizeMime } from "./normalize/index.js";
import type { PassportVerifier } from "./verification.js";

/**
 * Code shared by the IMAP sync adapter (`imap.ts`) and the on-demand reader (`imap-reader.ts`):
 * message identities, flag mapping, SPECIAL-USE roles and MIME normalization.
 */

/** SPECIAL-USE attribute (RFC 6154) to mailbox role. imapflow reports INBOX as `\Inbox`. */
export const imapRoles: Record<string, MailboxRole> = {
  "\\Inbox": "inbox",
  "\\Archive": "archive",
  "\\Drafts": "drafts",
  "\\Sent": "sent",
  "\\Trash": "trash",
  "\\Junk": "junk",
  "\\All": "all",
  "\\Flagged": "important",
};

/** Role of a listed mailbox: its SPECIAL-USE attribute, or `inbox` for the INBOX path. */
export function imapRole(folder: { path: string; specialUse?: string | undefined }): MailboxRole {
  return (
    imapRoles[folder.specialUse ?? ""] ?? (folder.path.toUpperCase() === "INBOX" ? "inbox" : null)
  );
}

/** JMAP keyword to IMAP flag. */
export const imapFlagMap: Record<string, string> = {
  $seen: "\\Seen",
  $flagged: "\\Flagged",
  $draft: "\\Draft",
  $answered: "\\Answered",
  $forwarded: "$Forwarded",
  $junk: "$Junk",
  $notjunk: "$NotJunk",
};

export function imapFlagsToKeywords(flags: Iterable<string>): Email["keywords"] {
  const reverse = Object.fromEntries(
    Object.entries(imapFlagMap).map(([k, v]) => [v.toLowerCase(), k]),
  );
  const result: Email["keywords"] = {};
  for (const flag of flags) {
    if (flag !== "\\Deleted" && flag !== "\\Recent") {
      result[reverse[flag.toLowerCase()] ?? flag] = true;
    }
  }
  return result;
}

/** IMAP provider id: mailbox path + UIDVALIDITY + UID. Changes whenever a message moves. */
export function imapIdentity(path: string, validity: string, uid: number): string {
  return `imap:${encodeCursor([path, validity, uid])}`;
}

export function parseImapIdentity(providerId: string): [string, string, number] {
  if (!providerId.startsWith("imap:")) {
    throw new ProviderError("INVALID_PROVIDER_ID", "Invalid IMAP message identity");
  }
  const v = decodeCursor<unknown>(providerId.slice(5));
  if (
    !Array.isArray(v) ||
    typeof v[0] !== "string" ||
    typeof v[1] !== "string" ||
    !Number.isInteger(v[2]) ||
    v[2] < 1
  ) {
    throw new ProviderError("INVALID_PROVIDER_ID", "Invalid IMAP UID identity");
  }
  return v as [string, string, number];
}

/** Thread provider ids backed by a server thread id (OBJECTID `THREADID` or Gmail `X-GM-THRID`). */
export const SERVER_THREAD_PREFIX = "thrid:";

/**
 * Thread provider id for a message: the server thread id when the server has one, otherwise the
 * root of the References chain (the same rule `normalizeMime` applies), otherwise the message.
 */
export function imapThreadKey(
  serverThreadId: string | undefined,
  headers: { references: string[]; inReplyTo: string | null; messageId: string | null },
  providerId: string,
): string {
  if (serverThreadId) {
    return `${SERVER_THREAD_PREFIX}${serverThreadId}`;
  }
  return headers.references[0] ?? headers.inReplyTo ?? headers.messageId ?? providerId;
}

/** Normalizes a fetched message with its full source into an `Email`. */
export async function normalizeImapSource(
  message: FetchMessageObject,
  context: {
    accountId: string;
    path: string;
    validity: string;
    verifier?: PassportVerifier | undefined;
    /** Server thread id (`FETCH THREADID` / `X-GM-THRID`); without it threads key on References. */
    serverThreadId?: string | undefined;
  },
): Promise<Email> {
  if (!message.source) {
    throw new ProviderError("INVALID_RESPONSE", "IMAP FETCH did not return message source");
  }
  return normalizeMime(message.source, {
    accountId: context.accountId,
    providerId: imapIdentity(context.path, context.validity, message.uid),
    ...(context.serverThreadId
      ? { threadId: `${SERVER_THREAD_PREFIX}${context.serverThreadId}` }
      : {}),
    mailboxIds: [context.path],
    keywords: imapFlagsToKeywords(message.flags ?? []),
    receivedAt: message.internalDate ? new Date(message.internalDate).toISOString() : undefined,
    verifier: context.verifier,
  });
}
