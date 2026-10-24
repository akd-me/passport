import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@passport/tools";
import type { HostAgentMcpServer } from "@passport/types";
import { afterEach, describe, expect, it } from "vitest";
import { type ToolBelt, ToolBeltListener } from "./index.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) {
    await close();
  }
  cleanup.length = 0;
});

const echo: Tool = {
  name: "echo",
  description: "Echo the input",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  risk: "read",
  handler: async () => ({ never: true }),
};

function belt(label: string, calls: Array<[string, unknown]>): ToolBelt {
  return {
    tools: [echo],
    call: async (name, input) => {
      calls.push([name, input]);
      return { belt: label, input };
    },
  };
}

async function connect(server: HostAgentMcpServer) {
  if (!("url" in server)) {
    throw new Error("expected an HTTP server");
  }
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers ?? {} },
    }),
  );
  cleanup.push(() => client.close());
  return client;
}

describe("tool belt listener", () => {
  it("lists a run's tools and routes calls to the belt its bearer is bound to", async () => {
    const listener = new ToolBeltListener();
    cleanup.push(() => listener.close());
    const a: Array<[string, unknown]> = [];
    const b: Array<[string, unknown]> = [];
    const one = await listener.bind(belt("one", a));
    const two = await listener.bind(belt("two", b));
    expect("url" in one.server && one.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const client = await connect(one.server);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["echo"]);
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual({
      belt: "one",
      input: { text: "hi" },
    });
    await (await connect(two.server)).callTool({ name: "echo", arguments: {} });
    expect(a).toEqual([["echo", { text: "hi" }]]);
    expect(b).toEqual([["echo", {}]]);
    await one.release();
    await two.release();
  });

  it("rejects missing, wrong and released bearers, browsers and foreign hosts", async () => {
    const listener = new ToolBeltListener();
    cleanup.push(() => listener.close());
    const keep = await listener.bind(belt("keep", []));
    const gone = await listener.bind(belt("gone", []));
    if (!("url" in keep.server) || !("url" in gone.server)) {
      throw new Error("expected HTTP servers");
    }
    const url = keep.server.url;
    const post = (headers: Record<string, string>) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: "{}",
      });
    expect((await post({})).status).toBe(401);
    expect((await post({ Authorization: "Bearer wrong" })).status).toBe(401);
    await gone.release();
    expect((await post(gone.server.headers ?? {})).status).toBe(401);
    expect(
      (await post({ ...(keep.server.headers ?? {}), Origin: "http://evil.example" })).status,
    ).toBe(403);
    expect(listener.size).toBe(1);
    await keep.release();
    expect(listener.size).toBe(0);
  });

  it("bounds oversized results with the mailbox server's response budget", async () => {
    const listener = new ToolBeltListener({ responseByteBudget: 4096 });
    cleanup.push(() => listener.close());
    const big: ToolBelt = {
      tools: [echo],
      call: async () => ({
        rows: Array.from({ length: 400 }, (_, i) => ({ i, pad: "x".repeat(40) })),
      }),
    };
    const binding = await listener.bind(big);
    const client = await connect(binding.server);
    const result = await client.callTool({ name: "echo", arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(Buffer.byteLength(text)).toBeLessThan(4096);
    await binding.release();
  });
});
