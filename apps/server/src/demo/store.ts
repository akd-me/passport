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
import { ApiError, required } from "../errors.js";

const copy = <T>(value: T): T => structuredClone(value);
function table<T extends { id: string }>() {
  const rows = new Map<string, T>();
  return {
    all: () => copy([...rows.values()]),
    get: async (id: string) => copy(rows.get(id) ?? null),
    upsert: async (value: T) => {
      rows.set(value.id, copy(value));
      return copy(value);
    },
    upsertMany: async (values: T[]) => {
      for (const value of values) rows.set(value.id, copy(value));
    },
    delete: async (id: string) => {
      rows.delete(id);
    },
    deleteMany: async (ids: string[]) => {
      ids.forEach((id) => rows.delete(id));
    },
  };
}
function page<T>(items: T[], limit = 50, cursor?: string | null): Page<T> {
  const offset = Number(cursor || 0);
  if (!Number.isInteger(offset) || offset < 0)
    throw new ApiError("INVALID_CURSOR", "Cursor must be a positive offset");
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    nextCursor: offset + limit < items.length ? String(offset + limit) : null,
  };
}
const inRange = (at: string, after?: string, before?: string) =>
  (!after || at >= after) && (!before || at <= before);

/** Deliberately ephemeral Store; clones every boundary, and never writes secrets to disk. */
export function createDemoStore(): Store {
  const accounts = table<Account>(),
    mailboxes = table<Mailbox>(),
    emails = table<Email>();
  const threads = table<Thread>(),
    calendars = table<Calendar>(),
    events = table<CalendarEvent>();
  const people = table<Person>(),
    matters = table<Matter>(),
    actions = table<ActionRecord>();
  const credentials = new Map<string, AccountCredentials>(),
    sync = new Map<string, SyncState>();
  const trust = new Map<string, TrustState>(),
    kv = new Map<string, string>();
  let config: GlobalPolicyConfig | null = null;
  return {
    migrate: async () => {},
    close: async () => {
      credentials.clear();
    },
    accounts: {
      ...accounts,
      list: async () => accounts.all(),
      setCredentials: async (id, value) => {
        credentials.set(id, copy(value));
      },
      getCredentials: async (id) => copy(credentials.get(id) ?? null),
    },
    syncState: {
      get: async (id) => copy(sync.get(id) ?? null),
      set: async (value) => {
        sync.set(value.accountId, copy(value));
      },
    },
    mailboxes: {
      ...mailboxes,
      list: async (id) => mailboxes.all().filter((row) => row.accountId === id),
    },
    emails: {
      ...emails,
      get: async (id, opts) => {
        const row = await emails.get(id);
        if (row && !opts?.includeBodies) {
          delete row.textBody;
          delete row.htmlBody;
        }
        return row;
      },
      getByProviderId: async (id, providerId) =>
        emails.all().find((row) => row.accountId === id && row.providerId === providerId) ?? null,
      query: async (q) => {
        const rows = emails
          .all()
          .filter(
            (e) =>
              (!q.accountId || e.accountId === q.accountId) &&
              (!q.mailboxId || e.mailboxIds.includes(q.mailboxId)) &&
              (!q.threadId || e.threadId === q.threadId) &&
              (q.matterId === undefined || (e.matterId ?? null) === q.matterId) &&
              (!q.personId || e.personIds.includes(q.personId)) &&
              (!q.category || e.category === q.category) &&
              inRange(e.receivedAt, q.after, q.before) &&
              (!q.text ||
                [e.subject, e.textBody, ...e.from.map((f) => `${f.name} ${f.email}`)]
                  .join(" ")
                  .toLowerCase()
                  .includes(q.text.toLowerCase())) &&
              (!q.keywords?.has || q.keywords.has.every((k) => e.keywords[k])) &&
              (!q.keywords?.not || q.keywords.not.every((k) => !e.keywords[k])),
          );
        rows.sort(
          (a, b) =>
            (q.sort === "receivedAt_asc" ? 1 : -1) * a.receivedAt.localeCompare(b.receivedAt),
        );
        if (!q.includeBodies)
          rows.forEach((e) => {
            delete e.textBody;
            delete e.htmlBody;
          });
        return page(rows, q.limit, q.cursor);
      },
      patchMany: async (ids, patch) => {
        for (const id of ids)
          await emails.upsert({
            ...required(await emails.get(id), "Email"),
            ...patch,
          });
      },
    },
    threads,
    calendars: {
      ...calendars,
      list: async (id) => calendars.all().filter((row) => row.accountId === id),
    },
    events: {
      ...events,
      query: async (q) =>
        events
          .all()
          .filter(
            (e) =>
              (!q.accountId || e.accountId === q.accountId) &&
              (!q.matterId || e.matterId === q.matterId) &&
              (!q.range || (e.start <= q.range.end && e.end >= q.range.start)),
          )
          .sort((a, b) => a.start.localeCompare(b.start))
          .slice(0, q.limit ?? 100),
    },
    people: {
      ...people,
      getByEmail: async (email) =>
        people.all().find((p) => p.emails.includes(email.toLowerCase())) ?? null,
      list: async (q = {}) =>
        people
          .all()
          .filter(
            (p) =>
              (!q.relationship || p.relationship === q.relationship) &&
              (!q.text ||
                `${p.displayName} ${p.emails.join(" ")}`
                  .toLowerCase()
                  .includes(q.text.toLowerCase())),
          )
          .slice(0, q.limit ?? 100),
      merge: async (keepId, mergeId) => {
        const keep = required(await people.get(keepId), "Person"),
          other = required(await people.get(mergeId), "Person");
        const result = await people.upsert({
          ...keep,
          emails: [...new Set([...keep.emails, ...other.emails])],
        });
        await people.delete(mergeId);
        return result;
      },
    },
    matters: {
      ...matters,
      list: async (q = {}) =>
        matters
          .all()
          .filter(
            (m) =>
              (!q.status || q.status.includes(m.status)) &&
              (!q.personId || m.personIds.includes(q.personId)) &&
              (!q.text || `${m.title} ${m.summary}`.toLowerCase().includes(q.text.toLowerCase())),
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, q.limit ?? 100),
    },
    actions: {
      ...actions,
      insert: async (row) => {
        if (await actions.get(row.id))
          throw new ApiError("DUPLICATE", "Action already exists", 409);
        return actions.upsert(row);
      },
      update: async (id, patch) =>
        actions.upsert({
          ...required(await actions.get(id), "Action"),
          ...patch,
          id,
        }),
      query: async (q) =>
        page(
          actions
            .all()
            .filter(
              (a) =>
                (!q.status || q.status.includes(a.status)) &&
                (!q.category || a.request.category === q.category) &&
                (!q.actorKind || a.request.actor.kind === q.actorKind) &&
                (!q.runId || a.request.runId === q.runId) &&
                (!q.matterId || a.request.matterId === q.matterId) &&
                inRange(a.createdAt, q.after, q.before),
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          q.limit,
          q.cursor,
        ),
      dueHeld: async (now) =>
        actions.all().filter((a) => a.status === "held" && a.holdUntil && a.holdUntil <= now),
    },
    trust: {
      list: async () => copy([...trust.values()]),
      get: async (c) => copy(trust.get(c) ?? null),
      upsert: async (state) => {
        trust.set(state.category, copy(state));
        return copy(state);
      },
      getConfig: async () => copy(config),
      setConfig: async (value) => {
        config = copy(value);
      },
    },
    kv: {
      get: async (key) => kv.get(key) ?? null,
      set: async (key, value) => {
        kv.set(key, value);
      },
      delete: async (key) => {
        kv.delete(key);
      },
    },
  };
}
