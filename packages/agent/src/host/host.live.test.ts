/**
 * Live tests against the real `claude` / `codex` CLIs and their subscription logins.
 * Each suite skips itself when its CLI is not installed or not logged in (as in CI).
 * Set PASSPORT_SKIP_LIVE_HOST_AGENTS=1 to skip them on a machine that has the CLIs.
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { HostAgentEvent, HostAgentKind } from "@passport/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HostAgentLlmClient } from "./client.js";
import { detectHostAgents } from "./detect.js";
import { runHostAgentSession } from "./session.js";

const statuses = process.env.PASSPORT_SKIP_LIVE_HOST_AGENTS ? [] : await detectHostAgents();
const ready = (kind: HostAgentKind) =>
  statuses.some((status) => status.kind === kind && status.ready);
const probeServer = fileURLToPath(new URL("./fixtures/probe-mcp-server.mjs", import.meta.url));
const FAST: Record<HostAgentKind, string> = {
  "claude-code": "claude-haiku-5-5",
  codex: "gpt-5.6-luna",
};

let dir: string;
let http: Server;
let httpUrl: string;
const token = randomBytes(16).toString("hex");
const httpCalls: string[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "passport-host-live-"));
  // Streamable HTTP MCP server that requires a bearer header, to prove headers are wired.
  http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += String(chunk);
    }
    const server = new McpServer({ name: "remote", version: "1.0.0" });
    server.registerTool(
      "get_tracking_number",
      { description: "Returns the parcel tracking number", inputSchema: {} },
      async () => {
        httpCalls.push("get_tracking_number");
        return { content: [{ type: "text", text: "The tracking number is TRK-7781" }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  httpUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
});
afterAll(async () => {
  await new Promise((resolve) => http?.close(resolve));
  if (dir) {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const kind of ["claude-code", "codex"] as const) {
  describe.skipIf(!ready(kind))(`live ${kind}`, () => {
    it("completes a JSON-mode request with the fast model", async () => {
      const client = new HostAgentLlmClient({ kind, cwd: join(dir, `${kind}-scratch`) });
      const result = await client.complete({
        system: "You classify email into a category.",
        messages: [
          {
            role: "user",
            content: "Subject: Your receipt for order #12345\nThanks for your purchase of $19.99.",
          },
        ],
        json: {
          type: "object",
          properties: { category: { type: "string", enum: ["receipts", "social", "work"] } },
          required: ["category"],
          additionalProperties: false,
        },
        model: "fast",
      });
      expect(result.json).toEqual({ category: "receipts" });
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.costUsd).toBeNull();
    }, 180_000);

    it("calls a tool on a stdio MCP server started by the test", async () => {
      const word = `WORD-${randomBytes(3).toString("hex").toUpperCase()}`;
      const log = join(dir, `${kind}-stdio.log`);
      const events: HostAgentEvent[] = [];
      const result = await runHostAgentSession(
        {
          kind,
          model: FAST[kind],
          reasoning: "low",
          cwd: join(dir, `${kind}-stdio`),
          prompt:
            "Call the get_code_word tool on the probe MCP server, then reply with only the code word it returned.",
          mcpServers: {
            probe: {
              command: process.execPath,
              args: [probeServer],
              env: { PROBE_WORD: word, PROBE_LOG: log },
            },
          },
          maxTurns: 6,
          timeoutMs: 170_000,
        },
        (event) => events.push(event),
      ).done;
      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(await readFile(log, "utf8")).toContain("get_code_word");
      expect(
        events.some(
          (event) => event.type === "tool_call" && event.name === "mcp__probe__get_code_word",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) => event.type === "tool_result" && event.ok && event.summary.includes(word),
        ),
      ).toBe(true);
      expect(result.text).toContain(word);
      expect(events[0]?.type).toBe("started");
      expect(events.at(-1)?.type).toBe("completed");
    }, 180_000);

    it("calls a tool on an authenticated HTTP MCP server", async () => {
      const before = httpCalls.length;
      const result = await runHostAgentSession({
        kind,
        model: FAST[kind],
        reasoning: "low",
        cwd: join(dir, `${kind}-http`),
        prompt:
          "Call the get_tracking_number tool on the remote MCP server, then reply with only the tracking number.",
        mcpServers: { remote: { url: httpUrl, headers: { Authorization: `Bearer ${token}` } } },
        allowedTools: ["mcp__remote__get_tracking_number"],
        maxTurns: 6,
        timeoutMs: 170_000,
      }).done;
      expect(result.error).toBeUndefined();
      expect(httpCalls.length).toBeGreaterThan(before);
      expect(result.text).toContain("TRK-7781");
    }, 180_000);
  });
}
