import type { GmailScope } from "./gmail-reader-labels.js";
import type { GmailMessage } from "./gmail-reader-normalize.js";

/** `messages.list` / `threads.list` request shapes shared by the reader's list-style methods. */

export interface IdPage {
  messages?: Array<{ id: string; threadId?: string }>;
  threads?: Array<{ id: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}
export interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}
export interface ListRequest {
  q: string;
  scope: GmailScope;
  limit: number;
  pageToken: string | undefined;
  includeSpamTrash: boolean;
  threads: boolean;
}

/** A non-negated `in:spam|trash|anywhere` in a raw Gmail query. */
export const RAW_SPAM_TRASH = /(?:^|[\s({])in:(?:spam|trash|anywhere)\b/i;

export function clampLimit(limit: number, max = 100): number {
  return Number.isFinite(limit) ? Math.min(max, Math.max(1, Math.floor(limit))) : 25;
}
export const joinQ = (...terms: Array<string | undefined>) => terms.filter(Boolean).join(" ");
export const scopesSpamTrash = (scope: GmailScope) =>
  scope.labelId === "SPAM" || scope.labelId === "TRASH" || scope.q === "in:anywhere";

export function listParams(
  r: Pick<ListRequest, "q" | "scope" | "pageToken" | "includeSpamTrash">,
  maxResults: number,
): URLSearchParams {
  const params = new URLSearchParams({ maxResults: String(maxResults) });
  if (r.q) {
    params.set("q", r.q);
  }
  if (r.scope.labelId) {
    params.set("labelIds", r.scope.labelId);
  }
  if (r.pageToken) {
    params.set("pageToken", r.pageToken);
  }
  if (r.includeSpamTrash) {
    params.set("includeSpamTrash", "true");
  }
  return params;
}

/** Newest message of a thread inside the requested scope (falls back to the newest overall). */
export function newestOf(messages: GmailMessage[], r: ListRequest): GmailMessage | undefined {
  const date = (m: GmailMessage) => Number(m.internalDate ?? 0);
  const sorted = [...messages].sort((a, b) => date(b) - date(a));
  const visible = (m: GmailMessage) =>
    r.includeSpamTrash || !m.labelIds?.some((l) => l === "SPAM" || l === "TRASH");
  const inScope = (m: GmailMessage) =>
    !r.scope.labelId || Boolean(m.labelIds?.includes(r.scope.labelId));
  return sorted.find((m) => visible(m) && inScope(m)) ?? sorted.find(visible) ?? sorted[0];
}
