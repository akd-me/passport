import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openStore } from "@passport/store";
import { describe, expect, it } from "vitest";

describe("passport mcp", () => {
  it("R9: starts a client stdio process with protocol-only stdout, no owner or background jobs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "passport-stdio-"));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    env.PASSPORT_DATA_DIR = dataDir;
    env.PASSPORT_PORT = "0";
    env.PASSPORT_HOST = "0.0.0.0"; // Stdio must not trigger the HTTP remote-bind guard.
    env.PASSPORT_ALLOWED_HOSTS = "*"; // HTTP auth configuration is not read by stdio.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", fileURLToPath(new URL("./cli.ts", import.meta.url)), "mcp"],
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-smoke", version: "1" });
    let diagnostics = "";
    transport.stderr?.on("data", (chunk) => {
      diagnostics += String(chunk);
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("search_emails");
      const result = await client.callTool({
        name: "search_emails",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(diagnostics).not.toContain("workspace →");
      expect(diagnostics).not.toContain("Mailbox MCP →");
      expect(diagnostics).toContain("Passport serve is not running");
      await expect(stat(join(dataDir, "owner.lock"))).rejects.toHaveProperty("code", "ENOENT");
      const store = openStore({
        path: join(dataDir, "passport.sqlite"),
        masterKey: (await readFile(join(dataDir, "master.key"), "utf8")).trim(),
      });
      try {
        expect(await store.kv.get("job:outbox.release")).toBeNull();
      } finally {
        await store.close();
      }
    } finally {
      await client.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 10000);
});
