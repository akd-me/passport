import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostAgentStatus } from "@passport/types";
import { initializePassport } from "./init.js";
import { setHostAgentDetector, type HostAgentDetector } from "../llm-selection.js";

const agent = (kind: "codex" | "claude-code", ready: boolean): HostAgentStatus => ({
  kind, label: kind === "codex" ? "Codex" : "Claude Code", installed: true, binaryPath: `/bin/${kind}`, version: "1.0.0",
  loggedIn: ready, account: ready ? (kind === "codex" ? "ChatGPT" : "claude.ai (max)") : null, ready,
  ...(ready ? {} : { fix: "Run `claude auth login`." }), checkedAt: new Date().toISOString(),
});

describe("passport init with host agents", () => {
  const paths: string[] = [];
  let previous: HostAgentDetector;
  let detected: HostAgentStatus[];
  beforeEach(() => {
    detected = [agent("codex", true), agent("claude-code", true)];
    previous = setHostAgentDetector(async () => detected);
  });
  afterEach(async () => {
    setHostAgentDetector(previous);
    vi.unstubAllEnvs();
    await Promise.all(paths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
  });
  async function run(replies: string[], args: string[] = []) {
    const dataDir = await mkdtemp(join(tmpdir(), "passport-init-host-"));
    paths.push(dataDir);
    vi.stubEnv("PASSPORT_DATA_DIR", dataDir);
    vi.stubEnv("PASSPORT_LLM_PROVIDER", "");
    const asked: string[] = [], logged: string[] = [];
    await initializePassport({
      ask: async (label, secret) => {
        asked.push(label);
        if (secret) throw new Error("No secret should be requested");
        return replies.shift() ?? "";
      },
      log: (text) => logged.push(text),
      close() {},
    }, args);
    return { asked, logged, config: JSON.parse(await readFile(join(dataDir, "passport.config.json"), "utf8")) };
  }
  it("shows detected agents and defaults to auto without asking for a key", async () => {
    const { asked, logged, config } = await run(["", "skip"]);
    expect(logged).toContain("Agents on this machine: Codex (ChatGPT login) ✓, Claude Code (claude.ai (max) login) ✓");
    expect(asked[0]).toBe("Agent model (auto / codex / claude-code / advanced / none) [auto]");
    expect(asked.some((label) => /api key/i.test(label))).toBe(false);
    expect(logged.some((line) => line.includes("Codex (gpt-6.1-sol)"))).toBe(true);
    expect(config.llmSelection).toBe("auto");
    expect(config.llm.apiKey).toBeUndefined();
  });
  it("persists an explicit host-agent choice and model", async () => {
    const { config } = await run(["claude-code", "claude-opus-5-5", "skip"]);
    expect(config).toMatchObject({ llmSelection: "explicit", llm: { provider: "claude-code", model: "claude-opus-5-5", fastModel: "claude-haiku-5-5" } });
  });
  it("explains how to log in when the chosen agent is not ready", async () => {
    detected = [agent("codex", false), agent("claude-code", false)];
    const { asked, logged, config } = await run(["skip"], ["--llm", "claude-code"]);
    expect(asked[0]).toBe("Model [claude-sonnet-5-5]");
    expect(logged).toContain("Claude Code is not ready yet. Run `claude auth login`.");
    expect(config.llm.provider).toBe("claude-code");
  });
  it("defaults to none when no agent is ready and keeps API providers under advanced", async () => {
    detected = [agent("codex", false), agent("claude-code", false)];
    vi.stubEnv("PASSPORT_LLM_API_KEY", "");
    const none = await run(["", "skip"]);
    expect(none.asked[0]).toMatch(/\[none\]$/);
    expect(none.config.llmSelection).toBe("explicit");
    const advanced = await run(["advanced", "ollama", "", "http://localhost:11434/v1", "skip"]);
    expect(advanced.asked[1]).toBe("API provider (anthropic / openai / openai-compatible / ollama) [anthropic]");
    expect(advanced.config).toMatchObject({ llmSelection: "explicit", llm: { provider: "ollama", model: "llama3.2", baseUrl: "http://localhost:11434/v1" } });
  });
});
