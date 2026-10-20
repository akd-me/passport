import { ToolError } from "./presentation.js";

export const DEFAULT_RESPONSE_BYTE_BUDGET = 512 * 1024;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

export function responseByteBudget(value = DEFAULT_RESPONSE_BYTE_BUDGET): number {
  if (!Number.isSafeInteger(value) || value < 1024) throw new ToolError("INVALID_RESPONSE_BUDGET", "Response byte budget must be an integer of at least 1024.");
  return value;
}

/** Prefix offsets use UTF-16 code units, without splitting a surrogate pair. */
export function bodyPrefix(text: string, length: number): string {
  if (length > 0 && length < text.length && /[\uD800-\uDBFF]/.test(text[length - 1]!)) length--;
  return text.slice(0, length);
}

/** Bound the entire serialized result, including JSON escaping and multi-email responses. */
export function limitResponse<T extends object>(value: T, budget = DEFAULT_RESPONSE_BYTE_BUDGET): T {
  responseByteBudget(budget);
  if (bytes(value) <= budget) return value;
  const result = structuredClone(value);
  const strings: Array<{ parent: Record<string, unknown>; key: string; original: string; body: boolean }> = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      // Identifiers, cursors and policy outcomes must remain intact.
      if (typeof child === "string" && /^(textBody|htmlBody|body|text|markdown|description|summary|notes|preview|subject|title|name|reason|actionReason|policy_note)$/.test(key)) {
        strings.push({ parent: node as Record<string, unknown>, key, original: child, body: /^(textBody|htmlBody|body|text|markdown)$/.test(key) });
      } else if (typeof child === "object") visit(child);
    }
  };
  visit(result);
  (result as Record<string, unknown>).truncated = true;
  const bodies = strings.filter(string => string.body);
  const parents = new Map(bodies.map(({ parent }) => [parent, { truncated: parent.truncated, continueFrom: parent.continueFrom }]));
  const markBodies = (length: number) => {
    for (const [parent, original] of parents) {
      parent.truncated = original.truncated;
      delete parent.continueFrom;
      if (original.continueFrom !== undefined) parent.continueFrom = original.continueFrom;
    }
    for (const { parent, key, original } of bodies) {
      const text = bodyPrefix(original, Math.min(length, original.length));
      parent[key] = text;
      if (text.length === original.length) continue;
      parent.truncated = true;
      const next = (typeof parent.offset === "number" ? parent.offset : 0) + text.length;
      parent.continueFrom = Math.min(typeof parent.continueFrom === "number" ? parent.continueFrom : Infinity, next);
      if (parent.uri) parent._meta = { truncated: true, continueFrom: parent.continueFrom };
    }
  };
  const fit = (max: number, mark: (length: number) => void) => {
    let low = 0, high = max;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      mark(mid);
      if (bytes(result) <= budget) low = mid; else high = mid - 1;
    }
    mark(low);
  };
  if (bodies.length) {
    markBodies(0);
    if (bytes(result) <= budget) {
      fit(Math.max(...bodies.map(body => body.original.length)), markBodies);
      return result;
    }
  }
  const metadata = strings.filter(string => !string.body).sort((a, b) => b.original.length - a.original.length);
  for (const { parent, key, original } of metadata) {
    parent.truncated = true;
    parent[key] = "";
    if (bytes(result) > budget) continue;
    fit(original.length, length => { parent[key] = bodyPrefix(original, length); });
    return result;
  }
  throw new ToolError("RESPONSE_TOO_LARGE", "Response metadata exceeds the byte budget; request fewer results.");
}
