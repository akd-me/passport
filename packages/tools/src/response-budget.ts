import { ToolError } from "./presentation.js";

export const DEFAULT_RESPONSE_BYTE_BUDGET = 512 * 1024;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

export function responseByteBudget(value = DEFAULT_RESPONSE_BYTE_BUDGET): number {
  if (!Number.isSafeInteger(value) || value < 1024) {
    throw new ToolError(
      "INVALID_RESPONSE_BUDGET",
      "Response byte budget must be an integer of at least 1024.",
    );
  }
  return value;
}

/** Prefix offsets use UTF-16 code units, without splitting a surrogate pair. */
function bodyPrefix(text: string, length: number): string {
  if (length > 0 && length < text.length && /[\uD800-\uDBFF]/.test(text[length - 1]!)) {
    length--;
  }
  return text.slice(0, length);
}

interface Clippable {
  parent: Record<string, unknown>;
  key: string;
  original: string;
  body: boolean;
}

interface ListEntry {
  parent: Record<string, unknown>;
  key: string;
  original: unknown[];
  size: number;
}

/** Lists trimmed per pass, largest first; bounds the serialisations a pathological result costs. */
const MAX_LISTS = 40;
const BODY_KEY = /^(textBody|htmlBody|body|bodyText|text|markdown)$/;
const CLIPPABLE_KEY =
  /^(textBody|htmlBody|body|bodyText|text|markdown|description|summary|notes|preview|subject|title|name|reason|actionReason|policy_note)$/;

/**
 * Bound the entire serialized result, including JSON escaping and multi-email responses:
 *  1. clip body strings (with `continueFrom`), keeping every item;
 *  2. otherwise drop trailing list items (grep matches, provider lists, export files), keeping
 *     at least one per list, then re-clip bodies; `omittedItems` counts what was dropped;
 *  3. otherwise blank metadata strings; else `RESPONSE_TOO_LARGE`.
 * A root `continueFrom` (mail_read) becomes the lowest per-body resume point.
 */
export function limitResponse<T extends object>(
  value: T,
  budget = DEFAULT_RESPONSE_BYTE_BUDGET,
): T {
  responseByteBudget(budget);
  if (bytes(value) <= budget) {
    return value;
  }
  const result = structuredClone(value);
  const root = result as Record<string, unknown>;
  const strings: Clippable[] = [];
  const lists: ListEntry[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      // Identifiers, cursors and policy outcomes must remain intact.
      if (typeof child === "string" && CLIPPABLE_KEY.test(key)) {
        strings.push({
          parent: node as Record<string, unknown>,
          key,
          original: child,
          body: BODY_KEY.test(key),
        });
      } else if (typeof child === "object") {
        if (Array.isArray(child) && child.length > 1 && key !== "untrusted") {
          lists.push({ parent: node as Record<string, unknown>, key, original: child, size: 0 });
        }
        visit(child);
      }
    }
  };
  visit(result);
  const rootContinue = root.continueFrom;
  root.truncated = true;
  const bodies = strings.filter((string) => string.body);
  const parents = new Map(
    bodies.map(({ parent }) => [
      parent,
      { truncated: parent.truncated, continueFrom: parent.continueFrom },
    ]),
  );
  const markBodies = (length: number) => {
    for (const [parent, original] of parents) {
      parent.truncated = original.truncated;
      delete parent.continueFrom;
      if (original.continueFrom !== undefined) {
        parent.continueFrom = original.continueFrom;
      }
    }
    for (const { parent, key, original } of bodies) {
      const text = bodyPrefix(original, Math.min(length, original.length));
      parent[key] = text;
      if (text.length === original.length) {
        continue;
      }
      parent.truncated = true;
      const next = (typeof parent.offset === "number" ? parent.offset : 0) + text.length;
      parent.continueFrom = Math.min(
        typeof parent.continueFrom === "number" ? parent.continueFrom : Infinity,
        next,
      );
      if (parent.uri) {
        parent._meta = { truncated: true, continueFrom: parent.continueFrom };
      }
    }
  };
  const fit = (max: number, mark: (length: number) => void) => {
    let low = 0,
      high = max;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      mark(mid);
      if (bytes(result) <= budget) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    mark(low);
  };
  const fitBodies = () => {
    if (!bodies.length) {
      return bytes(result) <= budget;
    }
    markBodies(0);
    if (bytes(result) > budget) {
      return false;
    }
    fit(Math.max(...bodies.map((body) => body.original.length)), markBodies);
    syncRootContinue(root, rootContinue, [...parents.keys()]);
    return true;
  };
  if (fitBodies()) {
    return result;
  }
  markBodies(Number.MAX_SAFE_INTEGER);
  if (trimLists(root, lists, budget) && fitBodies()) {
    return result;
  }
  const metadata = strings
    .filter((string) => !string.body)
    .sort((a, b) => b.original.length - a.original.length);
  for (const { parent, key, original } of metadata) {
    parent.truncated = true;
    parent[key] = "";
    if (bytes(result) > budget) {
      continue;
    }
    fit(original.length, (length) => {
      parent[key] = bodyPrefix(original, length);
    });
    return result;
  }
  throw new ToolError(
    "RESPONSE_TOO_LARGE",
    "Response metadata exceeds the byte budget; request fewer results.",
  );
}

/** A root `continueFrom` must not point past text a later pass clipped away (R4-15). */
function syncRootContinue(
  root: Record<string, unknown>,
  original: unknown,
  parents: Array<Record<string, unknown>>,
) {
  if (!("continueFrom" in root) || parents.includes(root)) {
    return;
  }
  const resume = parents
    .map((parent) => parent.continueFrom)
    .concat(original)
    .filter((value): value is number => typeof value === "number");
  if (resume.length) {
    root.continueFrom = Math.min(...resume);
  }
}

/**
 * Drops trailing items from the largest lists until the result (bodies unclipped) fits or every
 * list is down to one item. Returns whether anything was dropped.
 */
function trimLists(root: Record<string, unknown>, lists: ListEntry[], budget: number): boolean {
  for (const list of lists) {
    list.size = bytes(list.original);
  }
  let omitted = 0;
  for (const list of lists.sort((a, b) => b.size - a.size).slice(0, MAX_LISTS)) {
    if (bytes(root) <= budget) {
      break;
    }
    let low = 1,
      high = list.original.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      list.parent[list.key] = list.original.slice(0, mid);
      if (bytes(root) <= budget) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    list.parent[list.key] = list.original.slice(0, low);
    omitted += list.original.length - low;
  }
  if (omitted) {
    root.omittedItems = omitted;
  }
  return omitted > 0;
}
