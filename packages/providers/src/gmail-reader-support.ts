import type { Email, MailEnvelope, MailRow, QuotaLane, ReadCost } from "@passport/types";
import { toMailRow } from "@passport/types";
import { decodeCursor, encodeCursor, ProviderError } from "./errors.js";
import { GMAIL_API_BASE } from "./gmail-reader-normalize.js";
import type { RequestPolicy } from "./http.js";
import type { QuotaGovernor } from "./quota.js";
import type { ThrottleSignal } from "./quota-presets.js";
import type { PassportVerifier } from "./verification.js";

/** What `GmailMailReader` needs from the connected `GmailMailProvider`. */
export interface GmailTransport {
  /** The connected account id; throws `NOT_CONNECTED` otherwise. */
  accountId(): string;
  /** Governed JSON request (`HttpConnection.json`). */
  json<T>(url: string, init: RequestInit, policy: RequestPolicy): Promise<T>;
  /** Governed raw request (`HttpConnection.http`), used for the multipart batch endpoint. */
  http(url: string, init: RequestInit, policy: RequestPolicy): Promise<Response>;
  /** Forwards a throttling signal seen inside a batch response to the governor. */
  report(signal: ThrottleSignal): void;
  verifier?: PassportVerifier;
  governor?: QuotaGovernor;
}

/** Headers requested with `format=metadata`: row fields, threading and DMARC. */
export const GMAIL_METADATA_HEADERS = [
  "From",
  "To",
  "Cc",
  "Subject",
  "Date",
  "Message-ID",
  "List-Id",
  "List-Unsubscribe",
  "In-Reply-To",
  "References",
  "Authentication-Results",
  "ARC-Authentication-Results",
] as const;

/** `format=metadata&metadataHeaders=…` query string. */
export function metadataParams(): string {
  const params = new URLSearchParams({ format: "metadata" });
  for (const header of GMAIL_METADATA_HEADERS) {
    params.append("metadataHeaders", header);
  }
  return params.toString();
}

export const isNotFound = (e: unknown): boolean => e instanceof ProviderError && e.status === 404;

/**
 * One reader call: issues governed requests in the call's lane, sums the units it declared and
 * produces the `ReadMeta` for the result.
 */
export class GmailCall {
  units = 0;
  constructor(
    private readonly transport: GmailTransport,
    readonly lane: QuotaLane,
    private readonly signal?: AbortSignal,
  ) {}

  /** GET `users/me/<path>` as JSON, declaring `cost` units. */
  async get<T>(path: string, cost: number): Promise<T> {
    return this.transport.json<T>(`${GMAIL_API_BASE}/${path}`, this.init({}), this.policy(cost));
  }

  /** Any governed request (batch endpoint, batchModify) declaring `cost` units. */
  async send(url: string, init: RequestInit, cost: number): Promise<Response> {
    return this.transport.http(url, this.init(init), this.policy(cost));
  }

  report(signal: ThrottleSignal): void {
    this.transport.report(signal);
  }

  meta(): { source: "provider"; cost: ReadCost } {
    const snapshot = this.transport.governor?.snapshot(this.transport.accountId());
    return { source: "provider", cost: { gmailUnits: this.units, ...snapshot } };
  }

  private policy(cost: number): RequestPolicy {
    if (this.signal?.aborted) {
      throw new ProviderError("ABORTED", "The read was cancelled");
    }
    this.units += cost;
    return { lane: this.lane, cost };
  }

  private init(init: RequestInit): RequestInit {
    // Keep the transport's 30 s timeout when the caller also supplies a cancellation signal.
    return this.signal
      ? { ...init, signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]) }
      : init;
  }
}

// ---------------------------------------------------------------------------
// Page tokens and change cursors
// ---------------------------------------------------------------------------

interface PageCursor {
  account: string;
  kind: "search" | "list";
  key: string;
  token: string;
}

/** Wraps a Gmail `nextPageToken` so it only resumes the same query on the same account. */
export function encodePageToken(
  account: string,
  kind: PageCursor["kind"],
  key: string,
  token: string | undefined,
): string | undefined {
  return token ? encodeCursor({ account, kind, key, token } satisfies PageCursor) : undefined;
}

/** Inverse of `encodePageToken`; throws `INVALID_CURSOR` for a token from another query. */
export function decodePageToken(
  account: string,
  kind: PageCursor["kind"],
  key: string,
  pageToken: string | undefined,
): string | undefined {
  if (!pageToken) {
    return undefined;
  }
  const c = decodeCursor<PageCursor>(pageToken);
  if (c.account !== account || c.kind !== kind || c.key !== key || typeof c.token !== "string") {
    throw new ProviderError("INVALID_CURSOR", "Page token belongs to a different query");
  }
  return c.token;
}

interface ChangeCursor {
  account: string;
  kind: "changes";
  historyId: string;
}

export function encodeChangeCursor(account: string, historyId: string): string {
  return encodeCursor({ account, kind: "changes", historyId } satisfies ChangeCursor);
}

/** Accepts reader cursors and bare Gmail history ids (the v0.2 sync cursor format). */
export function decodeChangeCursor(account: string, cursor: string): string {
  if (/^\d+$/.test(cursor)) {
    return cursor;
  }
  const c = decodeCursor<ChangeCursor>(cursor);
  if (c.account !== account || c.kind !== "changes" || !/^\d+$/.test(String(c.historyId))) {
    throw new ProviderError("INVALID_CURSOR", "Change cursor does not belong to this mailbox");
  }
  return c.historyId;
}

/** Projects an envelope to a row, naming labels from `names` (system ids name themselves). */
export function gmailRow(
  email: MailEnvelope | Email,
  names: ReadonlyMap<string, string>,
  mimeType: string | undefined,
): MailRow {
  const prefix = `${email.accountId}:mailbox:`;
  const row = toMailRow(email, (mailboxId) => {
    if (!mailboxId.startsWith(prefix)) {
      return null;
    }
    const id = decodeURIComponent(mailboxId.slice(prefix.length));
    return names.get(id) ?? id;
  });
  // `format=metadata` has no MIME tree; multipart/mixed is the usual attachment signal.
  if (row.attachments === 0 && mimeType?.toLowerCase() === "multipart/mixed") {
    row.attachments = 1;
  }
  return row;
}

export function withoutBodies(email: Email): MailEnvelope {
  const { textBody: _text, htmlBody: _html, ...envelope } = email;
  return envelope;
}
