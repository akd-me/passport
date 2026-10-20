import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { createDemoBackend } from "./demo/index.js";
import { defaultConfig } from "./config.js";
import { startServer } from "./server.js";
import { createRealBackend } from "./compose.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadMcpToken } from "./mcp-token.js";

describe("HTTP + WebSocket listener", () => {
  it("starts the real UI/API without an LLM key and exposes HTTP MCP on its own loopback listener", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "passport-http-"));
    const backend = await createRealBackend(
      { ...defaultConfig(dataDir), port: 0, mcpPort: 0 },
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
          (await fetch(`${root}/api/health`).then((response) =>
            response.json(),
          )) as { mode: string }
        ).mode,
      ).toBe("real");
      const accounts = (await fetch(`${root}/api/accounts`).then((response) =>
        response.json(),
      )) as { llm: { configured: boolean } };
      expect(accounts.llm.configured).toBe(false);
      expect((await fetch(root)).status).toBe(200);
      expect((await fetch(mcpUrl)).status).toBe(401);
      const token = await loadMcpToken(backend.config.dataDir);
      await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      expect(
        (await client.listTools()).tools.map((tool) => tool.name),
      ).toContain("archive_emails");
    } finally {
      await client.close();
      await handle.close();
      await rm(dataDir, { recursive: true, force: true });
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
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
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
          (await fetch(`http://127.0.0.1:${address.port}/api/health`).then(
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
