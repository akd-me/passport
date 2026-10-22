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

/** An account left out of a multi-account search, with a bounded code (R4-13). */
interface Skipped {
  account: string;
  code: string;
  retryAfterSeconds?: number;
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function skippedFor(account: string, error: unknown): Skipped {
  const failure = error as { code?: unknown; retryAfterSeconds?: unknown };
  const code = typeof failure?.code === "string" && SAFE_CODE.test(failure.code);
  return {
    account,
    code: code ? (failure.code as string) : "PROVIDER_ERROR",
    ...(typeof failure?.retryAfterSeconds === "number"
      ? { retryAfterSeconds: Math.max(1, Math.ceil(failure.retryAfterSeconds)) }
      : {}),
  };
}

async function readersFor(backend: Backend, store: Store, account: string | undefined) {
  const accounts = account
    ? [required(await store.accounts.get(account), "Account")]
    : (await store.accounts.list()).filter((a) => a.capabilities.mail);
  const found: Array<{ accountId: string; reader: MailReader }> = [];
  const skipped: Skipped[] = [];
  for (const { id: accountId, settings } of accounts) {
    // A single failing account (e.g. needs sign-in) does not hide the others.
    if (!account && settings.reauthorizationRequired === true) {
      skipped.push({ account: accountId, code: "REAUTHORIZE_REQUIRED" });
      continue;
    }
    const reader = await backend.readers?.(accountId).catch((error: unknown) => {
      if (account) {
        throw error;
      }
      skipped.push(skippedFor(accountId, error));
      return null;
    });
    if (reader) {
      found.push({ accountId, reader });
    }
  }
  return { found, skipped };
}

export function installMailRoutes(app: Hono, backend: Backend): void {
  /** Provider search (`q` portable query, `account`, `limit`, `pageToken`); cache-only fallback. */
  app.get("/api/emails", async (c) => {
    const q = c.req.query();
    const { found: readers, skipped } = await readersFor(
      backend,
      backend.store,
      q.account ?? q.accountId,
    );
    if (!readers.length && !skipped.length) {
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
    const search = (reader: MailReader) =>
      reader.search({
        ...(q.q ? { query: q.q } : {}),
        limit,
        ...(q.pageToken ? { pageToken: q.pageToken } : {}),
      });
    if (q.account ?? q.accountId) {
      return provider(c, async () => {
        const page = await search(readers[0]!.reader);
        return c.json(page);
      });
    }
    return provider(c, async () => {
      const settled = await Promise.allSettled(readers.map(({ reader }) => search(reader)));
      const pages = [];
      const failures: unknown[] = [];
      for (const [index, result] of settled.entries()) {
        if (result.status === "fulfilled") {
          pages.push(result.value);
        } else {
          failures.push(result.reason);
          skipped.push(skippedFor(readers[index]!.accountId, result.reason));
        }
      }
      if (!pages.length && failures.length) {
        // Every searched account failed: 429 only when all of them are throttled.
        const limited = (f: unknown) => (f as { code?: string }).code === "RATE_LIMITED";
        throw failures.every(limited) ? failures[0] : failures.find((f) => !limited(f));
      }
      const items: MailRow[] = pages
        .flatMap((page) => page.items)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, limit);
      const [only] = pages;
      return c.json(
        readers.length === 1 && only
          ? { ...only, items, skipped }
          : { items, source: "provider", cost: sumCosts(pages.map((page) => page.cost)), skipped },
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
