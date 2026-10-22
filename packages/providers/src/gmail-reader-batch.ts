import { randomUUID } from "node:crypto";
import { ProviderError, RateLimitedError } from "./errors.js";
import type { GmailCall } from "./gmail-reader-support.js";

/** Gmail's batch endpoint (`multipart/mixed`, one `application/http` part per call). */
export const GMAIL_BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";
/** Google allows 100 calls per batch and recommends at most 50. */
export const GMAIL_BATCH_MAX = 50;
const API_PATH = "/gmail/v1/users/me/";

/** One inner response of a batch. */
export interface BatchPart {
  status: number;
  headers: Headers;
  body: unknown;
}

/** Builds the multipart body for GETs of `users/me/<path>`; parts are tagged `<item-N>`. */
export function buildBatchBody(paths: readonly string[], boundary: string): string {
  const parts = paths.map(
    (path, i) =>
      `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item-${i}>\r\n\r\n` +
      `GET ${API_PATH}${path}\r\n\r\n`,
  );
  return `${parts.join("")}--${boundary}--\r\n`;
}

function splitHead(text: string): [head: string, rest: string] {
  const match = /\r?\n\r?\n/.exec(text);
  return match
    ? [text.slice(0, match.index), text.slice(match.index + match[0].length)]
    : [text, ""];
}

function headerLines(head: string): Headers {
  const headers = new Headers();
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      try {
        headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      } catch {
        // Skip header names the platform rejects; they are never needed here.
      }
    }
  }
  return headers;
}

/**
 * Parses a batch response into parts indexed by request position (Google may reorder parts; the
 * `Content-ID: <response-item-N>` header maps them back). Missing parts are `undefined`.
 */
export function parseBatchResponse(
  text: string,
  contentType: string | null,
  count: number,
): Array<BatchPart | undefined> {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType ?? "")?.[1];
  if (!boundary) {
    throw new ProviderError("INVALID_RESPONSE", "Gmail batch response has no multipart boundary");
  }
  const out = new Array<BatchPart | undefined>(count).fill(undefined);
  for (const chunk of text.split(`--${boundary}`).slice(1)) {
    if (chunk.startsWith("--")) {
      break;
    }
    const [outer, http] = splitHead(chunk.replace(/^\r?\n/, ""));
    const index = Number(/item-(\d+)>?\s*$/i.exec(headerLines(outer).get("content-id") ?? "")?.[1]);
    const [statusAndHeaders, rawBody] = splitHead(http);
    const [statusLine = "", ...lines] = statusAndHeaders.split(/\r?\n/);
    const status = Number(/^HTTP\/[\d.]+\s+(\d{3})/.exec(statusLine)?.[1]);
    if (!Number.isInteger(index) || index < 0 || index >= count || !Number.isFinite(status)) {
      continue;
    }
    const bodyText = rawBody.trim();
    let body: unknown = null;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

        throw new ProviderError("INVALID_RESPONSE", "Gmail batch part is not valid JSON");
      }
    }
    out[index] = { status, headers: headerLines(lines.join("\n")), body };
  }
  return out;
}

/** 429, or Google's per-user quota 403 (`rateLimitExceeded` / `userRateLimitExceeded`). */
export function isThrottledPart(part: BatchPart): boolean {
  return (
    part.status === 429 ||
    (part.status === 403 &&
      /"(?:rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT_EXCEEDED)"/.test(
        JSON.stringify(part.body ?? {}),
      ))
  );
}

/**
 * Units one batch request may declare. The Gmail bucket holds 1,500; a larger request runs the
 * governor into debt and blocks every lane, so 50 `threads.get` (2,000) are split (R1-1).
 */
export const GMAIL_BATCH_MAX_UNITS = 1_000;

async function getOrNull<T>(call: GmailCall, path: string, cost: number): Promise<T | null> {
  try {
    return await call.get<T>(path, cost);
  } catch (e) {
    // A provider 404 means the requested resource no longer exists; a 400 is a malformed or
    // foreign id (R1-20). Either way the id resolves to nothing.

    if (e instanceof ProviderError && (e.status === 404 || e.status === 400)) {
      return null;
    }
    throw e;
  }
}

/** `batchGetSome` result: `undefined` marks paths not fetched because quota ran out. */
export interface BatchSome<T> {
  results: Array<T | null | undefined>;
  /** Set when the call stopped early; every later path is `undefined`. */
  limited?: RateLimitedError;
}

