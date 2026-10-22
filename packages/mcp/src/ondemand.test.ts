import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { ManualClock, MockMailProvider, QuotaGovernor } from "@passport/providers";
import { DEFAULT_RESPONSE_BYTE_BUDGET } from "@passport/tools";
import { afterEach, describe, expect, it } from "vitest";
import type { MailboxMcpDependencies } from "./context.js";
import { createMailboxMcpServer, DEFAULT_MCP_RESPONSE_BYTE_BUDGET } from "./index.js";
import { MemoryBus, MemoryExecutor, MemoryPolicy, MemoryStore } from "./testing/fakes.js";
import * as f from "./testing/fixtures.js";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) {
    await close();
  }
});

async function connect(extra: Partial<MailboxMcpDependencies> = {}, governor?: QuotaGovernor) {
  const store = new MemoryStore();
  const policy = new MemoryPolicy();
  await store.accounts.upsert(f.account());
  const provider = new MockMailProvider(governor ? { governor } : {});
  await provider.connect(f.account(), {});
  const server = createMailboxMcpServer({
    store,
    policy,
    executor: new MemoryExecutor(store, policy),
    bus: new MemoryBus(),
    readers: async (id) => (id === "account-1" ? provider.reader() : null),
    ...extra,
  });
  const client = new Client({ name: "ondemand-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    const text = response.content.find((content) => content.type === "text");
    return { response, value: JSON.parse(text?.type === "text" ? text.text : "{}") };
  };
  return { store, provider, client, call };
}

describe("on-demand mail over MCP", () => {
  it("registers the tool belt with read-only, open-world annotations and on-demand instructions", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const search = tools.find((tool) => tool.name === "mail_search");
    expect(search?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(tools.find((tool) => tool.name === "mail_read")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "mail_accounts")?.annotations?.openWorldHint).toBe(
      false,
    );
    expect(tools.some((tool) => tool.name === "mail_export")).toBe(false);
    expect(tools.find((tool) => tool.name === "get_email")?.description).toMatch(/^Deprecated/);
    expect(client.getInstructions()).toMatch(/read on demand/);
    expect(client.getInstructions()).toMatch(/cost/);
    expect(client.getInstructions()).toMatch(/handles/);
  });

  it("searches and reads through the injected reader", async () => {
    const { call } = await connect();
    const { response, value } = await call("mail_search", { query: "from:sam subject:garden" });
    expect(response.isError).toBeFalsy();
    expect(value).toMatchObject({ approxTotal: 4, source: "provider", cost: { gmailUnits: 85 } });
    const read = await call("mail_read", { id: value.items[0].threadId });
    expect(read.value).toMatchObject({ thread: { messageCount: 4 }, truncated: false });
  });

  it("passes RATE_LIMITED and provider failures through as isError results", async () => {
    const governor = new QuotaGovernor({
      clock: new ManualClock(Date.parse("2026-10-22T12:00:00Z")),
    });
    governor.configure("account-1", "gmail");
    governor.report("account-1", { retryAfterSeconds: 30 });
    const limited = await connect({}, governor);
    const { response, value } = await limited.call("mail_search", { query: "x" });
    expect(response.isError).toBe(true);
    expect(value).toMatchObject({
      error: "RATE_LIMITED",
      retryAfterSeconds: expect.any(Number),
      scope: "gmail:user-quota",
      hint: expect.any(String),
    });
    const { call, provider } = await connect();
    await provider.disconnect();
    const failed = await call("mail_search", { query: "x" });
    expect(failed.response.isError).toBe(true);
    expect(failed.value).toMatchObject({ error: "NOT_CONNECTED" });
  });

  it("registers mail_export when the host passes scratchDir", async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), "passport-mcp-scratch-"));
    const { client, call } = await connect({ scratchDir });
    const tool = (await client.listTools()).tools.find((item) => item.name === "mail_export");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    const { value } = await call("mail_export", { ids: ["account-1:email:fixture-19"] });
    expect(value.dir.startsWith(scratchDir)).toBe(true);
    expect(value.files).toHaveLength(1);
  });

  it("defaults the response budget to 64 KiB while the registry keeps 512 KiB", async () => {
    expect(DEFAULT_MCP_RESPONSE_BYTE_BUDGET).toBe(64 * 1024);
    expect(DEFAULT_RESPONSE_BYTE_BUDGET).toBe(512 * 1024);
    const { call, provider } = await connect();
    provider.injectEmail({ providerId: "huge", textBody: "x".repeat(200_000) });
    const { response, value } = await call("mail_read", {
      id: "account-1:email:huge",
      view: "message",
      length: 60_000,
    });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(64 * 1024);
    expect(value).toMatchObject({ truncated: true, continueFrom: 60_000 });
    const legacy = await connect({ readers: undefined });
    await legacy.store.emails.upsertMany([f.email({ textBody: "y".repeat(200_000) })]);
    const full = await legacy.call("get_email", { emailId: "email-1", full: true });
    const size = Buffer.byteLength(JSON.stringify(full.response));
    expect(size).toBeLessThanOrEqual(64 * 1024);
    expect(size).toBeGreaterThan(16 * 1024);
    expect(full.value).toMatchObject({ truncated: true });
  });
});
