import { randomBytes, scryptSync } from "node:crypto";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { nowIso } from "@passport/types";
import type {
  Account, ActionRecord, CalendarEvent, Email, Matter, Person, Store,
} from "@passport/types";
import { decryptCredentials, encryptCredentials } from "./credentials.js";
import { StoreError } from "./errors.js";
import { migrations } from "./migrations.js";

type Row = Record<string, unknown>;
type Cursor = { v: 1; sort: string; at: string; id: string };

function limitOf(limit = 50): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit >= Number.MAX_SAFE_INTEGER) {
    throw new StoreError("INVALID_QUERY", "limit must be a positive safe integer");
  }
  return limit;
}

function decodeCursor(value: string, sort: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!cursor || typeof cursor !== "object") throw new Error();
    const c = cursor as Partial<Cursor>;
    if (c.v !== 1 || c.sort !== sort || typeof c.at !== "string" || !Number.isFinite(Date.parse(c.at)) ||
        typeof c.id !== "string" || !c.id) throw new Error();
    return c as Cursor;
  } catch {
    throw new StoreError("INVALID_CURSOR", "Invalid cursor or cursor sort does not match the query");
  }
}

function nextCursor(sort: string, at: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, sort, at, id })).toString("base64url");
}

function unique(values: string[]): string[] { return [...new Set(values)]; }
function definedPatch<T extends object>(patch: T): T {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as T;
}
function latest(a?: string | null, b?: string | null): string | null {
  return a && b ? (a > b ? a : b) : a ?? b ?? null;
}
function like(text: string): string { return `%${text.replace(/[\\%_]/g, "\\$&")}%`; }

class SQLiteStore implements Store {
  private readonly statements = new Map<string, StatementSync>();
  private closed = false;

  constructor(private readonly db: DatabaseSync, private readonly key: Buffer) {}

  private statement(sql: string): StatementSync {
    if (this.closed) throw new StoreError("STORE_CLOSED", "The store is closed");
    let statement = this.statements.get(sql);
    if (!statement) this.statements.set(sql, (statement = this.db.prepare(sql)));
    return statement;
  }

  private all(sql: string, params: SQLInputValue[] = []): Row[] { return this.statement(sql).all(...params); }
  private one(sql: string, params: SQLInputValue[] = []): Row | undefined { return this.statement(sql).get(...params); }
  private run(sql: string, params: SQLInputValue[] = []): void { this.statement(sql).run(...params); }
  private transaction<T>(write: () => T): T {
    this.run("BEGIN IMMEDIATE");
    try {
      const result = write();
      this.run("COMMIT");
      return result;
    } catch (error) {
      this.run("ROLLBACK");
      throw error;
    }
  }

