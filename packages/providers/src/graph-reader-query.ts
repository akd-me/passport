import { type QueryAst, type QueryNode, relativeCutoff } from "./query.js";
import type { GraphQueryPlan } from "./query-render.js";

/**
 * Portable query → Graph plan (research 03 §2.2). `$search` (KQL) cannot be combined with `$filter`
 * or `$orderby` on messages, so each top-level conjunct is classified:
 *  - OData-able only (`is:`, `label:`, `rfc822msgid:`) or KQL-able only (text, participants,
 *    subject, `filename:`, `larger:`) or both (`has:attachment`, dates, exact `from:` addresses);
 *  - neither (`list:`, nested `in:`) → always client-side.
 * With no KQL-only conjunct the plan is `$filter` (sortable, countable). Otherwise it is `$search`
 * and OData-only conjuncts move to `clientFilter`.
 */

/** Portable container → Graph well-known folder name. */
export const GRAPH_WELL_KNOWN: Readonly<Record<string, string>> = {
  inbox: "inbox",
  sent: "sentitems",
  drafts: "drafts",
  spam: "junkemail",
  trash: "deleteditems",
  archive: "archive",
};

interface Classified {
  filter?: string;
  search?: string;
}

const odataString = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** KQL value: quotes are dropped, values with spaces or KQL syntax become phrases. */
function kqlValue(value: string, phrase = false): string {
  const clean = value.replaceAll('"', "").replaceAll("\\", "");
  return phrase || /[\s():<>=]/.test(clean) ? `"${clean}"` : clean;
}

const isExactAddress = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const KQL_FIELD: Partial<Record<string, string>> = {
  from: "from",
  to: "to",
  cc: "cc",
  bcc: "bcc",
  with: "participants",
  subject: "subject",
  filename: "attachment",
};

function dateIso(node: QueryNode, now: Date): { op: "ge" | "lt"; at: string } | null {
  if (node.kind === "date") {
    return { op: node.op === "after" ? "ge" : "lt", at: node.at };
  }
  if (node.kind === "relative") {
    const at = relativeCutoff(node, now).toISOString();
    return { op: node.op === "newer_than" ? "ge" : "lt", at };
  }
  return null;
}

function classifyField(node: Extract<QueryNode, { kind: "field" }>): Classified {
  const out: Classified = {};
  if (node.field === "from" && isExactAddress(node.value)) {
    out.filter = `from/emailAddress/address eq ${odataString(node.value.toLowerCase())}`;
  }
  if (node.field === "rfc822msgid") {
    const id = node.value.trim().replace(/^</, "").replace(/>$/, "");
    out.filter = `internetMessageId eq ${odataString(`<${id}>`)}`;
  }
  const kql = KQL_FIELD[node.field];
  if (kql) {
    // KQL has no domain operator; `from:example.com` matches the address token.
    const value = node.value.startsWith("@") ? node.value.slice(1) : node.value;
    out.search = `${kql}:${kqlValue(value, node.phrase)}`;
  }
  return out;
}

/** Renders a node as OData and/or KQL; an empty result means "client-side only". */
function classify(node: QueryNode, now: Date): Classified {
  switch (node.kind) {
    case "text":
      return { search: kqlValue(node.value, node.phrase) };
    case "field":
      return classifyField(node);
    case "has":
      return { filter: "hasAttachments eq true", search: "hasAttachments:true" };
    case "is":
      if (node.value === "flagged") {
        return { filter: "flag/flagStatus eq 'flagged'" };
      }
      return { filter: `isRead eq ${node.value === "read"}` };
    case "label":
      return { filter: `categories/any(c:c eq ${odataString(node.value)})` };
    case "date":
    case "relative": {
      const d = dateIso(node, now);
      if (!d) {
        return {};
      }
      const kqlOp = d.op === "ge" ? ">=" : "<";
      return {
        filter: `receivedDateTime ${d.op} ${d.at}`,
        search: `received${kqlOp}${d.at.slice(0, 10)}`,
      };
    }
    case "size":
      return { search: `size${node.op === "larger" ? ">" : "<"}${node.bytes}` };
    case "not":
      return classifyNot(node.node, now);
    case "or":
    case "and":
      return classifyGroup(node, now);
    case "in":
      return {};
  }
}

