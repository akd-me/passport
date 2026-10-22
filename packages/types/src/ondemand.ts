/**
 * Additive contract (v0.3): on-demand mail. Agents read the mailbox through the provider's own
 * index instead of a local mirror. See `docs/design/on-demand.md` and `docs/CONTRACT.md`
 * ("Additive contract: on-demand mail (v0.3)").
 *
 * Conventions shared by every type in this file:
 *  - Provider-derived strings (subjects, snippets, names, label names, bodies) are UNTRUSTED data.
 *    Consumers wrap them before they reach a prompt or a tool result.
 *  - Every provider read declares its quota cost and goes through the per-account governor
 *    (`QuotaGovernor` in `@passport/providers`). Results always carry `cost`.
 *  - Passport never backfills. `MailReader.changes(null, …)` starts at "now".
 *
 * Re-exported from `./index.ts`; import from the package root only.
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

// ---------------------------------------------------------------------------
// Cost and results
// ---------------------------------------------------------------------------

/** Quota spent by one read, plus the account's remaining budget. Absent fields mean "not used". */
export interface ReadCost {
  /** Gmail quota units (see `GMAIL_UNIT_COSTS` in `@passport/providers`). */
  gmailUnits?: number;
  /** Microsoft Graph HTTP requests (a `$batch` counts each inner request). */
  graphRequests?: number;
  /** IMAP commands issued. */
  imapCommands?: number;
  /** Governor budget left for this account after the read (provider units / requests). */
  budgetRemaining?: number;
  /** When the budget is fully refilled (or a provider block lifts), ISO UTC. */
  windowResetsAt?: Timestamp;
}

/** Where a result came from. `mixed` = some rows from the envelope cache, some from the provider. */
export type ReadSource = "provider" | "cache" | "mixed";

/** Metadata every `MailReader` result carries. */
export interface ReadMeta {
  source: ReadSource;
  /** Set when rows were served from cache while offline or throttled. */
  staleAsOf?: Timestamp;
  cost: ReadCost;
  /**
   * How a portable query was translated, when it was not a pass-through, e.g.
   * `"graph:$search+clientFilter"` or `"imap:SEARCH+localGrep"`. Shown to agents verbatim.
   */
  translation?: string;
}

/**
 * Paged collection result: `search`, `list`, `labels`. `nextPageToken` is opaque and encodes the
 * provider token, query and account; passing it with a different query is an error.
 */
export interface ReadResult<T> extends ReadMeta {
  items: T[];
  nextPageToken?: string;
  /** Provider estimate (Gmail resultSizeEstimate, Graph @odata.count). Label it approximate. */
  approxTotal?: number;
}

/** Single-value result: every other `MailReader` method. */
export interface ReadValue<T> extends ReadMeta {
  value: T;
}

// ---------------------------------------------------------------------------
// Reader inputs
// ---------------------------------------------------------------------------

/**
 * Quota priority lanes, highest first. Interactive tool calls never block on long backoff;
 * `arrivals` is new-mail triage; `background` is warm-up / optional deep index.
 */
export type QuotaLane = "interactive" | "arrivals" | "background";

/** Options accepted by every `MailReader` method. */
export interface MailReadOptions {
  /** Governor lane. Defaults to `"interactive"`. */
  lane?: QuotaLane;
  signal?: AbortSignal;
}

/** `mail_search` input. Exactly one of `query` (portable) or `rawQuery` (provider-native). */
export interface MailSearchInput {
  /** Portable query (`parsePortableQuery` in `@passport/providers`). */
  query?: string;
  /** Provider-native query passed through untranslated (Gmail `q`, KQL, IMAP criteria). */
  rawQuery?: string;
  /** Label / folder provider id, display name, or role (`"inbox"`). Omitted = all mail. */
  container?: string;
  /** Rows per page, 1–100. Tools default to 25. */
  limit: number;
  pageToken?: string;
  /** Include Spam and Trash. Default false (an explicit `in:spam` / `in:trash` still works). */
  includeSpamTrash?: boolean;
  /** One row per thread (the newest matching message). */
  threads?: boolean;
}

/** `mail_list` structural filters. Never touches bodies; every backend can apply them. */
export interface MailListFilter {
  /** Sender address or name substring. */
  from?: string;
  /** Sender domain, e.g. `"example.com"` (subdomains match). */
  fromDomain?: string;
  unread?: boolean;
  flagged?: boolean;
  hasAttachment?: boolean;
  /** Inclusive lower bound on the received date, ISO date or timestamp. */
  after?: Timestamp;
  /** Exclusive upper bound on the received date, ISO date or timestamp. */
  before?: Timestamp;
  /** Minimum size in bytes. */
  largerThan?: number;
}

/** `countIds` options. */
export interface MailCountOptions extends MailReadOptions {
  /** Treat the query as provider-native (`rawQuery`) instead of portable. */
  raw?: boolean;
  includeSpamTrash?: boolean;
}

/** Provider ids changed since a cursor: `mail_changes` and the watcher. */
export interface MailChanges {
  /** Provider ids of messages that arrived. */
  added: string[];
  /** Provider ids whose labels, flags or folder changed. */
  labelChanged: string[];
  /** Provider ids that were deleted (or left every watched folder). */
  deleted: string[];
  /** Cursor to pass next time. Persist it only after the changes were handled. */
  cursor: string;
  /** More changes are pending; call again immediately with `cursor`. */
  hasMore?: boolean;
  /**
   * The supplied cursor was too old for the provider (Gmail history 404, Graph delta 410).
   * The id lists are empty and `cursor` starts at "now". Callers mark cached labels stale and
   * sweep recent inbox mail; they never resync.
   */
  expired?: boolean;
}

