import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Mailbox, Store } from "@passport/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, email, matter } from "./fixtures.js";
import { openStore } from "./index.js";
import { migrations } from "./migrations.js";

let store: Store;
const DAY = 24 * 60 * 60 * 1000;
const setNow = (iso: string) => vi.setSystemTime(new Date(iso));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setNow("2026-10-01T00:00:00.000Z");
  store = openStore({ path: ":memory:" });
  await store.migrate();
});
afterEach(async () => {
  await store.close();
  vi.useRealTimers();
});

describe("body cache", () => {
  it("drops bodies past the TTL but keeps envelopes and draft bodies", async () => {
    await store.emails.upsertMany([
      email("old", { providerId: "p-old" }),
      email("draft", { providerId: "p-draft", keywords: { $draft: true } }),
    ]);
    setNow("2026-10-05T00:00:00.000Z");
    await store.emails.upsertMany([email("recent", { providerId: "p-recent" })]);
    setNow("2026-10-09T00:00:00.000Z");
    const result = await store.emails.evictBodies!();
    expect(result.evicted).toBe(1);
    const old = await store.emails.get("old");
    expect(old).toMatchObject({ id: "old", subject: "Travel plans" });
    expect(old).not.toHaveProperty("textBody");
    expect(old).not.toHaveProperty("htmlBody");
    expect(await store.emails.freshness!("old")).toMatchObject({ bodyFetchedAt: null });
    expect((await store.emails.get("draft"))?.textBody).toBe(email().textBody);
    expect((await store.emails.get("recent"))?.textBody).toBe(email().textBody);
    expect((await store.emails.query({ text: "expedition" })).total).toBe(3);
  });

  it("evicts least recently touched bodies until under the size cap", async () => {
    const big = "x".repeat(1000);
    await store.emails.upsertMany([
      email("a", { providerId: "pa", textBody: big, htmlBody: null }),
      email("b", { providerId: "pb", textBody: big, htmlBody: null }),
      email("c", { providerId: "pc", textBody: big, htmlBody: null }),
    ]);
    setNow("2026-10-02T00:00:00.000Z");
    await store.emails.touch!(["a"]);
    await store.emails.get("c");
    const result = await store.emails.evictBodies!({ maxBytes: 2000 });
    expect(result).toEqual({ evicted: 1, remainingBytes: 2000 });
    expect((await store.emails.get("b"))?.textBody).toBeUndefined();
    expect((await store.emails.get("a"))?.textBody).toBe(big);
    expect(await store.emails.evictBodies!({ maxBytes: 0, olderThanMs: 365 * DAY })).toEqual({
      evicted: 2,
      remainingBytes: 0,
    });
  });
});

describe("envelope eviction", () => {
  it("keeps the most recently touched rows, matter-linked rows and drafts", async () => {
    await store.matters.upsert(matter("matter", { emailIds: [] }));
    await store.emails.upsertMany([
      email("linked", { providerId: "p1", matterId: "matter" }),
      email("draft", { providerId: "p2", keywords: { $draft: true } }),
      email("stale", { providerId: "p3" }),
      email("older", { providerId: "p4" }),
    ]);
    await store.threads.upsertMany([
      { id: "thread", accountId: "account", emailIds: ["linked", "stale", "older"] },
    ]);
    setNow("2026-10-03T00:00:00.000Z");
    await store.emails.upsertMany([email("hot", { providerId: "p5" })]);
    expect(await store.emails.evictEnvelopes!({ keep: 1 })).toEqual({
      evicted: 2,
      remainingBytes: 0,
    });
    expect(await store.emails.get("stale")).toBeNull();
    expect(await store.emails.get("older")).toBeNull();
    for (const id of ["linked", "draft", "hot"]) {
      expect(await store.emails.get(id)).not.toBeNull();
    }
    expect((await store.threads.get("thread"))?.emailIds).toEqual(["linked"]);
    expect((await store.emails.evictEnvelopes!()).evicted).toBe(0);
  });
});