function classifyNot(inner: QueryNode, now: Date): Classified {
  switch (inner.kind) {
    case "is":
      if (inner.value === "flagged") {
        return { filter: "flag/flagStatus ne 'flagged'" };
      }
      return { filter: `isRead eq ${inner.value !== "read"}` };
    case "has":
      return { filter: "hasAttachments eq false", search: "hasAttachments:false" };
    default: {
      const c = classify(inner, now);
      // KQL NOT works on terms; OData `not` over lambdas and paths is unreliable on messages.
      return c.search ? { search: `NOT ${wrap(c.search)}` } : {};
    }
  }
}

function wrap(text: string): string {
  return /\s/.test(text) && !/^\(.*\)$/.test(text) ? `(${text})` : text;
}

function classifyGroup(node: Extract<QueryNode, { kind: "or" | "and" }>, now: Date): Classified {
  const parts = node.nodes.map((n) => classify(n, now));
  const out: Classified = {};
  const odataJoin = node.kind === "or" ? " or " : " and ";
  const kqlJoin = node.kind === "or" ? " OR " : " AND ";
  if (parts.every((p) => p.filter)) {
    out.filter = `(${parts.map((p) => p.filter).join(odataJoin)})`;
  }
  if (parts.every((p) => p.search)) {
    out.search = `(${parts.map((p) => wrap(p.search ?? "")).join(kqlJoin)})`;
  }
  return out;
}

/** The first non-negated top-level `in:` becomes the folder; `in:anywhere` scopes nothing. */
function takeFolder(nodes: QueryNode[]): { folder?: string; rest: QueryNode[] } {
  const index = nodes.findIndex((n) => n.kind === "in");
  const node = nodes[index];
  if (node?.kind !== "in") {
    return { rest: nodes };
  }
  const rest = nodes.filter((_, i) => i !== index);
  if (node.value === "anywhere") {
    return { rest };
  }
  return { folder: GRAPH_WELL_KNOWN[node.value] ?? node.value, rest };
}

/** Orders `$filter` clauses so `receivedDateTime` leads, as `$orderby=receivedDateTime` requires. */
function filterExpression(clauses: string[]): string | undefined {
  if (clauses.length === 0) {
    return undefined;
  }
  const dated = clauses.filter((c) => c.startsWith("receivedDateTime "));
  const other = clauses.filter((c) => !c.startsWith("receivedDateTime "));
  return [...dated, ...other].join(" and ");
}

/** Plans `ast` for Graph. `now` resolves `newer_than:` / `older_than:`. */
export function planGraphQuery(ast: QueryAst, now: Date = new Date()): GraphQueryPlan {
  const { folder, rest } = takeFolder(ast.nodes);
  const classified = rest.map((node) => ({ node, ...classify(node, now) }));
  const needsSearch = classified.some((c) => c.search && !c.filter);
  const scope = folder ? { folder } : {};
  if (!needsSearch) {
    const clientFilter = classified.filter((c) => !c.filter).map((c) => c.node);
    const filter = filterExpression(classified.flatMap((c) => (c.filter ? [c.filter] : [])));
    return {
      strategy: "filter",
      ...(filter ? { filter } : {}),
      ...scope,
      clientFilter,
      translation: clientFilter.length ? "graph:$filter+clientFilter" : "graph:$filter",
    };
  }
  const search = classified.flatMap((c) => (c.search ? [c.search] : [])).join(" AND ");
  const clientFilter = classified.filter((c) => !c.search).map((c) => c.node);
  return {
    strategy: clientFilter.length ? "search+clientFilter" : "search",
    search,
    ...scope,
    clientFilter,
    translation: clientFilter.length ? "graph:$search+clientFilter" : "graph:$search",
  };
}

/**
 * A provider-native Graph query (`rawQuery`, `countIds(…, { raw: true })`): `$filter=<OData>` runs
 * on the filter path, anything else is KQL for `$search`.
 */
export function planRawGraphQuery(raw: string): GraphQueryPlan {
  const trimmed = raw.trim();
  if (/^\$filter=/i.test(trimmed)) {
    return {
      strategy: "filter",
      filter: trimmed.slice("$filter=".length),
      clientFilter: [],
      translation: "graph:$filter(raw)",
    };
  }
  if (!trimmed) {
    return { strategy: "filter", clientFilter: [], translation: "graph:$filter" };
  }
  return {
    strategy: "search",
    search: trimmed,
    clientFilter: [],
    translation: "graph:$search(raw)",
  };
}
