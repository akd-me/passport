import type { MailboxRole } from "@passport/types";
import { ProviderError } from "./errors.js";
import { type QueryAst, type QueryNode, relativeCutoff } from "./query.js";

/** A JMAP `FilterCondition` or `FilterOperator` (RFC 8621 §4.4.1). `{}` matches everything. */
export type JmapFilter = Record<string, unknown>;

/** `Mailbox/get` fields the reader uses. */
export interface JmapMailboxInfo {
  id: string;
  name: string;
  role?: MailboxRole;
  parentId?: string | null;
  totalEmails?: number;
  unreadEmails?: number;
}

/** Properties fetched for rows and envelopes (headers by name, no bodies). */
export const JMAP_ROW_PROPERTIES = [
  "id",
  "threadId",
  "mailboxIds",
  "keywords",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "receivedAt",
  "preview",
  "size",
  "messageId",
  "inReplyTo",
  "references",
  "attachments",
  "header:List-Id:asText",
  "header:List-Unsubscribe:asText",
  "header:Authentication-Results:asText:all",
];

/** Properties fetched for `body` and `thread` (all headers plus body values). */
export const JMAP_BODY_PROPERTIES = [
  ...JMAP_ROW_PROPERTIES.filter((p) => !p.startsWith("header:")),
  "headers",
  "textBody",
  "htmlBody",
  "bodyValues",
];

/** Turns the `header:*` row properties back into the `headers` list `normalizeJmap` reads. */
export function rowHeaders(raw: Record<string, unknown>): Array<{ name: string; value: string }> {
  const headers: Array<{ name: string; value: string }> = [];
  for (const [property, name] of [
    ["header:List-Id:asText", "List-Id"],
    ["header:List-Unsubscribe:asText", "List-Unsubscribe"],
  ] as const) {
    const value = raw[property];
    if (typeof value === "string" && value.trim()) {
      headers.push({ name, value: value.trim() });
    }
  }
  const auth = raw["header:Authentication-Results:asText:all"];
  for (const value of Array.isArray(auth) ? auth : []) {
    if (typeof value === "string") {
      headers.push({ name: "Authentication-Results", value: value.trim() });
    }
  }
  return headers;
}

const ROLE_OF: Record<string, MailboxRole> = {
  inbox: "inbox",
  sent: "sent",
  drafts: "drafts",
  spam: "junk",
  trash: "trash",
  archive: "archive",
};

/** Finds a mailbox by provider id, role (`in:` names) or display name, case-insensitively. */
export function findMailbox(
  boxes: readonly JmapMailboxInfo[],
  value: string,
): JmapMailboxInfo | undefined {
  const lower = value.toLowerCase();
  const role = ROLE_OF[lower] ?? (lower === "junk" ? "junk" : undefined);
  return (
    boxes.find((m) => m.id === value) ??
    (role ? boxes.find((m) => m.role === role) : undefined) ??
    boxes.find((m) => m.name.toLowerCase() === lower)
  );
}

interface FilterContext {
  now: Date;
  boxes: readonly JmapMailboxInfo[];
  /** Translation notes for approximate mappings. */
  notes: Set<string>;
}

function container(value: string, ctx: FilterContext): JmapFilter {
  if (value === "anywhere") {
    return {};
  }
  const box = findMailbox(ctx.boxes, value);
  if (!box) {
    throw new ProviderError("NOT_FOUND", "Label or folder does not exist");
  }
  return { inMailbox: box.id };
}

function fieldFilter(node: Extract<QueryNode, { kind: "field" }>, ctx: FilterContext): JmapFilter {
  switch (node.field) {
    case "with":
      return {
        operator: "OR",
        conditions: (["from", "to", "cc", "bcc"] as const).map((f) => ({ [f]: node.value })),
      };
    case "filename":
      // RFC 8621 has no attachment-name condition; full-text search covers part names on most servers.
      ctx.notes.add("filename→text");
      return { text: node.value };
    case "list":
      return { header: ["List-Id", node.value] };
    case "rfc822msgid":
      return { header: ["Message-ID", `<${node.value.replace(/^<|>$/g, "")}>`] };
    default:
      return { [node.field]: node.value };
  }
}

function nodeFilter(node: QueryNode, ctx: FilterContext): JmapFilter {
  switch (node.kind) {
    case "and":
      return { operator: "AND", conditions: node.nodes.map((n) => nodeFilter(n, ctx)) };
    case "or":
      return { operator: "OR", conditions: node.nodes.map((n) => nodeFilter(n, ctx)) };
    case "not":
      return { operator: "NOT", conditions: [nodeFilter(node.node, ctx)] };
    case "text":
      return { text: node.value };
    case "field":
      return fieldFilter(node, ctx);
    case "has":
      return { hasAttachment: true };
    case "is":
      if (node.value === "flagged") {
        return { hasKeyword: "$flagged" };
      }
      return node.value === "unread" ? { notKeyword: "$seen" } : { hasKeyword: "$seen" };
    case "in":
    case "label":
      return container(node.value, ctx);
    case "date":
      return { [node.op]: node.at };
    case "relative": {
      const at = relativeCutoff(node, ctx.now).toISOString();
      return node.op === "newer_than" ? { after: at } : { before: at };
    }
    case "size":
      // minSize is inclusive, `larger:` is strict.
      return node.op === "larger" ? { minSize: node.bytes + 1 } : { maxSize: node.bytes };
  }
}

/** ANDs conditions, dropping match-all `{}` ones; null when nothing constrains the query. */
export function andFilters(conditions: JmapFilter[]): JmapFilter | null {
  const kept = conditions.filter((c) => Object.keys(c).length > 0);
  if (kept.length === 0) {
    return null;
  }
  return kept.length === 1 ? (kept[0] as JmapFilter) : { operator: "AND", conditions: kept };
}

/**
 * Translates a portable query into an `Email/query` filter. Every operator maps to a standard
 * condition except `filename:` (searched as text, noted in `notes`).
 */
export function renderJmapFilter(
  ast: QueryAst,
  options: { now: Date; boxes: readonly JmapMailboxInfo[] },
): { conditions: JmapFilter[]; notes: string[] } {
  const ctx: FilterContext = { ...options, notes: new Set() };
  const conditions = ast.nodes.map((n) => nodeFilter(n, ctx));
  return { conditions, notes: [...ctx.notes] };
}
