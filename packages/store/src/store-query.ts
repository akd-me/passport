import { StoreError } from "./errors.js";
export type Row = Record<string, unknown>;
export type Cursor = { v: 1; sort: string; at: string; id: string };
export function limitOf(limit = 50): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit >= Number.MAX_SAFE_INTEGER) {
    throw new StoreError("INVALID_QUERY", "limit must be a positive safe integer");
  }
  return limit;
}
export function decodeCursor(value: string, sort: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error();
    }
    const cursor: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!cursor || typeof cursor !== "object") {
      throw new Error();
    }
    const c = cursor as Partial<Cursor>;
    if (
      c.v !== 1 ||
      c.sort !== sort ||
      typeof c.at !== "string" ||
      !Number.isFinite(Date.parse(c.at)) ||
      typeof c.id !== "string" ||
      !c.id
    ) {
      throw new Error();
    }
    return c as Cursor;
  } catch {
    // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

    throw new StoreError(
      "INVALID_CURSOR",
      "Invalid cursor or cursor sort does not match the query",
    );
  }
}
export function nextCursor(sort: string, at: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, sort, at, id })).toString("base64url");
}
export function unique(values: string[]): string[] {
  return [...new Set(values)];
}
export function definedPatch<T extends object>(patch: T): T {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as T;
}
export function latest(a?: string | null, b?: string | null): string | null {
  return a && b ? (a > b ? a : b) : (a ?? b ?? null);
}
export function like(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}
