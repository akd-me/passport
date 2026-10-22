import type { Email, MailEnvelope, MailRow, QuotaLane, ReadCost } from "@passport/types";
import { toMailRow } from "@passport/types";
import { decodeCursor, encodeCursor, ProviderError, RateLimitedError } from "./errors.js";
import { GMAIL_API_BASE } from "./gmail-reader-normalize.js";
import type { RequestPolicy } from "./http.js";
import { type WaitBudget, waitBudget } from "./http-request.js";
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
  /** Queue and backoff time left for the whole call (interactive lane only). */
  readonly budget: WaitBudget | undefined;
  constructor(
    private readonly transport: GmailTransport,
    readonly lane: QuotaLane,
    private readonly signal?: AbortSignal,
  ) {
    this.budget = waitBudget(lane);
  }

  /** GET `users/me/<path>` as JSON, declaring `cost` units. */
  async get<T>(path: string, cost: number): Promise<T> {
    return this.counted(cost, () =>
      this.transport.json<T>(`${GMAIL_API_BASE}/${path}`, this.init({}), this.policy(cost)),
    );
  }

  /** Any governed request (batch endpoint, batchModify) declaring `cost` units. */
  async send(
    url: string,
    init: RequestInit,
    cost: number,
    extra: Pick<RequestPolicy, "idempotent"> = {},
  ): Promise<Response> {
    return this.counted(cost, () =>
      this.transport.http(url, this.init(init), { ...this.policy(cost), ...extra }),
    );
  }

  /** Takes back reported units for batch parts that were throttled and not served. */
  uncount(units: number): void {
    this.units = Math.max(0, this.units - units);
  }

  report(signal: ThrottleSignal): void {
    this.transport.report(signal);
  }

  meta(): { source: "provider"; cost: ReadCost } {
    const snapshot = this.transport.governor?.snapshot(this.transport.accountId());
    return { source: "provider", cost: { gmailUnits: this.units, ...snapshot } };
  }

  /** Runs a request; units refused by the governor or a still-throttled provider are not spent. */
  private async counted<T>(cost: number, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof RateLimitedError) {
        this.uncount(cost);
      }
      throw e;
    }
  }

  private policy(cost: number): RequestPolicy {
    if (this.signal?.aborted) {
      throw new ProviderError("ABORTED", "The read was cancelled");
    }
    this.units += cost;
    return { lane: this.lane, cost, ...(this.budget ? { budget: this.budget } : {}) };
  }

  private init(init: RequestInit): RequestInit {
    // The transport adds its per-attempt network timeout after the quota wait (R1-8).
    return this.signal ? { ...init, signal: this.signal } : init;
  }
}

// ---------------------------------------------------------------------------
// Page tokens and change cursors
// ---------------------------------------------------------------------------

interface PageCursor extends GmailPageState {
  account: string;
  kind: "search" | "list";
  key: string;
}

/**
 * Where the next page starts: Gmail's `nextPageToken`, and the ids of the current list page that
 * were not hydrated yet (a page cut short by quota, R1-1).
 */
export interface GmailPageState {
  token?: string;
  ids?: string[];
}

/** Ids kept in a page token: at most one list page of plain Gmail ids. */
const MAX_TOKEN_IDS = 100;
const GMAIL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Wraps a Gmail `nextPageToken` so it only resumes the same query on the same account. */
export function encodePageToken(
  account: string,
  kind: PageCursor["kind"],
  key: string,
  state: GmailPageState | undefined,
): string | undefined {
  const ids = state?.ids?.length ? state.ids.slice(0, MAX_TOKEN_IDS) : undefined;
  if (!state || (!state.token && !ids)) {
    return undefined;
  }
  return encodeCursor({
    account,
    kind,
    key,
    ...(state.token ? { token: state.token } : {}),
    ...(ids ? { ids } : {}),
  } satisfies PageCursor);
}

/** Inverse of `encodePageToken`; throws `INVALID_CURSOR` for a token from another query. */
export function decodePageToken(
  account: string,
  kind: PageCursor["kind"],
  key: string,
  pageToken: string | undefined,
): GmailPageState | undefined {
  if (!pageToken) {
    return undefined;
  }
  const c = decodeCursor<PageCursor>(pageToken);
  const ids = c.ids;
  if (
    c.account !== account ||
    c.kind !== kind ||
    c.key !== key ||
    (c.token !== undefined && typeof c.token !== "string") ||
    (ids !== undefined &&
      (!Array.isArray(ids) ||
        ids.length > MAX_TOKEN_IDS ||
        !ids.every((id) => typeof id === "string" && GMAIL_ID.test(id)))) ||
    (c.token === undefined && !ids?.length)
  ) {
    throw new ProviderError("INVALID_CURSOR", "Page token belongs to a different query");
  }
  return { ...(c.token ? { token: c.token } : {}), ...(ids?.length ? { ids } : {}) };
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
