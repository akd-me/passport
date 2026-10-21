import type {
  Account,
  AccountCredentials,
  ActionQuery,
  ActionRecord,
  Calendar,
  CalendarEvent,
  DomainEvent,
  Email,
  EmailQuery,
  EventBus,
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
import { PolicyError } from "../errors.js";

const clone = <T>(value: T): T => structuredClone(value);
const read = <T>(map: Map<string, T>, key: string): T | null => clone(map.get(key) ?? null);
const values = <T>(map: Map<string, T>): T[] => clone([...map.values()]);
const page = <T>(items: T[], limit = 100, cursor?: string | null): Page<T> => {
  const offset = Number(cursor ?? 0),
    size = Math.max(0, limit);
  return {
    items: clone(items.slice(offset, offset + size)),
    total: items.length,
    nextCursor: size > 0 && offset + size < items.length ? String(offset + size) : null,
  };
};

/** Small isolated Store fake. Returns copies, preserves query pagination, and never uses disk/network. */
export function createMemoryStore(): Store {
  const accounts = new Map<string, Account>(),
    credentials = new Map<string, AccountCredentials>();
  const sync = new Map<string, SyncState>(),
    mailboxes = new Map<string, Mailbox>(),
    emails = new Map<string, Email>();
  const threads = new Map<string, Thread>(),
    calendars = new Map<string, Calendar>(),
    events = new Map<string, CalendarEvent>();
  const people = new Map<string, Person>(),
    matters = new Map<string, Matter>(),
    actions = new Map<string, ActionRecord>();
  const trust = new Map<string, TrustState>(),
    kv = new Map<string, string>();
  let config: GlobalPolicyConfig | null = null;
  const setMany = <T extends { id: string }>(map: Map<string, T>, items: T[]) => {
    for (const item of items) {
      map.set(item.id, clone(item));
    }
  };
  const deleteMany = <T>(map: Map<string, T>, ids: string[]) => {
    for (const id of ids) {
      map.delete(id);
    }
  };
  return {
    async migrate() {},
    async close() {},
    accounts: {
      async list() {
        return values(accounts);
      },
      async get(id) {
        return read(accounts, id);
      },
      async upsert(account) {
        accounts.set(account.id, clone(account));
        return clone(account);
      },
      async delete(id) {
        accounts.delete(id);
        credentials.delete(id);
      },
      async setCredentials(id, value) {
        credentials.set(id, clone(value));
      },
      async getCredentials(id) {
        return read(credentials, id);
      },
    },
    syncState: {
      async get(id) {
        return read(sync, id);
      },
      async set(state) {
        sync.set(state.accountId, clone(state));
      },
    },
    mailboxes: {
      async list(accountId) {
        return values(mailboxes).filter((item) => item.accountId === accountId);
      },
      async get(id) {
        return read(mailboxes, id);
      },
      async upsertMany(items) {
        setMany(mailboxes, items);
      },
      async deleteMany(ids) {
        deleteMany(mailboxes, ids);
      },
    },
    emails: {
      async get(id) {
        return read(emails, id);
      },
      async getByProviderId(accountId, providerId) {
        return (
          values(emails).find(
            (item) => item.accountId === accountId && item.providerId === providerId,
          ) ?? null
        );
      },
      async query(q: EmailQuery) {
        const items = values(emails).filter(
          (item) =>
            (!q.accountId || item.accountId === q.accountId) &&
            (!q.mailboxId || item.mailboxIds.includes(q.mailboxId)) &&
            (!q.threadId || item.threadId === q.threadId) &&
            (q.matterId === undefined || (item.matterId ?? null) === q.matterId) &&
            (!q.personId || item.personIds.includes(q.personId)) &&
            (!q.category || item.category === q.category) &&
            (!q.after || item.receivedAt > q.after) &&
            (!q.before || item.receivedAt < q.before) &&
            (!q.text ||
              `${item.subject} ${item.textBody ?? ""} ${item.from.map((address) => address.email).join(" ")}`
                .toLowerCase()
                .includes(q.text.toLowerCase())) &&
            (q.keywords?.has ?? []).every((key) => item.keywords[key]) &&
            (q.keywords?.not ?? []).every((key) => !item.keywords[key]),
        );
        items.sort(
          (a, b) =>
            (q.sort === "receivedAt_asc" ? 1 : -1) * a.receivedAt.localeCompare(b.receivedAt) ||
            a.id.localeCompare(b.id),
        );
        return page(items, q.limit, q.cursor);
      },
      async upsertMany(items) {
        setMany(emails, items);
      },
      async patchMany(ids, patch) {
        for (const id of ids) {
          const item = emails.get(id);
          if (!item) {
            throw new PolicyError("EMAIL_NOT_FOUND", `Email ${id} does not exist`);
          }
          emails.set(id, { ...item, ...clone(patch) });
        }
      },
      async deleteMany(ids) {
        deleteMany(emails, ids);
      },
    },
    threads: {
      async get(id) {
        return read(threads, id);
      },
      async upsertMany(items) {
        setMany(threads, items);
      },
    },
    calendars: {
      async list(accountId) {
        return values(calendars).filter((item) => item.accountId === accountId);
      },
      async upsertMany(items) {
        setMany(calendars, items);
      },
    },
    events: {
      async get(id) {
        return read(events, id);
      },
      async query(q) {
        return values(events)
          .filter(
            (item) =>
              (!q.accountId || item.accountId === q.accountId) &&
              (!q.matterId || item.matterId === q.matterId) &&
              (!q.range ||
                (item.start < q.range.end && item.end > q.range.start) ||
                (q.includeRecurring &&
                  (Boolean(item.recurringEventId) ||
                    (Boolean(item.recurrenceRule) && item.start < q.range.end)))),
          )
          .slice(0, q.limit);
      },
      async upsertMany(items) {
        setMany(events, items);
      },
      async deleteMany(ids) {
        deleteMany(events, ids);
      },
    },
    people: {
      async get(id) {
        return read(people, id);
      },
      async getByEmail(email) {
        return (
          values(people).find((item) =>
            item.emails.some((address) => address.toLowerCase() === email.toLowerCase()),
          ) ?? null
        );
      },
      async list(q = {}) {
        return values(people)
          .filter(
            (item) =>
              (!q.relationship || item.relationship === q.relationship) &&
              (!q.text ||
                `${item.displayName} ${item.emails.join(" ")}`
                  .toLowerCase()
                  .includes(q.text.toLowerCase())),
          )
          .slice(0, q.limit);
      },
      async upsert(person) {
        people.set(person.id, clone(person));
        return clone(person);
      },
      async delete(id) {
        people.delete(id);
        for (const [key, email] of emails) {
          emails.set(key, {
            ...email,
            personIds: email.personIds.filter((personId) => personId !== id),
          });
        }
        for (const [key, matter] of matters) {
          matters.set(key, {
            ...matter,
            personIds: matter.personIds.filter((personId) => personId !== id),
          });
        }
      },
      async merge(keepId, mergeId) {
        const keep = people.get(keepId),
          merge = people.get(mergeId);
        if (!keep || !merge) {
          throw new PolicyError("PERSON_NOT_FOUND", "Both people must exist to merge");
        }
        const result = { ...keep, emails: [...new Set([...keep.emails, ...merge.emails])] };
        people.set(keepId, result);
        people.delete(mergeId);
        return clone(result);
      },
    },
    matters: {
      async get(id) {
        return read(matters, id);
      },
      async list(q = {}) {
        return values(matters)
          .filter(
            (item) =>
              (!q.status || q.status.includes(item.status)) &&
              (!q.personId || item.personIds.includes(q.personId)) &&
              (!q.text ||
                `${item.title} ${item.summary}`.toLowerCase().includes(q.text.toLowerCase())),
          )
          .slice(0, q.limit);
      },
      async upsert(matter) {
        matters.set(matter.id, clone(matter));
        return clone(matter);
      },
      async delete(id) {
        matters.delete(id);
      },
    },
    actions: {
      async claim(id, from, to, now) {
        const record = actions.get(id);
        if (!record || record.status !== from) {
          return null;
        }
        const updated = { ...record, status: to, decidedAt: now };
        actions.set(id, updated);
        return clone(updated);
      },
      async get(id) {
        return read(actions, id);
      },
      async query(q: ActionQuery) {
        return page(
          values(actions)
            .filter(
              (item) =>
                (!q.status || q.status.includes(item.status)) &&
                (!q.category || item.request.category === q.category) &&
                (!q.actorKind || item.request.actor.kind === q.actorKind) &&
                (!q.runId || item.request.runId === q.runId) &&
                (!q.matterId || item.request.matterId === q.matterId) &&
                (!q.after || item.createdAt > q.after) &&
                (!q.before || item.createdAt < q.before),
            )
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
          q.limit,
          q.cursor,
        );
      },
      async insert(record) {
        if (actions.has(record.id)) {
          throw new PolicyError("DUPLICATE_ACTION", "Action already exists");
        }
        actions.set(record.id, clone(record));
        return clone(record);
      },
      async update(id, patch) {
        const record = actions.get(id);
        if (!record) {
          throw new PolicyError("ACTION_NOT_FOUND", `Action ${id} does not exist`);
        }
        const updated = { ...record, ...clone(patch), id };
        actions.set(id, updated);
        return clone(updated);
      },
      async dueHeld(at) {
        return values(actions)
          .filter((item) => item.status === "held" && item.holdUntil && item.holdUntil <= at)
          .sort((a, b) => a.holdUntil!.localeCompare(b.holdUntil!));
      },
    },
    trust: {
      async list() {
        return values(trust);
      },
      async get(category) {
        return read(trust, category);
      },
      async upsert(state) {
        trust.set(state.category, clone(state));
        return clone(state);
      },
      async getConfig() {
        return clone(config);
      },
      async setConfig(value) {
        config = clone(value);
      },
    },
    kv: {
      async get(key) {
        return kv.get(key) ?? null;
      },
      async set(key, value) {
        kv.set(key, value);
      },
      async delete(key) {
        kv.delete(key);
      },
    },
  };
}

/** Synchronous EventBus fake with a captured event log for integration tests. */
export function createMemoryEventBus(): EventBus & { events: DomainEvent[] } {
  const handlers = new Set<(event: DomainEvent) => void>();
  const events: DomainEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(clone(event));
      for (const handler of handlers) {
        handler(clone(event));
      }
    },
    on(type, handler) {
      const wrapped = (event: DomainEvent) => {
        if (event.type === type) {
          handler(event as Parameters<typeof handler>[0]);
        }
      };
      handlers.add(wrapped);
      return () => {
        handlers.delete(wrapped);
      };
    },
    onAny(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