describe("mailbox label cache", () => {
  const box = (patch: Partial<Mailbox>): Mailbox => ({
    id: "trash-ulid",
    accountId: "account",
    providerId: "TRASH",
    name: "Trash",
    role: "trash",
    totalEmails: 4,
    unreadEmails: 1,
    ...patch,
  });

  it("upserts labels by provider id, keeps ids, roles and counts, and prunes on request", async () => {
    await store.mailboxes.upsertMany([
      box({}),
      box({ id: "old-ulid", providerId: "OLD", name: "Old", role: null }),
    ]);
    await store.emails.upsertMany([email("e", { mailboxIds: ["old-ulid"] })]);
    const boxes = await store.mailboxes.refreshFromLabels!("account", [
      { id: "TRASH", name: "Bin" },
      { id: "Label_1", name: "Work", parentId: "TRASH", counts: { total: 9, unread: 2 } },
    ]);
    expect(boxes).toEqual([
      {
        id: "account:mailbox:Label_1",
        accountId: "account",
        providerId: "Label_1",
        name: "Work",
        role: null,
        parentId: "trash-ulid",
        totalEmails: 9,
        unreadEmails: 2,
      },
      box({ id: "old-ulid", providerId: "OLD", name: "Old", role: null }),
      { ...box({ name: "Bin" }), parentId: null },
    ]);
    const pruned = await store.mailboxes.refreshFromLabels!(
      "account",
      [{ id: "TRASH", name: "Trash", role: "trash" }],
      { prune: true },
    );
    expect(pruned.map((item) => item.id)).toEqual(["trash-ulid"]);
    expect((await store.emails.get("e"))?.mailboxIds).toEqual([]);
  });
});

describe("migration from a v0.2 database", () => {
  it("keeps mirror rows and bodies, stamps cache columns and rebuilds FTS without bodies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "passport-v02-"));
    const path = join(directory, "store.sqlite");
    try {
      const raw = new DatabaseSync(path);
      raw.exec(migrations[0]!);
      raw.exec(
        "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      raw.prepare("INSERT INTO schema_version VALUES (1, ?)").run(at);
      const insert = raw.prepare(
        `INSERT INTO emails (id, account_id, provider_id, thread_id, matter_id, category, received_at,
        subject, "from", preview, textBody, html_body, data) VALUES (?, 'account', ?, 'thread', NULL,
        'scheduling', ?, 'Travel plans', 'Alice Doe alice@example.com', 'Mountain expedition', ?, ?, ?)`,
      );
      const { personIds: _p, mailboxIds: _m, ...withBody } = email("bodied");
      insert.run(
        "bodied",
        "p1",
        at,
        withBody.textBody!,
        withBody.htmlBody!,
        JSON.stringify({ ...withBody, textBody: null, htmlBody: null }),
      );
      const { textBody: _t, htmlBody: _h, ...envelope } = email("bare", { providerId: "p2" });
      insert.run("bare", "p2", at, null, null, JSON.stringify(envelope));
      raw.exec(`INSERT INTO email_mailboxes VALUES ('bodied', 'inbox', 0)`);
      raw.close();

      const migrated = openStore({ path, masterKey: "test-key" });
      try {
        await migrated.migrate();
        expect(await migrated.emails.freshness!("bodied")).toEqual({
          labelsFreshAt: null,
          touchedAt: at,
          bodyFetchedAt: expect.any(String),
        });
        expect(await migrated.emails.get("bodied")).toEqual({
          ...email("bodied"),
          personIds: [],
        });
        expect(await migrated.emails.freshness!("bare")).toMatchObject({ bodyFetchedAt: null });
        expect((await migrated.emails.query({ text: "expedition" })).total).toBe(2);
        expect((await migrated.emails.query({ text: "reservations" })).total).toBe(0);
        await migrated.emails.patchMany(["bare"], { category: "other" });
        expect((await migrated.emails.query({ text: "Travel", category: "other" })).total).toBe(1);
      } finally {
        await migrated.close();
      }
      const check = new DatabaseSync(path);
      expect(check.prepare("SELECT version FROM schema_version").all()).toEqual([
        { version: 1 },
        { version: 2 },
        // Migration 3 (matter refs) follows; this test only covers the v0.2 → envelope cache step.
        { version: 3 },
      ]);
      check.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
