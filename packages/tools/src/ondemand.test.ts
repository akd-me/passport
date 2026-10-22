import { ManualClock, QuotaGovernor } from "@passport/providers";
import { describe, expect, it } from "vitest";
import { UNTRUSTED_NOTICE } from "./ondemand-support.js";
import * as f from "./testing/fixtures.js";
import { onDemandHarness, rows } from "./testing/ondemand.js";

const limitedGovernor = (accountId = "account-1") => {
  const governor = new QuotaGovernor({
    clock: new ManualClock(Date.parse("2026-10-22T12:00:00Z")),
  });
  governor.configure(accountId, "gmail");
  governor.report(accountId, { retryAfterSeconds: 30 });
  return governor;
};

describe("mail_search / mail_list / mail_labels", () => {
  it("returns compact rows with cost, source and the untrusted notice", async () => {
    const { call } = await onDemandHarness();
    const result = await call("mail_search", { query: "from:sam subject:garden" });
    expect(rows(result).map((row) => row.subject)).toEqual([
      "Re: Garden project 4",
      "Re: Garden project 3",
      "Re: Garden project 2",
      "Re: Garden project 1",
    ]);
    expect(result).toMatchObject({
      account: "account-1",
      source: "provider",
      approxTotal: 4,
      cost: { gmailUnits: 85 },
      untrusted: UNTRUSTED_NOTICE,
    });
    expect(rows(result)[0]).toMatchObject({
      id: "account-1:email:fixture-22",
      threadId: "account-1:thread:garden",
      from: "Sam Rivera <sam@example.com>",
    });
  });

  it("pages a single account with provider tokens", async () => {
    const { call } = await onDemandHarness();
    const seen: string[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const page = await call("mail_search", { limit: 15, ...(pageToken ? { pageToken } : {}) });
      seen.push(...rows(page).map((row) => row.id));
      pageToken = page.nextPageToken as string | undefined;
      pages++;
    } while (pageToken);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(40);
  });

  it('fans out account:"all" in parallel and merges pages newest first without gaps', async () => {
    const { call, provider } = await onDemandHarness({ accounts: 3, withoutReader: ["account-3"] });
    provider("account-2").injectEmail({
      providerId: "late",
      subject: "Newest everywhere",
      receivedAt: "2026-02-01T00:00:00.000Z",
    });
    const seen: Array<{ id: string; date: string }> = [];
    let pageToken: string | undefined;
    let first: Record<string, unknown> | undefined;
    do {
      const page = await call("mail_search", {
        account: "all",
        limit: 7,
        ...(pageToken ? { pageToken } : {}),
      });
      first ??= page;
      seen.push(...rows(page));
      pageToken = page.nextPageToken as string | undefined;
    } while (pageToken);
    expect(seen).toHaveLength(81);
    expect(new Set(seen.map((row) => row.id)).size).toBe(81);
    expect(seen[0]?.id).toBe("account-2:email:late");
    for (let index = 1; index < seen.length; index++) {
      expect((seen[index - 1]?.date ?? "") >= (seen[index]?.date ?? "")).toBe(true);
    }
    expect(first).toMatchObject({
      account: "all",
      approxTotal: 81,
      skippedAccounts: ["account-3"],
      cost: { gmailUnits: 2 * 5 + 7 * 20 * 2 },
    });
  });

  it("rejects mixed inputs, bad portable queries and foreign page tokens with stable codes", async () => {
    const { call } = await onDemandHarness({ accounts: 2 });
    expect(await call("mail_search", { query: "a", rawQuery: "b" })).toMatchObject({
      isError: true,
      error: "INVALID_INPUT",
    });
    expect(
      await call("mail_search", { account: "account-1", query: "category:promotions" }),
    ).toMatchObject({
      isError: true,
      error: "INVALID_QUERY",
      reason: expect.stringContaining("rawQuery"),
    });
    const page = await call("mail_search", { account: "account-1", query: "is:unread", limit: 5 });
    expect(
      await call("mail_search", {
        account: "account-1",
        query: "is:read",
        pageToken: page.nextPageToken,
      }),
    ).toMatchObject({ isError: true, error: "INVALID_CURSOR" });
    expect(await call("mail_search", { account: "all", pageToken: "garbage" })).toMatchObject({
      isError: true,
      error: "INVALID_CURSOR",
    });
  });

  it("lists one container with structural filters and labels with counts", async () => {
    const { call } = await onDemandHarness();
    const list = await call("mail_list", {
      container: "inbox",
      filter: { unread: true },
      limit: 100,
    });
    expect(rows(list).length).toBeGreaterThan(0);
    expect(rows(list).every((row) => row.unread && row.labels.includes("Inbox"))).toBe(true);
    const labels = await call("mail_labels", { counts: true });
    expect(labels.items).toContainEqual({
      id: "Newsletters",
      name: "Newsletters",
      role: null,
      account: "account-1",
      counts: { total: 10, unread: 6 },
    });
    expect(labels.cost).toEqual({ gmailUnits: 1 + 8 });
  });

  it("lists accounts with on-demand availability", async () => {
    const { call } = await onDemandHarness({ accounts: 2, withoutReader: ["account-2"] });
    expect((await call("mail_accounts")).items).toMatchObject([
      { id: "account-1", onDemand: true },
      { id: "account-2", onDemand: false },
    ]);
  });

  it("returns ON_DEMAND_UNSUPPORTED without a reader", async () => {
    const { call } = await onDemandHarness({ noReaders: true });
    expect(await call("mail_search", { query: "x" })).toMatchObject({
      isError: true,
      error: "ON_DEMAND_UNSUPPORTED",
    });
  });
});