  private parse<T>(row: Row): T { return JSON.parse(row.data as string) as T; }
  private get<T>(table: string, id: string): T | null {
    const row = this.one(`SELECT data FROM ${table} WHERE id = ?`, [id]);
    return row ? this.parse<T>(row) : null;
  }
  private rows<T>(sql: string, params: SQLInputValue[] = []): T[] {
    return this.all(sql, params).map(row => this.parse<T>(row));
  }
  // Identifiers are internal constants; all caller-provided values are bound parameters.
  private put(table: string, id: string, data: unknown, scalars: Record<string, SQLInputValue> = {}): void {
    const columns = ["id", "data", ...Object.keys(scalars)];
    this.run(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})
      ON CONFLICT(id) DO UPDATE SET ${columns.slice(1).map(c => `${c}=excluded.${c}`).join(",")}`,
    [id, JSON.stringify(data), ...Object.values(scalars)]);
  }

  async migrate(): Promise<void> {
    this.transaction(() => {
      this.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
      const rows = this.all("SELECT version FROM schema_version ORDER BY version");
      if (rows.some((row, i) => Number(row.version) !== i + 1) || rows.length > migrations.length) {
        throw new StoreError("SCHEMA_VERSION", "Database migrations do not match this version of @passport/store");
      }
      for (let i = rows.length; i < migrations.length; i += 1) {
        this.db.exec(migrations[i]!);
        this.run("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)", [i + 1, nowIso()]);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
    this.statements.clear();
    this.key.fill(0);
  }

  accounts: Store["accounts"] = {
    list: async () => this.rows<Account>("SELECT data FROM accounts ORDER BY id"),
    get: async id => this.get("accounts", id),
    upsert: async account => { this.put("accounts", account.id, account); return this.get<Account>("accounts", account.id)!; },
    delete: async id => this.transaction(() => {
      for (const row of this.all("SELECT id FROM emails WHERE account_id = ?", [id])) this.deleteEmail(row.id as string);
      for (const row of this.all("SELECT id FROM events WHERE account_id = ?", [id])) this.deleteEvent(row.id as string);
      this.run("DELETE FROM email_mailboxes WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE account_id = ?)", [id]);
      for (const table of ["mailboxes", "threads", "calendars"]) this.run(`DELETE FROM ${table} WHERE account_id = ?`, [id]);
      this.run("DELETE FROM credentials WHERE account_id = ?", [id]);
      this.run("DELETE FROM sync_state WHERE account_id = ?", [id]);
      this.run("DELETE FROM accounts WHERE id = ?", [id]);
      // The action log, people, and matters are independent of account lifetime.
    }),
    setCredentials: async (accountId, credentials) => {
      const encrypted = encryptCredentials(this.key, accountId, credentials);
      this.run("INSERT INTO credentials(account_id, encrypted) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET encrypted=excluded.encrypted",
        [accountId, encrypted]);
    },
    getCredentials: async accountId => {
      const row = this.one("SELECT encrypted FROM credentials WHERE account_id = ?", [accountId]);
      if (!row) return null;
      return decryptCredentials(this.key, accountId, row.encrypted as Uint8Array);
    },
  };

  syncState: Store["syncState"] = {
    get: async accountId => {
      const row = this.one("SELECT data FROM sync_state WHERE account_id = ?", [accountId]);
      return row ? this.parse(row) : null;
    },
    set: async state => this.run("INSERT INTO sync_state(account_id, data) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET data=excluded.data",
      [state.accountId, JSON.stringify(state)]),
  };

  mailboxes: Store["mailboxes"] = {
    list: async accountId => this.rows("SELECT data FROM mailboxes WHERE account_id = ? ORDER BY id", [accountId]),
    get: async id => this.get("mailboxes", id),
    upsertMany: async mailboxes => this.transaction(() => {
      for (const mailbox of mailboxes) this.put("mailboxes", mailbox.id, mailbox, { account_id: mailbox.accountId, provider_id: mailbox.providerId });
    }),
    deleteMany: async ids => this.transaction(() => {
      for (const id of unique(ids)) {
        this.run("DELETE FROM email_mailboxes WHERE mailbox_id = ?", [id]);
        this.run("DELETE FROM mailboxes WHERE id = ?", [id]);
      }
    }),
  };

  private ids(table: string, ownerColumn: string, owner: string, targetColumn: string): string[] {
    return this.all(`SELECT ${targetColumn} AS id FROM ${table} WHERE ${ownerColumn} = ? ORDER BY position, ${targetColumn}`, [owner])
      .map(row => row.id as string);
  }
  private replaceIds(table: string, ownerColumn: string, owner: string, targetColumn: string, ids: string[]): void {
    this.run(`DELETE FROM ${table} WHERE ${ownerColumn} = ?`, [owner]);
    unique(ids).forEach((id, position) => this.run(`INSERT INTO ${table}(${ownerColumn}, ${targetColumn}, position) VALUES (?, ?, ?)`, [owner, id, position]));
  }

  private readEmail(row: Row, includeBodies = true): Email {
    const email = this.parse<Email>(row);
    email.mailboxIds = this.ids("email_mailboxes", "email_id", email.id, "mailbox_id");
    email.personIds = this.ids("email_people", "email_id", email.id, "person_id");
    if (row.matter_id !== null || email.matterId !== undefined) email.matterId = row.matter_id as string | null;
    if (includeBodies) {
      if (row.textBody !== null) email.textBody = row.textBody as string;
      if (row.html_body !== null) email.htmlBody = row.html_body as string;
    } else {
      delete email.textBody;
      delete email.htmlBody;
    }
    return email;
  }
  private getEmail(id: string, includeBodies = true): Email | null {
    const row = this.one(`SELECT data, matter_id${includeBodies ? ", textBody, html_body" : ""} FROM emails WHERE id = ?`, [id]);
    return row ? this.readEmail(row, includeBodies) : null;
  }
  private setMatterLink(kind: "emails" | "events", id: string, matterId: string | null): void {
    const column = kind === "emails" ? "email_id" : "event_id";
    const current = this.one(`SELECT matter_id FROM matter_${kind} WHERE ${column} = ?`, [id]);
    if ((current?.matter_id ?? null) !== matterId) {
      this.run(`DELETE FROM matter_${kind} WHERE ${column} = ?`, [id]);
      if (matterId !== null) {
        this.run(`INSERT INTO matter_${kind}(matter_id, ${column}, position)
          SELECT ?, ?, COALESCE(MAX(position), -1) + 1 FROM matter_${kind} WHERE matter_id = ?`, [matterId, id, matterId]);
      }
    }
    this.run(`UPDATE ${kind} SET matter_id = ? WHERE id = ? AND matter_id IS NOT ?`, [matterId, id, matterId]);
  }

  private saveEmail(input: Email): void {
    const previous = this.getEmail(input.id);
    const pending = this.one("SELECT matter_id FROM matter_emails WHERE email_id = ?", [input.id]);
    const email = { ...input };
    if (email.textBody === undefined && previous?.textBody !== undefined) email.textBody = previous.textBody;
    if (email.htmlBody === undefined && previous?.htmlBody !== undefined) email.htmlBody = previous.htmlBody;
    const matterId = email.matterId === undefined ? (pending?.matter_id as string | undefined) ?? previous?.matterId ?? null : email.matterId;
    const data = { ...email };
    // Store only presence markers in JSON; bodies live in separately selectable columns.
    if (data.textBody !== undefined) data.textBody = null;
    if (data.htmlBody !== undefined) data.htmlBody = null;
    this.put("emails", email.id, data, {
      account_id: email.accountId, provider_id: email.providerId, thread_id: email.threadId,
      matter_id: matterId, category: email.category ?? null, received_at: email.receivedAt,
      subject: email.subject, '"from"': email.from.map(from => `${from.name ?? ""} ${from.email}`).join(" "),
      preview: email.preview, textBody: email.textBody ?? null, html_body: email.htmlBody ?? null,
    });
    this.replaceIds("email_mailboxes", "email_id", email.id, "mailbox_id", email.mailboxIds);
    this.replaceIds("email_people", "email_id", email.id, "person_id", email.personIds);
    this.setMatterLink("emails", email.id, matterId);
  }

  private deleteEmail(id: string): void {
    this.run("DELETE FROM matter_emails WHERE email_id = ?", [id]);
    this.run("DELETE FROM emails WHERE id = ?", [id]);
    for (const row of this.all("SELECT id, data FROM threads WHERE EXISTS (SELECT 1 FROM json_each(data, '$.emailIds') WHERE value = ?)", [id])) {
      const thread = this.parse<{ id: string; accountId: string; emailIds: string[] }>(row);
      thread.emailIds = thread.emailIds.filter(emailId => emailId !== id);
      this.put("threads", thread.id, thread, { account_id: thread.accountId });
    }
  }

  emails: Store["emails"] = {
    get: async (id, opts) => this.getEmail(id, opts?.includeBodies ?? true),
    getByProviderId: async (accountId, providerId) => {
      const row = this.one("SELECT data, matter_id, textBody, html_body FROM emails WHERE account_id = ? AND provider_id = ?", [accountId, providerId]);
      return row ? this.readEmail(row) : null;
    },
    query: async q => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      const equal = (column: string, value: string | undefined) => {
        if (value !== undefined) { where.push(`e.${column} = ?`); params.push(value); }
      };
      equal("account_id", q.accountId);
      equal("thread_id", q.threadId);
      equal("category", q.category);
      if (q.matterId === null) where.push("e.matter_id IS NULL");
      else equal("matter_id", q.matterId);
      for (const [value, table, column] of [[q.mailboxId, "email_mailboxes", "mailbox_id"], [q.personId, "email_people", "person_id"]] as const) {
        if (value !== undefined) {
          where.push(`EXISTS (SELECT 1 FROM ${table} j WHERE j.email_id = e.id AND j.${column} = ?)`);
          params.push(value);
        }
      }
      if (q.text?.trim()) {
        where.push("e.rowid IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?)");
        params.push(q.text);
      }
      for (const [keywords, has] of [[q.keywords?.has, true], [q.keywords?.not, false]] as const) {
        for (const keyword of keywords ?? []) {
          where.push(`${has ? "" : "NOT "}EXISTS (SELECT 1 FROM json_each(e.data, '$.keywords') k WHERE k.key = ? AND k.value = 1)`);
          params.push(keyword);
        }
      }
      if (q.after !== undefined) { where.push("e.received_at > ?"); params.push(q.after); }
      if (q.before !== undefined) { where.push("e.received_at < ?"); params.push(q.before); }
      const clause = () => where.length ? `WHERE ${where.join(" AND ")}` : "";
      const total = Number(this.one(`SELECT COUNT(*) AS count FROM emails e ${clause()}`, params)!.count);
      const sort = q.sort ?? "receivedAt_desc";
      const direction = sort === "receivedAt_asc" ? "ASC" : "DESC";
      if (q.cursor) {
        const cursor = decodeCursor(q.cursor, sort);
        where.push(`(e.received_at, e.id) ${direction === "ASC" ? ">" : "<"} (?, ?)`);
        params.push(cursor.at, cursor.id);
      }
      const limit = limitOf(q.limit);
      const rows = this.all(`SELECT e.data, e.matter_id${q.includeBodies ? ", e.textBody, e.html_body" : ""}
        FROM emails e ${clause()} ORDER BY e.received_at ${direction}, e.id ${direction} LIMIT ?`, [...params, limit + 1]);
      const items = rows.slice(0, limit).map(row => this.readEmail(row, q.includeBodies ?? false));
      const last = items.at(-1);
      return { items, total, nextCursor: rows.length > limit && last ? nextCursor(sort, last.receivedAt, last.id) : null };
    },
    upsertMany: async emails => this.transaction(() => { for (const email of emails) this.saveEmail(email); }),
    patchMany: async (ids, patch) => this.transaction(() => {
      for (const id of unique(ids)) {
        const email = this.getEmail(id);
        if (!email) continue;
        // Like other top-level patches, keywords and membership arrays replace their fields.
        this.saveEmail({ ...email, ...definedPatch(patch) });
      }
    }),
    deleteMany: async ids => this.transaction(() => { for (const id of unique(ids)) this.deleteEmail(id); }),
  };

  threads: Store["threads"] = {
    get: async id => this.get("threads", id),
    upsertMany: async threads => this.transaction(() => {
      for (const thread of threads) this.put("threads", thread.id, thread, { account_id: thread.accountId });
    }),
  };

  calendars: Store["calendars"] = {
    list: async accountId => this.rows("SELECT data FROM calendars WHERE account_id = ? ORDER BY id", [accountId]),
    upsertMany: async calendars => this.transaction(() => {
      for (const calendar of calendars) this.put("calendars", calendar.id, calendar, { account_id: calendar.accountId, provider_id: calendar.providerId });
    }),
  };

  private readEvent(row: Row): CalendarEvent {
    const event = this.parse<CalendarEvent>(row);
    if (row.matter_id !== null || event.matterId !== undefined) event.matterId = row.matter_id as string | null;
    return event;
  }
  private deleteEvent(id: string): void {
    this.run("DELETE FROM matter_events WHERE event_id = ?", [id]);
    this.run("DELETE FROM events WHERE id = ?", [id]);
  }
  events: Store["events"] = {
    get: async id => {
      const row = this.one("SELECT data, matter_id FROM events WHERE id = ?", [id]);
      return row ? this.readEvent(row) : null;
    },
    query: async q => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (q.accountId !== undefined) { where.push("account_id = ?"); params.push(q.accountId); }
      if (q.matterId !== undefined) { where.push("matter_id = ?"); params.push(q.matterId); }
      if (q.range) { where.push("start < ? AND end > ?"); params.push(q.range.end, q.range.start); }
      return this.all(`SELECT data, matter_id FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY start, id LIMIT ?`,
        [...params, limitOf(q.limit)]).map(row => this.readEvent(row));
    },
    upsertMany: async events => this.transaction(() => {
      for (const event of events) {
        const pending = this.one("SELECT matter_id FROM matter_events WHERE event_id = ?", [event.id]);
        const matterId = event.matterId === undefined ? (pending?.matter_id as string | undefined) ?? null : event.matterId;
        this.put("events", event.id, event, { account_id: event.accountId, provider_id: event.providerId,
          calendar_id: event.calendarId, matter_id: matterId, start: event.start, end: event.end });
        this.setMatterLink("events", event.id, matterId);
      }
    }),
    deleteMany: async ids => this.transaction(() => { for (const id of unique(ids)) this.deleteEvent(id); }),
  };

  private savePerson(person: Person): Person {
    const seen = new Set<string>();
    const emails = [...person.emails, person.primaryEmail].filter(email => {
      const normalized = email.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    }).map(email => email.trim());
    const saved = { ...person, emails };
    this.put("people", person.id, saved, { relationship: person.relationship, display_name: person.displayName });
    this.replaceIds("person_emails", "person_id", person.id, "email", emails);
    return this.get<Person>("people", person.id)!;
  }

  people: Store["people"] = {
    get: async id => this.get("people", id),
    getByEmail: async email => {
      const row = this.one("SELECT p.data FROM people p JOIN person_emails pe ON pe.person_id = p.id WHERE pe.email = ? COLLATE NOCASE ORDER BY p.id LIMIT 1", [email.trim()]);
      return row ? this.parse<Person>(row) : null;
    },
    list: async (q = {}) => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (q.relationship !== undefined) { where.push("p.relationship = ?"); params.push(q.relationship); }
      if (q.text) {
        where.push("(p.display_name LIKE ? ESCAPE '\\' OR COALESCE(json_extract(p.data, '$.notes'), '') LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM person_emails pe WHERE pe.person_id = p.id AND pe.email LIKE ? ESCAPE '\\'))");
        params.push(like(q.text), like(q.text), like(q.text));
      }
      return this.rows(`SELECT p.data FROM people p ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY p.display_name COLLATE NOCASE, p.id LIMIT ?`, [...params, limitOf(q.limit)]);
    },
    upsert: async person => this.transaction(() => this.savePerson(person)),
    merge: async (keepId, mergeId) => this.transaction(() => {
      const keep = this.get<Person>("people", keepId);
      const merge = this.get<Person>("people", mergeId);
      if (!keep || !merge) throw new StoreError("NOT_FOUND", "Both people must exist to merge them");
      if (keepId === mergeId) return keep;
      for (const [table, ownerColumn] of [["email_people", "email_id"], ["matter_people", "matter_id"]] as const) {
        for (const row of this.all(`SELECT ${ownerColumn} AS owner, position FROM ${table} WHERE person_id = ?`, [mergeId])) {
          this.run(`INSERT INTO ${table}(${ownerColumn}, person_id, position) VALUES (?, ?, ?) ON CONFLICT(${ownerColumn}, person_id) DO NOTHING`,
            [row.owner as string, keepId, row.position as number]);
        }
        this.run(`DELETE FROM ${table} WHERE person_id = ?`, [mergeId]);
      }
      const saved = this.savePerson({ ...keep, emails: [...keep.emails, ...merge.emails],
        stats: { sent: keep.stats.sent + merge.stats.sent, received: keep.stats.received + merge.stats.received,
          lastContactAt: latest(keep.stats.lastContactAt, merge.stats.lastContactAt) },
        lastSeenBlueAt: latest(keep.lastSeenBlueAt, merge.lastSeenBlueAt), updatedAt: nowIso() });
      this.run("DELETE FROM people WHERE id = ?", [mergeId]);
      return saved;
    }),
  };

  private readMatter(row: Row): Matter {
    const matter = this.parse<Matter>(row);
    matter.emailIds = this.ids("matter_emails", "matter_id", matter.id, "email_id");
    matter.eventIds = this.ids("matter_events", "matter_id", matter.id, "event_id");
    matter.personIds = this.ids("matter_people", "matter_id", matter.id, "person_id");
    return matter;
  }
  matters: Store["matters"] = {
    get: async id => {
      const row = this.one("SELECT data FROM matters WHERE id = ?", [id]);
      return row ? this.readMatter(row) : null;
    },
    list: async (q = {}) => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (q.status !== undefined) { where.push(`m.status IN (${q.status.map(() => "?").join(",")})`); params.push(...q.status); }
      if (q.personId !== undefined) { where.push("EXISTS (SELECT 1 FROM matter_people mp WHERE mp.matter_id = m.id AND mp.person_id = ?)"); params.push(q.personId); }
      if (q.text) {
        where.push("(json_extract(m.data, '$.title') LIKE ? ESCAPE '\\' OR json_extract(m.data, '$.summary') LIKE ? ESCAPE '\\')");
        params.push(like(q.text), like(q.text));
      }
      return this.all(`SELECT m.data FROM matters m ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY m.updated_at DESC, m.id DESC LIMIT ?`,
        [...params, limitOf(q.limit)]).map(row => this.readMatter(row));
    },
    upsert: async matter => this.transaction(() => {
      this.put("matters", matter.id, matter, { status: matter.status, updated_at: matter.updatedAt });
      for (const [kind, column, ids] of [["emails", "email_id", matter.emailIds], ["events", "event_id", matter.eventIds]] as const) {
        this.run(`UPDATE ${kind} SET matter_id = NULL WHERE matter_id = ?`, [matter.id]);
        this.run(`DELETE FROM matter_${kind} WHERE matter_id = ?`, [matter.id]);
        unique(ids).forEach((id, position) => {
          this.setMatterLink(kind, id, matter.id);
          this.run(`UPDATE matter_${kind} SET position = ? WHERE ${column} = ?`, [position, id]);
        });
      }
      this.replaceIds("matter_people", "matter_id", matter.id, "person_id", matter.personIds);
      return this.readMatter(this.one("SELECT data FROM matters WHERE id = ?", [matter.id])!);
    }),
    delete: async id => this.transaction(() => {
      this.run("UPDATE emails SET matter_id = NULL WHERE matter_id = ?", [id]);
      this.run("UPDATE events SET matter_id = NULL WHERE matter_id = ?", [id]);
      for (const table of ["matter_emails", "matter_events", "matter_people"]) this.run(`DELETE FROM ${table} WHERE matter_id = ?`, [id]);
      this.run("DELETE FROM matters WHERE id = ?", [id]);
    }),
  };

  private actionScalars(record: ActionRecord): Record<string, SQLInputValue> {
    return { status: record.status, category: record.request.category, actor_kind: record.request.actor.kind,
      run_id: record.request.runId ?? null, matter_id: record.request.matterId ?? null,
      created_at: record.createdAt, hold_until: record.holdUntil ?? null };
  }
  actions: Store["actions"] = {
    get: async id => this.get("actions", id),
    query: async q => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (q.status !== undefined) { where.push(`status IN (${q.status.map(() => "?").join(",")})`); params.push(...q.status); }
      for (const [column, value] of [["category", q.category], ["actor_kind", q.actorKind], ["run_id", q.runId], ["matter_id", q.matterId]] as const) {
        if (value !== undefined) { where.push(`${column} = ?`); params.push(value); }
      }
      if (q.after !== undefined) { where.push("created_at > ?"); params.push(q.after); }
      if (q.before !== undefined) { where.push("created_at < ?"); params.push(q.before); }
      const clause = () => where.length ? `WHERE ${where.join(" AND ")}` : "";
      const total = Number(this.one(`SELECT COUNT(*) AS count FROM actions ${clause()}`, params)!.count);
      if (q.cursor) {
        const cursor = decodeCursor(q.cursor, "createdAt_desc");
        where.push("(created_at, id) < (?, ?)");
        params.push(cursor.at, cursor.id);
      }
      const limit = limitOf(q.limit);
      const rows = this.rows<ActionRecord>(`SELECT data FROM actions ${clause()} ORDER BY created_at DESC, id DESC LIMIT ?`, [...params, limit + 1]);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items, total, nextCursor: rows.length > limit && last ? nextCursor("createdAt_desc", last.createdAt, last.id) : null };
    },
    insert: async record => {
      const scalars = this.actionScalars(record);
      const columns = ["id", "data", ...Object.keys(scalars)];
      this.run(`INSERT INTO actions(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, [record.id, JSON.stringify(record), ...Object.values(scalars)]);
      return this.get<ActionRecord>("actions", record.id)!;
    },
    update: async (id, patch) => this.transaction(() => {
      const record = this.get<ActionRecord>("actions", id);
      if (!record) throw new StoreError("NOT_FOUND", "Action does not exist");
      if (patch.id !== undefined && patch.id !== id) throw new StoreError("INVALID_PATCH", "An action's id cannot change");
      const updated = { ...record, ...definedPatch(patch), id };
      this.put("actions", id, updated, this.actionScalars(updated));
      return this.get<ActionRecord>("actions", id)!;
    }),
    dueHeld: async now => this.rows("SELECT data FROM actions WHERE status = 'held' AND hold_until <= ? ORDER BY hold_until, id", [now]),
  };

  trust: Store["trust"] = {
    list: async () => this.rows("SELECT data FROM trust ORDER BY id"),
    get: async category => this.get("trust", category),
    upsert: async state => { this.put("trust", state.category, state); return this.get("trust", state.category)!; },
    getConfig: async () => this.get("policy_config", "global"),
    setConfig: async config => this.put("policy_config", "global", config),
  };

  kv: Store["kv"] = {
    get: async key => (this.one("SELECT value FROM kv WHERE key = ?", [key])?.value as string | undefined) ?? null,
    set: async (key, value) => this.run("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]),
    delete: async key => this.run("DELETE FROM kv WHERE key = ?", [key]),
  };
}

