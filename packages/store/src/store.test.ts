import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EmailQuery, Store, TrustState } from "@passport/types";
import { DEFAULT_POLICY_CONFIG } from "@passport/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { account, action, at, email, event, matter, person } from "./fixtures.js";
import { openStore } from "./index.js";

let store: Store;
beforeEach(async () => {
  store = openStore({ path: ":memory:" });
  await store.migrate();
});
afterEach(async () => {
  await store.close();
  vi.unstubAllEnvs();
});

describe("lifecycle and credentials", () => {
  it("migrates repeatedly without losing records", async () => {
    await store.kv.set("existing", "value");
    await store.migrate();
    await store.migrate();
    expect(await store.kv.get("existing")).toBe("value");
    await store.emails.upsertMany([email()]);
    expect((await store.emails.query({ text: '"quick brown"' })).total).toBe(1);
  });

  it("closes idempotently and rejects later repository calls", async () => {
    await store.close();
    await store.close();
    await expect(store.kv.get("x")).rejects.toMatchObject({ code: "STORE_CLOSED" });
    await expect(store.migrate()).rejects.toMatchObject({ code: "STORE_CLOSED" });
  });

  it("round-trips, replaces, and isolates encrypted credentials", async () => {
    expect(await store.accounts.getCredentials("missing")).toBeNull();
    await store.accounts.setCredentials("account", {
      refresh_token: "very-private",
      password: "p@ss",
    });
    await store.accounts.setCredentials("other", { token: "other-secret" });
    expect(await store.accounts.getCredentials("account")).toEqual({
      refresh_token: "very-private",
      password: "p@ss",
    });
    await store.accounts.setCredentials("account", { access_token: "new" });
    expect(await store.accounts.getCredentials("account")).toEqual({ access_token: "new" });
    expect(await store.accounts.getCredentials("other")).toEqual({ token: "other-secret" });
  });

  it("rejects missing and empty file-backed keys before creating a database", () => {
    vi.stubEnv("PASSPORT_MASTER_KEY", undefined);
    expect(() => openStore({ path: "/does-not-exist/store.sqlite" })).toThrow(
      expect.objectContaining({ code: "MASTER_KEY_REQUIRED" }),
    );
    expect(() => openStore({ path: ":memory:", masterKey: " " })).toThrow(
      expect.objectContaining({ code: "MASTER_KEY_REQUIRED" }),
    );
    expect(() => openStore({ path: "" })).toThrow(
      expect.objectContaining({ code: "INVALID_PATH" }),
    );
  });

  it("persists migrations and encrypted data, supports env keys, and fails with the wrong key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "passport-store-"));
    const path = join(directory, "store.sqlite");
    const opened: Store[] = [];
    try {
      vi.stubEnv("PASSPORT_MASTER_KEY", "correct secret key");
      const first = openStore({ path });
      opened.push(first);
      await first.migrate();
      await first.accounts.upsert(account());
      await first.accounts.setCredentials("account", { token: "unique-secret-not-in-database" });
      await first.emails.upsertMany([email("removed"), email("retained")]);
      await first.emails.deleteMany(["removed"]);
      await first.close();
      const bytes = await readFile(path);
      expect(bytes.includes(Buffer.from("unique-secret-not-in-database"))).toBe(false);
      const raw = new DatabaseSync(path);
      expect(raw.prepare("SELECT version FROM schema_version").all()).toEqual([{ version: 1 }]);
      expect(raw.prepare("SELECT COUNT(*) AS count FROM kv").get()).toEqual({ count: 0 });
      raw.exec("VACUUM");
      raw.close();
      const wrong = openStore({ path, masterKey: "wrong" });
      opened.push(wrong);
      await wrong.migrate();
      await expect(wrong.accounts.getCredentials("account")).rejects.toMatchObject({
        code: "CREDENTIAL_DECRYPTION_FAILED",
      });
      await wrong.close();
      const correct = openStore({ path });
      opened.push(correct);
      await correct.migrate();
      expect(await correct.accounts.get("account")).toEqual(account());
      expect(await correct.accounts.getCredentials("account")).toEqual({
        token: "unique-secret-not-in-database",
      });
      expect(
        (await correct.emails.query({ text: '"quick brown"' })).items.map((item) => item.id),
      ).toEqual(["retained"]);
    } finally {
      for (const openedStore of opened) await openedStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("accounts, sync state, mailboxes, threads, calendars, and kv", () => {
  it("creates, reads, updates and deletes accounts", async () => {
    expect(await store.accounts.get("missing")).toBeNull();
    expect(await store.accounts.list()).toEqual([]);
    expect(await store.accounts.upsert(account())).toEqual(account());
    const changed = { ...account(), displayName: "Updated", lastSyncError: "Offline" };
    expect(await store.accounts.upsert(changed)).toEqual(changed);
    expect(await store.accounts.list()).toEqual([changed]);
    await store.accounts.delete("account");
    await store.accounts.delete("account");
    expect(await store.accounts.get("account")).toBeNull();
  });

  it("reads and overwrites sync state by account", async () => {
    expect(await store.syncState.get("account")).toBeNull();
    await store.syncState.set({ accountId: "account", cursor: null, updatedAt: at });
    await store.syncState.set({ accountId: "account", cursor: "delta-2", updatedAt: at });
    expect(await store.syncState.get("account")).toEqual({
      accountId: "account",
      cursor: "delta-2",
      updatedAt: at,
    });
    expect(await store.syncState.get("other")).toBeNull();
  });

  it("upserts, filters and deletes mailboxes and their memberships", async () => {
    const mailbox = {
      id: "inbox",
      accountId: "account",
      providerId: "inbox",
      name: "Inbox",
      role: "inbox" as const,
      totalEmails: 1,
      unreadEmails: 0,
    };
    expect(await store.mailboxes.get("inbox")).toBeNull();
    await store.mailboxes.upsertMany([mailbox, { ...mailbox, id: "other", accountId: "other" }]);
    await store.mailboxes.upsertMany([{ ...mailbox, unreadEmails: 1 }]);
    expect(await store.mailboxes.list("account")).toEqual([{ ...mailbox, unreadEmails: 1 }]);
    expect(await store.mailboxes.get("inbox")).toEqual({ ...mailbox, unreadEmails: 1 });
    await store.emails.upsertMany([email()]);
    await store.mailboxes.deleteMany(["inbox", "missing"]);
    expect(await store.mailboxes.get("inbox")).toBeNull();
    expect((await store.emails.get("email"))?.mailboxIds).toEqual([]);
    expect((await store.emails.query({ mailboxId: "inbox" })).items).toEqual([]);
  });

  it("upserts threads and removes deleted email references", async () => {
    expect(await store.threads.get("thread")).toBeNull();
    await store.threads.upsertMany([
      { id: "thread", accountId: "account", emailIds: ["email", "other"] },
    ]);
    await store.threads.upsertMany([{ id: "thread", accountId: "account", emailIds: ["email"] }]);
    expect(await store.threads.get("thread")).toEqual({
      id: "thread",
      accountId: "account",
      emailIds: ["email"],
    });
    await store.emails.upsertMany([email()]);
    await store.emails.deleteMany(["email"]);
    expect((await store.threads.get("thread"))?.emailIds).toEqual([]);
  });

  it("upserts calendars and scopes lists by account", async () => {
    const calendar = {
      id: "calendar",
      accountId: "account",
      providerId: "main",
      name: "Main",
      isPrimary: true,
      timeZone: "America/New_York",
    };
    await store.calendars.upsertMany([calendar, { ...calendar, id: "other", accountId: "other" }]);
    await store.calendars.upsertMany([{ ...calendar, name: "Renamed" }]);
    expect(await store.calendars.list("account")).toEqual([{ ...calendar, name: "Renamed" }]);
  });

  it("cleans account data and memberships while preserving the audit log and other accounts", async () => {
    await store.accounts.upsert(account());
    await store.accounts.upsert(account("other"));
    await store.emails.upsertMany([email(), email("other", { accountId: "other" })]);
    await store.events.upsertMany([event()]);
    await store.matters.upsert(matter());
    await store.accounts.setCredentials("account", { token: "secret" });
    await store.syncState.set({ accountId: "account", cursor: "cursor", updatedAt: at });
    await store.threads.upsertMany([{ id: "thread", accountId: "account", emailIds: ["email"] }]);
    await store.calendars.upsertMany([
      {
        id: "calendar",
        accountId: "account",
        providerId: "calendar",
        name: "Calendar",
        isPrimary: true,
      },
    ]);
    await store.actions.insert(action());
    await store.accounts.delete("account");
    expect(await store.emails.get("email")).toBeNull();
    expect(await store.emails.get("other")).not.toBeNull();
    expect(await store.events.get("event")).toBeNull();
    expect(await store.calendars.list("account")).toEqual([]);
    expect(await store.threads.get("thread")).toBeNull();
    expect(await store.syncState.get("account")).toBeNull();
    expect(await store.accounts.getCredentials("account")).toBeNull();
    expect(await store.matters.get("matter")).toMatchObject({ emailIds: [], eventIds: [] });
    expect(await store.actions.get("action")).not.toBeNull();
  });

  it("handles missing, empty, replaced and deleted kv strings with bound keys", async () => {
    const key = "key'); DROP TABLE kv;--";
    expect(await store.kv.get(key)).toBeNull();
    await store.kv.set(key, "");
    expect(await store.kv.get(key)).toBe("");
    await store.kv.set(key, "USER.md\nHello");
    expect(await store.kv.get(key)).toBe("USER.md\nHello");
    await store.kv.delete(key);
    await store.kv.delete(key);
    expect(await store.kv.get(key)).toBeNull();
  });
});

describe("email records and search", () => {
  beforeEach(async () => {
    await store.emails.upsertMany([email()]);
  });

  it("round-trips nested data and supports provider lookup with account isolation", async () => {
    expect(await store.emails.get("missing")).toBeNull();
    expect(await store.emails.get("email")).toEqual(email());
    expect(await store.emails.getByProviderId("account", "provider-email")).toEqual(email());
    expect(await store.emails.getByProviderId("other", "provider-email")).toBeNull();
  });

  it("excludes bodies from lists by default and from explicit lightweight gets", async () => {
    const listed = (await store.emails.query({})).items[0];
    expect(listed).not.toHaveProperty("textBody");
    expect(listed).not.toHaveProperty("htmlBody");
    expect(await store.emails.get("email", { includeBodies: false })).not.toHaveProperty(
      "textBody",
    );
    expect((await store.emails.query({ includeBodies: true })).items).toEqual([email()]);
  });

  it("preserves fetched bodies on metadata-only sync and clears explicitly null bodies", async () => {
    const metadata = email("email", { subject: "Changed" });
    delete metadata.textBody;
    delete metadata.htmlBody;
    await store.emails.upsertMany([metadata]);
    expect(await store.emails.get("email")).toMatchObject({
      subject: "Changed",
      textBody: email().textBody,
      htmlBody: email().htmlBody,
    });
    await store.emails.upsertMany([email("email", { textBody: null, htmlBody: null })]);
    expect(await store.emails.get("email")).toMatchObject({ textBody: null, htmlBody: null });
  });

  it.each([
    "Travel",
    "expedition",
    '"quick brown"',
    "reserv*",
    "Alice",
    "example",
    "from:Alice",
    "textBody:reserv*",
  ])("searches with FTS5 MATCH: %s", async (text) => {
    expect((await store.emails.query({ text })).items.map((item) => item.id)).toEqual(["email"]);
  });

  it("does not treat unquoted reordered words as a phrase and updates/deletes FTS postings", async () => {
    expect((await store.emails.query({ text: '"brown quick"' })).total).toBe(0);
    await store.emails.upsertMany([
      email("email", {
        subject: "Completely changed",
        preview: "Nothing",
        from: [],
        textBody: "Replacement",
      }),
    ]);
    expect((await store.emails.query({ text: "Travel OR fox OR Alice" })).total).toBe(0);
    expect((await store.emails.query({ text: "Replacement" })).total).toBe(1);
    await store.emails.deleteMany(["email"]);
    expect((await store.emails.query({ text: "Replacement" })).total).toBe(0);
    expect(await store.emails.get("email")).toBeNull();
  });

  it("combines every email filter and distinguishes no matter from no matter filter", async () => {
    await store.emails.upsertMany([
      email("different", {
        accountId: "other",
        mailboxIds: ["archive"],
        threadId: "other",
        personIds: ["bob"],
        keywords: { $seen: false, $flagged: true },
        category: "other",
        matterId: "matter",
        receivedAt: "2026-10-21T12:00:00.000Z",
      }),
    ]);
    const query: EmailQuery = {
      accountId: "account",
      mailboxId: "inbox",
      threadId: "thread",
      matterId: null,
      personId: "alice",
      category: "scheduling",
      after: "2026-10-19T00:00:00.000Z",
      before: "2026-10-21T00:00:00.000Z",
      keywords: { has: ["$seen"], not: ["$flagged", "custom"] },
      text: "Travel",
    };
    expect((await store.emails.query(query)).items.map((item) => item.id)).toEqual(["email"]);
    expect((await store.emails.query({ matterId: "matter" })).items.map((item) => item.id)).toEqual(
      ["different"],
    );
    expect((await store.emails.query({})).total).toBe(2);
    expect(
      (await store.emails.query({ after: at, before: "2026-10-21T12:00:00.000Z" })).total,
    ).toBe(0);
    expect((await store.emails.query({ keywords: { has: ["$flagged"] } })).total).toBe(1);
  });

  it("binds arbitrary keyword keys, including quotes and punctuation", async () => {
    const keyword = 'label:He said "hi".$odd';
    await store.emails.patchMany(["email"], { keywords: { [keyword]: true, $seen: false } });
    expect((await store.emails.query({ keywords: { has: [keyword], not: ["$seen"] } })).total).toBe(
      1,
    );
    expect((await store.emails.query({ keywords: { has: ["x' OR 1=1 --"] } })).total).toBe(0);
  });

  it("patches memberships, keywords, matter and category, ignoring absent ids", async () => {
    await store.matters.upsert(matter("matter", { emailIds: [], eventIds: [] }));
    await store.emails.patchMany(["email", "email", "missing"], {
      mailboxIds: ["archive", "archive"],
      personIds: ["bob"],
      keywords: { $flagged: true },
      category: "other",
      matterId: "matter",
    });
    expect(await store.emails.get("email")).toMatchObject({
      mailboxIds: ["archive"],
      personIds: ["bob"],
      keywords: { $flagged: true },
      category: "other",
      matterId: "matter",
    });
    expect((await store.emails.query({ personId: "alice" })).total).toBe(0);
    expect((await store.emails.query({ mailboxId: "inbox" })).total).toBe(0);
    expect((await store.matters.get("matter"))?.emailIds).toEqual(["email"]);
    await store.emails.patchMany(["email"], { matterId: null });
    expect((await store.matters.get("matter"))?.emailIds).toEqual([]);
  });

  it("rolls back an entire batch, including FTS and joins, on a provider-id collision", async () => {
    await expect(
      store.emails.upsertMany([
        email("email", { subject: "Uncommitted", personIds: ["wrong"], matterId: "wrong" }),
        email("new"),
        email("collision", { providerId: "provider-new" }),
      ]),
    ).rejects.toMatchObject({ code: "ERR_SQLITE_ERROR" });
    expect(await store.emails.get("new")).toBeNull();
    expect(await store.emails.get("email")).toEqual(email());
    expect((await store.emails.query({ text: "Uncommitted" })).total).toBe(0);
    expect((await store.emails.query({ text: "fox" })).total).toBe(1);
    await store.emails.upsertMany([email("new")]);
    expect((await store.emails.query({})).total).toBe(2);
  });

  it("rejects invalid FTS instead of silently changing the search", async () => {
    await expect(store.emails.query({ text: '"unfinished' })).rejects.toMatchObject({
      code: "ERR_SQLITE_ERROR",
    });
  });

  it("ignores undefined patch properties while allowing explicit null", async () => {
    await store.emails.patchMany(["email"], {
      keywords: undefined,
      mailboxIds: undefined,
      personIds: undefined,
      category: null,
    });
    expect(await store.emails.get("email")).toEqual(email("email", { category: null }));
  });
});

describe("cursor pagination", () => {
  it.each(["receivedAt_asc", "receivedAt_desc"] as const)(
    "visits 67 emails exactly once in %s order, including timestamp ties",
    async (sort) => {
      const records = Array.from({ length: 67 }, (_, i) =>
        email(`email-${String(i).padStart(3, "0")}`, {
          receivedAt: new Date(Date.parse(at) + Math.floor(i / 8) * 1000).toISOString(),
        }),
      );
      await store.emails.upsertMany(records);
      const expected = records.map((record) => record.id);
      if (sort === "receivedAt_desc") expected.reverse();
      const ids: string[] = [];
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const page = await store.emails.query({ sort, limit: 7, cursor, text: "Travel" });
        expect(page.total).toBe(67);
        ids.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(11);
      } while (cursor);
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(67);
    },
  );

  it("does not duplicate rows when a new earlier-sorting row arrives between pages", async () => {
    await store.emails.upsertMany(
      Array.from({ length: 55 }, (_, i) => email(`id-${String(i).padStart(2, "0")}`)),
    );
    const first = await store.emails.query({ limit: 10 });
    await store.emails.upsertMany([email("new", { receivedAt: "2026-10-21T00:00:00.000Z" })]);
    const second = await store.emails.query({ limit: 50, cursor: first.nextCursor });
    expect(second.items).toHaveLength(45);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(55);
  });

  it("rejects malformed cursors, changed sort and invalid limits", async () => {
    await store.emails.upsertMany([email("a"), email("b")]);
    const page = await store.emails.query({ limit: 1 });
    await expect(
      store.emails.query({ cursor: page.nextCursor, sort: "receivedAt_asc" }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(store.emails.query({ cursor: "%%%" })).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
    await expect(
      store.emails.query({ cursor: Buffer.from("{}").toString("base64url") }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    for (const limit of [0, -1, 0.5, Infinity])
      await expect(store.emails.query({ limit })).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });
});

describe("calendar events", () => {
  it("creates, reads, updates and deletes events with nested participants", async () => {
    expect(await store.events.get("missing")).toBeNull();
    await store.events.upsertMany([event()]);
    expect(await store.events.get("event")).toEqual(event());
    await store.events.upsertMany([event("event", { title: "Changed" })]);
    expect(await store.events.get("event")).toMatchObject({ title: "Changed" });
    await store.events.deleteMany(["event", "missing"]);
    expect(await store.events.get("event")).toBeNull();
  });

  it("filters by overlapping half-open range, account, matter and limit", async () => {
    await store.events.upsertMany([
      event(),
      event("second", { matterId: "matter" }),
      event("other", { accountId: "other" }),
    ]);
    expect(
      await store.events.query({
        accountId: "account",
        matterId: "matter",
        range: { start: "2026-10-20T12:30:00.000Z", end: "2026-10-20T14:00:00.000Z" },
      }),
    ).toEqual([event("second", { matterId: "matter" })]);
    expect(
      await store.events.query({
        range: { start: "2026-10-20T13:00:00.000Z", end: "2026-10-20T14:00:00.000Z" },
      }),
    ).toEqual([]);
    expect(
      await store.events.query({ range: { start: "2026-10-20T11:00:00.000Z", end: at } }),
    ).toEqual([]);
    expect(await store.events.query({ limit: 1 })).toHaveLength(1);
  });
});

describe("people and matters", () => {
  it("deletes people and cascades email addresses and email/matter memberships", async () => {
    await store.people.upsert(person());
    await store.people.upsert(person("bob"));
    await store.emails.upsertMany([
      email("email", { personIds: ["alice", "bob"] }),
      email("alice-only"),
    ]);
    await store.matters.upsert(matter("matter", { personIds: ["alice", "bob"], eventIds: [] }));
    await store.matters.upsert(matter("alice-only", { emailIds: [], eventIds: [] }));
    await store.people.delete!("alice");
    await store.people.delete!("alice"); // Missing people are an idempotent no-op.
    expect(await store.people.get("alice")).toBeNull();
    expect(await store.people.getByEmail("alice@example.com")).toBeNull();
    expect(await store.people.list()).toEqual([person("bob")]);
    expect((await store.emails.get("email"))?.personIds).toEqual(["bob"]);
    expect((await store.emails.get("alice-only"))?.personIds).toEqual([]);
    expect((await store.emails.query({ personId: "alice" })).total).toBe(0);
    expect((await store.emails.query({ personId: "bob" })).total).toBe(1);
    expect((await store.matters.get("matter"))?.personIds).toEqual(["bob"]);
    expect((await store.matters.get("alice-only"))?.personIds).toEqual([]);
    expect(await store.matters.list({ personId: "alice" })).toEqual([]);
    expect((await store.matters.list({ personId: "bob" })).map((item) => item.id)).toEqual([
      "matter",
    ]);
    // Reusing the id must not resurrect deleted joins.
    await store.people.upsert(person());
    expect((await store.emails.query({ personId: "alice" })).total).toBe(0);
    expect(await store.matters.list({ personId: "alice" })).toEqual([]);
  });

  it("creates and updates people with case-insensitive email lookup and deduplication", async () => {
    expect(await store.people.get("missing")).toBeNull();
    expect(await store.people.getByEmail("missing@example.com")).toBeNull();
    await store.people.upsert(person());
    expect(await store.people.get("alice")).toEqual(person());
    expect(await store.people.getByEmail(" ALICE@EXAMPLE.COM ")).toEqual(person());
    await store.people.upsert(
      person("alice", {
        emails: ["new@example.com", "NEW@example.com"],
        primaryEmail: "new@example.com",
        displayName: "Updated",
      }),
    );
    expect(await store.people.getByEmail("alice@example.com")).toBeNull();
    expect(await store.people.get("alice")).toMatchObject({
      emails: ["new@example.com"],
      displayName: "Updated",
    });
  });

  it("filters people by relationship, name, email and notes with literal LIKE characters", async () => {
    await store.people.upsert(person("alice", { notes: "Owns 100% of _project" }));
    await store.people.upsert(person("bob", { displayName: "Bob", relationship: "stranger" }));
    expect(await store.people.list({ relationship: "known", text: "Alice" })).toHaveLength(1);
    expect(await store.people.list({ text: "bob@" })).toHaveLength(1);
    expect(await store.people.list({ text: "100%" })).toHaveLength(1);
    expect(await store.people.list({ text: "_project" })).toHaveLength(1);
    expect(await store.people.list({ limit: 1 })).toHaveLength(1);
  });

  it("merges emails, stats, email_people and matter memberships without duplicates", async () => {
    await store.people.upsert(person());
    await store.people.upsert(
      person("alias", {
        emails: ["ALICE@example.com", "alias@example.com"],
        stats: { sent: 5, received: 7, lastContactAt: "2026-10-21T00:00:00.000Z" },
        lastSeenBlueAt: at,
      }),
    );
    await store.emails.upsertMany([
      email(),
      email("both", { personIds: ["alias", "alice"] }),
      email("alias-only", { personIds: ["alias"] }),
    ]);
    await store.matters.upsert(matter("matter", { personIds: ["alice", "alias"], eventIds: [] }));
    await store.matters.upsert(
      matter("other", { personIds: ["alias"], emailIds: [], eventIds: [] }),
    );
    const merged = await store.people.merge("alice", "alias");
    expect(merged).toMatchObject({
      id: "alice",
      emails: ["alice@example.com", "alias@example.com"],
      stats: { sent: 7, received: 10, lastContactAt: "2026-10-21T00:00:00.000Z" },
      lastSeenBlueAt: at,
    });
    expect(await store.people.get("alias")).toBeNull();
    expect((await store.people.getByEmail("alias@example.com"))?.id).toBe("alice");
    expect((await store.emails.get("both"))?.personIds).toEqual(["alice"]);
    expect((await store.emails.get("alias-only"))?.personIds).toEqual(["alice"]);
    expect((await store.emails.query({ personId: "alice" })).total).toBe(3);
    expect((await store.emails.query({ personId: "alias" })).total).toBe(0);
    expect((await store.matters.get("matter"))?.personIds).toEqual(["alice"]);
    expect(await store.matters.list({ personId: "alice" })).toHaveLength(2);
  });

  it("makes merging a person into itself a no-op and missing merges atomic errors", async () => {
    await store.people.upsert(person());
    expect(await store.people.merge("alice", "alice")).toEqual(person());
    await expect(store.people.merge("alice", "missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await store.people.get("alice")).toEqual(person());
  });

  it("creates, filters, updates and deletes matters and synchronizes both directions", async () => {
    expect(await store.matters.get("missing")).toBeNull();
    await store.emails.upsertMany([email()]);
    await store.events.upsertMany([event()]);
    expect(await store.matters.upsert(matter())).toEqual(matter());
    expect(await store.emails.get("email")).toMatchObject({ matterId: "matter" });
    expect(await store.events.get("event")).toMatchObject({ matterId: "matter" });
    expect(
      await store.matters.list({ status: ["active"], personId: "alice", text: "hotel", limit: 1 }),
    ).toEqual([matter()]);
    expect(await store.matters.list({ status: [] })).toEqual([]);
    expect(await store.matters.list({ status: ["done"] })).toEqual([]);
    await store.matters.upsert(
      matter("matter", { status: "done", emailIds: [], personIds: [], eventIds: [] }),
    );
    expect(await store.emails.get("email")).toMatchObject({ matterId: null });
    expect(await store.events.get("event")).toMatchObject({ matterId: null });
    await store.matters.upsert(matter());
    await store.matters.delete("matter");
    expect(await store.matters.get("matter")).toBeNull();
    expect(await store.emails.get("email")).toMatchObject({ matterId: null });
    expect(await store.events.get("event")).toMatchObject({ matterId: null });
  });

  it("supports attaching not-yet-synced records and moves memberships between matters", async () => {
    await store.matters.upsert(matter());
    const pendingEmail = email();
    delete pendingEmail.matterId;
    const pendingEvent = event();
    delete pendingEvent.matterId;
    await store.emails.upsertMany([pendingEmail]);
    await store.events.upsertMany([pendingEvent]);
    expect(await store.emails.get("email")).toMatchObject({ matterId: "matter" });
    expect(await store.events.get("event")).toMatchObject({ matterId: "matter" });
    await store.matters.upsert(matter("second"));
    expect(await store.matters.get("matter")).toMatchObject({ emailIds: [], eventIds: [] });
    expect(await store.matters.get("second")).toMatchObject({
      emailIds: ["email"],
      eventIds: ["event"],
    });
    await store.emails.deleteMany(["email"]);
    await store.events.deleteMany(["event"]);
    expect(await store.matters.get("second")).toMatchObject({ emailIds: [], eventIds: [] });
  });

  it("keeps matter membership order stable through email and event metadata upserts", async () => {
    await store.matters.upsert(matter("matter", { emailIds: ["a", "b"], eventIds: ["a", "b"] }));
    const firstEmail = email("a");
    delete firstEmail.matterId;
    const firstEvent = event("a");
    delete firstEvent.matterId;
    await store.emails.upsertMany([firstEmail]);
    await store.events.upsertMany([firstEvent]);
    await store.emails.patchMany(["a"], { keywords: { $seen: true } });
    await store.events.upsertMany([{ ...firstEvent, title: "Updated" }]);
    expect(await store.matters.get("matter")).toMatchObject({
      emailIds: ["a", "b"],
      eventIds: ["a", "b"],
    });
  });
});

describe("actions and trust", () => {
  it("F2 conditionally claims a row once across independent database connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "passport-claims-"));
    const path = join(directory, "store.sqlite");
    const first = openStore({ path, masterKey: "test" }),
      second = openStore({ path, masterKey: "test" });
    try {
      await first.migrate();
      await second.migrate();
      const record = action("held", {
        status: "held",
        holdUntil: at,
        approvedSnapshot: { subject: "Approved" },
      });
      await first.actions.insert(record);
      const results = await Promise.all([
        first.actions.claim!(record.id, "held", "executing", at),
        second.actions.claim!(record.id, "held", "executing", at),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.find(Boolean)).toEqual({ ...record, status: "executing", decidedAt: at });
      expect((await second.actions.query({ status: ["executing"] })).items).toHaveLength(1);
      expect(await first.actions.dueHeld(at)).toEqual([]);
      expect(await first.actions.claim!("missing", "held", "executing", at)).toBeNull();
      expect(await first.actions.claim!(record.id, "held", "executing", at)).toBeNull();
    } finally {
      await first.close();
      await second.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("inserts, gets and updates complete nested action records", async () => {
    expect(await store.actions.get("missing")).toBeNull();
    expect(await store.actions.insert(action())).toEqual(action());
    const patch = {
      status: "executed" as const,
      executedAt: at,
      inverse: action().request,
      result: { providerId: "sent", nested: [1, true] },
    };
    expect(await store.actions.update("action", patch)).toEqual({ ...action(), ...patch });
    expect(
      await store.actions.update("action", { status: undefined, createdAt: undefined }),
    ).toEqual({ ...action(), ...patch });
    await expect(store.actions.insert(action())).rejects.toMatchObject({
      code: "ERR_SQLITE_ERROR",
    });
    await expect(store.actions.update("missing", {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.actions.update("action", { id: "other" })).rejects.toMatchObject({
      code: "INVALID_PATCH",
    });
  });

  it("combines every action query filter and uses updated scalar values", async () => {
    await store.actions.insert(action());
    await store.actions.insert(
      action("other", {
        status: "failed",
        request: {
          ...action().request,
          category: "other",
          actor: { kind: "human", id: "user" },
          runId: "other",
          matterId: "other",
        },
      }),
    );
    expect(
      (
        await store.actions.query({
          status: ["proposed"],
          category: "triage",
          actorKind: "agent",
          runId: "run",
          matterId: "matter",
          after: "2026-10-19T00:00:00.000Z",
          before: "2026-10-21T00:00:00.000Z",
        })
      ).items,
    ).toEqual([action()]);
    expect((await store.actions.query({ status: [] })).items).toEqual([]);
    expect((await store.actions.query({ after: at })).total).toBe(0);
    await store.actions.update("action", { request: { ...action().request, category: "other" } });
    expect((await store.actions.query({ category: "other" })).total).toBe(2);
  });

  it("paginates 61 actions across timestamp ties without duplicates", async () => {
    const expected = Array.from({ length: 61 }, (_, i) => `action-${String(i).padStart(2, "0")}`);
    for (const id of expected) await store.actions.insert(action(id));
    const ids: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const page = await store.actions.query({ limit: 8, cursor });
      expect(page.total).toBe(61);
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(9);
    } while (cursor);
    expect(ids).toEqual(expected.reverse());
    await expect(store.actions.query({ cursor: "bad" })).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
  });

  it("returns only held actions with a non-null holdUntil at or before now", async () => {
    for (const record of [
      action("past", { status: "held", holdUntil: "2026-10-19T00:00:00.000Z" }),
      action("exact", { status: "held", holdUntil: at }),
      action("future", { status: "held", holdUntil: "2026-10-21T00:00:00.000Z" }),
      action("no-time", { status: "held" }),
      action("approved", { status: "approved", holdUntil: at }),
      action("executed", { status: "executed", holdUntil: at }),
    ])
      await store.actions.insert(record);
    expect((await store.actions.dueHeld(at)).map((record) => record.id)).toEqual(["past", "exact"]);
    await store.actions.update("past", { status: "executed" });
    expect((await store.actions.dueHeld(at)).map((record) => record.id)).toEqual(["exact"]);
  });

  it("gets, lists and replaces trust and policy configuration without inventing defaults", async () => {
    expect(await store.trust.get("triage")).toBeNull();
    expect(await store.trust.list()).toEqual([]);
    expect(await store.trust.getConfig()).toBeNull();
    const state: TrustState = {
      category: "triage",
      level: "supervised",
      score: 0.1,
      stage: "learning",
      approvals: 1,
      approvalsUnchanged: 1,
      edits: 0,
      rejections: 0,
      lastActivityAt: at,
      pinnedLevel: null,
    };
    expect(await store.trust.upsert(state)).toEqual(state);
    await store.trust.upsert({ ...state, score: 0.5, pinnedLevel: "auto" });
    expect(await store.trust.get("triage")).toEqual({ ...state, score: 0.5, pinnedLevel: "auto" });
    expect(await store.trust.list()).toHaveLength(1);
    await store.trust.setConfig(DEFAULT_POLICY_CONFIG);
    expect(await store.trust.getConfig()).toEqual(DEFAULT_POLICY_CONFIG);
    await store.trust.setConfig({ ...DEFAULT_POLICY_CONFIG, outboxHoldMinutes: 10 });
    expect(await store.trust.getConfig()).toEqual({
      ...DEFAULT_POLICY_CONFIG,
      outboxHoldMinutes: 10,
    });
  });
});

it("T8 queries all in-range events with an explicit limit beyond the 50 oldest events", async () => {
  await store.events.upsertMany([
    ...Array.from({ length: 60 }, (_, i) =>
      event(`old-${i}`, { start: "2025-01-01T00:00:00Z", end: "2025-01-01T01:00:00Z" }),
    ),
    event("recent"),
  ]);
  expect(
    await store.events.query({
      range: { start: "2026-10-20T00:00:00Z", end: "2026-10-22T00:00:00Z" },
      limit: 2_147_483_647,
    }),
  ).toHaveLength(1);
});

it("T9 availability can query old series masters and cancelled instances without changing ordinary range queries", async () => {
  const series = event("series", {
    start: "2025-01-01T09:00:00Z",
    end: "2025-01-01T10:00:00Z",
    recurrenceRule: "FREQ=WEEKLY;BYDAY=WE",
  });
  await store.events.upsertMany([series]);
  const range = { start: "2026-10-20T00:00:00Z", end: "2026-10-22T00:00:00Z" };
  expect(await store.events.query({ range })).toEqual([]);
  expect(await store.events.query({ range, includeRecurring: true, limit: 2_147_483_647 })).toEqual(
    [expect.objectContaining({ id: "series" })],
  );
});

it("R11 excludes tombstones from queries, FTS, totals and pagination unless includeDeleted is explicit", async () => {
  await store.emails.upsertMany([
    email("live"),
    email("deleted", { keywords: { $deleted: true } }),
    email("false", { keywords: { $deleted: false } }),
  ]);
  for (const text of [undefined, "reservations"]) {
    const first = await store.emails.query({ text, limit: 1 });
    expect(first.total).toBe(2);
    expect(first.items[0]?.id).toBe("live");
    const second = await store.emails.query({ text, limit: 1, cursor: first.nextCursor });
    expect(second.items.map((item) => item.id)).toEqual(["false"]);
    expect(second.nextCursor).toBeNull();
    expect((await store.emails.query({ text, includeDeleted: true })).total).toBe(3);
  }
  expect((await store.emails.get("deleted"))?.keywords.$deleted).toBe(true);
  await store.emails.patchMany(["deleted"], { keywords: { $deleted: false } });
  expect((await store.emails.query({ text: "reservations" })).total).toBe(3);
});
