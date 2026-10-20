import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoBackend } from "./demo/index.js";
import { defaultConfig } from "./config.js";
import { startServer } from "./server.js";
import { createRealBackend } from "./compose.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

describe("HTTP + WebSocket listener", () => {
  const token = "server-integration-test-token";
  const headers = { Authorization: `Bearer ${token}` };
  beforeEach(() => vi.stubEnv("PASSPORT_API_TOKEN", token));
  afterEach(() => vi.unstubAllEnvs());
  it("starts the real UI/API without an LLM key and exposes HTTP MCP on its own loopback listener", async () => {
    const backend = await createRealBackend(
      { ...defaultConfig(), port: 0, mcpPort: 0 },
      { storePath: ":memory:" },
    );
    const handle = startServer(backend);
    const client = new Client({ name: "http-integration", version: "1" });
    try {
      await once(handle.server, "listening");
      const mcpUrl = await handle.ready;
      if (!mcpUrl) throw new Error("Expected MCP URL");
      const address = handle.server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected HTTP listener");
      const root = `http://127.0.0.1:${address.port}`;
      expect(
        (
          (await fetch(`${root}/api/health`, { headers }).then((response) =>
            response.json(),
          )) as { mode: string }
        ).mode,
      ).toBe("real");
      const accounts = (await fetch(`${root}/api/accounts`, { headers }).then((response) =>
        response.json(),
      )) as { llm: { configured: boolean } };
      expect(accounts.llm.configured).toBe(false);
      expect((await fetch(root)).status).toBe(200);
      await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
      expect(
        (await client.listTools()).tools.map((tool) => tool.name),
      ).toContain("archive_emails");
    } finally {
      await client.close();
      await handle.close();
    }
    expect(handle.server.listening).toBe(false);
  });
  it("streams raw DomainEvents, then closes sockets, timers, and storage", async () => {
    const backend = await createDemoBackend({ ...defaultConfig(), port: 0 });
    const handle = startServer(backend);
    await once(handle.server, "listening");
    const address = handle.server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP listener");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers });
    try {
      await once(socket, "open");
      const message = once(socket, "message");
      backend.bus.emit({ type: "email.updated", emailId: "email-0" });
      expect(JSON.parse(String((await message)[0]))).toEqual({
        type: "email.updated",
        emailId: "email-0",
      });
      expect(
        (
          (await fetch(`http://127.0.0.1:${address.port}/api/health`, { headers }).then(
            (r) => r.json(),
          )) as { mode: string }
        ).mode,
      ).toBe("demo");
    } finally {
      socket.terminate();
      await handle.close();
    }
    expect(handle.server.listening).toBe(false);
  });
});