/**
 * Open a SQLite store. Call and await migrate() before repository operations.
 * File-backed stores require masterKey or PASSPORT_MASTER_KEY. In-memory stores may use an ephemeral key.
 */
export function openStore(opts: { path: string | ":memory:"; masterKey?: string }): Store {
  if (!opts.path || (opts.path !== ":memory:" && (opts.path.startsWith("file:") || opts.path.includes("\0")))) {
    throw new StoreError("INVALID_PATH", "Use a filesystem path or :memory: (SQLite URI paths are not supported)");
  }
  const configured = opts.masterKey ?? process.env.PASSPORT_MASTER_KEY;
  if (configured !== undefined && !configured.trim()) throw new StoreError("MASTER_KEY_REQUIRED", "Master key must not be empty");
  if (configured === undefined && opts.path !== ":memory:") {
    throw new StoreError("MASTER_KEY_REQUIRED", "A file-backed store requires masterKey or PASSPORT_MASTER_KEY");
  }
  const key = configured === undefined ? randomBytes(32) : scryptSync(configured, "passport/store/aes-256-gcm/v1", 32);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(opts.path);
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    return new SQLiteStore(db, key);
  } catch (cause) {
    db?.close();
    key.fill(0);
    throw new StoreError("STORE_OPEN_FAILED", "Cannot open SQLite store", { cause });
  }
}
