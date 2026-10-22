import type { QuotaLane, ReadCost } from "@passport/types";
import { ProviderError, RateLimitedError } from "./errors.js";
import type { GraphMessage } from "./graph.js";
import type { RequestPolicy } from "./http.js";
import type { ThrottleSignal } from "./quota-presets.js";
import { INTERACTIVE_MAX_WAIT_MS } from "./quota-presets.js";
import type { PassportVerifier } from "./verification.js";

export const graphApi = "https://graph.microsoft.com/v1.0";

/** Columns for list/search rows (research 03 §5). Headers are added only when a filter needs them. */
export const ROW_SELECT =
  "id,conversationId,internetMessageId,receivedDateTime,from,toRecipients,ccRecipients,subject,bodyPreview,isRead,flag,hasAttachments,parentFolderId,categories";
/** Envelope columns: rows plus the fields `normalizeGraph` fills into an `Email`. */
export const ENVELOPE_SELECT = `${ROW_SELECT},sender,bccRecipients,replyTo,sentDateTime,isDraft,internetMessageHeaders`;
/** Delta columns for `changes` (the delta token remembers them). */
export const DELTA_SELECT = "id,conversationId,isRead,parentFolderId,categories,receivedDateTime";
export const ATTACHMENTS_EXPAND = "attachments($select=id,name,contentType,size,isInline)";
/** Graph `$batch` accepts at most 20 requests. */
export const BATCH_LIMIT = 20;
/** Graph `$search` never returns more than this many results. */
export const SEARCH_CEILING = 1_000;

export const IMMUTABLE_ID = 'IdType="ImmutableId"';
export const PREFER_TEXT = `${IMMUTABLE_ID}, outlook.body-content-type="text"`;

/** A Graph message as the reader selects it. */
export type ReaderMessage = GraphMessage & {
  uniqueBody?: { contentType: string; content: string };
  "@odata.etag"?: string;
};

/** What `GraphMailProvider` lends its reader: authenticated, governed requests. */
export interface GraphReaderTransport {
  /** The connected account id; throws `NOT_CONNECTED` otherwise. */
  accountId(): string;
  json<T>(url: string, init: RequestInit, policy: RequestPolicy): Promise<T>;
  /** Validates a continuation link against the Graph origin. */
  safeLink(link: string): string;
  /** Feeds throttling signals from `$batch` inner responses to the governor. */
  report(signal: ThrottleSignal): void;
  snapshot(): Pick<ReadCost, "budgetRemaining" | "windowResetsAt">;
  /** True when a governor paces requests (it then waits out Retry-After itself). */
  governed: boolean;
  sleep(ms: number): Promise<void>;
  now(): Date;
  verifier?: PassportVerifier | undefined;
}

