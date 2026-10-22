import type {
  Email,
  EmailGetOptions,
  EnvelopeFreshness,
  EvictionResult,
  MailEnvelope,
  MailReader,
  MailReaderResolver,
  MailReadOptions,
  Store,
  Thread,
} from "@passport/types";
import { mailHandle, parseMailHandle, watcherTickKey } from "@passport/types";
import type { StoreDatabase } from "./store-database.js";
import type { EmailRows } from "./store-email-rows.js";
import type { Row } from "./store-query.js";
import { unique } from "./store-query.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const BODY_BYTES =
  "COALESCE(length(CAST(textBody AS BLOB)), 0) + COALESCE(length(CAST(html_body AS BLOB)), 0)";
const NOT_DRAFT =
  "NOT EXISTS (SELECT 1 FROM json_each(data, '$.keywords') k WHERE k.key = '$draft' AND k.type = 'true')";

/** Maps adapter mailbox ids (`account:mailbox:<providerId>`) to cached mailbox rows. */
export function localMailboxIds(db: StoreDatabase, accountId: string, ids: string[]): string[] {
  const prefix = `${accountId}:mailbox:`;
  return unique(
    ids.map((id) => {
      if (!id.startsWith(prefix)) {
        return id;
      }
      let providerId: string;
      try {
        providerId = decodeURIComponent(id.slice(prefix.length));
      } catch {
        // Not an id we issued; keep it verbatim.
        return id;
      }
      const row = db.one("SELECT id FROM mailboxes WHERE account_id = ? AND provider_id = ?", [
        accountId,
        providerId,
      ]);
      return (row?.id as string | undefined) ?? id;
    }),
  );
}

/**
 * Read-through envelope cache over the `emails` table (contract: `@passport/types`
 * store-ondemand.ts). Without a resolver every method behaves exactly like the v0.2 mirror.
 */