/**
 * On-demand read access to one connected account. Obtain it from `MailProvider.reader()`.
 *
 * Every method returns cost information: paged collections return `ReadResult<T>`, everything
 * else returns `ReadValue<T>`; both extend `ReadMeta` (`source`, `cost`, `staleAsOf?`,
 * `translation?`). Every call acquires quota from the per-account governor in the given lane.
 *
 * Errors are `ProviderError`s with stable codes from `MAIL_READ_ERROR_CODES` (and the existing
 * provider codes). An interactive-lane call that would wait more than ~5 s throws
 * `RATE_LIMITED` carrying `retryAfterSeconds` and `scope` rather than blocking.
 */
export interface MailReader {
  /** Server-side search, newest first. */
  search(input: MailSearchInput, opts?: MailReadOptions): Promise<ReadResult<MailRow>>;
  /**
   * Newest-first listing of one container with structural filters only.
   * `container` null = all mail except Spam/Trash.
   */
  list(
    container: string | null,
    filter: MailListFilter,
    limit: number,
    pageToken?: string,
    opts?: MailReadOptions,
  ): Promise<ReadResult<MailRow>>;
  /** Label / folder tree. `counts` costs extra (Gmail: one `labels.get` per label). */
  labels(counts?: boolean, opts?: MailReadOptions): Promise<ReadResult<MailLabel>>;
  /** Envelopes by provider id; `null` for ids the provider no longer has. Bodies omitted. */
  envelopes(
    providerIds: string[],
    opts?: MailReadOptions,
  ): Promise<ReadValue<Map<string, MailEnvelope | null>>>;
  /**
   * All messages of a thread, chronological, with bodies. `format: "text"` returns `htmlBody`
   * null; `"html"` returns both. Throws `NOT_FOUND` for an unknown thread.
   */
  thread(
    threadProviderId: string,
    opts: { format: "text" | "html" } & MailReadOptions,
  ): Promise<ReadValue<Email[]>>;
  /** Bodies and attachment manifest. Throws `NOT_FOUND` (or `STALE_ID`) for unknown ids. */
  body(providerId: string, opts?: MailReadOptions): Promise<ReadValue<MailBody>>;
  /** Exact count of matching ids up to `cap` (portable query unless `opts.raw`). */
  countIds(
    query: string,
    cap: number,
    opts?: MailCountOptions,
  ): Promise<ReadValue<{ count: number; capped: boolean }>>;
  /**
   * Changes since `cursor`, at most `limit` ids in total. `null` returns no changes and a
   * cursor at "now" (never a backfill).
   */
  changes(
    cursor: string | null,
    limit: number,
    opts?: MailReadOptions,
  ): Promise<ReadValue<MailChanges>>;
  /** Re-finds a message by RFC 822 Message-ID. Returns its provider id, or null. */
  findByRfc822(rfc822Id: string, opts?: MailReadOptions): Promise<ReadValue<string | null>>;
}

// ---------------------------------------------------------------------------
// Errors and structured tool results
// ---------------------------------------------------------------------------

/** Stable error codes for on-demand reads (also used as `ProviderError.code`). */
export const MAIL_READ_ERROR_CODES = {
  /** Quota exhausted or the governor would block an interactive call for too long. */
  RATE_LIMITED: "RATE_LIMITED",
  /** The requested shape would spend more quota than allowed without `confirmCost`. */
  WOULD_EXCEED_BUDGET: "WOULD_EXCEED_BUDGET",
  /** The handle no longer resolves (moved / id changed); a candidate may be offered. */
  STALE_ID: "STALE_ID",
  /** The message, thread or label does not exist. */
  NOT_FOUND: "NOT_FOUND",
} as const;

export type MailReadErrorCode = (typeof MAIL_READ_ERROR_CODES)[keyof typeof MAIL_READ_ERROR_CODES];

/**
 * Which limit was hit. Known values: `"gmail:user-quota"`, `"graph:mailbox"`,
 * `"imap:connection"`, `"jmap:session"`, `"passport:governor"`, `"provider:http"`.
 */
export type RateLimitScope =
  | "gmail:user-quota"
  | "graph:mailbox"
  | "imap:connection"
  | "jmap:session"
  | "passport:governor"
  | "provider:http"
  | (string & {});

/** Non-fatal tool result returned instead of blocking when quota runs out (research §5.1). */
export interface RateLimitedResult<T = MailRow> {
  isError: true;
  error: "RATE_LIMITED";
  retryAfterSeconds: number;
  scope: RateLimitScope;
  /** Rows already fetched or served from cache. */
  partial?: { items: T[]; source: ReadSource };
  hint: string;
}

/** Returned for expensive shapes unless the caller passes `confirmCost: true`. */
export interface WouldExceedBudgetResult {
  isError: true;
  error: "WOULD_EXCEED_BUDGET";
  /** Estimated provider units / requests. */
  estimatedUnits: number;
  hint: string;
}

/** Builds a `RateLimitedResult` with the standard hint. */
export function rateLimitedResult<T = MailRow>(input: {
  retryAfterSeconds: number;
  scope: RateLimitScope;
  partial?: { items: T[]; source: ReadSource };
  hint?: string;
}): RateLimitedResult<T> {
  const seconds = Math.max(0, Math.ceil(input.retryAfterSeconds));
  const result: RateLimitedResult<T> = {
    isError: true,
    error: "RATE_LIMITED",
    retryAfterSeconds: seconds,
    scope: input.scope,
    hint:
      input.hint ??
      `Quota for this account resets in ~${seconds}s. Narrow the query, lower limit, or use rows already returned.`,
  };
  if (input.partial) {
    result.partial = input.partial;
  }
  return result;
}
