import type { ActionQuery, EmailQuery } from "@passport/types";
import { ApiError } from "./errors.js";
import { categories, integer, member, object, statuses } from "./validation.js";
export const csv = (value?: string) => value?.split(",").filter(Boolean);
export const limit = (value?: string) =>
  value === undefined ? undefined : integer(Number(value), "limit", 1, 500);
export function timestamp(value: string | undefined): string | undefined {
  if (
    value !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))
  ) {
    throw new ApiError("INVALID_QUERY", "Expected an ISO timestamp");
  }
  return value;
}
export function actionQuery(q: Record<string, string>): ActionQuery {
  return {
    status: csv(q.status)?.map((s) => member(s, statuses, "status")),
    category: q.category ? member(q.category, categories, "category") : undefined,
    actorKind: q.actorKind
      ? member(q.actorKind, ["human", "agent", "external-agent"], "actorKind")
      : undefined,
    runId: q.runId,
    matterId: q.matterId,
    after: timestamp(q.after),
    before: timestamp(q.before),
    limit: limit(q.limit),
    cursor: q.cursor,
  };
}
export function emailQuery(q: Record<string, string>): EmailQuery {
  if (q.includeBodies && !["true", "false"].includes(q.includeBodies)) {
    throw new ApiError("INVALID_QUERY", "includeBodies must be true or false");
  }
  if (q.includeDeleted && !["true", "false"].includes(q.includeDeleted)) {
    throw new ApiError("INVALID_QUERY", "includeDeleted must be true or false");
  }
  return {
    accountId: q.accountId,
    mailboxId: q.mailboxId,
    threadId: q.threadId,
    matterId: q.matterId === "null" ? null : q.matterId,
    personId: q.personId,
    text: q.text,
    category: q.category ? member(q.category, categories, "category") : undefined,
    after: timestamp(q.after),
    before: timestamp(q.before),
    limit: limit(q.limit),
    cursor: q.cursor,
    sort: q.sort ? member(q.sort, ["receivedAt_desc", "receivedAt_asc"], "sort") : undefined,
    includeBodies: q.includeBodies === "true",
    includeDeleted: q.includeDeleted === "true",
    keywords: q.has || q.not ? { has: csv(q.has), not: csv(q.not) } : undefined,
  };
}
export async function jsonBody(
  request: Request,
  optional = false,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim() && optional) {
    return {};
  }
  try {
    return object(JSON.parse(text));
  } catch (error) {
    // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError("INVALID_JSON", "Expected a JSON object");
  }
}
