import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMailboxMcpServer, type MailboxHttpHandle, serveHttp } from "./index.js";
import { MemoryBus, MemoryExecutor, MemoryPolicy, MemoryStore } from "./testing/fakes.js";
import { account, email } from "./testing/fixtures.js";

const token = "test-bearer-credential";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) {
    await close();
  }
  cleanup.length = 0;
});
async function host(options: { host?: string } = {}) {
  const store = new MemoryStore(),
    policy = new MemoryPolicy(),
    bus = new MemoryBus(),
    executor = new MemoryExecutor(store, policy);
  await store.accounts.upsert(account());
  await store.emails.upsertMany([email()]);
  const server = createMailboxMcpServer({ store, executor, policy, bus });
  const handle = await serveHttp(server, { port: 0, token, ...options });
  cleanup.push(() => handle.close());
  return { handle, executor, bus, store };
}
async function connect(handle: MailboxHttpHandle, name: string) {
  const client = new Client({ name, version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  cleanup.push(() => client.close());
  return { client, transport };
}

describe("authenticated streamable HTTP", () => {
  it.each(["GET", "POST", "DELETE"])(
    "rejects anonymous and incorrect-token %s requests",
    async (method) => {
      const { handle } = await host();
      for (const authorization of [undefined, "Bearer incorrect", `Basic ${token}`]) {
        const response = await fetch(handle.url, {
          method,
          headers: authorization ? { Authorization: authorization } : {},
        });
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe("Bearer");
        expect(await response.text()).not.toContain(token);
      }
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    },
  );
  it("authenticates isolated SDK sessions and still requires a token for an existing session", async () => {
    const { handle, executor, bus } = await host();
    const one = await connect(handle, "one"),
      two = await connect(handle, "two");
    expect((await one.client.listTools()).tools).toHaveLength(54);
    for (const { client } of [one, two]) {
      await client.callTool({
        name: "archive_emails",
        arguments: { emailIds: ["email-1"], reason: "Organize" },
      });
    }
    expect(executor.submitted.map((request) => request.actor)).toEqual([
      { kind: "external-agent", id: one.transport.sessionId },
      { kind: "external-agent", id: two.transport.sessionId },
    ]);
    const response = await fetch(handle.url, {
      headers: { "mcp-session-id": one.transport.sessionId! },
    });
    expect(response.status).toBe(401);
    await one.client.close();
    await two.client.close();
    await handle.close();
    await handle.close();
    expect(bus.listenerCount).toBe(0);
  });
  it("R8 same-name authenticated sessions cannot impersonate ownership of held actions or undo", async () => {
    const { handle, executor, store } = await host();
    const one = await connect(handle, "same-name"),
      two = await connect(handle, "same-name");
    for (const { client } of [one, two]) {
      await client.callTool({
        name: "mark_read",
        arguments: { emailIds: ["email-1"], reason: "Read" },
      });
    }
    expect(executor.submitted.map((request) => request.actor.id)).toEqual([
      one.transport.sessionId,
      two.transport.sessionId,
    ]);
    expect(one.transport.sessionId).not.toBe(two.transport.sessionId);
    const original = (await store.actions.get("action-1"))!;
    await store.actions.update(original.id, { status: "held" });
    const response = await two.client.callTool({
      name: "cancel_held_action",
      arguments: { actionId: original.id },
    });
    expect(response.isError).toBe(true);
    expect(executor.cancelled).toEqual([]);
    await store.actions.update(original.id, { status: "executed", inverse: original.request });
    await two.client.callTool({
      name: "undo_action",
      arguments: { actionId: original.id, reason: "Restore" },
    });
    // The real executor's ownership gate receives the session ID, never the shared label.
    expect(executor.submitted.at(-1)!.actor.id).toBe(two.transport.sessionId);
    expect(executor.submitted.at(-1)!.actor.id).not.toBe(original.request.actor.id);
  });
  it("retains Host/Origin validation with authentication", async () => {
    const { handle } = await host();
    for (const extra of [{ Host: "evil.example" }, { Origin: "https://evil.example" }]) {
      const status = await new Promise<number>((resolve) => {
        const req = request(
          handle.url,
          { headers: { Authorization: `Bearer ${token}`, ...extra } },
          (response) => {
            response.resume();
            resolve(response.statusCode!);
          },
        );
        req.end();
      });
      expect(status).toBe(403);
    }
  });
  it("accepts an explicit host override", async () => {
    const { handle } = await host({ host: "localhost" });
    expect(handle.url).toMatch(/^http:\/\/localhost:/);
    expect((await (await connect(handle, "host-test")).client.listTools()).tools).toHaveLength(54);
  });
  it("bridges Claude Desktop stdio to authenticated HTTP", async () => {
    const { handle } = await host();
    const client = new Client({ name: "desktop-bridge", version: "1" });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../../../apps/server/dist/cli.js", import.meta.url)),
        "mcp",
        "proxy",
        "--url",
        handle.url,
      ],
      env: { ...env, PASSPORT_MCP_TOKEN: token },
      stderr: "pipe",
    });
    let errors = "";
    transport.stderr?.on("data", (data) => {
      errors += String(data);
    });
    cleanup.push(() => client.close());
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(54);
    expect(errors).not.toContain(token);
  });
  it("requires a usable configured token before opening a listener", async () => {
    const store = new MemoryStore(),
      policy = new MemoryPolicy(),
      bus = new MemoryBus();
    for (const value of ["", "contains space", "contains\nnewline"]) {
      await expect(
        serveHttp(
          createMailboxMcpServer({
            store,
            policy,
            bus,
            executor: new MemoryExecutor(store, policy),
          }),
          { port: 0, token: value },
        ),
      ).rejects.toMatchObject({ code: "TOKEN_REQUIRED" });
    }
  });
});
