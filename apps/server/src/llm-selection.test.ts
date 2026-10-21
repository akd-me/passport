import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostAgentStatus } from "@passport/types";
import { defaultConfig, llmConfigured, loadConfig, saveConfig } from "./config.js";
import { resolveLlmSelection, setHostAgentDetector, type HostAgentDetector } from "./llm-selection.js";
import { createRealBackend } from "./compose.js";
import { createApp } from "./auth.test-client.js";
import { hostAgentChecks, pingHostAgent } from "./doctor-host-agents.js";
import { runDoctor } from "./doctor.js";

const status = (kind: "codex" | "claude-code", ready: boolean, installed = true): HostAgentStatus => ({
  kind, label: kind === "codex" ? "Codex" : "Claude Code", installed, binaryPath: installed ? `/bin/${kind}` : null,
  version: installed ? "1.0.0" : null, loggedIn: ready, account: ready ? (kind === "codex" ? "ChatGPT" : "claude.ai (max)") : null, ready,
  ...(ready ? {} : { fix: installed ? `Run \`${kind === "codex" ? "codex login" : "claude auth login"}\`` : "Install it" }),
  checkedAt: new Date().toISOString(),
});
const body = (value: unknown) => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

let detected: HostAgentStatus[] = [];
const detector = vi.fn<HostAgentDetector>(async () => detected);
let previous: HostAgentDetector;
const dirs: string[] = [];
beforeEach(() => {
  detected = [];
  detector.mockClear();
  previous = setHostAgentDetector(detector);
});
afterEach(async () => {
  setHostAgentDetector(previous);
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "passport-llm-select-"));
  dirs.push(dir);
  return dir;
}

describe("LLM selection", () => {
  it("defaults new and placeholder configs to auto, and keeps deliberate v0.1 choices explicit", async () => {
    const dir = await dataDir();
    expect((await loadConfig({ PASSPORT_DATA_DIR: dir })).llmSelection).toBe("auto");
    await writeFile(join(dir, "passport.config.json"), JSON.stringify({ llm: { provider: "anthropic", model: "claude-sonnet-5-5" } }));
    expect((await loadConfig({ PASSPORT_DATA_DIR: dir })).llmSelection).toBe("auto");
    await writeFile(join(dir, "passport.config.json"), JSON.stringify({ llm: { provider: "ollama", model: "llama3.2" } }));
    expect((await loadConfig({ PASSPORT_DATA_DIR: dir })).llmSelection).toBe("explicit");
    await writeFile(join(dir, "passport.config.json"), JSON.stringify({ llmSelection: "auto", llm: { provider: "openai", model: "gpt-4.1" } }));
    expect((await loadConfig({ PASSPORT_DATA_DIR: dir })).llmSelection).toBe("auto");
    await writeFile(join(dir, "passport.config.json"), JSON.stringify({ llmSelection: "sometimes" }));
    await expect(loadConfig({ PASSPORT_DATA_DIR: dir })).rejects.toThrow("llmSelection");
  });
  it("accepts PASSPORT_LLM_PROVIDER=codex|claude-code with model overrides and never attaches a key", async () => {
    const dir = await dataDir();
    await writeFile(join(dir, "passport.config.json"), JSON.stringify({ llm: { provider: "anthropic", model: "claude-sonnet-5-5", fastModel: "claude-haiku-5-5" } }));
    const codex = await loadConfig({ PASSPORT_DATA_DIR: dir, PASSPORT_LLM_PROVIDER: "codex", PASSPORT_LLM_API_KEY: "sk-should-not-attach" });
    expect(codex.llm).toEqual({ provider: "codex", model: "gpt-6.1-sol" });
    expect(llmConfigured(codex.llm)).toBe(true);
    const claude = await loadConfig({ PASSPORT_DATA_DIR: dir, PASSPORT_LLM_PROVIDER: "claude-code", PASSPORT_LLM_MODEL: "claude-opus-5-5", PASSPORT_LLM_FAST_MODEL: "haiku" });
    expect(claude.llm).toEqual({ provider: "claude-code", model: "claude-opus-5-5", fastModel: "haiku" });
    // The environment pin wins over detection.
    detected = [status("claude-code", true)];
    expect(await resolveLlmSelection(codex, { env: { PASSPORT_LLM_PROVIDER: "codex" } })).toMatchObject({ source: "env", llm: { provider: "codex" } });
    expect(detector).not.toHaveBeenCalled();
  });
  it("auto prefers Codex, then Claude Code, then a configured HTTP provider, else no agent", async () => {
    const config = defaultConfig(await dataDir());
    detected = [status("codex", true), status("claude-code", true)];
    expect(await resolveLlmSelection(config, { env: {} })).toMatchObject({ selection: "auto", source: "host-agent", llm: { provider: "codex", model: "gpt-6.1-sol", fastModel: "gpt-5.6-luna" } });
    detected = [status("codex", false), status("claude-code", true)];
    expect((await resolveLlmSelection(config, { env: {} })).llm).toEqual({ provider: "claude-code", model: "claude-sonnet-5-5", fastModel: "claude-haiku-5-5" });
    detected = [status("codex", false, false), status("claude-code", false)];
    const none = await resolveLlmSelection(config, { env: {} });
    expect(none).toMatchObject({ source: "none", llm: { provider: "anthropic" } });
    expect(llmConfigured(config.llm)).toBe(false);
    const keyed = { ...defaultConfig(await dataDir()), llm: { provider: "anthropic" as const, model: "claude-sonnet-5-5", apiKey: "env-key" } };
    expect(await resolveLlmSelection(keyed, { env: {} })).toMatchObject({ source: "fallback", llm: { apiKey: "env-key" } });
    const explicit = { ...defaultConfig(await dataDir()), llmSelection: "explicit" as const };
    detected = [status("codex", true)];
    expect(await resolveLlmSelection(explicit, { env: {} })).toMatchObject({ source: "explicit", llm: { provider: "anthropic" } });
  });
  it("persists the configured fallback, not the auto-detected agent", async () => {
    const dir = await dataDir();
    await writeFile(join(dir, "passport.config.json"), JSON.stringify({ llm: { provider: "anthropic", model: "claude-sonnet-5-5" } }));
    const config = await loadConfig({ PASSPORT_DATA_DIR: dir });
    detected = [status("codex", true)];
    await resolveLlmSelection(config, { env: {} });
    expect(config.llm.provider).toBe("codex");
    await saveConfig({ ...config, port: 4100 });
    const saved = JSON.parse(await readFile(join(dir, "passport.config.json"), "utf8"));
    expect(saved).toMatchObject({ port: 4100, llmSelection: "auto", llm: { provider: "anthropic", model: "claude-sonnet-5-5" } });
  });
});

