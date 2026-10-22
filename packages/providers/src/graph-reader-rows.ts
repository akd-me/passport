import type { Email, MailboxRole, MailRow } from "@passport/types";
import { toMailRow } from "@passport/types";
import { decodeCursor, encodeCursor, ProviderError } from "./errors.js";
import { normalizeGraph } from "./graph.js";
import type { GraphFolderInfo } from "./graph-reader-folders.js";
import {
  type GraphCall,
  graphUrl,
  newestFirst,
  type ReaderMessage,
  ROW_SELECT,
  SEARCH_CEILING,
} from "./graph-reader-support.js";
import type { QueryNode } from "./query.js";
import { type MatchLabel, matchesQuery } from "./query-match.js";
import type { GraphQueryPlan } from "./query-render.js";

/** Where a plan runs: the resolved folder and the folders hidden from it (Spam/Trash). */
export interface GraphScope {
  folderId: string | null;
  hidden: ReadonlySet<string>;
  /** `container` and `in:` named different folders: nothing can match. */
  empty: boolean;
}

/** Opaque page token payload: the provider link plus how far into its page we got. */
export interface GraphPageToken {
  account: string;
  kind: "search" | "list";
  key: string;
  link: string;
  /** Rows of `link`'s page already consumed (client filtering can stop mid-page). */
  skip: number;
  /** Provider rows scanned before `link` (the `$search` ceiling is 1,000). */
  scanned: number;
  /** Short hashes of conversations already returned (`threads: true`). */
  seen?: string[];
}

export function encodePageToken(token: GraphPageToken): string {
  return encodeCursor(token);
}

export function decodePageToken(
  value: string,
  expected: Pick<GraphPageToken, "account" | "kind" | "key">,
): GraphPageToken {
  const c = decodeCursor<GraphPageToken>(value);
  if (
    c.account !== expected.account ||
    c.kind !== expected.kind ||
    c.key !== expected.key ||
    typeof c.link !== "string" ||
    !Number.isInteger(c.skip) ||
    !Number.isInteger(c.scanned)
  ) {
    throw new ProviderError("INVALID_CURSOR", "Page token belongs to a different query");
  }
  return c;
}

/** True when any client predicate reads the List-Id header. */
export function needsHeaders(nodes: readonly QueryNode[]): boolean {
  return JSON.stringify(nodes).includes('"field":"list"');
}

const NO_ORDER_FLOOR = "receivedDateTime ge 1900-01-01T00:00:00Z";

/** First-page URL for a plan: `$filter` + `$orderby` + `$count`, or `$search`. */
export function planUrl(
  plan: GraphQueryPlan,
  scope: GraphScope,
  options: { top: number; select?: string; count?: boolean },
): string {
  const path = scope.folderId
    ? `/me/mailFolders/${encodeURIComponent(scope.folderId)}/messages`
    : "/me/messages";
  const params: Record<string, string | undefined> = {
    $select: options.select ?? ROW_SELECT,
    $top: String(options.top),
  };
  if (plan.strategy === "filter") {
    // $orderby needs its property to lead the $filter, or Graph answers InefficientFilter.
    const filter = plan.filter;
    params.$filter =
      filter && !filter.startsWith("receivedDateTime ")
        ? `${NO_ORDER_FLOOR} and ${filter}`
        : filter;
    params.$orderby = "receivedDateTime desc";
    params.$count = options.count === false ? undefined : "true";
  } else {
    params.$search = `"${(plan.search ?? "").replaceAll("\\", "").replaceAll('"', '\\"')}"`;
  }
  return graphUrl(path, params);
}

/** Folder + categories of a message, as the matcher and `MailRow.labels` see them. */
export function messageLabels(
  message: Pick<ReaderMessage, "parentFolderId" | "categories">,
  folders: ReadonlyMap<string, GraphFolderInfo>,
): MatchLabel[] {
  const folder = message.parentFolderId ? folders.get(message.parentFolderId) : undefined;
  const categories = (message.categories ?? []).map((name) => ({
    name,
    role: null as MailboxRole,
  }));
  return folder ? [{ name: folder.name, role: folder.role }, ...categories] : categories;
}

/** Projects a normalized message into a `MailRow`: labels are [folderName, ...categories]. */
export function rowOf(
  email: Email,
  message: ReaderMessage,
  folders: ReadonlyMap<string, GraphFolderInfo>,
): MailRow {
  const row = toMailRow(email, () => null);
  row.labels = messageLabels(message, folders).map((l) => l.name);
  if (!message.attachments) {
    // Rows do not expand attachments; `hasAttachments` ignores inline parts, like the count.
    row.attachments = message.hasAttachments ? 1 : 0;
  }
  return row;
}

export interface RowScan {
  call: GraphCall;
  url: string;
  token: GraphPageToken | null;
  limit: number;
  search: boolean;
  /** Provider pages fetched at most per call while client filtering drops rows. */
  maxPages: number;
  /** Returns the row for a message, or null to drop it. */
  keep(message: ReaderMessage): Promise<MailRow | null>;
}

export interface RowScanResult {
  rows: MailRow[];
  next?: Pick<GraphPageToken, "link" | "skip" | "scanned">;
  approxTotal?: number;
  capped: boolean;
}

interface MessagePage {
  value?: ReaderMessage[];
  "@odata.nextLink"?: string;
  "@odata.count"?: number;
}

/** Pages provider results into at most `limit` rows, resuming mid-page from the token. */
export async function scanRows(scan: RowScan): Promise<RowScanResult> {
  let link: string | undefined = scan.token?.link ?? scan.url;
  let skip = scan.token?.skip ?? 0;
  let scanned = scan.token?.scanned ?? 0;
  let approxTotal: number | undefined;
  const rows: MailRow[] = [];
  for (let pages = 0; link && pages < scan.maxPages && rows.length < scan.limit; pages++) {
    const page: MessagePage = await scan.call.get<MessagePage>(link);
    if (typeof page["@odata.count"] === "number") {
      approxTotal = page["@odata.count"];
    }
    const values = scan.search ? newestFirst(page.value ?? []) : (page.value ?? []);
    for (let i = skip; i < values.length; i++) {
      if (rows.length >= scan.limit) {
        return { rows, next: { link, skip: i, scanned }, ...total(approxTotal), capped: false };
      }
      const row = await scan.keep(values[i] as ReaderMessage);
      if (row) {
        rows.push(row);
      }
    }
    scanned += values.length;
    skip = 0;
    const nextLink: string | undefined = page["@odata.nextLink"];
    link = nextLink ? scan.call.transport.safeLink(nextLink) : undefined;
  }
  const capped = scan.search && scanned >= SEARCH_CEILING;
  return {
    rows,
    ...(link ? { next: { link, skip, scanned } } : {}),
    ...total(capped ? SEARCH_CEILING : approxTotal),
    capped,
  };
}

const total = (value: number | undefined) => (value === undefined ? {} : { approxTotal: value });

/** Normalizes a row message (no bodies) for client filtering and row projection. */
export function envelopeOf(call: GraphCall, message: ReaderMessage): Promise<Email> {
  return normalizeGraph(message, call.transport.accountId(), call.transport.verifier);
}

/** Applies the plan's client predicates (AND) to one message. */
export function clientMatch(
  plan: GraphQueryPlan,
  email: Email,
  labels: MatchLabel[],
  now: Date,
): boolean {
  if (plan.clientFilter.length === 0) {
    return true;
  }
  return matchesQuery({ kind: "and", nodes: plan.clientFilter }, email, {
    now,
    labels: () => labels,
  });
}
