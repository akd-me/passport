import {
  isProviderGetAllowed,
  type ProviderKind,
  RAW_GET_MAX_BYTES,
  type RawGetResponse,
} from "@passport/types";
import { ProviderError } from "./errors.js";
import { GMAIL_UNIT_COSTS as UNITS } from "./quota-presets.js";

/**
 * Shared pieces of `MailReader.rawGet` (the `provider_get` escape hatch, research 03 §2.3 row 15):
 * path and query validation, response clipping and Gmail pricing. IMAP and JMAP have no REST
 * surface to expose, so their readers leave `rawGet` undefined.
 */

const QUERY_KEY = /^[A-Za-z0-9_$.-]{1,64}$/;
const MAX_QUERY_VALUE = 2_000;

/**
 * Re-checks a `rawGet` request: relative path only (no scheme, host or query string), allowed by
 * `isProviderGetAllowed` for `kind`, and plain query keys. Throws `PATH_NOT_ALLOWED` /
 * `INVALID_QUERY`; returns the normalized path.
 */
export function checkRawGet(
  kind: ProviderKind,
  path: string,
  query: Record<string, string>,
): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path.trim()) || path.trim().startsWith("//")) {
    throw new ProviderError("PATH_NOT_ALLOWED", "provider_get takes a relative API path");
  }
  const allowed = isProviderGetAllowed(kind, path);
  if (!allowed) {
    throw new ProviderError(
      "PATH_NOT_ALLOWED",
      `Path is not on the ${kind} provider_get allowlist`,
    );
  }
  for (const [key, value] of Object.entries(query)) {
    if (!QUERY_KEY.test(key) || typeof value !== "string" || value.length > MAX_QUERY_VALUE) {
      throw new ProviderError("INVALID_QUERY", "provider_get query keys must be plain names");
    }
  }
  return allowed;
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "");

/** Longest prefix of `list` whose JSON fits in `limit` bytes (binary search). */
function clipArray(list: unknown[], limit: number): unknown[] {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes(list.slice(0, mid)) <= limit) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return list.slice(0, low);
}

/**
 * Shrinks a JSON value to at most `limit` serialized bytes by dropping trailing items of its
 * largest arrays (top level or one property deep). Returns undefined when that is not enough.
 */
export function clipJson(value: unknown, limit: number): unknown {
  if (bytes(value) <= limit) {
    return value;
  }
  if (Array.isArray(value)) {
    return clipArray(value, limit);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const arrays = Object.keys(out)
    .filter((key) => Array.isArray(out[key]))
    .sort((a, b) => bytes(out[b]) - bytes(out[a]));
  for (const key of arrays) {
    const list = out[key] as unknown[];
    const rest = bytes({ ...out, [key]: [] });
    out[key] = rest >= limit ? [] : clipArray(list, limit - rest + 2);
    if (bytes(out) <= limit) {
      return out;
    }
  }
  return undefined;
}

/** First `limit` bytes of `text` (a cut multi-byte character becomes U+FFFD). */
function clipText(text: string, limit: number): string {
  const buffer = Buffer.from(text);
  return buffer.byteLength <= limit ? text : buffer.subarray(0, limit).toString();
}

/**
 * Reads a provider response into a `RawGetResponse`: JSON parsed (or text), clipped to
 * `RAW_GET_MAX_BYTES`. A clipped body sets `truncated` and `totalBytes`.
 */
export async function rawGetBody(response: Response): Promise<RawGetResponse> {
  const text = await response.text();
  const totalBytes = Buffer.byteLength(text);
  let parsed: unknown = text;
  if (/json/i.test(response.headers.get("content-type") ?? "") || /^\s*[[{]/.test(text)) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON after all: return it as text.
      parsed = text;
    }
  }
  if (totalBytes <= RAW_GET_MAX_BYTES) {
    return { status: response.status, body: parsed };
  }
  const clipped = typeof parsed === "string" ? undefined : clipJson(parsed, RAW_GET_MAX_BYTES);
  return {
    status: response.status,
    body: clipped ?? clipText(text, RAW_GET_MAX_BYTES),
    truncated: true,
    totalBytes,
  };
}

/**
 * Gmail units for a raw GET, by path (relative to `users/me/`) and `format`: `GMAIL_UNIT_COSTS`
 * for known methods, 5 otherwise.
 */
export function gmailRawGetUnits(path: string, query: Record<string, string>): number {
  const segments = path.replace(/^users\/me\//, "").split("/");
  const depth = segments.length;
  const light = ["metadata", "minimal"].includes((query.format ?? "full").toLowerCase());
  switch (segments[0]) {
    case "messages":
      if (depth === 1) {
        return UNITS.messagesList;
      }
      if (depth === 2) {
        return light ? UNITS.messagesGetMetadata : UNITS.messagesGetFull;
      }
      return segments[2] === "attachments" && depth === 4 ? UNITS.attachmentsGet : 5;
    case "threads":
      if (depth === 1) {
        return UNITS.threadsList;
      }
      return depth === 2 ? (light ? UNITS.threadsGetMetadata : UNITS.threadsGetFull) : 5;
    case "labels":
      return depth === 1 ? UNITS.labelsList : UNITS.labelsGet;
    case "history":
      return UNITS.historyList;
    case "drafts":
      return depth === 1 ? UNITS.draftsList : 5;
    case "settings":
      return segments[1] === "filters" ? UNITS.filtersList : 5;
    default:
      return 5;
  }
}