describe("host agent routes", () => {
  it("lists detected host agents and switches providers without an API key", async () => {
    const dir = await dataDir();
    vi.stubEnv("PASSPORT_LLM_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    detected = [status("codex", true), status("claude-code", false)];
    // A file-backed workspace, so settings are persisted.
    const backend = await createRealBackend(defaultConfig(dir));
    try {
      const app = createApp(backend);
      const agents = await (await app.request("/api/host-agents?refresh=1")).json();
      expect(agents).toEqual(detected);
      expect(detector).toHaveBeenLastCalledWith({ refresh: true });

      const codex = await app.request("/api/settings/llm", body({ provider: "codex" }));
      expect(codex.status).toBe(200);
      expect(await codex.json()).toEqual({ provider: "codex", model: "gpt-6.1-sol", fastModel: "gpt-5.6-luna", apiKeyConfigured: false, configured: true, selection: "explicit" });
      const saved = JSON.parse(await readFile(join(dir, "passport.config.json"), "utf8"));
      expect(saved).toMatchObject({ llmSelection: "explicit", llm: { provider: "codex", model: "gpt-6.1-sol" } });
      expect(saved.llm.apiKey).toBeUndefined();

      const claude = await (await app.request("/api/settings/llm", body({ provider: "claude-code", model: "claude-opus-5-5", baseUrl: "", fastModel: "" }))).json() as Record<string, unknown>;
      expect(claude).toMatchObject({ provider: "claude-code", model: "claude-opus-5-5", fastModel: "claude-haiku-5-5", selection: "explicit" });
      expect(claude.baseUrl).toBeUndefined();

      const auto = await (await app.request("/api/settings/llm", body({ provider: "auto" }))).json();
      expect(auto).toMatchObject({ provider: "codex", selection: "auto", configured: true });
      expect(JSON.parse(await readFile(join(dir, "passport.config.json"), "utf8")).llmSelection).toBe("auto");

      const accounts = await (await app.request("/api/accounts")).json() as { llm: unknown };
      expect(accounts.llm).toMatchObject({ provider: "codex", selection: "auto", configured: true });

      const http = await (await app.request("/api/settings/llm", body({ provider: "ollama", baseUrl: "http://localhost:11434/v1" }))).json() as Record<string, unknown>;
      expect(http).toMatchObject({ provider: "ollama", model: "llama3.2", selection: "explicit" });
      expect(http.fastModel).toBeUndefined();

      expect((await app.request("/api/settings/llm", body({ provider: "gemini-cli" }))).status).toBe(400);
      expect((await app.request("/api/settings/llm", body({ provider: "codex", apiKey: "nope" }))).status).toBe(400);
    } finally {
      await backend.close();
    }
  });
});

describe("host agent composition", () => {
  it("runs the agent through the configured host CLI in a scratch directory under the data dir", async () => {
    const dir = await dataDir();
    const fake = join(dir, "codex"), log = join(dir, "codex.log");
    await writeFile(fake, `#!${process.execPath}
const fs = require("node:fs");
let input = "";
process.stdin.on("data", c => { input += c; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input, keys: Object.keys(process.env) }) + "\\n");
  const text = JSON.stringify({ text: "Nothing to do.", toolCalls: [] });
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t" }) + "\\n" + JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\\n" + JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }) + "\\n");
});
`);
    await chmod(fake, 0o755);
    vi.stubEnv("PASSPORT_CODEX_PATH", fake);
    vi.stubEnv("PASSPORT_MASTER_KEY_TEST_SENTINEL", "do-not-forward");
    const config = { ...defaultConfig(dir), llm: { provider: "codex" as const, model: "gpt-6-sol" }, llmSelection: "explicit" as const };
    const backend = await createRealBackend(config, { storePath: ":memory:" });
    try {
      const run = await backend.agent.run({ kind: "manual", instruction: "Tidy my inbox" });
      expect(run.error ?? null).toBeNull();
      const [call] = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(call.cwd).toBe(await realpath(join(dir, "host-agent")));
      expect(call.args).toEqual(expect.arrayContaining(["exec", "--json", "-m", "gpt-6-sol"]));
      expect(call.input).toContain("Tidy my inbox");
      expect(call.keys.some((key: string) => key.startsWith("PASSPORT_"))).toBe(false);
    } finally {
      await backend.close();
    }
  });
});

describe("host agent doctor checks", () => {
  it("reports each CLI with an actionable fix and pings the selected agent", async () => {
    const config = { ...defaultConfig(await dataDir()), llm: { provider: "codex" as const, model: "gpt-6.1-sol" } };
    const rows = await hostAgentChecks(config, { hostAgents: async () => [status("codex", true), status("claude-code", false, false)] });
    expect(rows).toEqual([
      { name: "Codex", status: "ok", detail: "1.0.0 · ChatGPT login · in use" },
      { name: "Claude Code", status: "ok", detail: "Not installed. (optional) Install it" },
    ]);
    const missing = await hostAgentChecks(config, { hostAgents: async () => [status("codex", false), status("claude-code", false, false)] });
    expect(missing[0]).toMatchObject({ name: "Codex", status: "error", detail: expect.stringContaining("codex login") });
    const unused = await hostAgentChecks(defaultConfig(await dataDir()), { hostAgents: async () => [status("codex", false), status("claude-code", false, false)] });
    expect(unused.map(row => row.status)).toEqual(["warning", "warning"]);

    expect(await pingHostAgent(config, { pingHostAgent: async () => {} })).toMatchObject({ name: "LLM", status: "ok", detail: expect.stringContaining("Codex (gpt-6.1-sol)") });
    const failed = await pingHostAgent(config, { pingHostAgent: async () => { throw Object.assign(new Error("Codex is not logged in. Run `codex login`."), { code: "HOST_AGENT_AUTH" }); } });
    expect(failed).toEqual({ name: "LLM", status: "error", detail: "Codex is not logged in. Run `codex login`." });
    const opaque = await pingHostAgent(config, { pingHostAgent: async () => { throw new Error("raw token=abc"); } });
    expect(opaque.detail).not.toContain("abc");
  });
  it("runDoctor includes host-agent rows and does not HTTP-ping a host agent", async () => {
    const dir = await dataDir();
    const backend = await createRealBackend({ ...defaultConfig(dir), llm: { provider: "claude-code", model: "claude-sonnet-5-5" } }, { storePath: ":memory:" });
    try {
      const fetcher = vi.fn<typeof fetch>();
      const report = await runDoctor(backend, { fetch: fetcher, hostAgents: async () => [status("codex", false, false), status("claude-code", true)], pingHostAgent: async () => {} });
      expect(fetcher).not.toHaveBeenCalled();
      expect(report.checks).toContainEqual({ name: "Claude Code", status: "ok", detail: "1.0.0 · claude.ai (max) login · in use" });
      expect(report.checks).toContainEqual(expect.objectContaining({ name: "LLM", status: "ok" }));
    } finally {
      await backend.close();
    }
  });
});
