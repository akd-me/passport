import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Store } from "@passport/types";
import { mailHandle, watcherTickKey } from "@passport/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { account, at, email } from "./fixtures.js";
import { FakeMailReader, providerEmail } from "./fixtures-reader.js";
import { openStore } from "./index.js";

let store: Store;
let reader: FakeMailReader;
const handle = (providerId: string) => mailHandle("account", "email", providerId);
const limited = () => Object.assign(new Error("slow down"), { code: "RATE_LIMITED" });

beforeEach(async () => {
  store = openStore({ path: ":memory:" });
  await store.migrate();
  reader = new FakeMailReader(["p1", "p2", "p3"].map((id) => providerEmail(id)));
  store.setMailReaderResolver!(async (accountId) => (accountId === "account" ? reader : null));
});
afterEach(async () => {
  await store.close();
  vi.useRealTimers();
});

describe("R2-3 normal watcher ticks do not make the cache stale", () => {
  it("only the cursor-expiry watermark forces revalidation", async () => {
    await store.emails.get(handle("p1"), { includeBodies: false });
    await store.kv.set("watch-last-tick:account", new Date(Date.now() + 1000).toISOString());
    for (let i = 0; i < 3; i++) {
      await store.emails.get(handle("p1"), { includeBodies: false });
    }
    expect(reader.methods()).toEqual(["envelopes"]);
  });
});

