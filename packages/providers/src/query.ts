import type { Timestamp } from "@passport/types";
import { ProviderError } from "./errors.js";

/**
 * Portable query mini-language (research report 03 §2.2): a Gmail-flavoured subset every backend
 * can translate. Terms are ANDed; `OR` (uppercase) binds tighter than the implicit AND, `-`
 * negates, parentheses group, and `"…"` is a phrase.
 *
 * | Operator | Meaning |
 * |---|---|
 * | `from:` `to:` `cc:` `bcc:` | participant address or name contains the value |
 * | `with:` | any participant (from, to, cc, bcc) |
 * | `subject:` | subject contains the value (`subject:"a b"` for phrases) |
 * | bare words, `"phrase"` | subject, snippet or body contains the text |
 * | `has:attachment` | at least one non-inline attachment |
 * | `filename:` | an attachment name contains the value (`filename:pdf`) |
 * | `after:` `before:` | `YYYY-MM-DD`, `YYYY/MM/DD` (UTC midnight) or epoch seconds |
 * | `newer_than:` `older_than:` | `Nd`, `Nm` (months), `Ny` |
 * | `in:` | `inbox` `sent` `drafts` `spam` (`junk`) `trash` `archive` `anywhere`, or a folder |
 * | `label:` | a label, folder or category by display name |
 * | `is:` | `unread` `read` `starred` (`flagged`) |
 * | `larger:` `smaller:` | bytes, or with `K` / `M` suffix (1,000-based) |
 * | `list:` | List-Id contains the value |
 * | `rfc822msgid:` | Message-ID equals the value |
 *
 * Gmail operators outside this set (`category:`, `has:drive`, `is:important`, …) are rejected
 * with `INVALID_QUERY`; pass them through `rawQuery` instead. Other `word:value` tokens are text.
 */

/** Fields whose value is matched as text. */
export type QueryField =
  | "from"
  | "to"
  | "cc"
  | "bcc"
  | "with"
  | "subject"
  | "filename"
  | "list"
  | "rfc822msgid";

/** One node of a parsed portable query. */
export type QueryNode =
  | { kind: "and"; nodes: QueryNode[] }
  | { kind: "or"; nodes: QueryNode[] }
  | { kind: "not"; node: QueryNode }
  | { kind: "text"; value: string; phrase: boolean }
  | { kind: "field"; field: QueryField; value: string; phrase: boolean }
  | { kind: "has"; value: "attachment" }
  /** `is:starred` is normalized to `flagged`. */
  | { kind: "is"; value: "unread" | "read" | "flagged" }
  /** Lower-cased; `junk` is normalized to `spam`. Unknown values name a folder or label. */
  | { kind: "in"; value: string }
  | { kind: "label"; value: string }
  /** `after:` is inclusive, `before:` exclusive. `at` is ISO UTC. */
  | { kind: "date"; op: "after" | "before"; at: Timestamp; epochSeconds: number }
  | { kind: "relative"; op: "newer_than" | "older_than"; amount: number; unit: "d" | "m" | "y" }
  | { kind: "size"; op: "larger" | "smaller"; bytes: number };

/** Root of a parsed query: an implicit AND (empty for an empty query). */
export type QueryAst = { kind: "and"; nodes: QueryNode[] };

/** Containers every backend understands in `in:`. */
export const PORTABLE_CONTAINERS = [
  "inbox",
  "sent",
  "drafts",
  "spam",
  "trash",
  "archive",
  "anywhere",
] as const;

const TEXT_FIELDS = new Set<string>([
  "from",
  "to",
  "cc",
  "bcc",
  "with",
  "subject",
  "filename",
  "list",
  "rfc822msgid",
]);

/** Gmail operators with no portable translation. */
const UNSUPPORTED = new Set([
  "category",
  "deliveredto",
  "older",
  "newer",
  "around",
  "header",
  "has",
  "is",
]);

