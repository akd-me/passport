import type { MailListFilter } from "@passport/types";
import type { SearchObject } from "imapflow";
import { NotImplementedError, ProviderError } from "./errors.js";
import type { QueryAst, QueryNode } from "./query.js";

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
 * Plans a portable query for Graph.
 * @throws NotImplementedError until the Graph reader lands (Wave 1, Graph agent).
 */
export function renderGraphQuery(_ast: QueryAst): GraphQueryPlan {
  throw new NotImplementedError(
    "renderGraphQuery is a stub: the Graph reader implements the $search/$filter translator",
  );
}

/** How a portable query runs over IMAP SEARCH plus local post-filtering. */
export interface ImapQueryPlan {
  /** Mailbox paths to search (INBOX, Sent, …); empty means the default set. */
  mailboxes: string[];
  /** Server-side criteria for imapflow's `search()`. */
  criteria: SearchObject;
  /** Predicates the server cannot evaluate (BODYSTRUCTURE, weak TEXT search). */
  localFilter: QueryNode[];
  /** Reported as `ReadMeta.translation`, e.g. `"imap:SEARCH+localGrep"`. */
  translation: string;
}

/**
 * Plans a portable query for IMAP.
 * @throws NotImplementedError until the IMAP reader lands (Wave 1, IMAP agent).
 */
export function renderImapQuery(_ast: QueryAst): ImapQueryPlan {
  throw new NotImplementedError(
    "renderImapQuery is a stub: the IMAP reader implements SEARCH criteria and local filtering",
  );
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
