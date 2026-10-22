import type { SQLInputValue } from "node:sqlite";
import type { Account, MailReaderResolver, Store } from "@passport/types";
import { decryptCredentials, encryptCredentials } from "./credentials.js";
import type { StoreDatabase } from "./store-database.js";
import { createEmailCache } from "./store-email-cache.js";
import { createEmailRows } from "./store-email-rows.js";
import { refreshFromLabels } from "./store-mailbox-labels.js";
import { decodeCursor, definedPatch, limitOf, nextCursor, unique } from "./store-query.js";

export function createMailRepositories(
  db: StoreDatabase,
  resolver: () => MailReaderResolver | null = () => null,
) {
  const accounts: Store["accounts"] = {
    list: async () => db.rows<Account>("SELECT data FROM accounts ORDER BY id"),
    get: async (id) => db.get("accounts", id),
    upsert: async (account) => {
      db.put("accounts", account.id, account);
      return db.get<Account>("accounts", account.id)!;
    },
    delete: async (id) =>
      db.transaction(() => {
        for (const row of db.all("SELECT id FROM emails WHERE account_id = ?", [id])) {
          deleteEmail(row.id as string);
        }
        for (const row of db.all("SELECT id FROM events WHERE account_id = ?", [id])) {
          db.deleteEvent(row.id as string);
        }
        db.run(
          "DELETE FROM email_mailboxes WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE account_id = ?)",
          [id],
        );
        for (const table of ["mailboxes", "threads", "calendars"]) {
          db.run(`DELETE FROM ${table} WHERE account_id = ?`, [id]);
        }
        db.run("DELETE FROM credentials WHERE account_id = ?", [id]);
        db.run("DELETE FROM sync_state WHERE account_id = ?", [id]);
        db.run("DELETE FROM accounts WHERE id = ?", [id]);
        // The action log, people, and matters are independent of account lifetime.
      }),
    setCredentials: async (accountId, credentials) => {
      const encrypted = encryptCredentials(db.key, accountId, credentials);
      db.run(
        "INSERT INTO credentials(account_id, encrypted) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET encrypted=excluded.encrypted",
        [accountId, encrypted],
      );
    },
    getCredentials: async (accountId) => {
      const row = db.one("SELECT encrypted FROM credentials WHERE account_id = ?", [accountId]);
      if (!row) {
        return null;
      }
      return decryptCredentials(db.key, accountId, row.encrypted as Uint8Array);
    },
  };
  const syncState: Store["syncState"] = {
    get: async (accountId) => {
      const row = db.one("SELECT data FROM sync_state WHERE account_id = ?", [accountId]);
      return row ? db.parse(row) : null;
    },
    set: async (state) =>
      db.run(
        "INSERT INTO sync_state(account_id, data) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET data=excluded.data",
        [state.accountId, JSON.stringify(state)],
      ),
  };
  const mailboxes: Store["mailboxes"] = {
    list: async (accountId) =>
      db.rows("SELECT data FROM mailboxes WHERE account_id = ? ORDER BY id", [accountId]),
    get: async (id) => db.get("mailboxes", id),
    upsertMany: async (mailboxes) =>
      db.transaction(() => {
        for (const mailbox of mailboxes) {
          db.put("mailboxes", mailbox.id, mailbox, {
            account_id: mailbox.accountId,
            provider_id: mailbox.providerId,
          });
        }
      }),
    deleteMany: async (ids) =>
      db.transaction(() => {
        for (const id of unique(ids)) {
          db.run("DELETE FROM email_mailboxes WHERE mailbox_id = ?", [id]);
          db.run("DELETE FROM mailboxes WHERE id = ?", [id]);
        }
      }),
    refreshFromLabels: async (accountId, labels, opts) =>
      refreshFromLabels(db, accountId, labels, opts),
  };
  const rows = createEmailRows(db);
  const { readEmail, getEmail, saveEmail, deleteEmail } = rows;
  const cache = createEmailCache(db, rows, resolver);
  const emails: Store["emails"] = {
    get: cache.get,
    getMany: cache.getMany,
    getByProviderId: cache.getByProviderId,
    touch: cache.touch,
    freshness: cache.freshness,
    evictBodies: cache.evictBodies,
    evictEnvelopes: cache.evictEnvelopes,
    query: async (q) => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      const equal = (column: string, value: string | undefined) => {
        if (value !== undefined) {
          where.push(`e.${column} = ?`);
          params.push(value);
        }
      };
      if (!q.includeDeleted) {
        where.push(
          "NOT EXISTS (SELECT 1 FROM json_each(e.data, '$.keywords') k WHERE k.key = '$deleted' AND k.type = 'true')",
        );
      }
      equal("account_id", q.accountId);
      equal("thread_id", q.threadId);
      equal("category", q.category);
      if (q.matterId === null) {
        where.push("e.matter_id IS NULL");
      } else {
        equal("matter_id", q.matterId);
      }
      for (const [value, table, column] of [
        [q.mailboxId, "email_mailboxes", "mailbox_id"],
        [q.personId, "email_people", "person_id"],
      ] as const) {
        if (value !== undefined) {
          where.push(
            `EXISTS (SELECT 1 FROM ${table} j WHERE j.email_id = e.id AND j.${column} = ?)`,
          );
          params.push(value);
        }
      }
      if (q.text?.trim()) {
        where.push("e.rowid IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?)");
        params.push(q.text);
      }
      for (const [keywords, has] of [
        [q.keywords?.has, true],
        [q.keywords?.not, false],
      ] as const) {
        for (const keyword of keywords ?? []) {
          where.push(
            `${has ? "" : "NOT "}EXISTS (SELECT 1 FROM json_each(e.data, '$.keywords') k WHERE k.key = ? AND k.value = 1)`,
          );
          params.push(keyword);
        }
      }
      if (q.after !== undefined) {
        where.push("e.received_at > ?");
        params.push(q.after);
      }
      if (q.before !== undefined) {
        where.push("e.received_at < ?");
        params.push(q.before);
      }
      const clause = () => (where.length ? `WHERE ${where.join(" AND ")}` : "");
      const total = Number(
        db.one(`SELECT COUNT(*) AS count FROM emails e ${clause()}`, params)!.count,
      );
      const sort = q.sort ?? "receivedAt_desc";
      const direction = sort === "receivedAt_asc" ? "ASC" : "DESC";
      if (q.cursor) {
        const cursor = decodeCursor(q.cursor, sort);
        where.push(`(e.received_at, e.id) ${direction === "ASC" ? ">" : "<"} (?, ?)`);
        params.push(cursor.at, cursor.id);
      }
      const limit = limitOf(q.limit);
      const rows = db.all(
        `SELECT e.data, e.matter_id${q.includeBodies ? ", e.textBody, e.html_body" : ""}
        FROM emails e ${clause()} ORDER BY e.received_at ${direction}, e.id ${direction} LIMIT ?`,
        [...params, limit + 1],
      );
      const items = rows.slice(0, limit).map((row) => readEmail(row, q.includeBodies ?? false));
      const last = items.at(-1);
      return {
        items,
        total,
        nextCursor: rows.length > limit && last ? nextCursor(sort, last.receivedAt, last.id) : null,
      };
    },
    upsertMany: async (emails) =>
      db.transaction(() => {
        for (const email of emails) {
          saveEmail(email, { labelsFresh: true });
        }
      }),
    patchMany: async (ids, patch) =>
      db.transaction(() => {
        for (const id of unique(ids)) {
          const email = getEmail(id);
          if (!email) {
            continue;
          }
          // Like other top-level patches, keywords and membership arrays replace their fields.
          saveEmail({ ...email, ...definedPatch(patch) }, { labelsFresh: false });
        }
      }),
    deleteMany: async (ids) =>
      db.transaction(() => {
        for (const id of unique(ids)) {
          deleteEmail(id);
        }
      }),
  };
  const threads: Store["threads"] = {
    get: async (id) => db.get("threads", id),
    upsertMany: async (threads) =>
      db.transaction(() => {
        for (const thread of threads) {
          db.put("threads", thread.id, thread, { account_id: thread.accountId });
        }
      }),
  };
  return { accounts, syncState, mailboxes, emails, threads };
}
