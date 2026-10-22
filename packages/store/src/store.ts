import { randomBytes, scryptSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { MailReaderResolver, Store, StoreTasks } from "@passport/types";
import { StoreError } from "./errors.js";
import { createActionsRepositories } from "./store-actions.js";
import { createCalendarRepositories } from "./store-calendar.js";
import { StoreDatabase } from "./store-database.js";
import { createMailRepositories } from "./store-mail.js";
import { createPeopleRepositories } from "./store-people.js";
import { createTasksRepository } from "./store-tasks.js";

class SQLiteStore extends StoreDatabase implements Store {
  accounts: Store["accounts"];
  syncState: Store["syncState"];
  mailboxes: Store["mailboxes"];
  emails: Store["emails"];
  threads: Store["threads"];
  calendars: Store["calendars"];
  events: Store["events"];
  people: Store["people"];
  matters: Store["matters"];
  actions: Store["actions"];
  trust: Store["trust"];
  kv: Store["kv"];
  tasks: StoreTasks;
  private resolver: MailReaderResolver | null = null;
  constructor(db: DatabaseSync, key: Buffer) {
    super(db, key);
    const mail = createMailRepositories(this, () => this.resolver);
    this.accounts = mail.accounts;
    this.syncState = mail.syncState;
    this.mailboxes = mail.mailboxes;
    this.emails = mail.emails;
    this.threads = mail.threads;
    const calendar = createCalendarRepositories(this);
    this.calendars = calendar.calendars;
    this.events = calendar.events;
    const people = createPeopleRepositories(this);
    this.people = people.people;
    this.matters = people.matters;
    const actions = createActionsRepositories(this);
    this.actions = actions.actions;
    this.trust = actions.trust;
    this.kv = actions.kv;
    this.tasks = createTasksRepository(this);
  }
  setMailReaderResolver(resolver: MailReaderResolver): void {
    this.resolver = resolver;
  }
}

/**
 * Open a SQLite store. Call and await migrate() before repository operations.
 * File-backed stores require masterKey or PASSPORT_MASTER_KEY. In-memory stores may use an ephemeral key.
 */
export function openStore(opts: { path: string | ":memory:"; masterKey?: string }): Store {
  if (
    !opts.path ||
    (opts.path !== ":memory:" && (opts.path.startsWith("file:") || opts.path.includes("\0")))
  ) {
    throw new StoreError(
      "INVALID_PATH",
      "Use a filesystem path or :memory: (SQLite URI paths are not supported)",
    );
  }
  const configured = opts.masterKey ?? process.env.PASSPORT_MASTER_KEY;
  if (configured !== undefined && !configured.trim()) {
    throw new StoreError("MASTER_KEY_REQUIRED", "Master key must not be empty");
  }
  if (configured === undefined && opts.path !== ":memory:") {
    throw new StoreError(
      "MASTER_KEY_REQUIRED",
      "A file-backed store requires masterKey or PASSPORT_MASTER_KEY",
    );
  }
  const key =
    configured === undefined
      ? randomBytes(32)
      : scryptSync(configured, "passport/store/aes-256-gcm/v1", 32);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(opts.path);
    db.exec(
      "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;",
    );
    return new SQLiteStore(db, key);
  } catch (cause) {
    // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

    db?.close();
    key.fill(0);
    throw new StoreError("STORE_OPEN_FAILED", "Cannot open SQLite store", { cause });
  }
}
