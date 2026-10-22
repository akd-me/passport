import { TASKS_MIGRATION } from "./store-tasks-migration.js";

// Append migrations; never change an already released migration.
export const migrations: readonly string[] = [
  String.raw`
  CREATE TABLE accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
  CREATE TABLE credentials (account_id TEXT PRIMARY KEY, encrypted BLOB NOT NULL);
  CREATE TABLE sync_state (account_id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
  CREATE TABLE mailboxes (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
    provider_id TEXT NOT NULL, UNIQUE(account_id, provider_id)
  );
  CREATE TABLE emails (
    rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    thread_id TEXT NOT NULL, matter_id TEXT, category TEXT, received_at TEXT NOT NULL,
    subject TEXT NOT NULL, "from" TEXT NOT NULL, preview TEXT NOT NULL,
    textBody TEXT, html_body TEXT, data TEXT NOT NULL CHECK(json_valid(data)),
    UNIQUE(account_id, provider_id)
  );
  CREATE INDEX emails_received ON emails(received_at, id);
  CREATE INDEX emails_account_received ON emails(account_id, received_at, id);
  CREATE INDEX emails_thread ON emails(thread_id, received_at, id);
  CREATE INDEX emails_matter ON emails(matter_id, received_at, id);
  CREATE INDEX emails_category ON emails(category, received_at, id);
  CREATE TABLE email_mailboxes (
    email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    mailbox_id TEXT NOT NULL, position INTEGER NOT NULL,
    PRIMARY KEY(email_id, mailbox_id)
  );
  CREATE INDEX email_mailboxes_mailbox ON email_mailboxes(mailbox_id, email_id);
  CREATE TABLE email_people (
    email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL, position INTEGER NOT NULL,
    PRIMARY KEY(email_id, person_id)
  );
  CREATE INDEX email_people_person ON email_people(person_id, email_id);
  CREATE VIRTUAL TABLE emails_fts USING fts5(
    subject, "from", preview, textBody, content='emails', content_rowid='rowid',
    tokenize='unicode61'
  );
  CREATE TRIGGER emails_fts_insert AFTER INSERT ON emails BEGIN
    INSERT INTO emails_fts(rowid, subject, "from", preview, textBody)
      VALUES (new.rowid, new.subject, new."from", new.preview, new.textBody);
  END;
  CREATE TRIGGER emails_fts_delete AFTER DELETE ON emails BEGIN
    INSERT INTO emails_fts(emails_fts, rowid, subject, "from", preview, textBody)
      VALUES ('delete', old.rowid, old.subject, old."from", old.preview, old.textBody);
  END;
  CREATE TRIGGER emails_fts_update AFTER UPDATE ON emails BEGIN
    INSERT INTO emails_fts(emails_fts, rowid, subject, "from", preview, textBody)
      VALUES ('delete', old.rowid, old.subject, old."from", old.preview, old.textBody);
    INSERT INTO emails_fts(rowid, subject, "from", preview, textBody)
      VALUES (new.rowid, new.subject, new."from", new.preview, new.textBody);
  END;
  CREATE TABLE threads (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
  CREATE INDEX threads_account ON threads(account_id);
  CREATE TABLE calendars (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(account_id, provider_id)
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, calendar_id TEXT NOT NULL,
    provider_id TEXT NOT NULL, matter_id TEXT, start TEXT NOT NULL, end TEXT NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(account_id, provider_id)
  );
  CREATE INDEX events_account ON events(account_id);
  CREATE INDEX events_calendar ON events(calendar_id);
  CREATE INDEX events_range ON events(start, end);
  CREATE INDEX events_matter ON events(matter_id, start);
  CREATE TABLE people (
    id TEXT PRIMARY KEY, relationship TEXT NOT NULL, display_name TEXT NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data))
  );
  CREATE INDEX people_relationship ON people(relationship, display_name, id);
  CREATE INDEX people_name ON people(display_name, id);
  CREATE TABLE person_emails (
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE, position INTEGER NOT NULL,
    PRIMARY KEY(person_id, email)
  );
  CREATE INDEX person_emails_email ON person_emails(email, person_id);
  CREATE TABLE matters (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data))
  );
  CREATE INDEX matters_status ON matters(status, updated_at, id);
  CREATE INDEX matters_updated ON matters(updated_at, id);
  CREATE TABLE matter_emails (
    matter_id TEXT NOT NULL, email_id TEXT NOT NULL UNIQUE, position INTEGER NOT NULL,
    PRIMARY KEY(matter_id, email_id)
  );
  CREATE TABLE matter_events (
    matter_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, position INTEGER NOT NULL,
    PRIMARY KEY(matter_id, event_id)
  );
  CREATE TABLE matter_people (
    matter_id TEXT NOT NULL, person_id TEXT NOT NULL, position INTEGER NOT NULL,
    PRIMARY KEY(matter_id, person_id)
  );
  CREATE INDEX matter_people_person ON matter_people(person_id, matter_id);
  CREATE TABLE actions (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, category TEXT NOT NULL,
    actor_kind TEXT NOT NULL, run_id TEXT, matter_id TEXT,
    created_at TEXT NOT NULL, hold_until TEXT, data TEXT NOT NULL CHECK(json_valid(data))
  );
  CREATE INDEX actions_created ON actions(created_at, id);
  CREATE INDEX actions_status ON actions(status, created_at, id);
  CREATE INDEX actions_category ON actions(category, created_at, id);
  CREATE INDEX actions_actor ON actions(actor_kind, created_at, id);
  CREATE INDEX actions_run ON actions(run_id, created_at, id);
  CREATE INDEX actions_matter ON actions(matter_id, created_at, id);
  CREATE INDEX actions_due ON actions(status, hold_until, id);
  CREATE TABLE trust (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
  CREATE TABLE policy_config (id TEXT PRIMARY KEY CHECK(id = 'global'), data TEXT NOT NULL CHECK(json_valid(data)));
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`,
  // v0.3: the mirror becomes a read-through envelope cache. Bodies stay in their columns as a
  // TTL/LRU cache (body_fetched_at); FTS covers envelopes only (subject, from, preview).
  String.raw`
  DROP TRIGGER emails_fts_insert;
  DROP TRIGGER emails_fts_delete;
  DROP TRIGGER emails_fts_update;
  DROP TABLE emails_fts;
  ALTER TABLE emails ADD COLUMN touched_at TEXT;
  ALTER TABLE emails ADD COLUMN labels_fresh_at TEXT;
  ALTER TABLE emails ADD COLUMN body_fetched_at TEXT;
  UPDATE emails SET
    touched_at = received_at,
    body_fetched_at = CASE
      WHEN textBody IS NOT NULL OR html_body IS NOT NULL
        OR json_type(data, '$.textBody') IS NOT NULL OR json_type(data, '$.htmlBody') IS NOT NULL
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END;
  CREATE INDEX emails_touched ON emails(touched_at, id);
  CREATE INDEX emails_body_fetched ON emails(body_fetched_at) WHERE body_fetched_at IS NOT NULL;
  CREATE VIRTUAL TABLE emails_fts USING fts5(
    subject, "from", preview, content='emails', content_rowid='rowid', tokenize='unicode61'
  );
  INSERT INTO emails_fts(emails_fts) VALUES ('rebuild');
  CREATE TRIGGER emails_fts_insert AFTER INSERT ON emails BEGIN
    INSERT INTO emails_fts(rowid, subject, "from", preview)
      VALUES (new.rowid, new.subject, new."from", new.preview);
  END;
  CREATE TRIGGER emails_fts_delete AFTER DELETE ON emails BEGIN
    INSERT INTO emails_fts(emails_fts, rowid, subject, "from", preview)
      VALUES ('delete', old.rowid, old.subject, old."from", old.preview);
  END;
  CREATE TRIGGER emails_fts_update AFTER UPDATE OF subject, "from", preview ON emails BEGIN
    INSERT INTO emails_fts(emails_fts, rowid, subject, "from", preview)
      VALUES ('delete', old.rowid, old.subject, old."from", old.preview);
    INSERT INTO emails_fts(rowid, subject, "from", preview)
      VALUES (new.rowid, new.subject, new."from", new.preview);
  END;
`,
  // v0.3: people and matters as notes. `Matter.refs` (JSON) is the source of truth for a matter's
  // conversations; matter_refs indexes it for lookups by message, thread or Message-ID. v0.2
  // matters get refs derived from the cached envelopes of their attached emails.
  String.raw`
  CREATE TABLE matter_refs (
    matter_id TEXT NOT NULL, account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    rfc822_id TEXT, thread_pid TEXT, date TEXT NOT NULL, position INTEGER NOT NULL,
    PRIMARY KEY(matter_id, account_id, provider_id)
  );
  CREATE INDEX matter_refs_message ON matter_refs(account_id, provider_id);
  CREATE INDEX matter_refs_thread ON matter_refs(account_id, thread_pid) WHERE thread_pid IS NOT NULL;
  CREATE INDEX matter_refs_rfc822 ON matter_refs(rfc822_id) WHERE rfc822_id IS NOT NULL;
  UPDATE matters SET data = json_set(data, '$.refs', json((
    SELECT COALESCE(json_group_array(json(ref)), '[]') FROM (
      SELECT json_object(
        'account', e.account_id, 'providerId', e.provider_id,
        'rfc822Id', json_extract(e.data, '$.headers.messageId'),
        'date', e.received_at, 'subject', e.subject
      ) AS ref
      FROM matter_emails me JOIN emails e ON e.id = me.email_id
      WHERE me.matter_id = matters.id
      ORDER BY e.received_at, e.id
    )
  ))) WHERE json_type(data, '$.refs') IS NULL;
  INSERT OR IGNORE INTO matter_refs(matter_id, account_id, provider_id, rfc822_id, thread_pid, date, position)
    SELECT m.id, json_extract(r.value, '$.account'), json_extract(r.value, '$.providerId'),
      json_extract(r.value, '$.rfc822Id'), json_extract(r.value, '$.threadPid'),
      json_extract(r.value, '$.date'), r.key
    FROM matters m, json_each(m.data, '$.refs') r;
`,
  TASKS_MIGRATION,
  // v0.3: label revalidation rewrites the row; reindex FTS only when an indexed column changed.
  String.raw`
  DROP TRIGGER emails_fts_update;
  CREATE TRIGGER emails_fts_update AFTER UPDATE OF subject, "from", preview ON emails
  WHEN old.subject IS NOT new.subject OR old."from" IS NOT new."from"
    OR old.preview IS NOT new.preview
  BEGIN
    INSERT INTO emails_fts(emails_fts, rowid, subject, "from", preview)
      VALUES ('delete', old.rowid, old.subject, old."from", old.preview);
    INSERT INTO emails_fts(rowid, subject, "from", preview)
      VALUES (new.rowid, new.subject, new."from", new.preview);
  END;
`,
];