describe("R2-5 provider failures serve the cached copy", () => {
  it("returns the envelope marked staleAsOf when the body fetch is rate limited", async () => {
    await store.emails.get(handle("p1"), { includeBodies: false });
    reader.failNext = limited();
    const served = await store.emails.get(handle("p1"), { includeBodies: true });
    expect(served).toMatchObject({ id: handle("p1"), subject: "Travel plans" });
    expect(served?.textBody).toBeUndefined();
    expect(served?.staleAsOf).toEqual(expect.any(String));
    reader.failNext = limited();
    await expect(
      store.emails.get(handle("p1"), { includeBodies: true, fresh: true }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // The marker describes one read and is never persisted.
    await store.emails.upsertMany([served!]);
    expect(await store.emails.get(handle("p1"), { cacheOnly: true })).not.toHaveProperty(
      "staleAsOf",
    );
  });

  it("serves stale rows while the resolver throws (offline, reauth) unless fresh", async () => {
    let offline = false;
    store.setMailReaderResolver!(async () => {
      if (offline) {
        throw new Error("ECONNREFUSED");
      }
      return reader;
    });
    await store.emails.get(handle("p1"), { includeBodies: false });
    await store.kv.set(watcherTickKey("account"), new Date(Date.now() + 1000).toISOString());
    offline = true;
    expect(await store.emails.get(handle("p1"))).toMatchObject({
      id: handle("p1"),
      staleAsOf: expect.any(String),
    });
    await expect(store.emails.get(handle("p1"), { fresh: true })).rejects.toThrow("ECONNREFUSED");
  });
});

describe("R2-7 batched reads", () => {
  it("revalidates many rows with one envelopes call and fills misses in one call", async () => {
    await store.emails.upsertMany([email(handle("p1"), { providerId: "p1" })]);
    const found = await store.emails.getMany!(
      [handle("p1"), handle("p2"), handle("p3"), handle("missing")],
      { fresh: true, includeBodies: false, lane: "arrivals" },
    );
    expect([...found.values()].map((item) => item?.id ?? null)).toEqual([
      handle("p1"),
      handle("p2"),
      handle("p3"),
      null,
    ]);
    expect(reader.calls).toEqual([
      { method: "envelopes", args: [["p2", "p3", "missing"]], opts: { lane: "arrivals" } },
      { method: "envelopes", args: [["p1"]], opts: { lane: "arrivals" } },
    ]);
  });

  it("propagates a failed batch for fresh reads", async () => {
    await store.emails.upsertMany([email(handle("p1"), { providerId: "p1" })]);
    reader.failNext = limited();
    await expect(store.emails.getMany!([handle("p1")], { fresh: true })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });
});

describe("R2-8 revalidation is compare-and-set", () => {
  it("keeps a local label write that lands while the provider read is in flight", async () => {
    reader.messages.set("p1", providerEmail("p1", { keywords: {} }));
    await store.emails.get(handle("p1"), { includeBodies: false });
    const envelopes = reader.envelopes.bind(reader);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    reader.envelopes = async (ids, opts) => {
      const value = await envelopes(ids, opts);
      await gate;
      return value;
    };
    const pending = store.emails.get(handle("p1"), { fresh: true, includeBodies: false });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The executor marked it read at the provider and mirrored the post-state.
    reader.messages.get("p1")!.keywords = { $seen: true };
    const cached = await store.emails.get(handle("p1"), { cacheOnly: true });
    await store.emails.upsertMany([{ ...cached!, keywords: { $seen: true } }]);
    release();
    expect((await pending)?.keywords).toEqual({ $seen: true });
    expect((await store.emails.get(handle("p1"), { cacheOnly: true }))?.keywords).toEqual({
      $seen: true,
    });
  });
});

describe("R2-9 envelope eviction", () => {
  it("never evicts rows read-through cannot refill or that open work still references", async () => {
    await store.emails.upsertMany([
      email("01JULIDV02ROW", { providerId: "v02", threadId: "t-v02" }),
      email(handle("held"), { providerId: "held", threadId: "t-held" }),
      email(handle("arrival"), { providerId: "arrival", threadId: "t-arrival" }),
      email(handle("moved"), { providerId: "moved-new", threadId: "t-moved" }),
      email(handle("cold"), { providerId: "cold", threadId: "t-cold" }),
    ]);
    await store.threads.upsertMany([
      { id: "t-cold", accountId: "account", emailIds: [handle("cold")] },
      { id: "t-other", accountId: "account", emailIds: ["unrelated"] },
    ]);
    await store.actions.insert({
      id: "act",
      status: "held",
      createdAt: at,
      holdUntil: "2999-01-01T00:00:00.000Z",
      request: {
        type: "archive",
        accountId: "account",
        actor: { kind: "agent", id: "run" },
        category: "triage",
        reason: "tidy",
        params: { emailIds: [handle("held")] },
      },
      decision: { outcome: "hold", reason: "", reversibility: "reversible", risk: "low" },
    } as never);
    await store.kv.set(`arrival:${handle("arrival")}`, "{}");
    expect(await store.emails.evictEnvelopes!({ keep: 0, batchSize: 1 })).toEqual({
      evicted: 1,
      remainingBytes: 0,
    });
    expect(await store.emails.get(handle("cold"), { cacheOnly: true })).toBeNull();
    expect((await store.threads.get("t-cold"))?.emailIds).toEqual([]);
    expect((await store.threads.get("t-other"))?.emailIds).toEqual(["unrelated"]);
    for (const id of ["01JULIDV02ROW", handle("held"), handle("arrival"), handle("moved")]) {
      expect(await store.emails.get(id, { cacheOnly: true })).not.toBeNull();
    }
  });
});

describe("R2-10 / R2-17 moved messages are rebound by Message-ID", () => {
  it("rebinds a row whose provider id vanished instead of tombstoning it", async () => {
    await store.emails.get(handle("p1"), { includeBodies: false });
    const moved = reader.messages.get("p1")!;
    reader.messages.delete("p1");
    reader.messages.set("uid-99", { ...moved, providerId: "uid-99", keywords: { $flagged: true } });
    const fresh = await store.emails.get(handle("p1"), { fresh: true, includeBodies: false });
    expect(fresh).toMatchObject({ id: handle("p1"), providerId: "uid-99" });
    expect(fresh?.keywords).toEqual({ $flagged: true });
    expect((await store.emails.get(handle("uid-99"), { cacheOnly: true }))?.id).toBe(handle("p1"));
    // The rebound row's id is no longer its handle, so eviction keeps it.
    expect((await store.emails.evictEnvelopes!({ keep: 0 })).evicted).toBe(0);
  });

  it("rebinds on a STALE_ID body read and retries the body once", async () => {
    await store.emails.get(handle("p2"), { includeBodies: false });
    const moved = reader.messages.get("p2")!;
    reader.messages.delete("p2");
    reader.messages.set("uid-7", { ...moved, providerId: "uid-7" });
    const full = await store.emails.get(handle("p2"), { includeBodies: true });
    expect(full).toMatchObject({ providerId: "uid-7", textBody: "Body of p2" });
    expect(full).not.toHaveProperty("staleAsOf");
  });

  it("still tombstones a message the provider cannot find at all", async () => {
    await store.emails.upsertMany([email("ulid", { providerId: "vanished" })]);
    expect((await store.emails.get("ulid", { fresh: true }))?.keywords.$deleted).toBe(true);
  });
});

describe("R2-15 fresh reads say when they could not reach the provider", () => {
  it("marks staleAsOf for an on-demand account without a reader", async () => {
    await store.accounts.upsert({
      ...account("other"),
      capabilities: { ...account().capabilities, onDemand: true },
    });
    await store.emails.upsertMany([email("x", { accountId: "other" })]);
    expect((await store.emails.get("x", { fresh: true }))?.staleAsOf).toBeDefined();
    expect(await store.emails.get("x")).not.toHaveProperty("staleAsOf");
  });
});

describe("R2-19 reads are rarely writes", () => {
  it("throttles touch stamps on get and only reindexes FTS when indexed text changed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"));
    await store.emails.upsertMany([email("e")]);
    vi.setSystemTime(new Date("2026-10-22T10:00:30.000Z"));
    await store.emails.get("e");
    expect((await store.emails.freshness!("e"))?.touchedAt).toBe("2026-10-22T10:00:00.000Z");
    vi.setSystemTime(new Date("2026-10-22T10:02:00.000Z"));
    await store.emails.get("e");
    expect((await store.emails.freshness!("e"))?.touchedAt).toBe("2026-10-22T10:02:00.000Z");
    const dir = await mkdtemp(join(tmpdir(), "passport-r2-"));
    try {
      const path = join(dir, "store.db");
      const file = openStore({ path, masterKey: "test-key" });
      await file.migrate();
      await file.close();
      const raw = new DatabaseSync(path);
      const sql = raw
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'emails_fts_update'")
        .get()?.sql as string;
      raw.close();
      expect(sql).toContain("WHEN old.subject IS NOT new.subject");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
