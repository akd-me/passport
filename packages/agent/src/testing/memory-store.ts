import type {
  Account,
  AccountCredentials,
  ActionRecord,
  Calendar,
  CalendarEvent,
  Email,
  GlobalPolicyConfig,
  Mailbox,
  Matter,
  Page,
  Person,
  Store,
  SyncState,
  Thread,
  TrustState,
} from "@passport/types";
import { overlaps } from "../data.js";
import { AgentError } from "../errors.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}
function page<T>(items: T[], limit = 200, cursor?: string | null): Page<T> {
  const start = Number(cursor ?? 0),
    end = start + limit;
  return {
    items: copy(items.slice(start, end)),
    total: items.length,
    nextCursor: end < items.length ? String(end) : null,
  };
}
function search(text: string, query: string): boolean {
  return query
    .split(/\s+OR\s+/)
    .some((word) => text.toLowerCase().includes(word.replace(/^"|"$/g, "").toLowerCase()));
}

/** Complete in-memory Store fake; clone boundaries catch accidental direct mutation. */
export class MemoryStore implements Store {
  readonly data = {
    accounts: new Map<string, Account>(),
    credentials: new Map<string, AccountCredentials>(),
    sync: new Map<string, SyncState>(),
    mailboxes: new Map<string, Mailbox>(),
    emails: new Map<string, Email>(),
    threads: new Map<string, Thread>(),
    calendars: new Map<string, Calendar>(),
    events: new Map<string, CalendarEvent>(),
    people: new Map<string, Person>(),
    matters: new Map<string, Matter>(),
    actions: new Map<string, ActionRecord>(),
    trust: new Map<string, TrustState>(),
    kv: new Map<string, string>(),
  };
  private config: GlobalPolicyConfig | null = null;
  async migrate(): Promise<void> {}
  async close(): Promise<void> {}