describe("mail_count", () => {
  it("counts exactly and computes facets over a sample", async () => {
    const { call } = await onDemandHarness();
    const result = await call("mail_count", { query: "from:sam", facets: ["from", "month"] });
    expect(result).toMatchObject({
      count: 11,
      capped: false,
      sampled: 11,
      facets: {
        from: [{ value: "sam@example.com", count: 11 }],
        month: [{ value: "2026-01", count: 11 }],
      },
    });
    expect(await call("mail_count", { query: "", cap: 5 })).toMatchObject({
      count: 5,
      capped: true,
    });
  });

  it("guards cold samples above 200 rows unless confirmCost", async () => {
    const { call, provider } = await onDemandHarness();
    for (let index = 0; index < 230; index++) {
      provider().injectEmail({ subject: `Bulk ${index}`, textBody: "bulk" });
    }
    const guarded = await call("mail_count", { query: "bulk", facets: ["from"], sample: 300 });
    expect(guarded).toMatchObject({
      isError: true,
      error: "WOULD_EXCEED_BUDGET",
      estimatedUnits: 3 * 5 + 230 * 20,
      count: 230,
      hint: expect.stringContaining("confirmCost"),
    });
    const confirmed = await call("mail_count", {
      query: "bulk",
      facets: ["from"],
      sample: 300,
      confirmCost: true,
    });
    expect(confirmed).toMatchObject({ count: 230, sampled: 230 });
  });
});

describe("mail_changes and people_history", () => {
  it("starts at now and reports arrivals and label changes since the cursor", async () => {
    const { call, provider } = await onDemandHarness();
    const start = await call("mail_changes");
    expect(start).toMatchObject({ changes: [], cursor: expect.any(String) });
    provider().injectEmail({ providerId: "arrival", subject: "Fresh" });
    await provider().applyChanges([
      { op: "setKeywords", providerIds: ["fixture-02"], add: ["$flagged"] },
    ]);
    const next = await call("mail_changes", { cursor: start.cursor });
    expect(next.changes).toMatchObject([
      { kind: "added", id: "account-1:email:arrival", subject: "Fresh" },
      { kind: "labelChanged", id: "account-1:email:fixture-02", flagged: true },
    ]);
    const added = await call("mail_changes", { cursor: start.cursor, kinds: ["added"] });
    expect(added.changes).toHaveLength(1);
  });

  it("searches a correspondent by address or person and direction", async () => {
    const { call, store } = await onDemandHarness();
    const from = await call("people_history", { email: "sam@example.com", direction: "from" });
    expect(rows(from)).toHaveLength(11);
    expect(rows(from).every((row) => row.from.includes("sam@example.com"))).toBe(true);
    await store.people.upsert(
      f.person({ primaryEmail: "pat@unknown.example", emails: ["pat@unknown.example"] }),
    );
    const person = await call("people_history", { personId: "person-1" });
    expect(rows(person).map((row) => row.subject)).toEqual(["An introduction"]);
    expect(await call("people_history", {})).toMatchObject({ error: "INVALID_INPUT" });
  });
});

describe("rate limiting", () => {
  it("returns a structured RATE_LIMITED result instead of throwing", async () => {
    const { call } = await onDemandHarness({ governors: { "account-1": limitedGovernor() } });
    const result = await call("mail_search", { query: "from:sam" });
    expect(result).toEqual({
      isError: true,
      error: "RATE_LIMITED",
      retryAfterSeconds: expect.any(Number),
      scope: "gmail:user-quota",
      hint: expect.stringContaining(`resets in ~${result.retryAfterSeconds}s`),
      untrusted: UNTRUSTED_NOTICE,
    });
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(30);
  });

  it("keeps rows from accounts that answered as partial results", async () => {
    const { call } = await onDemandHarness({
      accounts: 2,
      governors: { "account-1": limitedGovernor() },
    });
    const result = await call("mail_search", { account: "all", query: "from:sam", limit: 3 });
    expect(result).toMatchObject({
      isError: true,
      error: "RATE_LIMITED",
      partial: { source: "mixed" },
    });
    const partial = (result.partial as { items: Array<{ account: string }> }).items;
    expect(partial).toHaveLength(3);
    expect(partial.every((row) => row.account === "account-2")).toBe(true);
  });
});