/**
 * GETs `users/me/<path>` for every path, in batch requests of at most `GMAIL_BATCH_MAX` calls
 * and `GMAIL_BATCH_MAX_UNITS` units, each path declaring `cost` units. Results keep input order;
 * `null` marks a 404 (or a malformed id). Throttled or missing parts are retried one by one as
 * plain GETs, which draw on the call's wait budget, and are counted once. When the governor or
 * the provider refuses within the budget (`RateLimitedError`), the call stops and returns what
 * it has; other part failures throw `HTTP_<status>`.
 */
export async function batchGetSome<T>(
  call: GmailCall,
  paths: readonly string[],
  cost: number,
): Promise<BatchSome<T>> {
  const results = new Array<T | null | undefined>(paths.length).fill(undefined);
  const size = Math.max(1, Math.min(GMAIL_BATCH_MAX, Math.floor(GMAIL_BATCH_MAX_UNITS / cost)));
  try {
    for (let start = 0; start < paths.length; start += size) {
      const chunk = paths.slice(start, start + size);
      // A batch of one costs a multipart round trip for nothing.
      const parts = chunk.length > 1 ? await sendBatch(call, chunk, cost) : [undefined];
      const retry: number[] = [];
      for (const i of chunk.keys()) {
        const settled = settlePart<T>(call, parts[i]);
        if (settled === RETRY) {
          retry.push(i);
        } else {
          results[start + i] = settled;
        }
      }
      for (const i of retry) {
        results[start + i] = await getOrNull<T>(call, chunk[i] as string, cost);
      }
    }
  } catch (e) {
    if (e instanceof RateLimitedError) {
      return { results, limited: e };
    }
    throw e;
  }
  return { results };
}

/** `batchGetSome` that fails with `RateLimitedError` instead of returning a partial result. */
export async function batchGet<T>(
  call: GmailCall,
  paths: readonly string[],
  cost: number,
): Promise<Array<T | null>> {
  const { results, limited } = await batchGetSome<T>(call, paths, cost);
  if (limited) {
    throw limited;
  }
  return results as Array<T | null>;
}

const RETRY = Symbol("retry");

/** The part's value, `null` when gone, or `RETRY` for a throttled / missing part. */
function settlePart<T>(call: GmailCall, part: BatchPart | undefined): T | null | typeof RETRY {
  if (part && part.status >= 200 && part.status < 300) {
    return part.body as T;
  }
  if (part?.status === 404 || part?.status === 400) {
    return null;
  }
  if (part && !isThrottledPart(part)) {
    throw new ProviderError(
      part.status === 401 ? "AUTH_FAILED" : `HTTP_${part.status}`,
      `Provider request failed (HTTP ${part.status})`,
      part.status,
    );
  }
  const retryAfter = Number(part?.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    call.report({ retryAfterSeconds: retryAfter });
  }
  return RETRY;
}

async function sendBatch(
  call: GmailCall,
  chunk: readonly string[],
  cost: number,
): Promise<Array<BatchPart | undefined>> {
  const boundary = `passport_${randomUUID()}`;
  let parts: Array<BatchPart | undefined>;
  try {
    const response = await call.send(
      GMAIL_BATCH_URL,
      {
        method: "POST",
        headers: { "content-type": `multipart/mixed; boundary=${boundary}` },
        body: buildBatchBody(chunk, boundary),
      },
      cost * chunk.length,
      // A batch of GETs is safe to replay after an outer 429 (R1-14).
      { idempotent: true },
    );
    parts = parseBatchResponse(
      await response.text(),
      response.headers.get("content-type"),
      chunk.length,
    );
  } catch (e) {
    // Outside the interactive lane a batch still throttled after its retries falls back to
    // single GETs, which back off; RateLimitedError always propagates.

    if (
      e instanceof ProviderError &&
      !(e instanceof RateLimitedError) &&
      e.code === "RATE_LIMITED"
    ) {
      parts = chunk.map(() => undefined);
    } else {
      throw e;
    }
  }
  // Parts that were not served are charged again by their retry; report each row once (R1-2).
  const unserved = parts.filter((p) => !p || isThrottledPart(p)).length;
  call.uncount(unserved * cost);
  return parts;
}