  accounts: Store["accounts"] = {
    list: async () => copy([...this.data.accounts.values()]),
    get: async (id) => copy(this.data.accounts.get(id) ?? null),
    upsert: async (item) => {
      this.data.accounts.set(item.id, copy(item));
      return copy(item);
    },
    delete: async (id) => {
      this.data.accounts.delete(id);
    },
    setCredentials: async (id, credentials) => {
      this.data.credentials.set(id, copy(credentials));
    },
    getCredentials: async (id) => copy(this.data.credentials.get(id) ?? null),
  };
  syncState: Store["syncState"] = {
    get: async (id) => copy(this.data.sync.get(id) ?? null),
    set: async (state) => {
      this.data.sync.set(state.accountId, copy(state));
    },
  };
  mailboxes: Store["mailboxes"] = {
    list: async (id) =>
      copy([...this.data.mailboxes.values()].filter((item) => item.accountId === id)),
    get: async (id) => copy(this.data.mailboxes.get(id) ?? null),
    upsertMany: async (items) => {
      for (const item of items) this.data.mailboxes.set(item.id, copy(item));
    },
    deleteMany: async (ids) => {
      for (const id of ids) this.data.mailboxes.delete(id);
    },
  };
  emails: Store["emails"] = {
    get: async (id) => copy(this.data.emails.get(id) ?? null),
    getByProviderId: async (accountId, providerId) =>
      copy(
        [...this.data.emails.values()].find(
          (item) => item.accountId === accountId && item.providerId === providerId,
        ) ?? null,
      ),
    query: async (query) => {
      const items = [...this.data.emails.values()]
        .filter(
          (email) =>
            (!query.accountId || email.accountId === query.accountId) &&
            (!query.mailboxId || email.mailboxIds.includes(query.mailboxId)) &&
            (!query.threadId || email.threadId === query.threadId) &&
            (query.matterId === undefined || (email.matterId ?? null) === query.matterId) &&
            (!query.personId || email.personIds.includes(query.personId)) &&
            (!query.category || email.category === query.category) &&
            (!query.after || email.receivedAt >= query.after) &&
            (!query.before || email.receivedAt < query.before) &&
            (!query.text ||
              search(
                `${email.subject} ${email.from.map((a) => a.email).join(" ")} ${email.textBody ?? email.preview}`,
                query.text,
              )) &&
            (query.keywords?.has ?? []).every((key) => email.keywords[key]) &&
            (query.keywords?.not ?? []).every((key) => !email.keywords[key]),
        )
        .sort((a, b) =>
          query.sort === "receivedAt_asc"
            ? a.receivedAt.localeCompare(b.receivedAt)
            : b.receivedAt.localeCompare(a.receivedAt),
        );
      const result = page(items, query.limit, query.cursor);
      if (!query.includeBodies)
        for (const item of result.items) {
          delete item.textBody;
          delete item.htmlBody;
        }
      return result;
    },
    upsertMany: async (items) => {
      for (const item of items) this.data.emails.set(item.id, copy(item));
    },
    patchMany: async (ids, patch) => {
      for (const id of ids) {
        const email = this.data.emails.get(id);
        if (email) this.data.emails.set(id, copy({ ...email, ...patch }));
      }
    },
    deleteMany: async (ids) => {
      for (const id of ids) this.data.emails.delete(id);
    },
  };
  threads: Store["threads"] = {
    get: async (id) => copy(this.data.threads.get(id) ?? null),
    upsertMany: async (items) => {
      for (const item of items) this.data.threads.set(item.id, copy(item));
    },
  };
  calendars: Store["calendars"] = {
    list: async (id) =>
      copy([...this.data.calendars.values()].filter((item) => item.accountId === id)),
    upsertMany: async (items) => {
      for (const item of items) this.data.calendars.set(item.id, copy(item));
    },
  };
  events: Store["events"] = {
    get: async (id) => copy(this.data.events.get(id) ?? null),
    query: async (query) =>
      copy(
        [...this.data.events.values()]
          .filter(
            (event) =>
              (!query.accountId || event.accountId === query.accountId) &&
              (!query.matterId || event.matterId === query.matterId) &&
              (!query.range ||
                overlaps(event, query.range) ||
                (query.includeRecurring &&
                  (Boolean(event.recurringEventId) ||
                    (Boolean(event.recurrenceRule) && event.start < query.range.end)))),
          )
          .slice(0, query.limit),
      ),
    upsertMany: async (items) => {
      for (const item of items) this.data.events.set(item.id, copy(item));
    },
    deleteMany: async (ids) => {
      for (const id of ids) this.data.events.delete(id);
    },
  };
  people: Store["people"] = {
    get: async (id) => copy(this.data.people.get(id) ?? null),
    getByEmail: async (email) =>
      copy(
        [...this.data.people.values()].find((person) =>
          person.emails.some((item) => item.toLowerCase() === email.toLowerCase()),
        ) ?? null,
      ),
    list: async (query) =>
      copy(
        [...this.data.people.values()]
          .filter(
            (person) =>
              (!query?.relationship || person.relationship === query.relationship) &&
              (!query?.text ||
                search(`${person.displayName} ${person.emails.join(" ")}`, query.text)),
          )
          .slice(0, query?.limit),
      ),
    upsert: async (person) => {
      this.data.people.set(person.id, copy(person));
      return copy(person);
    },
    merge: async (keepId, mergeId) => {
      const keep = this.data.people.get(keepId),
        merge = this.data.people.get(mergeId);
      if (!keep || !merge) throw new AgentError("Missing person in fake merge", "FAKE_NOT_FOUND");
      const person = { ...keep, emails: [...new Set([...keep.emails, ...merge.emails])] };
      this.data.people.set(keepId, person);
      this.data.people.delete(mergeId);
      return copy(person);
    },
  };
  matters: Store["matters"] = {
    get: async (id) => copy(this.data.matters.get(id) ?? null),
    list: async (query) =>
      copy(
        [...this.data.matters.values()]
          .filter(
            (matter) =>
              (!query?.status || query.status.includes(matter.status)) &&
              (!query?.personId || matter.personIds.includes(query.personId)) &&
              (!query?.text || search(`${matter.title} ${matter.summary}`, query.text)),
          )
          .slice(0, query?.limit),
      ),
    upsert: async (matter) => {
      this.data.matters.set(matter.id, copy(matter));
      return copy(matter);
    },
    delete: async (id) => {
      this.data.matters.delete(id);
    },
  };
  actions: Store["actions"] = {
    get: async (id) => copy(this.data.actions.get(id) ?? null),
    query: async (query) =>
      page(
        [...this.data.actions.values()].filter(
          (action) =>
            (!query.status || query.status.includes(action.status)) &&
            (!query.category || action.request.category === query.category) &&
            (!query.actorKind || action.request.actor.kind === query.actorKind) &&
            (!query.runId || action.request.runId === query.runId) &&
            (!query.matterId || action.request.matterId === query.matterId) &&
            (!query.after || action.createdAt >= query.after) &&
            (!query.before || action.createdAt < query.before),
        ),
        query.limit,
        query.cursor,
      ),
    insert: async (record) => {
      this.data.actions.set(record.id, copy(record));
      return copy(record);
    },
    update: async (id, patch) => {
      const record = this.data.actions.get(id);
      if (!record) throw new AgentError("Missing fake action", "FAKE_NOT_FOUND");
      const updated = { ...record, ...patch };
      this.data.actions.set(id, copy(updated));
      return copy(updated);
    },
    dueHeld: async (now) =>
      copy(
        [...this.data.actions.values()].filter(
          (action) => action.status === "held" && action.holdUntil && action.holdUntil <= now,
        ),
      ),
  };
  trust: Store["trust"] = {
    list: async () => copy([...this.data.trust.values()]),
    get: async (category) => copy(this.data.trust.get(category) ?? null),
    upsert: async (state) => {
      this.data.trust.set(state.category, copy(state));
      return copy(state);
    },
    getConfig: async () => copy(this.config),
    setConfig: async (config) => {
      this.config = copy(config);
    },
  };
  kv: Store["kv"] = {
    get: async (key) => this.data.kv.get(key) ?? null,
    set: async (key, value) => {
      this.data.kv.set(key, value);
    },
    delete: async (key) => {
      this.data.kv.delete(key);
    },
  };
}
