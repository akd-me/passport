import type { Store } from "@passport/types";
import { mailHandle, watcherTickKey } from "@passport/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { email } from "./fixtures.js";
import { FakeMailReader, providerEmail } from "./fixtures-reader.js";
import { openStore } from "./index.js";

let store: Store;
let reader: FakeMailReader;
const handle = (providerId: string) => mailHandle("account", "email", providerId);

beforeEach(async () => {
  store = openStore({ path: ":memory:" });
  await store.migrate();
  reader = new FakeMailReader([providerEmail("p1"), providerEmail("p2", { subject: "Second" })]);
});
afterEach(async () => {
  await store.close();
  vi.useRealTimers();
});

const withReader = () =>
  store.setMailReaderResolver!(async (accountId) => (accountId === "account" ? reader : null));

describe("without a resolver (v0.2 behaviour)", () => {
  it("serves local rows and never invents rows for handles", async () => {
    await store.emails.upsertMany([email("local")]);
    expect(await store.emails.get("local")).toEqual(email("local"));
    expect(await store.emails.get(handle("p1"))).toBeNull();
    expect(await store.emails.getByProviderId("account", "p1")).toBeNull();
    expect(await store.emails.get("local", { fresh: true, includeBodies: true })).toEqual(
      email("local"),
    );
  });

  it("treats a resolver that returns null exactly like no resolver", async () => {
    store.setMailReaderResolver!(async () => null);
    await store.emails.upsertMany([email("local", { textBody: undefined, htmlBody: undefined })]);
    expect(await store.emails.get(handle("p1"))).toBeNull();
    expect(await store.emails.get("local", { fresh: true, includeBodies: true })).toMatchObject({
      id: "local",
    });
    expect(reader.calls).toEqual([]);
  });
});

