import type { MailReader } from "@passport/types";
import { describe, expect, it } from "vitest";
import { onDemandHarness, rows } from "./testing/ondemand.js";

const cappedSearch = (_accountId: string, reader: MailReader): MailReader =>
  Object.assign(Object.create(reader) as MailReader, {
    search: async (input: Parameters<MailReader["search"]>[0]) => ({
      ...(await reader.search(input)),
      capped: true,
    }),
  });

describe("on-demand result metadata", () => {
  it("every read tool result carries source, cost and nextPageToken", async () => {
    const { call } = await onDemandHarness();
    const calls: Array<[string, unknown]> = [
      ["mail_accounts", {}],
      ["mail_labels", {}],
      ["mail_list", { limit: 5 }],
      ["mail_search", { query: "from:sam" }],
      ["mail_count", { query: "from:sam" }],
      ["mail_read", { id: "account-1:thread:garden" }],
      ["mail_grep", { query: "from:sam", pattern: "garden", maxMessages: 5 }],
      ["mail_changes", {}],
      ["people_history", { email: "sam@example.com" }],
    ];
    for (const [name, input] of calls) {
      const result = await call(name, input);
      expect(result.isError, name).toBeUndefined();
      expect(result, name).toHaveProperty("source");
      expect(result, name).toHaveProperty("cost");
      expect(result, name).toHaveProperty("nextPageToken");
    }
    const last = await call("mail_search", { query: "from:sam", limit: 100 });
    expect(last.nextPageToken).toBeNull();
  });

  it("passes a provider result ceiling (Graph capped) through search, fan-out and list", async () => {
    const { call } = await onDemandHarness({ accounts: 2, wrapReader: cappedSearch });
    const single = await call("mail_search", { account: "account-1", query: "from:sam" });
    expect(single).toMatchObject({ capped: true });
    const all = await call("mail_search", { account: "all", query: "from:sam" });
    expect(all).toMatchObject({ account: "all", capped: true });
    const plain = await onDemandHarness();
    expect(await plain.call("mail_search", { query: "from:sam" })).not.toHaveProperty("capped");
  });
});

describe("per-call readers", () => {
  it("ToolContext.readers serves a call when the registry has none", async () => {
    const { tools, provider } = await onDemandHarness({ noReaders: true });
    const search = tools.find((tool) => tool.name === "mail_search");
    const without = await search?.handler({ query: "from:sam" });
    expect(without).toMatchObject({ isError: true, error: "ON_DEMAND_UNSUPPORTED" });
    const reader = provider().reader();
    const withReaders = await search?.handler(
      { query: "from:sam" },
      { readers: async (accountId) => (accountId === "account-1" ? reader : null) },
    );
    expect(withReaders?.isError).toBeUndefined();
    expect(rows(withReaders ?? {}).length).toBeGreaterThan(0);
  });

  it("legacy aliases follow the per-call readers", async () => {
    const { tools, provider } = await onDemandHarness({ noReaders: true });
    const legacy = tools.find((tool) => tool.name === "search_emails");
    const reader = provider().reader();
    const result = await legacy?.handler({ text: "garden" }, { readers: async () => reader });
    expect(result).toMatchObject({ deprecated: expect.stringContaining("mail_search") });
  });
});
