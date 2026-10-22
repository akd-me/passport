import { ProviderError } from "./errors.js";
import { ENVELOPE_SELECT, graphUrl } from "./graph-reader-support.js";

/**
 * Continuation links that come back from agents (R1-4). Row page tokens are sealed
 * (`reader-tokens.ts`) and their link must also stay on a message collection under
 * `https://graph.microsoft.com/v1.0/me/` that the reader itself pages, selecting only row columns,
 * with no `$expand` and a bounded `$top`. Delta links in change cursors are never fetched as
 * given: only their `$deltatoken` / `$skiptoken` is kept and the URL is rebuilt for the folder.
 */

const ORIGIN = "https://graph.microsoft.com";
const ROW_PATH = /^\/v1\.0\/me\/(?:mailfolders(?:\/[^/()]+|\('[^'/]+'\))\/)?messages$/i;
const ROW_PARAMS = new Set([
  "$select",
  "$top",
  "$filter",
  "$orderby",
  "$count",
  "$search",
  "$skip",
  "$skiptoken",
]);
const ROW_COLUMNS = new Set(ENVELOPE_SELECT.split(","));
const MAX_TOP = 1_000;
const MAX_LINK = 4_000;

function reject(): never {
  throw new ProviderError("INVALID_CURSOR", "Page token or cursor is not a Graph message link");
}

function parse(link: unknown): URL {
  if (typeof link !== "string" || link.length > MAX_LINK) {
    reject();
  }
  try {
    return new URL(link);
  } catch {
    // Not an absolute URL: never resolve it against the Graph origin.
    reject();
  }
}

/** Returns `link` when it is a row page link the reader could have produced. */
export function assertRowLink(link: unknown): string {
  const url = parse(link);
  if (url.origin !== ORIGIN || url.username || url.password || url.hash) {
    reject();
  }
  if (!ROW_PATH.test(url.pathname) || /%2e|\.\./i.test(url.pathname)) {
    reject();
  }
  for (const [rawName, value] of url.searchParams) {
    const name = rawName.toLowerCase();
    if (!ROW_PARAMS.has(name)) {
      reject();
    }
    if (name === "$select" && !value.split(",").every((c) => ROW_COLUMNS.has(c.trim()))) {
      reject();
    }
    if (name === "$top" && !(Number(value) >= 1 && Number(value) <= MAX_TOP)) {
      reject();
    }
  }
  return url.href;
}

/** The folder's delta URL for the state token in a stored (`deltaLink` / `nextLink`) link. */
export function rebuildDeltaLink(folder: string, link: unknown): string {
  const url = parse(link);
  const params = new Map([...url.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
  const delta = params.get("$deltatoken");
  const skip = params.get("$skiptoken");
  if ((!delta && !skip) || (delta?.length ?? 0) + (skip?.length ?? 0) > MAX_LINK) {
    reject();
  }
  return graphUrl(`/me/mailFolders/${encodeURIComponent(folder)}/messages/delta`, {
    ...(skip ? { $skiptoken: skip } : { $deltatoken: delta }),
  });
}
