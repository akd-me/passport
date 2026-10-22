/**
 * Additive contract (v0.3): compact mail rows and opaque handles for on-demand reads.
 * Provider-derived strings in these shapes are untrusted. Re-exported from `./index.ts`.
 */

import type { Email, EmailAddress, Id, MailboxRole, Timestamp } from "./index.js";

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

/**
 * Builds the opaque, account-scoped handle used in `MailRow.id` / `MailRow.threadId`:
 * `${accountId}:${type}:${encodeURIComponent(providerId)}`. Identical to the adapter ids that
 * providers already assign to `Email.id` and `Email.threadId`.
 */
export function mailHandle(accountId: Id, type: "email" | "thread", providerId: string): string {
  return `${accountId}:${type}:${encodeURIComponent(providerId)}`;
}

/**
 * Inverse of `mailHandle`. Returns null for strings that are not handles (for example store
 * ULIDs). The account id may itself contain `:`; the provider id never does once encoded.
 */
export function parseMailHandle(
  handle: string,
): { accountId: Id; type: "email" | "thread"; providerId: string } | null {
  const last = handle.lastIndexOf(":");
  const middle = last > 0 ? handle.lastIndexOf(":", last - 1) : -1;
  if (middle <= 0) {
    return null;
  }
  const type = handle.slice(middle + 1, last);
  if (type !== "email" && type !== "thread") {
    return null;
  }
  try {
    return {
      accountId: handle.slice(0, middle),
      type,
      providerId: decodeURIComponent(handle.slice(last + 1)),
    };
  } catch {
    // A malformed percent-escape means the string is not a handle we issued.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rows and labels
// ---------------------------------------------------------------------------

/** Maximum `MailRow.snippet` length in characters. */
export const MAIL_ROW_SNIPPET_MAX = 160;
/** `MailRow.to` lists at most this many recipients, then one `"+N more"` entry. */
export const MAIL_ROW_MAX_RECIPIENTS = 3;

/**
 * Compact list/search row (about 300 bytes; 25 rows ≈ 3k tokens). All strings except `id`,
 * `threadId`, `account` and `date` are provider-derived and untrusted.
 */
export interface MailRow {
  /** Opaque Passport handle (`mailHandle(account, "email", providerId)`). */
  id: string;
  /** Opaque, account-scoped thread handle. Thread boundaries are provider-defined. */
  threadId: string;
  /** RFC 822 Message-ID including angle brackets; lets tools re-find a message after a move. */
  rfc822Id: string | null;
  /** Account id. */
  account: Id;
  /** ISO UTC (Gmail internalDate / Graph receivedDateTime / IMAP INTERNALDATE). */
  date: Timestamp;
  /** `"Name <addr>"`, or `"addr"` when there is no display name. One string, not an array. */
  from: string;
  /**
   * Recipients formatted like `from`: the first `MAIL_ROW_MAX_RECIPIENTS`, then a final
   * `"+N more"` entry when there are more (e.g. `["a <a@x>", "b@x", "c@x", "+4 more"]`).
   */
  to: string[];
  subject: string;
  /** Provider snippet / bodyPreview, at most `MAIL_ROW_SNIPPET_MAX` characters. */
  snippet: string;
  /** Display names. Gmail: label names. Graph: [folderName, ...categories]. IMAP: mailbox + keywords. */
  labels: string[];
  unread: boolean;
  flagged: boolean;
  /** Attachment count; names come from `MailReader.thread` / `body`. */
  attachments: number;
  /** The List-Id header, when present: a newsletter signal. */
  listId?: string;
  /** DMARC summary, present only when authentication headers were fetched. */
  auth?: "pass" | "fail" | "none";
}

/** A label, folder or category: `mail_labels` output. */
export interface MailLabel {
  /** Provider id (Gmail label id, Graph folder id or category name, IMAP mailbox path). */
  id: string;
  /** Display name (untrusted). */
  name: string;
  role?: MailboxRole;
  /** Provider id of the parent folder, for folder trees. */
  parentId?: string | null;
  /** Present only when counts were requested. */
  counts?: { total: number; unread: number };
}

/** An `Email` without bodies: what `MailReader.envelopes` returns and the envelope cache stores. */
export type MailEnvelope = Omit<Email, "textBody" | "htmlBody">;

/** Bodies and attachment manifest of one message. */
export type MailBody = Pick<Email, "textBody" | "htmlBody" | "attachments">;

/** Formats an address as `"Name <addr>"`, or `"addr"` without a usable name. */
export function formatMailAddress(address: EmailAddress): string {
  const name = address.name?.trim();
  return name && name !== address.email ? `${name} <${address.email}>` : address.email;
}

/** Applies the `MailRow.to` convention: first 3 formatted recipients, then `"+N more"`. */
export function compactRecipients(addresses: readonly EmailAddress[]): string[] {
  const shown = addresses.slice(0, MAIL_ROW_MAX_RECIPIENTS).map(formatMailAddress);
  const hidden = addresses.length - shown.length;
  return hidden > 0 ? [...shown, `+${hidden} more`] : shown;
}

/**
 * Projects a normalized envelope into a `MailRow`. `labelName` maps each `mailboxIds` entry to a
 * display name (return null to drop it). `auth` is derived from `verification.dmarc` and omitted
 * when the result is unknown (headers not fetched).
 */
export function toMailRow(
  email: MailEnvelope,
  labelName: (mailboxId: Id) => string | null = () => null,
): MailRow {
  const sender = email.from[0];
  const labels = email.mailboxIds
    .map((id) => labelName(id))
    .filter((name): name is string => name !== null);
  const dmarc = email.verification.dmarc;
  const row: MailRow = {
    id: email.id,
    threadId: email.threadId,
    rfc822Id: email.headers.messageId,
    account: email.accountId,
    date: email.receivedAt,
    from: sender ? formatMailAddress(sender) : "",
    to: compactRecipients([...email.to, ...email.cc]),
    subject: email.subject,
    snippet: email.preview.slice(0, MAIL_ROW_SNIPPET_MAX),
    labels,
    unread: !email.keywords.$seen,
    flagged: Boolean(email.keywords.$flagged),
    attachments: email.attachments.filter((a) => a.disposition !== "inline").length,
  };
  if (email.headers.listId) {
    row.listId = email.headers.listId;
  }
  if (dmarc !== "unknown") {
    row.auth = dmarc;
  }
  return row;
}
