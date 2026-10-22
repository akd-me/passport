import type { MailListFilter } from "@passport/types";
import type { SearchObject } from "imapflow";
import { NotImplementedError, ProviderError } from "./errors.js";
import { planGraphQuery } from "./graph-reader-query.js";
import { type QueryAst, type QueryNode, relativeCutoff } from "./query.js";

/** Gmail drops the quote character inside phrases, so it is removed rather than escaped. */
function quoteIfNeeded(value: string, phrase = false): string {
  const clean = value.replaceAll('"', "");
  return phrase || /[\s(){}]/.test(clean) ? `"${clean}"` : clean;
}

function group(node: QueryNode): string {
  const text = renderGmailNode(node);
  return node.kind === "and" && node.nodes.length > 1 ? `(${text})` : text;
}

function renderGmailNode(node: QueryNode): string {
  switch (node.kind) {
    case "and":
      return node.nodes.map(group).join(" ");
    case "or":
      return `(${node.nodes.map(group).join(" OR ")})`;
    case "not": {
      const inner = renderGmailNode(node.node);
      return node.node.kind === "and" ? `-(${inner})` : `-${inner}`;
    }
    case "text":
      return quoteIfNeeded(node.value, node.phrase);
    case "field": {
      const value = quoteIfNeeded(node.value, node.phrase);
      if (node.field === "with") {
        return `{from:${value} to:${value} cc:${value} bcc:${value}}`;
      }
      return `${node.field}:${value}`;
    }
    case "has":
      return "has:attachment";
    case "is":
      return node.value === "flagged" ? "is:starred" : `is:${node.value}`;
    case "in":
      return `in:${quoteIfNeeded(node.value)}`;
    case "label":
      return `label:${quoteIfNeeded(node.value)}`;
    case "date":
      // Epoch seconds avoid Gmail interpreting dates in the account's time zone.
      return `${node.op}:${node.epochSeconds}`;
    case "relative":
      return `${node.op}:${node.amount}${node.unit}`;
    case "size":
      return `${node.op}:${node.bytes}`;
  }
}

/**
 * Renders a portable query as a Gmail `q` string. Nearly a pass-through: `with:` expands to
 * `{from: to: cc: bcc:}`, dates become epoch seconds, `is:flagged` becomes `is:starred`.
 */
export function renderGmailQuery(ast: QueryAst): string {
  return renderGmailNode(ast);
}

/**
 * How a portable query runs on Microsoft Graph. `$search` handles free text (no sort, ≤1,000
 * results); `$filter` handles structured predicates (sortable, countable). Mixed queries use
 * `$search` and apply `clientFilter` to the returned rows.
 */
export interface GraphQueryPlan {
  strategy: "search" | "filter" | "search+clientFilter";
  /** KQL for `$search`, without the surrounding quotes. */
  search?: string;
  /** OData `$filter` expression. */
  filter?: string;
  /** Folder to scope the request to (`in:` / `label:` that names a folder). */
  folder?: string;
  /** Predicates to evaluate locally (see `matchesQuery`). */
  clientFilter: QueryNode[];
  /** Reported as `ReadMeta.translation`, e.g. `"graph:$search+clientFilter"`. */
  translation: string;
}

/**
 * Plans a portable query for Graph: `$filter` when every predicate is structured, otherwise
 * `$search` with structured predicates in `clientFilter` (see `graph-reader-query.ts`).
 * `now` resolves `newer_than:` / `older_than:`.
 */
export function renderGraphQuery(ast: QueryAst, now: Date = new Date()): GraphQueryPlan {
  return planGraphQuery(ast, now);
}

/** How a portable query runs over IMAP SEARCH plus local post-filtering. */
export interface ImapQueryPlan {
  /**
   * Mailboxes to search: a path, or a SPECIAL-USE attribute (`\\Sent`, `\\Archive`, `\\All`, …)
   * the reader resolves; `\\Archive` falls back to `\\All`. Empty means the default (INBOX).
   */
  mailboxes: string[];
  /** Server-side criteria for imapflow's `search()`. */
  criteria: SearchObject;
  /** Predicates the server cannot evaluate (BODYSTRUCTURE, weak TEXT search). */
  localFilter: QueryNode[];
  /** Reported as `ReadMeta.translation`, e.g. `"imap:SEARCH+localGrep"`. */
  translation: string;
}

/** Server facts `renderImapQuery` adapts to. */
export interface ImapPlanOptions {
  /** The server advertises X-GM-EXT-1: the whole query runs as Gmail `X-GM-RAW`. */
  gmail?: boolean;
  /** Reference time for `newer_than:` / `older_than:`. Defaults to the current time. */
  now?: Date;
}

const IMAP_CONTAINERS: Record<string, string[]> = {
  inbox: ["INBOX"],
  sent: ["\\Sent"],
  drafts: ["\\Drafts"],
  spam: ["\\Junk"],
  trash: ["\\Trash"],
  archive: ["\\Archive"],
  anywhere: ["INBOX", "\\Sent", "\\Archive"],
};

function imapContainer(node: Extract<QueryNode, { kind: "in" | "label" }>): string[] {
  return (node.kind === "in" && IMAP_CONTAINERS[node.value]) || [node.value];
}

/** Merges `extra` into `into` (an implicit AND). False, untouched, when a key would clash. */
function mergeCriteria(into: SearchObject, extra: SearchObject): boolean {
  const header = { ...into.header };
  for (const [key, value] of Object.entries(extra.header ?? {})) {
    if (key in header) {
      return false;
    }
    header[key] = value;
  }
  const keys = Object.keys(extra).filter((k) => k !== "header");
  if (keys.some((k) => k in into)) {
    return false;
  }
  Object.assign(into, extra, Object.keys(header).length ? { header } : {});
  return true;
}