type Token =
  | { type: "open" | "close" | "or" | "not" }
  | { type: "term"; key: string | null; value: string; phrase: boolean };

function invalid(message: string): ProviderError {
  return new ProviderError("INVALID_QUERY", `${message}. Use rawQuery for provider-native syntax.`);
}

function readQuoted(input: string, start: number): { value: string; end: number } {
  const close = input.indexOf('"', start + 1);
  const end = close === -1 ? input.length : close + 1;
  return { value: input.slice(start + 1, close === -1 ? input.length : close), end };
}

/** Reads a bare word, `key:value` or `key:"phrase"` starting at `start`. */
function readWord(input: string, start: number): { token: Token; end: number } {
  let end = start;
  while (end < input.length && !/[\s()"]/.test(input[end] ?? "")) {
    end++;
  }
  const word = input.slice(start, end);
  const colon = word.indexOf(":");
  if (colon > 0 && colon === word.length - 1 && input[end] === '"') {
    const quoted = readQuoted(input, end);
    const token: Token = {
      type: "term",
      key: word.slice(0, -1),
      value: quoted.value,
      phrase: true,
    };
    return { token, end: quoted.end };
  }
  if (word === "OR") {
    return { token: { type: "or" }, end };
  }
  const keyed = colon > 0 && colon < word.length - 1;
  const token: Token = {
    type: "term",
    key: keyed ? word.slice(0, colon) : null,
    value: keyed ? word.slice(colon + 1) : word,
    phrase: false,
  };
  return { token, end };
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] ?? "";
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ type: ch === "(" ? "open" : "close" });
      i++;
      continue;
    }
    if (ch === "-" && i + 1 < input.length && !/[\s)]/.test(input[i + 1] ?? "")) {
      tokens.push({ type: "not" });
      i++;
      continue;
    }
    if (ch === '"') {
      const quoted = readQuoted(input, i);
      tokens.push({ type: "term", key: null, value: quoted.value, phrase: true });
      i = quoted.end;
      continue;
    }
    const word = readWord(input, i);
    tokens.push(word.token);
    i = word.end;
  }
  return tokens;
}

function parseDate(op: "after" | "before", value: string): QueryNode {
  let ms = NaN;
  if (/^\d{9,11}$/.test(value)) {
    ms = Number(value) * 1000;
  } else {
    const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
    if (match) {
      const [, y, m, d] = match.map(Number) as [number, number, number, number];
      ms = Date.UTC(y, m - 1, d);
      if (new Date(ms).getUTCDate() !== d) {
        ms = NaN;
      }
    }
  }
  if (!Number.isFinite(ms)) {
    throw invalid(`${op}: expects YYYY-MM-DD or epoch seconds, got "${value}"`);
  }
  return { kind: "date", op, at: new Date(ms).toISOString(), epochSeconds: Math.floor(ms / 1000) };
}

function parseSize(op: "larger" | "smaller", value: string): QueryNode {
  const match = /^(\d+(?:\.\d+)?)([km]?)b?$/i.exec(value);
  if (!match) {
    throw invalid(`${op}: expects a size such as 500K or 5M`);
  }
  const unit = { "": 1, k: 1_000, m: 1_000_000 }[(match[2] ?? "").toLowerCase()] ?? 1;
  return { kind: "size", op, bytes: Math.round(Number(match[1]) * unit) };
}

