import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MailRef, Store } from "@passport/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { at, email, matter, person } from "./fixtures.js";
import { openStore } from "./index.js";
import { migrations } from "./migrations.js";

let store: Store;
beforeEach(async () => {
  store = openStore({ path: ":memory:" });
  await store.migrate();
});
afterEach(async () => {
  await store.close();
});

const ref = (providerId: string, patch: Partial<MailRef> = {}): MailRef => ({
  account: "account",
  providerId,
  rfc822Id: `<${providerId}@example.com>`,
  threadPid: `t-${providerId}`,
  date: at,
  subject: "Lease renewal",
  ...patch,
});

describe("notes persistence", () => {
  it("round-trips person notes and matter notes, refs and watch", async () => {
    await store.people.upsert(person("dana", { notes: "Leasing manager at Acme." }));
    await store.matters.upsert(
      matter("lease", {
        emailIds: [],
        eventIds: [],
        personIds: [],
        notes: "## Log\n- 2026-10-20: renewal received",
        refs: [ref("p1")],
        watch: "from:dana@example.com newer_than:30d",
      }),
    );
    expect((await store.people.get("dana"))?.notes).toBe("Leasing manager at Acme.");
    expect(await store.matters.get("lease")).toMatchObject({
      notes: "## Log\n- 2026-10-20: renewal received",
      refs: [ref("p1")],
      watch: "from:dana@example.com newer_than:30d",
    });
  });

  it("finds matters by message, thread or Message-ID and forgets refs on update and delete", async () => {
    const base = { emailIds: [], eventIds: [], personIds: [] };
    await store.matters.upsert(matter("lease", { ...base, refs: [ref("p1"), ref("p2")] }));
    await store.matters.upsert(matter("other", { ...base, refs: [ref("p3")] }));
    const byRef = store.notes!.mattersByRef!;
    expect((await byRef({ account: "account", providerId: "p2" })).map((m) => m.id)).toEqual([
      "lease",
    ]);
    expect((await byRef({ account: "account", threadPid: "t-p3" })).map((m) => m.id)).toEqual([
      "other",
    ]);
    expect(
      (await byRef({ account: "account", rfc822Id: "<p1@example.com>" })).map((m) => m.id),
    ).toEqual(["lease"]);
    expect(await byRef({ account: "elsewhere", providerId: "p1" })).toEqual([]);
    await store.matters.upsert(matter("lease", { ...base, refs: [ref("p2")] }));
    expect(await byRef({ account: "account", providerId: "p1" })).toEqual([]);
    await store.matters.delete("lease");
    expect(await byRef({ account: "account", providerId: "p2" })).toEqual([]);
    await expect(byRef({ account: "account" })).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });
});

describe("notes search", () => {
  beforeEach(async () => {
    await store.people.upsert(
      person("dana", {
        displayName: "Dana Ruiz",
        notes: "Leasing manager at Acme Properties.\nRenewal is annual in November.",
        updatedAt: "2026-10-21T00:00:00.000Z",
      }),
    );
    await store.people.upsert(person("sam", { displayName: "Sam Lee", notes: null }));
    await store.matters.upsert(
      matter("lease", {
        title: "Lease renewal 2026",
        summary: "Counter at 3%",
        notes: "## Log\n- 2026-10-20: Dana sent the renewal PDF",
        emailIds: [],
        eventIds: [],
        personIds: [],
      }),
    );
  });

  it("matches names, addresses, summaries and notes with a snippet of the matching line", async () => {
    const hits = await store.notes!.search({ text: "renewal" });
    expect(hits).toEqual([
      {
        kind: "person",
        id: "dana",
        name: "Dana Ruiz",
        field: "notes",
        snippet: "Renewal is annual in November.",
        updatedAt: "2026-10-21T00:00:00.000Z",
      },
      expect.objectContaining({ kind: "matter", id: "lease", field: "name" }),
    ]);
    expect(await store.notes!.search({ text: "sam@example" })).toEqual([
      expect.objectContaining({ id: "sam", field: "email", snippet: "sam@example.com" }),
    ]);
    expect(await store.notes!.search({ text: "renewal", kind: "matter" })).toHaveLength(1);
    expect(await store.notes!.search({ text: "100%_" })).toEqual([]);
  });

  it("supports case-insensitive regular expressions and validates them", async () => {
    expect(
      (await store.notes!.search({ pattern: "^- \\d{4}-10-20: dana" })).map((hit) => hit.id),
    ).toEqual(["lease"]);
    await expect(store.notes!.search({ pattern: "(" })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
    await expect(store.notes!.search({ text: "  " })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });

  it("includes notes in matters.list and people.list text filters", async () => {
    expect((await store.matters.list({ text: "PDF" })).map((m) => m.id)).toEqual(["lease"]);
    expect((await store.people.list({ text: "Acme" })).map((p) => p.id)).toEqual(["dana"]);
  });
});

describe("migration 3", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "passport-notes-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("derives refs for v0.2 matters from their attached emails' envelopes", async () => {
    const path = join(dir, "store.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const [index, sql] of migrations.slice(0, 2).entries()) {
      legacy.exec(sql);
      legacy.prepare("INSERT INTO schema_version VALUES (?, ?)").run(index + 1, at);
    }
    const row = email("e1", { matterId: "m1" });
    legacy
      .prepare(
        `INSERT INTO emails(id, account_id, provider_id, thread_id, matter_id, received_at, subject, "from", preview, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.accountId,
        row.providerId,
        row.threadId,
        "m1",
        row.receivedAt,
        row.subject,
        "alice@example.com",
        row.preview,
        JSON.stringify(row),
      );
    legacy
      .prepare("INSERT INTO matters(id, status, updated_at, data) VALUES (?, ?, ?, ?)")
      .run("m1", "active", at, JSON.stringify(matter("m1", { emailIds: ["e1"] })));
    legacy
      .prepare("INSERT INTO matters(id, status, updated_at, data) VALUES (?, ?, ?, ?)")
      .run("m2", "active", at, JSON.stringify(matter("m2", { emailIds: [] })));
    legacy.prepare("INSERT INTO matter_emails VALUES (?, ?, ?)").run("m1", "e1", 0);
    legacy.close();

    const migrated = openStore({ path, masterKey: "test-key" });
    try {
      await migrated.migrate();
      expect((await migrated.matters.get("m1"))?.refs).toEqual([
        {
          account: "account",
          providerId: "provider-e1",
          rfc822Id: "<e1@example.com>",
          date: at,
          subject: "Travel plans",
        },
      ]);
      expect((await migrated.matters.get("m1"))?.emailIds).toEqual(["e1"]);
      expect((await migrated.matters.get("m2"))?.refs).toEqual([]);
      const found = await migrated.notes!.mattersByRef!({
        account: "account",
        providerId: "provider-e1",
      });
      expect(found.map((m) => m.id)).toEqual(["m1"]);
    } finally {
      await migrated.close();
    }
  });
});