describe("read-through", () => {
  beforeEach(withReader);

  it("fetches a missing handle once, caches it under the handle and serves later hits locally", async () => {
    await store.mailboxes.upsertMany([
      {
        id: "inbox-ulid",
        accountId: "account",
        providerId: "INBOX",
        name: "Inbox",
        role: "inbox",
        totalEmails: 0,
        unreadEmails: 0,
      },
    ]);
    const fetched = await store.emails.get(handle("p1"), { lane: "arrivals" });
    expect(fetched).toMatchObject({
      id: handle("p1"),
      providerId: "p1",
      threadId: mailHandle("account", "thread", "t-p1"),
      mailboxIds: ["inbox-ulid"],
      personIds: [],
    });
    expect(fetched?.textBody).toBeUndefined();
    expect(reader.calls).toEqual([
      { method: "envelopes", args: [["p1"]], opts: { lane: "arrivals" } },
    ]);
    expect(await store.threads.get(mailHandle("account", "thread", "t-p1"))).toEqual({
      id: mailHandle("account", "thread", "t-p1"),
      accountId: "account",
      emailIds: [handle("p1")],
    });
    expect((await store.emails.get(handle("p1")))?.id).toBe(handle("p1"));
    expect(await store.emails.getByProviderId("account", "p1")).toMatchObject({ id: handle("p1") });
    expect(reader.methods()).toEqual(["envelopes"]);
    expect((await store.emails.query({ mailboxId: "inbox-ulid" })).total).toBe(1);
  });

  it("resolves a handle to an existing mirror row by provider id without a provider call", async () => {
    await store.emails.upsertMany([email("ulid", { providerId: "p1" })]);
    expect((await store.emails.get(handle("p1")))?.id).toBe("ulid");
    expect(reader.calls).toEqual([]);
  });

  it("returns null for unknown handles, non-email handles and plain ids", async () => {
    expect(await store.emails.get(handle("gone"))).toBeNull();
    expect(await store.emails.get(mailHandle("account", "thread", "p1"))).toBeNull();
    expect(await store.emails.get("01JPLAINULID")).toBeNull();
    expect(await store.emails.get(mailHandle("other", "email", "p1"))).toBeNull();
    expect(reader.methods()).toEqual(["envelopes"]);
  });

  it("reads through getByProviderId and respects cacheOnly", async () => {
    expect(await store.emails.getByProviderId("account", "p2", { cacheOnly: true })).toBeNull();
    expect(await store.emails.get(handle("p2"), { cacheOnly: true })).toBeNull();
    expect(reader.calls).toEqual([]);
    expect(await store.emails.getByProviderId("account", "p2")).toMatchObject({
      id: handle("p2"),
      subject: "Second",
    });
    expect(reader.methods()).toEqual(["envelopes"]);
  });

  it("revalidates mutable state when fresh is requested", async () => {
    await store.emails.upsertMany([email("ulid", { providerId: "p1", personIds: ["alice"] })]);
    reader.messages.set(
      "p1",
      providerEmail("p1", {
        keywords: { $flagged: true },
        mailboxIds: ["account:mailbox:Archive"],
        subject: "Provider subject",
      }),
    );
    expect(await store.emails.get("ulid")).toMatchObject({ keywords: { $seen: true } });
    expect(reader.calls).toEqual([]);
    const fresh = await store.emails.get("ulid", { fresh: true, lane: "interactive" });
    expect(fresh).toMatchObject({
      id: "ulid",
      keywords: { $flagged: true },
      mailboxIds: ["account:mailbox:Archive"],
      // Immutable and local fields are not replaced by revalidation.
      subject: "Travel plans",
      personIds: ["alice"],
      category: "scheduling",
    });
    expect(reader.calls).toEqual([
      { method: "envelopes", args: [["p1"]], opts: { lane: "interactive" } },
    ]);
  });

  it("revalidates rows whose labels are older than the account's watcher tick", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"));
    await store.emails.upsertMany([email("ulid", { providerId: "p1" })]);
    await store.kv.set(watcherTickKey("account"), "2026-10-22T09:00:00.000Z");
    await store.emails.get("ulid");
    expect(reader.calls).toEqual([]);
    await store.kv.set(watcherTickKey("account"), "2026-10-22T11:00:00.000Z");
    vi.setSystemTime(new Date("2026-10-22T11:30:00.000Z"));
    expect((await store.emails.get("ulid"))?.keywords).toEqual(providerEmail("p1").keywords);
    expect(await store.emails.freshness!("ulid")).toMatchObject({
      labelsFreshAt: "2026-10-22T11:30:00.000Z",
      touchedAt: "2026-10-22T11:30:00.000Z",
    });
    await store.emails.get("ulid");
    expect(reader.methods()).toEqual(["envelopes"]);
  });

  it("tombstones rows the provider no longer has", async () => {
    await store.emails.upsertMany([email("ulid", { providerId: "vanished" })]);
    const email_ = await store.emails.get("ulid", { fresh: true });
    expect(email_?.keywords.$deleted).toBe(true);
    expect((await store.emails.query({})).total).toBe(0);
  });

  it("serves the cached row when implicit revalidation fails but propagates for fresh reads", async () => {
    await store.emails.upsertMany([email("ulid", { providerId: "p1" })]);
    await store.kv.set(watcherTickKey("account"), "2999-01-01T00:00:00.000Z");
    reader.failNext = Object.assign(new Error("slow down"), { code: "RATE_LIMITED" });
    expect(await store.emails.get("ulid")).toMatchObject({ keywords: { $seen: true } });
    reader.failNext = Object.assign(new Error("slow down"), { code: "RATE_LIMITED" });
    await expect(store.emails.get("ulid", { fresh: true })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("fetches bodies only when explicitly requested and caches them", async () => {
    await store.emails.get(handle("p1"));
    expect((await store.emails.get(handle("p1")))?.textBody).toBeUndefined();
    expect(await store.emails.freshness!(handle("p1"))).toMatchObject({ bodyFetchedAt: null });
    const full = await store.emails.get(handle("p1"), { includeBodies: true });
    expect(full).toMatchObject({ textBody: "Body of p1", htmlBody: "<p>Body of p1</p>" });
    expect((await store.emails.get(handle("p1"), { includeBodies: true }))?.textBody).toBe(
      "Body of p1",
    );
    expect(await store.emails.get(handle("p1"), { includeBodies: false })).not.toHaveProperty(
      "textBody",
    );
    expect(reader.methods()).toEqual(["envelopes", "body"]);
    expect((await store.emails.freshness!(handle("p1")))?.bodyFetchedAt).not.toBeNull();
  });

  it("does not refetch bodies a sync already cached, and query never touches", async () => {
    await store.emails.upsertMany([email("ulid", { providerId: "p1" })]);
    const before = (await store.emails.freshness!("ulid"))?.touchedAt;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    await store.emails.query({ includeBodies: true });
    expect((await store.emails.freshness!("ulid"))?.touchedAt).toBe(before);
    expect((await store.emails.get("ulid", { includeBodies: true }))?.textBody).toBe(
      email().textBody,
    );
    expect((await store.emails.freshness!("ulid"))?.touchedAt).toBe("2030-01-01T00:00:00.000Z");
    expect(reader.calls).toEqual([]);
  });
});