/** Converts one `key:value` (or bare) term into a node. */
function termNode(token: Extract<Token, { type: "term" }>): QueryNode {
  const { value, phrase } = token;
  const key = token.key?.toLowerCase() ?? null;
  if (key === null) {
    return { kind: "text", value, phrase };
  }
  if (TEXT_FIELDS.has(key)) {
    return { kind: "field", field: key as QueryField, value, phrase };
  }
  const lower = value.toLowerCase();
  switch (key) {
    case "has":
      if (lower === "attachment") {
        return { kind: "has", value: "attachment" };
      }
      break;
    case "is":
      if (lower === "unread" || lower === "read") {
        return { kind: "is", value: lower };
      }
      if (lower === "starred" || lower === "flagged") {
        return { kind: "is", value: "flagged" };
      }
      break;
    case "in":
      return { kind: "in", value: lower === "junk" ? "spam" : lower };
    case "label":
      return { kind: "label", value };
    case "after":
    case "before":
      return parseDate(key, value);
    case "newer_than":
    case "older_than": {
      const match = /^(\d+)([dmy])$/i.exec(value);
      if (!match) {
        throw invalid(`${key}: expects Nd, Nm or Ny`);
      }
      const unit = (match[2] ?? "d").toLowerCase() as "d" | "m" | "y";
      return { kind: "relative", op: key, amount: Number(match[1]), unit };
    }
    case "larger":
    case "size":
      return parseSize("larger", value);
    case "smaller":
      return parseSize("smaller", value);
  }
  if (UNSUPPORTED.has(key)) {
    throw invalid(`"${key}:${value}" is not part of the portable query language`);
  }
  // Not an operator (for example a URL or "note:"): search it as text.
  return { kind: "text", value: `${token.key}:${value}`, phrase };
}

/** Parses a portable query. Throws `ProviderError("INVALID_QUERY")` with a hint on bad input. */
export function parsePortableQuery(query: string): QueryAst {
  const tokens = tokenize(query);
  let at = 0;
  const peek = () => tokens[at];
  const unary = (): QueryNode => {
    const token = tokens[at++];
    if (!token) {
      throw invalid("Query ends where a term was expected");
    }
    if (token.type === "not") {
      return { kind: "not", node: unary() };
    }
    if (token.type === "open") {
      const inner = sequence(true);
      if (tokens[at++]?.type !== "close") {
        throw invalid("Missing closing parenthesis");
      }
      return inner.nodes.length === 1 && inner.nodes[0] ? inner.nodes[0] : inner;
    }
    if (token.type === "term") {
      return termNode(token);
    }
    throw invalid(token.type === "or" ? "OR needs a term on both sides" : "Unexpected ')'");
  };
  const disjunction = (): QueryNode => {
    const nodes = [unary()];
    while (peek()?.type === "or") {
      at++;
      nodes.push(unary());
    }
    return nodes.length === 1 && nodes[0] ? nodes[0] : { kind: "or", nodes };
  };
  const sequence = (nested: boolean): QueryAst => {
    const nodes: QueryNode[] = [];
    for (let next = peek(); next && !(nested && next.type === "close"); next = peek()) {
      nodes.push(disjunction());
    }
    return { kind: "and", nodes };
  };
  const ast = sequence(false);
  if (at < tokens.length) {
    throw invalid("Unexpected ')'");
  }
  return ast;
}

/** The instant `newer_than:` / `older_than:` compares against, relative to `now` (UTC). */
export function relativeCutoff(node: Extract<QueryNode, { kind: "relative" }>, now: Date): Date {
  const cutoff = new Date(now.getTime());
  if (node.unit === "d") {
    cutoff.setUTCDate(cutoff.getUTCDate() - node.amount);
  } else if (node.unit === "m") {
    cutoff.setUTCMonth(cutoff.getUTCMonth() - node.amount);
  } else {
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - node.amount);
  }
  return cutoff;
}

/**
 * True when the query explicitly scopes to Spam/Trash (`in:spam`, `in:trash`, `in:anywhere`
 * outside a negation), which overrides `includeSpamTrash: false`.
 */
export function queryScopesSpamTrash(ast: QueryNode): boolean {
  switch (ast.kind) {
    case "and":
    case "or":
      return ast.nodes.some(queryScopesSpamTrash);
    case "in":
      return ast.value === "spam" || ast.value === "trash" || ast.value === "anywhere";
    default:
      return false;
  }
}
