/**
 * Live W1A check against the real `claude` / `codex` CLIs and their subscription logins: a
 * session calls a tool on Passport's tool belt listener (in-process Streamable HTTP with a
 * per-run bearer), then a resumed session remembers the result without calling it again.
 * Each suite skips when its CLI is not installed or not logged in, or when
 * PASSPORT_SKIP_LIVE_HOST_AGENTS=1.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectHostAgents, HostAgentLlmClient } from "@passport/agent";
import { ToolBeltListener } from "@passport/mcp";
import type { Tool } from "@passport/tools";
import type { HostAgentKind } from "@passport/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const statuses = process.env.PASSPORT_SKIP_LIVE_HOST_AGENTS ? [] : await detectHostAgents();
const ready = (kind: HostAgentKind) =>
  statuses.some((status) => status.kind === kind && status.ready);
const FAST: Record<HostAgentKind, string> = {
  "claude-code": "claude-haiku-5-5",
  codex: "gpt-5.6-luna",
};

const codeWord: Tool = {
  name: "get_code_word",
  description: "Returns today's secret code word",
  inputSchema: { type: "object", properties: {} },
  risk: "read",
  handler: async () => ({}),
};

describe.each((["claude-code", "codex"] as const).filter(ready))("live %s session", (kind) => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "passport-session-live-"));
  });
  afterAll(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("calls the tool belt natively, then resumes the provider session", async () => {
    const calls: string[] = [];
    const listener = new ToolBeltListener();
    const binding = await listener.bind({
      tools: [codeWord],
      call: async (name) => {
        calls.push(name);
        return { codeWord: "PELICAN" };
      },
    });
    const client = new HostAgentLlmClient({
      kind,
      model: FAST[kind],
      reasoning: { main: "low" },
      cwd: join(dir, "work"),
    });
    const run = (prompt: string, resumeSessionId?: string) =>
      client.session(
        {
          prompt,
          systemPrompt: "You are a terse test assistant. Use the passport tools when asked.",
          mcpServers: { passport: binding.server },
          allowedTools: ["mcp__passport"],
          ...(resumeSessionId ? { resumeSessionId } : {}),
          timeoutMs: 180_000,
        },
        () => {},
      ).done;
    try {
      const first = await run("Call get_code_word and reply with the code word only.");
      expect(first.error).toBeUndefined();
      expect(first.ok).toBe(true);
      expect(calls).toEqual(["get_code_word"]);
      expect(first.text.toUpperCase()).toContain("PELICAN");
      expect(first.sessionId).toBeTruthy();
      const second = await run(
        "Without calling any tool: what was the code word you got earlier? Reply with it only.",
        first.sessionId,
      );
      expect(second.error).toBeUndefined();
      expect(second.text.toUpperCase()).toContain("PELICAN");
      expect(calls).toHaveLength(1);
    } finally {
      await binding.release();
      await listener.close();
    }
  }, 400_000);
});
