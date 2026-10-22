import type {
  Account,
  Email,
  EmailGetOptions,
  EnvelopeFreshness,
  MailEnvelope,
  MailReader,
  MailReaderResolver,
  Store,
  Thread,
} from "@passport/types";
import { mailHandle, parseMailHandle, watcherTickKey } from "@passport/types";
import type { StoreDatabase } from "./store-database.js";
import { createEviction } from "./store-email-eviction.js";
import {
  createRevalidation,
  ENVELOPE_BATCH,
  localMailboxIds,
  readOptions,
} from "./store-email-revalidate.js";
import type { EmailRows } from "./store-email-rows.js";
import type { Row } from "./store-query.js";
import { unique } from "./store-query.js";

export { localMailboxIds };

/**
 * Read-through envelope cache over the `emails` table (contract: `@passport/types`
 * store-ondemand.ts). Without a resolver every method behaves exactly like the v0.2 mirror.
 */
export function createEmailCache(
  db: StoreDatabase,
  rows: EmailRows,
  resolver: () => MailReaderResolver | null,
) {
  const { refresh, fetchBody } = createRevalidation(db, rows);
  const isStale = (row: Row): boolean => {
    const tick = db.one("SELECT value FROM kv WHERE key = ?", [
      watcherTickKey(row.account_id as string),
    ])?.value as string | undefined;
    if (!tick) {
      return false;
    }
    const fresh = row.labels_fresh_at as string | null;
    return fresh === null || Date.parse(fresh) < Date.parse(tick);
  };
  const onDemand = (accountId: string) =>
    db.get<Account>("accounts", accountId)?.capabilities.onDemand === true;
  const threadOf = (email: Email) => {
    const thread = db.get<Thread>("threads", email.threadId) ?? {
      id: email.threadId,
      accountId: email.accountId,
      emailIds: [],
    };
    if (!thread.emailIds.includes(email.id)) {
      thread.emailIds.push(email.id);
      db.put("threads", thread.id, thread, { account_id: thread.accountId });
    }
  };
  /** Caches a provider envelope under `id` (the mail handle for new rows). */
  const insertEnvelope = (accountId: string, envelope: MailEnvelope, id: string): void => {
    const { matterId: _matter, ...fields } = envelope;
    const email: Email = {
      ...fields,
      id,
      accountId,
      mailboxIds: localMailboxIds(db, accountId, envelope.mailboxIds),
      personIds: envelope.personIds ?? [],
      category: envelope.category ?? null,
    };
    db.transaction(() => {
      rows.saveEmail(email, { labelsFresh: true });
      threadOf(email);
    });
  };
  /**
   * The account's reader. `strict` (misses: no cached copy to serve) and `fresh` propagate
   * resolution errors; otherwise a failure is reported so the cached rows are marked stale.
   */
  const readerFor = async (
    accountId: string,
    opts: EmailGetOptions,
    strict: boolean,
  ): Promise<{ reader: MailReader | null; failed: boolean }> => {
    const resolve = opts.cacheOnly ? null : resolver();
    if (!resolve) {
      return { reader: null, failed: false };
    }
    try {
      return { reader: await resolve(accountId), failed: false };
    } catch (error) {
      if (strict || opts.fresh) {
        throw error;
      }
      return { reader: null, failed: true };
    }
  };
  /** Fetches and caches envelopes for uncached provider ids (one call per batch). */
  const fetchMissing = async (accountId: string, providerIds: string[], opts: EmailGetOptions) => {
    const { reader } = providerIds.length
      ? await readerFor(accountId, opts, true)
      : { reader: null };
    for (let i = 0; reader && i < providerIds.length; i += ENVELOPE_BATCH) {
      const chunk = providerIds.slice(i, i + ENVELOPE_BATCH);
      const found = (await reader.envelopes(chunk, readOptions(opts))).value;
      for (const providerId of chunk) {
        const envelope = found.get(providerId);
        if (envelope && !rows.rowByProvider(accountId, providerId)) {
          insertEnvelope(accountId, envelope, mailHandle(accountId, "email", providerId));
        }
      }
    }
  };
  /**
   * Revalidates labels (when `fresh` or older than the watcher tick) and fills bodies (when asked
   * and none are cached), batched per account; touches the rows; marks rows served from cache
   * after a provider failure with `staleAsOf`. `fetched` rows were just read and are not re-read.
   */
  const finish = async (
    targets: Row[],
    opts: EmailGetOptions,
    includeBodies: boolean,
    fetched: Set<string> = new Set(),
  ): Promise<Map<string, Email | null>> => {
    const stale = new Set<string>();
    const byAccount = new Map<string, Row[]>();
    for (const row of targets) {
      const group = byAccount.get(row.account_id as string) ?? [];
      group.push(row);
      byAccount.set(row.account_id as string, group);
    }
    for (const [accountId, group] of byAccount) {
      const labels = group.filter(
        (row) => !fetched.has(row.id as string) && (opts.fresh === true || isStale(row)),
      );
      const bodies =
        opts.includeBodies === true ? group.filter((row) => row.body_fetched_at === null) : [];
      if (!labels.length && !bodies.length) {
        continue;
      }
      const { reader, failed } = await readerFor(accountId, opts, false);
      if (!reader) {
        // Provider truth was wanted but is unavailable: say so instead of degrading silently.
        if (failed || (opts.fresh && resolver() !== null && onDemand(accountId))) {
          for (const row of group) {
            stale.add(row.id as string);
          }
        }
        continue;
      }
      for (const id of await refresh(reader, labels, opts)) {
        stale.add(id);
      }
      for (const row of bodies) {
        if (!(await fetchBody(reader, row.id as string, opts))) {
          stale.add(row.id as string);
        }
      }
    }
    const result = new Map<string, Email | null>();
    for (const row of targets) {
      const id = row.id as string;
      rows.touch(id, true);
      const email = rows.getEmail(id, includeBodies);
      if (email && stale.has(id)) {
        email.staleAsOf = (rows.rowById(id, false)?.labels_fresh_at as string | null) ?? null;
      }
      result.set(id, email);
    }
    return result;
  };
  /** Local row for an id or handle, else (handle misses) fetched in one batch per account. */
  const many = async (ids: string[], opts: EmailGetOptions): Promise<Map<string, Email | null>> => {
    const located = new Map<string, Row>();
    const misses = new Map<string, Array<{ id: string; providerId: string }>>();
    for (const id of unique(ids)) {
      const handle = parseMailHandle(id);
      const row =
        rows.rowById(id, false) ??
        (handle?.type === "email"
          ? rows.rowByProvider(handle.accountId, handle.providerId)
          : undefined);
      if (row) {
        located.set(id, row);
      } else if (handle?.type === "email") {
        const wanted = misses.get(handle.accountId) ?? [];
        wanted.push({ id, providerId: handle.providerId });
        misses.set(handle.accountId, wanted);
      }
    }
    const fetched = new Set<string>();
    for (const [accountId, wanted] of misses) {
      await fetchMissing(
        accountId,
        wanted.map((item) => item.providerId),
        opts,
      );
      for (const item of wanted) {
        const row = rows.rowByProvider(accountId, item.providerId);
        if (row) {
          located.set(item.id, row);
          fetched.add(row.id as string);
        }
      }
    }
    const distinct = [...new Map([...located.values()].map((row) => [row.id, row])).values()];
    const emails = await finish(distinct, opts, opts.includeBodies ?? true, fetched);
    return new Map(
      ids.map((id) => {
        const row = located.get(id);
        return [id, row ? (emails.get(row.id as string) ?? null) : null];
      }),
    );
  };
  const get: Store["emails"]["get"] = async (id, opts = {}) =>
    (await many([id], opts)).get(id) ?? null;
  const getMany = (ids: string[], opts: EmailGetOptions = {}) => many(ids, opts);
  const getByProviderId: Store["emails"]["getByProviderId"] = async (
    accountId,
    providerId,
    opts = {},
  ) => {
    let row = rows.rowByProvider(accountId, providerId);
    let fetched = false;
    if (!row) {
      await fetchMissing(accountId, [providerId], opts);
      row = rows.rowByProvider(accountId, providerId);
      fetched = true;
    }
    if (!row) {
      return null;
    }
    const emails = await finish(
      [row],
      opts,
      opts.includeBodies ?? true,
      new Set(fetched ? [row.id as string] : []),
    );
    return emails.get(row.id as string) ?? null;
  };
  const touch = async (ids: string[]) =>
    db.transaction(() => {
      for (const id of unique(ids)) {
        rows.touch(id);
      }
    });
  const freshness = async (id: string): Promise<EnvelopeFreshness | null> => {
    const row = db.one(
      "SELECT labels_fresh_at, touched_at, body_fetched_at FROM emails WHERE id = ?",
      [id],
    );
    return row
      ? {
          labelsFreshAt: row.labels_fresh_at as string | null,
          touchedAt: row.touched_at as string | null,
          bodyFetchedAt: row.body_fetched_at as string | null,
        }
      : null;
  };
  return { get, getMany, getByProviderId, touch, freshness, ...createEviction(db, rows) };
}