/** Cheap, universally supported SEARCH keys only; null when the node needs local evaluation. */
function imapCriteria(node: QueryNode, now: Date): SearchObject | null {
  switch (node.kind) {
    case "and": {
      const merged: SearchObject = {};
      for (const child of node.nodes) {
        const criteria = imapCriteria(child, now);
        if (!criteria || !mergeCriteria(merged, criteria)) {
          return null;
        }
      }
      return merged;
    }
    case "or": {
      const nodes = node.nodes.map((n) => imapCriteria(n, now));
      return nodes.every((n): n is SearchObject => n !== null) ? { or: nodes } : null;
    }
    case "not": {
      const inner = imapCriteria(node.node, now);
      return inner ? { not: inner } : null;
    }
    case "field":
      switch (node.field) {
        case "from":
        case "to":
        case "cc":
        case "bcc":
        case "subject":
          return { [node.field]: node.value };
        case "with":
          return { or: [{ from: node.value }, { to: node.value }, { cc: node.value }] };
        case "rfc822msgid":
          return { header: { "message-id": `<${node.value.replace(/^<|>$/g, "")}>` } };
        case "list":
          return { header: { "list-id": node.value } };
        default:
          return null;
      }
    case "is":
      return node.value === "flagged" ? { flagged: true } : { seen: node.value === "read" };
    case "date":
      // imapflow widens BEFORE to the next day for non-midnight times (SEARCH is day-granular).
      return node.op === "after" ? { since: new Date(node.at) } : { before: new Date(node.at) };
    case "relative": {
      const cutoff = relativeCutoff(node, now);
      return node.op === "newer_than" ? { since: cutoff } : { before: cutoff };
    }
    case "size":
      return node.op === "larger" ? { larger: node.bytes } : { smaller: node.bytes };
    default:
      // Free text (weak or slow on many servers), attachments and nested containers.
      return null;
  }
}

/**
 * Plans a portable query for IMAP (research 03 §2.2, §5.6). Cheap keys (dates, participants,
 * subject, flags, size, Message-ID / List-Id headers) go to the server; free text, attachments
 * and nested `in:` become `localFilter`, which the reader evaluates with `matchesQuery` over a
 * capped set of the newest candidates. A top-level `in:` / `label:` picks the mailboxes
 * (`in:anywhere` = INBOX + Sent + Archive). On Gmail IMAP the query runs as `X-GM-RAW`.
 */
export function renderImapQuery(ast: QueryAst, options: ImapPlanOptions = {}): ImapQueryPlan {
  const containers = ast.nodes.filter(
    (n): n is Extract<QueryNode, { kind: "in" | "label" }> => n.kind === "in" || n.kind === "label",
  );
  if (options.gmail) {
    // Gmail's own query language covers every operator; All Mail holds everything but Spam/Trash.
    const scoped = containers.find((n) => n.kind === "in" && /^(spam|trash)$/.test(n.value));
    const raw = renderGmailQuery(ast);
    return {
      mailboxes: scoped ? imapContainer(scoped) : ["\\All"],
      criteria: raw ? { gmraw: raw } : {},
      localFilter: [],
      translation: "imap:X-GM-RAW",
    };
  }
  const now = options.now ?? new Date();
  const first = containers[0];
  const criteria: SearchObject = {};
  const localFilter: QueryNode[] = [];
  for (const node of ast.nodes) {
    if (node === first) {
      continue;
    }
    const server = imapCriteria(node, now);
    if (!server || !mergeCriteria(criteria, server)) {
      localFilter.push(node);
    }
  }
  return {
    mailboxes: first ? imapContainer(first) : [],
    criteria,
    localFilter,
    translation: localFilter.length ? "imap:SEARCH+localGrep" : "imap:SEARCH",
  };
}

function dateNode(op: "after" | "before", value: string): QueryNode {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new ProviderError("INVALID_QUERY", `filter.${op} must be an ISO date or timestamp`);
  }
  return { kind: "date", op, at: new Date(ms).toISOString(), epochSeconds: Math.floor(ms / 1000) };
}

/**
 * Converts `mail_list` structural filters into a query AST, so readers can render them with the
 * same translator as search. `fromDomain` becomes `from:@domain`.
 */
export function listFilterToAst(filter: MailListFilter): QueryAst {
  const nodes: QueryNode[] = [];
  if (filter.from) {
    nodes.push({ kind: "field", field: "from", value: filter.from, phrase: false });
  }
  if (filter.fromDomain) {
    const domain = filter.fromDomain.replace(/^@/, "");
    nodes.push({ kind: "field", field: "from", value: `@${domain}`, phrase: false });
  }
  if (filter.unread !== undefined) {
    nodes.push({ kind: "is", value: filter.unread ? "unread" : "read" });
  }
  if (filter.flagged !== undefined) {
    const flagged: QueryNode = { kind: "is", value: "flagged" };
    nodes.push(filter.flagged ? flagged : { kind: "not", node: flagged });
  }
  if (filter.hasAttachment !== undefined) {
    const has: QueryNode = { kind: "has", value: "attachment" };
    nodes.push(filter.hasAttachment ? has : { kind: "not", node: has });
  }
  if (filter.after) {
    nodes.push(dateNode("after", filter.after));
  }
  if (filter.before) {
    nodes.push(dateNode("before", filter.before));
  }
  if (filter.largerThan !== undefined) {
    nodes.push({ kind: "size", op: "larger", bytes: filter.largerThan });
  }
  return { kind: "and", nodes };
}