describe("legacy aliases", () => {
  it("serve legacy read names from the reader and mark them deprecated", async () => {
    const { call, store } = await onDemandHarness();
    const search = await call("search_emails", { text: "Garden", keywords: { not: ["$seen"] } });
    expect(search).toMatchObject({ deprecated: expect.stringContaining("mail_search") });
    expect(rows(search).every((row) => row.unread && row.subject.includes("Garden"))).toBe(true);
    const inbox = await call("search_emails", {
      mailboxId: "account-1:mailbox:Receipts",
      limit: 3,
    });
    expect(rows(inbox).every((row) => row.labels.includes("Receipts"))).toBe(true);
    expect(await call("get_email", { emailId: "account-1:email:fixture-22" })).toMatchObject({
      deprecated: expect.stringContaining("mail_read"),
      messages: [
        { id: "account-1:email:fixture-22", text: expect.stringContaining("Thanks Alex") },
      ],
    });
    expect(
      await call("get_email_body", { emailId: "account-1:email:fixture-22", offset: 7, length: 4 }),
    ).toMatchObject({ messages: [{ offset: 7, text: "Alex" }], truncated: true, continueFrom: 11 });
    expect(await call("get_thread", { threadId: "account-1:thread:garden" })).toMatchObject({
      thread: { messageCount: 4 },
    });
    expect(await call("list_mailboxes")).toMatchObject({
      deprecated: expect.stringContaining("mail_labels"),
      items: expect.arrayContaining([
        expect.objectContaining({ name: "Inbox", counts: expect.any(Object) }),
      ]),
    });
    const summary = await call("summarize_thread", { threadId: "account-1:thread:scheduling" });
    expect(summary).toMatchObject({
      total: 4,
      openQuestions: [
        { question: "Are you free at 2pm UTC?" },
        { question: " Shall we use the usual room?".trim() },
      ],
      lastMessage: { subject: "Confirmed: Tuesday at 2" },
    });
    await store.people.upsert(
      f.person({ primaryEmail: "sam@example.com", emails: ["sam@example.com"] }),
    );
    const recent = await call("list_recent_from_person", { personId: "person-1", limit: 2 });
    expect(rows(recent)).toHaveLength(2);
    expect(recent.nextPageToken).toEqual(expect.any(String));
  });

  it("keep the store path for store-only filters and without readers", async () => {
    const { call, store } = await onDemandHarness();
    await store.emails.upsertMany([f.email()]);
    const byCategory = await call("search_emails", { category: "triage" });
    expect(byCategory).not.toHaveProperty("deprecated");
    const legacy = await onDemandHarness({ noReaders: true });
    await legacy.store.emails.upsertMany([f.email()]);
    const plain = await legacy.call("get_email", { emailId: "email-1" });
    expect(plain).toMatchObject({ id: "email-1" });
    expect(plain).not.toHaveProperty("deprecated");
  });

  it("resolves query writes server-side through reader.search paging", async () => {
    const { call, executor } = await onDemandHarness();
    const dry = await call("batch_archive_by_query", {
      query: { text: '"Systems Weekly"' },
      dryRun: true,
      reason: "Clear newsletters",
    });
    expect(dry).toMatchObject({
      dryRun: true,
      count: 10,
      total: 10,
      capped: false,
      source: "provider",
    });
    expect(executor.submitted).toEqual([]);
    const result = await call("apply_label_by_query", {
      query: { text: '"Systems Weekly"' },
      label: "Read later",
      reason: "Label newsletters",
    });
    expect(result).toMatchObject({ actionId: expect.any(String) });
    expect(executor.submitted[0]).toMatchObject({
      type: "label",
      accountId: "account-1",
      params: { label: "Read later" },
    });
    const ids =
      (executor.submitted[0]?.params as { emailIds: string[] } | undefined)?.emailIds ?? [];
    expect(ids).toHaveLength(10);
    expect(ids.every((id) => id.startsWith("account-1:email:fixture-"))).toBe(true);
  });

  it("reports RATE_LIMITED from query writes without submitting", async () => {
    const { call, executor } = await onDemandHarness({
      governors: { "account-1": limitedGovernor() },
    });
    expect(
      await call("batch_archive_by_query", { query: { text: "x" }, reason: "Archive x" }),
    ).toMatchObject({ isError: true, error: "RATE_LIMITED", policy_note: expect.any(String) });
    expect(executor.submitted).toEqual([]);
  });
});
