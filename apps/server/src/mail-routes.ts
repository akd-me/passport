import {
  type MailReader,
  type MailRow,
  parseMailHandle,
  type ReadCost,
  type Store,
} from "@passport/types";
import type { Context, Hono } from "hono";
import type { Backend } from "./backend.js";
import { ApiError, required } from "./errors.js";
import { readEmail } from "./ondemand-wiring.js";
import { emailQuery } from "./route-input.js";
import { integer } from "./validation.js";

/** RATE_LIMITED reads answer 429 with the governor's retry hint instead of blocking. */
async function provider<T>(c: Context, read: () => Promise<T>): Promise<T | Response> {
  try {
    return await read();
  } catch (error) {
    const failure = error as { code?: string; retryAfterSeconds?: number; scope?: string };
    if (failure.code === "RATE_LIMITED") {
      const retryAfterSeconds = Math.max(1, Math.ceil(failure.retryAfterSeconds ?? 1));
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json(
        {
          error: { code: "RATE_LIMITED", message: "Provider quota reached; retry shortly." },
          retryAfterSeconds,
          scope: failure.scope ?? "provider:http",
        },
        429,
      );
    }
    if (failure.code === "NOT_FOUND" || failure.code === "STALE_ID") {
      throw new ApiError("NOT_FOUND", "Not found", 404);
    }
    throw error;
  }
}

function sumCosts(costs: ReadCost[]): ReadCost {
  const total: ReadCost = {};
  for (const cost of costs) {
    for (const key of ["gmailUnits", "graphRequests", "imapCommands"] as const) {
      if (cost[key] !== undefined) {
        total[key] = (total[key] ?? 0) + cost[key];
      }
    }
  }
  return total;
}

async function readersFor(backend: Backend, store: Store, account: string | undefined) {
  const ids = account
    ? [required(await store.accounts.get(account), "Account").id]
    : (await store.accounts.list()).filter((a) => a.capabilities.mail).map((a) => a.id);
  const found: Array<{ accountId: string; reader: MailReader }> = [];
  for (const accountId of ids) {
    // A single failing account (e.g. needs sign-in) does not hide the others.
    const reader = await backend.readers?.(accountId).catch((error: unknown) => {
      if (account) {
        throw error;
      }
      return null;
    });
    if (reader) {
      found.push({ accountId, reader });
    }
  }
  return found;
}

export function installMailRoutes(app: Hono, backend: Backend): void {
  /** Provider search (`q` portable query, `account`, `limit`, `pageToken`); cache-only fallback. */
  app.get("/api/emails", async (c) => {
    const q = c.req.query();
    const readers = await readersFor(backend, backend.store, q.account ?? q.accountId);
    if (!readers.length) {
      // No on-demand reader (demo, or a provider without one): only what is cached locally.
      const page = await backend.store.emails.query(
        emailQuery({
          ...q,
          ...(q.q ? { text: q.q } : {}),
          ...(q.account ? { accountId: q.account } : {}),
        }),
      );
      return c.json({ ...page, source: "cache" });
    }
    const limit = q.limit === undefined ? 25 : integer(Number(q.limit), "limit", 1, 100);
    if (q.pageToken && readers.length > 1) {
      throw new ApiError("INVALID_QUERY", "pageToken requires account");
    }
    return provider(c, async () => {
      const pages = await Promise.all(
        readers.map(({ reader }) =>
          reader.search({
            ...(q.q ? { query: q.q } : {}),
            limit,
            ...(q.pageToken ? { pageToken: q.pageToken } : {}),
          }),
        ),
      );
      const items: MailRow[] = pages
        .flatMap((page) => page.items)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, limit);
      const [only] = pages;
      return c.json(
        pages.length === 1 && only
          ? { ...only, items }
          : { items, source: "provider", cost: sumCosts(pages.map((page) => page.cost)) },
      );
    });
  });
  /** Read-through: cached rows by ULID or handle, else fetched from the provider. */
  app.get("/api/emails/:id", async (c) =>
    provider(c, async () =>
      c.json(required(await readEmail(backend.store, backend.readers, c.req.param("id")), "Email")),
    ),
  );
  app.get("/api/threads/:id", async (c) => {
    const id = c.req.param("id");
    const handle = parseMailHandle(id);
    const reader = handle?.type === "thread" ? await backend.readers?.(handle.accountId) : null;
    if (handle && reader) {
      return provider(c, async () => {
        const { value, ...meta } = await reader.thread(handle.providerId, { format: "text" });
        return c.json({
          thread: { id, accountId: handle.accountId, emailIds: value.map((email) => email.id) },
          emails: { items: value, nextCursor: null, total: value.length },
          ...meta,
        });
      });
    }
    const thread = required(await backend.store.threads.get(id), "Thread");
    return c.json({
      thread,
      emails: await backend.store.emails.query({
        threadId: thread.id,
        includeBodies: true,
        includeDeleted: true,
        limit: 500,
        sort: "receivedAt_asc",
      }),
      source: "cache",
    });
  });
}