export function createEmailCache(
  db: StoreDatabase,
  rows: EmailRows,
  resolver: () => MailReaderResolver | null,
) {
  const readOptions = (opts: EmailGetOptions): MailReadOptions =>
    opts.lane ? { lane: opts.lane } : {};
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
  const revalidate = async (reader: MailReader, row: Row, opts: EmailGetOptions): Promise<void> => {
    const providerId = row.provider_id as string;
    const accountId = row.account_id as string;
    let envelope: MailEnvelope | null;
    try {
      envelope =
        (await reader.envelopes([providerId], readOptions(opts))).value.get(providerId) ?? null;
    } catch (error) {
      // Offline or throttled: serve the cached row unless the caller needs provider truth.
      if (opts.fresh) {
        throw error;
      }
      return;
    }
    const email = rows.getEmail(row.id as string);
    if (!email) {
      return;
    }
    const keywords = envelope ? envelope.keywords : { ...email.keywords, $deleted: true };
    const mailboxIds = envelope
      ? localMailboxIds(db, accountId, envelope.mailboxIds)
      : email.mailboxIds;
    db.transaction(() => rows.saveEmail({ ...email, keywords, mailboxIds }, { labelsFresh: true }));
  };
  const fetchBody = async (reader: MailReader, row: Row, opts: EmailGetOptions) => {
    const body = (await reader.body(row.provider_id as string, readOptions(opts))).value;
    const email = rows.getEmail(row.id as string);
    if (email) {
      db.transaction(() =>
        rows.saveEmail(
          {
            ...email,
            textBody: body.textBody ?? null,
            htmlBody: body.htmlBody ?? null,
            attachments: body.attachments ?? email.attachments,
          },
          { labelsFresh: false },
        ),
      );
    }
  };
  /** Revalidates and fills bodies as requested, touches the row and returns it. */
  const finish = async (row: Row, opts: EmailGetOptions, includeBodies: boolean) => {
    const resolve = opts.cacheOnly ? null : resolver();
    if (resolve) {
      const stale = opts.fresh === true || isStale(row);
      const wantsBody = opts.includeBodies === true && row.body_fetched_at === null;
      if (stale || wantsBody) {
        const reader = await resolve(row.account_id as string);
        if (reader && stale) {
          await revalidate(reader, row, opts);
        }
        if (reader && wantsBody) {
          await fetchBody(reader, row, opts);
        }
      }
    }
    rows.touch(row.id as string);
    return rows.getEmail(row.id as string, includeBodies);
  };
  const fetchEnvelope = async (
    accountId: string,
    providerId: string,
    opts: EmailGetOptions,
  ): Promise<Row | undefined> => {
    const resolve = opts.cacheOnly ? null : resolver();
    const reader = resolve ? await resolve(accountId) : null;
    if (!reader) {
      return undefined;
    }
    const envelope = (await reader.envelopes([providerId], readOptions(opts))).value.get(
      providerId,
    );
    if (!envelope) {
      return undefined;
    }
    insertEnvelope(accountId, envelope, mailHandle(accountId, "email", providerId));
    return rows.rowByProvider(accountId, providerId);
  };
  const get: Store["emails"]["get"] = async (id, opts = {}) => {
    const includeBodies = opts.includeBodies ?? true;
    const local = rows.rowById(id, false);
    if (local) {
      return finish(local, opts, includeBodies);
    }
    const handle = parseMailHandle(id);
    if (handle?.type !== "email") {
      return null;
    }
    const cached =
      rows.rowByProvider(handle.accountId, handle.providerId) ??
      (await fetchEnvelope(handle.accountId, handle.providerId, opts));
    return cached ? finish(cached, opts, includeBodies) : null;
  };
  const getByProviderId: Store["emails"]["getByProviderId"] = async (
    accountId,
    providerId,
    opts = {},
  ) => {
    const cached =
      rows.rowByProvider(accountId, providerId) ??
      (await fetchEnvelope(accountId, providerId, opts));
    return cached ? finish(cached, opts, opts.includeBodies ?? true) : null;
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
  const dropBodies = (ids: string[]) => {
    for (const id of ids) {
      db.run(
        `UPDATE emails SET textBody = NULL, html_body = NULL, body_fetched_at = NULL,
        data = json_remove(data, '$.textBody', '$.htmlBody') WHERE id = ?`,
        [id],
      );
    }
  };
  const evictBodies = async ({
    olderThanMs = 7 * DAY_MS,
    maxBytes = 200 * 1024 * 1024,
  } = {}): Promise<EvictionResult> =>
    db.transaction(() => {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const expired = db
        .all(
          `SELECT id FROM emails WHERE body_fetched_at IS NOT NULL AND body_fetched_at < ? AND ${NOT_DRAFT}`,
          [cutoff],
        )
        .map((row) => row.id as string);
      dropBodies(expired);
      const cached = db.all(
        `SELECT id, ${BODY_BYTES} AS bytes FROM emails
        WHERE body_fetched_at IS NOT NULL AND ${NOT_DRAFT}
        ORDER BY touched_at ASC, id ASC`,
      );
      const drafts = Number(
        db.one(
          `SELECT COALESCE(SUM(${BODY_BYTES}), 0) AS bytes FROM emails
          WHERE body_fetched_at IS NOT NULL AND NOT (${NOT_DRAFT})`,
        )!.bytes,
      );
      let total = drafts + cached.reduce((sum, row) => sum + Number(row.bytes), 0);
      const overflow: string[] = [];
      for (const row of cached) {
        if (total <= maxBytes) {
          break;
        }
        overflow.push(row.id as string);
        total -= Number(row.bytes);
      }
      dropBodies(overflow);
      return { evicted: expired.length + overflow.length, remainingBytes: total };
    });
  const evictEnvelopes = async ({ keep = 100_000 } = {}): Promise<EvictionResult> =>
    db.transaction(() => {
      const victims = db
        .all(
          `SELECT id FROM (
            SELECT id, matter_id, data FROM emails ORDER BY touched_at DESC, id DESC LIMIT -1 OFFSET ?
          ) WHERE matter_id IS NULL AND ${NOT_DRAFT}`,
          [Math.max(0, keep)],
        )
        .map((row) => row.id as string);
      for (const id of victims) {
        rows.deleteEmail(id);
      }
      return { evicted: victims.length, remainingBytes: 0 };
    });
  return { get, getByProviderId, touch, freshness, evictBodies, evictEnvelopes };
}