export interface BatchItem {
  id: string;
  url: string;
  headers?: Record<string, string>;
}
export interface BatchResponse {
  id: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Builds a Graph URL; `$` stays literal and values are percent-encoded (spaces as `%20`). */
export function graphUrl(path: string, params: Record<string, string | undefined> = {}): string {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${graphApi}${path}${query ? `?${query}` : ""}`;
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  const key = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === name);
  return key ? headers?.[key] : undefined;
}

/**
 * One reader call: counts Graph requests (a `$batch` counts each inner request) and sends every
 * request through the governor in the call's lane.
 */
export class GraphCall {
  requests = 0;
  constructor(
    readonly transport: GraphReaderTransport,
    readonly lane: QuotaLane,
    readonly signal?: AbortSignal,
  ) {}

  async get<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
    this.requests += 1;
    return this.transport.json<T>(
      this.transport.safeLink(url),
      { headers: { Prefer: IMMUTABLE_ID, ...headers }, ...this.init() },
      { lane: this.lane, cost: 1 },
    );
  }

  /**
   * Sends GETs in `$batch` requests of ≤20, one batch at a time (Outlook runs 4 inner requests
   * concurrently per mailbox, so parallel batches only produce 429s). Inner 429s are retried
   * after their Retry-After; other statuses are returned to the caller.
   */
  async batch(items: BatchItem[]): Promise<Map<string, BatchResponse>> {
    const out = new Map<string, BatchResponse>();
    for (let start = 0; start < items.length; start += BATCH_LIMIT) {
      await this.batchChunk(items.slice(start, start + BATCH_LIMIT), out);
    }
    return out;
  }

  private async batchChunk(chunk: BatchItem[], out: Map<string, BatchResponse>): Promise<void> {
    let pending = chunk;
    let waitedMs = 0;
    for (let round = 0; pending.length > 0; round++) {
      this.requests += pending.length;
      const response = await this.transport.json<{ responses?: BatchResponse[] }>(
        `${graphApi}/$batch`,
        {
          method: "POST",
          headers: { "content-type": "application/json", Prefer: IMMUTABLE_ID },
          body: JSON.stringify({
            requests: pending.map((r) => ({
              id: r.id,
              method: "GET",
              url: r.url,
              headers: { Prefer: IMMUTABLE_ID, ...r.headers },
            })),
          }),
          ...this.init(),
        },
        { lane: this.lane, cost: pending.length },
      );
      const byId = new Map((response.responses ?? []).map((r) => [String(r.id), r]));
      const retry: BatchItem[] = [];
      let delayMs = 0;
      for (const item of pending) {
        const inner = byId.get(item.id);
        if (!inner) {
          throw new ProviderError("INVALID_RESPONSE", "Graph $batch omitted a response");
        }
        this.reportPercentage(inner);
        if (inner.status === 429) {
          retry.push(item);
          const after = Number(header(inner.headers, "retry-after"));
          delayMs = Math.max(delayMs, Number.isFinite(after) ? after * 1000 : 2_000 * 2 ** round);
        } else {
          out.set(item.id, inner);
        }
      }
      if (retry.length === 0) {
        return;
      }
      this.transport.report({ retryAfterSeconds: delayMs / 1000 });
      const tooLong = this.lane === "interactive" && waitedMs + delayMs > INTERACTIVE_MAX_WAIT_MS;
      if (round >= 4 || tooLong) {
        throw new RateLimitedError(Math.max(1, Math.ceil(delayMs / 1000)), "graph:mailbox", 429);
      }
      // A governor already blocks the next acquire until Retry-After; do not wait twice.
      if (!this.transport.governed) {
        await this.transport.sleep(delayMs);
      }
      waitedMs += delayMs;
      pending = retry;
    }
  }

  private reportPercentage(inner: BatchResponse): void {
    const value = Number(header(inner.headers, "x-ms-throttle-limit-percentage"));
    if (Number.isFinite(value) && header(inner.headers, "x-ms-throttle-limit-percentage")) {
      this.transport.report({ throttlePercentage: value });
    }
  }

  private init(): { signal?: AbortSignal } {
    return this.signal ? { signal: this.signal } : {};
  }

  /** `ReadMeta` for the call so far. */
  meta(translation?: string): { source: "provider"; cost: ReadCost; translation?: string } {
    return {
      source: "provider",
      cost: { graphRequests: this.requests, ...this.transport.snapshot() },
      ...(translation ? { translation } : {}),
    };
  }
}

/** Throws the `ProviderError` an inner `$batch` response stands for. */
export function batchError(inner: BatchResponse): ProviderError {
  return new ProviderError(
    inner.status === 401 ? "AUTH_FAILED" : `HTTP_${inner.status}`,
    `Provider request failed (HTTP ${inner.status})`,
    inner.status,
  );
}

/** Messages sorted newest first (ties by id), as `$search` pages are not ordered. */
export function newestFirst<T extends { id: string; receivedDateTime?: string }>(list: T[]): T[] {
  return [...list].sort(
    (a, b) =>
      (b.receivedDateTime ?? "").localeCompare(a.receivedDateTime ?? "") ||
      b.id.localeCompare(a.id),
  );
}
