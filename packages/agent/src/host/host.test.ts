import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostAgentEvent } from "@passport/types";
import { afterEach, describe, expect, it } from "vitest";
import { createLlmClient } from "../llm/client.js";
import { claudeInvocation, createClaudeParser } from "./claude.js";
import { HostAgentLlmClient } from "./client.js";
import { codexInvocation, createCodexParser, strictCompatible } from "./codex.js";
import { detectHostAgents, preferredHostAgent } from "./detect.js";
import { hostAgentEnv, redact } from "./env.js";
import { runHostAgentSession } from "./session.js";
import type { HostRunSpec, HostStreamParser } from "./types.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean);
function parse(parser: HostStreamParser, lines: string[]): HostAgentEvent[] {
  return lines.flatMap((line) => parser.push(line));
}
const spec = (overrides: Partial<HostRunSpec>): HostRunSpec => ({
  kind: "claude-code",
  prompt: "hi",
  cwd: tmpdir(),
  completion: true,
  ...overrides,
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "passport-host-test-"));
  dirs.push(dir);
  return dir;
}

interface FakeBehaviour {
  version?: string;
  auth?: { code: number; stdout?: string; stderr?: string };
  run?: { lines?: string[]; stderr?: string; exit?: number; sleepMs?: number };
}
/** A fake `claude`/`codex` executable. The child env is filtered, so behaviour comes from a file. */
async function fakeBinary(
  dir: string,
  name: "claude" | "codex",
  behaviour: FakeBehaviour,
): Promise<{
  path: string;
  log: () => Promise<{ args: string[]; env: Record<string, string>; stdin: string; pid: number }[]>;
}> {
  const path = join(dir, name),
    logPath = join(dir, `${name}.log`);
  await writeFile(`${path}.json`, JSON.stringify(behaviour));
  await writeFile(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const b = JSON.parse(fs.readFileSync(${JSON.stringify(`${path}.json`)}, "utf8"));
const args = process.argv.slice(2);
const finish = (out, err, code) => { if (out) process.stdout.write(out); if (err) process.stderr.write(err); process.exit(code); };
if (args[0] === "--version") finish((b.version ?? "1.2.3") + "\\n", "", 0);
else if ((args[0] === "auth" || args[0] === "login") && args[1] === "status") finish(b.auth?.stdout ?? "", b.auth?.stderr ?? "", b.auth?.code ?? 0);
else {
  let stdin = "";
  process.stdin.on("data", c => { stdin += c; });
  process.stdin.on("end", () => {
    fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, env: process.env, stdin, pid: process.pid }) + "\\n");
    const run = b.run ?? {};
    setTimeout(() => finish((run.lines ?? []).map(l => l + "\\n").join(""), run.stderr ?? "", run.exit ?? 0), run.sleepMs ?? 0);
  });
}
`,
  );
  await chmod(path, 0o755);
  return {
    path,
    log: async () =>
      (await readFile(logPath, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}
const codexMessage = (text: string) => [
  '{"type":"thread.started","thread_id":"t-1"}',
  JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } }),
  '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"cache_write_input_tokens":0,"output_tokens":7}}',
];

describe("Claude Code stream parser (recorded fixtures)", () => {
  it("maps an MCP tool session to started/tool_call/tool_result/text events", () => {
    const parser = createClaudeParser();
    const events = parse(parser, fixture("claude-mcp.jsonl"));
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "tool_call",
      "tool_result",
      "text",
    ]);
    expect(events[0]).toEqual({
      type: "started",
      sessionId: "41e79ef5-6092-45ed-b88e-f93afde2e516",
    });
    expect(events[1]).toEqual({ type: "tool_call", name: "mcp__probe__get_code_word", input: {} });
    expect(events[2]).toMatchObject({
      type: "tool_result",
      name: "mcp__probe__get_code_word",
      ok: true,
      summary: "The code word is ZEBRA",
    });
    const outcome = parser.outcome();
    expect(outcome).toMatchObject({
      finished: true,
      text: "The code word is **ZEBRA**.",
      model: "claude-haiku-5-5",
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.usage).toEqual({
      inputTokens: 4 + 1099 + 1025,
      outputTokens: 50,
      totalTokens: 4 + 1099 + 1025 + 50,
      cachedInputTokens: 1025,
      cacheWriteTokens: 1099,
      costUsd: null,
    });
  });
  it("returns structured output without surfacing the internal StructuredOutput tool", () => {
    const parser = createClaudeParser();
    expect(parse(parser, fixture("claude-json.jsonl")).map((event) => event.type)).toEqual([
      "started",
    ]);
    expect(parser.outcome()).toMatchObject({
      finished: true,
      structured: { category: "receipts" },
    });
  });
  it("reports an unknown model as a typed error", () => {
    const parser = createClaudeParser();
    parse(parser, fixture("claude-error.jsonl"));
    expect(parser.outcome().error).toMatchObject({ code: "HOST_AGENT_MODEL" });
    expect(parser.outcome().error?.message).toContain("selected model");
  });
  it("ignores malformed and unknown lines", () => {
    const parser = createClaudeParser();
    expect(parse(parser, ["not json", "[]", '{"type":"rate_limit_event"}'])).toEqual([]);
    expect(parser.outcome().finished).toBe(false);
  });
});

describe("Codex exec --json parser (recorded fixtures)", () => {
  it("maps an MCP tool session to events with namespaced tool names", () => {
    const parser = createCodexParser();
    const events = parse(parser, fixture("codex-mcp.jsonl"));
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "text",
      "tool_call",
      "tool_result",
      "text",
    ]);
    expect(events[2]).toEqual({ type: "tool_call", name: "mcp__probe__get_code_word", input: {} });
    expect(events[3]).toMatchObject({ ok: true, summary: "The code word is ZEBRA" });
    expect(parser.outcome()).toMatchObject({
      finished: true,
      text: "The code word is **ZEBRA**.",
      sessionId: "01a15ca7-f7dd-7ae3-92fe-f6b8897c2b27",
    });
    expect(parser.outcome().usage).toEqual({
      inputTokens: 22381,
      outputTokens: 164,
      totalTokens: 22545,
      cachedInputTokens: 17408,
      cacheWriteTokens: 0,
      costUsd: null,
    });
  });
  it("returns the final JSON message", () => {
    const parser = createCodexParser();
    parse(parser, fixture("codex-json.jsonl"));
    expect(JSON.parse(parser.outcome().text)).toEqual({ category: "receipts" });
  });
  it("classifies a failed turn without echoing the raw API envelope", () => {
    const parser = createCodexParser();
    parse(parser, fixture("codex-schema-error.jsonl"));
    const { error } = parser.outcome();
    expect(error?.code).toBe("HOST_AGENT_SCHEMA");
    expect(error?.message).toMatch(/^Codex run failed: Invalid schema/);
    expect(error?.message).not.toContain('"type"');
  });
  it("treats an error followed by a completed turn as a transient reconnect", () => {
    const parser = createCodexParser();
    parse(parser, ['{"type":"error","message":"Reconnecting... 1/5"}', ...codexMessage("done")]);
    expect(parser.outcome()).toMatchObject({ text: "done", finished: true });
    expect(parser.outcome().error).toBeUndefined();
  });
  it("reports failed MCP calls", () => {
    const parser = createCodexParser();
    const events = parse(parser, [
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "probe",
          tool: "x",
          status: "failed",
          error: { message: "MCP tool call requires approval" },
        },
      }),
    ]);
    expect(events).toEqual([
      {
        type: "tool_result",
        name: "mcp__probe__x",
        ok: false,
        summary: "MCP tool call requires approval",
      },
    ]);
  });
});

describe("host CLI invocations", () => {
  it("runs Claude completions in safe mode with tools disabled and the system prompt replaced", async () => {
    const invocation = await claudeInvocation(
      spec({ systemPrompt: "SYS", model: "claude-haiku-5-5", jsonSchema: { type: "object" } }),
    );
    const { args } = invocation;
    expect(args).toEqual(
      expect.arrayContaining([
        "-p",
        "--safe-mode",
        "--strict-mcp-config",
        "--no-session-persistence",
      ]),
    );
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("SYS");
    expect(args).not.toContain("--append-system-prompt");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toEqual({ type: "object" });
    expect(args).not.toContain("--mcp-config");
    expect(invocation.input).toBe("hi");
  });
  it("writes Claude MCP config to a private file and removes it on cleanup", async () => {
    const invocation = await claudeInvocation(
      spec({
        completion: false,
        maxTurns: 6,
        mcpServers: {
          probe: { command: "node", args: ["server.mjs"], env: { TOKEN: "s3cret-value" } },
          remote: { url: "http://127.0.0.1:9/mcp", headers: { authorization: "Bearer abc" } },
        },
      }),
    );
    const { args } = invocation;
    const path = args[args.indexOf("--mcp-config") + 1]!;
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      mcpServers: {
        probe: {
          type: "stdio",
          command: "node",
          args: ["server.mjs"],
          env: { TOKEN: "s3cret-value" },
        },
        remote: {
          type: "http",
          url: "http://127.0.0.1:9/mcp",
          headers: { authorization: "Bearer abc" },
        },
      },
    });
    expect(args.join(" ")).not.toContain("s3cret-value");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__probe,mcp__remote");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("6");
    expect(args).not.toContain("--safe-mode");
    await invocation.cleanup();
    await expect(stat(path)).rejects.toThrow();
  });
  it("passes explicit Claude allowed tools and enables only named built-ins", async () => {
    const { args } = await claudeInvocation(
      spec({
        completion: false,
        mcpServers: { probe: { command: "node" } },
        allowedTools: ["mcp__probe__get_code_word", "WebFetch"],
      }),
    );
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__probe__get_code_word,WebFetch");
    expect(args[args.indexOf("--tools") + 1]).toBe("WebFetch");
  });
  it("rejects MCP server names that cannot be tool prefixes", async () => {
    await expect(
      claudeInvocation(spec({ completion: false, mcpServers: { "bad name": { command: "x" } } })),
    ).rejects.toMatchObject({ code: "HOST_AGENT_CONFIG" });
    await expect(
      codexInvocation(
        spec({ kind: "codex", completion: false, mcpServers: { "a.b": { command: "x" } } }),
      ),
    ).rejects.toMatchObject({ code: "HOST_AGENT_CONFIG" });
  });
  it("runs Codex completions read-only, outside git, without user config, shell or web search", async () => {
    const invocation = await codexInvocation(
      spec({
        kind: "codex",
        systemPrompt: 'Say "hi"\nnow',
        model: "gpt-5.6-luna",
        reasoning: "low",
      }),
    );
    const { args } = invocation;
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toEqual(
      expect.arrayContaining([
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "-s",
        "read-only",
        "features.shell_tool=false",
        "features.unified_exec=false",
        'web_search="disabled"',
        'model_reasoning_effort="low"',
      ]),
    );
    expect(args).toContain(`developer_instructions=${JSON.stringify('Say "hi"\nnow')}`);
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.6-luna");
    expect(args.at(-1)).toBe("-");
    expect(args.some((arg) => arg.startsWith("mcp_servers"))).toBe(false);
  });
  it("enforces only strict-compatible schemas through --output-schema", async () => {
    const strict = {
      type: "object" as const,
      properties: { a: { type: "string" as const } },
      required: ["a"],
      additionalProperties: false,
    };
    const loose = {
      type: "object" as const,
      properties: { a: { type: "string" as const }, b: { type: "string" as const } },
      required: ["a"],
    };
    expect(strictCompatible(strict)).toBe(true);
    expect(strictCompatible(loose)).toBe(false);
    expect(strictCompatible({ type: "array", items: loose })).toBe(false);
    const enforced = await codexInvocation(spec({ kind: "codex", jsonSchema: strict }));
    const path = enforced.args[enforced.args.indexOf("--output-schema") + 1]!;
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(strict);
    expect(enforced.schemaEnforced).toBe(true);
    await enforced.cleanup();
    await expect(stat(path)).rejects.toThrow();
    const described = await codexInvocation(spec({ kind: "codex", jsonSchema: loose }));
    expect(described.args).not.toContain("--output-schema");
    expect(described.schemaEnforced).toBe(false);
  });
  it("wires Codex MCP servers with secrets in the child environment, not argv", async () => {
    const invocation = await codexInvocation(
      spec({
        kind: "codex",
        completion: false,
        mcpServers: {
          probe: {
            command: "node",
            args: ["server.mjs"],
            env: { PROBE_WORD: "s3cret-word", PATH: "/custom/bin" },
          },
          remote: {
            url: "http://127.0.0.1:9/mcp",
            headers: { Authorization: "Bearer s3cret-token" },
          },
        },
        allowedTools: ["mcp__probe__get_code_word", "mcp__remote"],
      }),
    );
    const argv = invocation.args.join("\n");
    expect(argv).not.toContain("s3cret");
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        'mcp_servers.probe.command="node"',
        'mcp_servers.probe.args=["server.mjs"]',
        'mcp_servers.probe.env_vars=["PROBE_WORD"]',
        'mcp_servers.probe.env={ "PATH" = "/custom/bin" }',
        'mcp_servers.probe.default_tools_approval_mode="approve"',
        'mcp_servers.probe.enabled_tools=["get_code_word"]',
        'mcp_servers.remote.url="http://127.0.0.1:9/mcp"',
        'mcp_servers.remote.env_http_headers={ "Authorization" = "PASSPORT_HOST_MCP_0" }',
        "features.shell_tool=false",
      ]),
    );
    expect(argv).not.toContain("mcp_servers.remote.enabled_tools");
    expect(invocation.env).toEqual({
      PROBE_WORD: "s3cret-word",
      PASSPORT_HOST_MCP_0: "Bearer s3cret-token",
    });
  });
  it("raises MCP startup and tool timeouts per CLI", async () => {
    const mcpServers = {
      slow: { command: "npx", timeouts: { startupSec: 120 } },
      human: { url: "http://127.0.0.1:9/mcp", timeouts: { toolSec: 900.5 } },
    };
    const codex = await codexInvocation(spec({ kind: "codex", completion: false, mcpServers }));
    expect(codex.args).toEqual(
      expect.arrayContaining([
        "mcp_servers.slow.startup_timeout_sec=120.0",
        "mcp_servers.human.tool_timeout_sec=900.5",
      ]),
    );
    expect(codex.args.join("\n")).not.toContain("slow.tool_timeout_sec");
    await expect(
      codexInvocation(
        spec({
          kind: "codex",
          completion: false,
          mcpServers: { bad: { command: "x", timeouts: { toolSec: -1 } } },
        }),
      ),
    ).rejects.toMatchObject({ code: "HOST_AGENT_CONFIG" });
    const claude = await claudeInvocation(spec({ completion: false, mcpServers }));
    expect(claude.env).toEqual({ MCP_TIMEOUT: "120000", MCP_TOOL_TIMEOUT: "900500" });
    await claude.cleanup();
    expect(
      (
        await claudeInvocation(
          spec({ completion: false, mcpServers: { probe: { command: "node" } } }),
        )
      ).env,
    ).toEqual({});
  });
  it("enables the Codex shell only when Bash is explicitly allowed", async () => {
    const { args } = await codexInvocation(
      spec({ kind: "codex", completion: false, allowedTools: ["Bash"] }),
    );
    expect(args).not.toContain("features.shell_tool=false");
  });
});

describe("host agent environment and redaction", () => {
  it("forwards login-relevant variables only", () => {
    const env = hostAgentEnv(
      {
        HOME: "/home/u",
        PATH: "/usr/bin",
        PASSPORT_MASTER_KEY: "k",
        PASSPORT_LLM_API_KEY: "k",
        ANTHROPIC_API_KEY: "k",
        OPENAI_API_KEY: "k",
        CODEX_HOME: "/c",
        AWS_SECRET_ACCESS_KEY: "k",
      },
      "/opt/tools/claude",
    );
    expect(env).toMatchObject({ HOME: "/home/u", CODEX_HOME: "/c" });
    expect(
      Object.keys(env).some(
        (key) => key.startsWith("PASSPORT_") || key.endsWith("_API_KEY") || key.startsWith("AWS_"),
      ),
    ).toBe(false);
    expect(env.PATH!.split(":")).toEqual(
      expect.arrayContaining([
        "/usr/bin",
        "/opt/tools",
        "/home/u/.local/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ]),
    );
  });
  it("redacts token-shaped strings but keeps ordinary paths", () => {
    const text = redact(
      "failed with sk-ant-api03-abcdefghijklmnop and Bearer abcdef1234567890 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U at /Users/me/my-project/apps/web-ui/src",
    );
    expect(text).not.toMatch(/sk-ant|abcdef1234567890|eyJ/);
    expect(text).toContain("/Users/me/my-project/apps/web-ui/src");
    expect(redact("x".repeat(10) + " ".repeat(3) + "y", 5)).toBe("xxxxx…");
  });
});

describe("HostAgentLlmClient", () => {
  it("returns validated JSON, maps fast to the cheaper model, and withholds Passport secrets", async () => {
    const dir = await temp();
    const fake = await fakeBinary(dir, "claude", { run: { lines: fixture("claude-json.jsonl") } });
    const client = new HostAgentLlmClient({
      kind: "claude-code",
      binaryPath: fake.path,
      cwd: join(dir, "scratch"),
      env: {
        HOME: dir,
        PATH: "/usr/bin:/bin",
        PASSPORT_MASTER_KEY: "master-secret",
        ANTHROPIC_API_KEY: "sk-ant-should-not-pass",
      },
    });
    const result = await client.complete({
      system: "Classify.",
      messages: [{ role: "user", content: "Receipt" }],
      json: {
        type: "object",
        properties: { category: { type: "string", enum: ["receipts", "social"] } },
        required: ["category"],
        additionalProperties: false,
      },
      model: "fast",
    });
    expect(result.json).toEqual({ category: "receipts" });
    expect(result.usage.costUsd).toBeNull();
    expect(result.model).toBe("claude-haiku-5-5");
    const [call] = await fake.log();
    expect(call!.args[call!.args.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
    expect(call!.stdin).toBe("Receipt");
    expect(JSON.stringify(call!.env)).not.toMatch(/master-secret|sk-ant-should-not-pass/);
  });
  it("uses configured models and Codex reasoning defaults", async () => {
    const dir = await temp();
    const fake = await fakeBinary(dir, "codex", { run: { lines: codexMessage('{"ok":true}') } });
    const client = new HostAgentLlmClient({
      kind: "codex",
      model: "gpt-6-sol",
      binaryPath: fake.path,
      cwd: join(dir, "scratch"),
      env: { HOME: dir, PATH: "/usr/bin:/bin" },
    });
    const result = await client.complete({
      system: "S",
      messages: [{ role: "user", content: "U" }],
      json: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    });
    expect(result).toMatchObject({
      json: { ok: true },
      model: "gpt-6-sol",
      usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 7, costUsd: null },
    });
    const [call] = await fake.log();
    expect(call!.args).toEqual(
      expect.arrayContaining(["-m", "gpt-6-sol", 'model_reasoning_effort="medium"']),
    );
  });
  it("emulates interactive tools as structured output and validates arguments", async () => {
    const dir = await temp();
    const tools = [
      {
        name: "archive",
        description: "Archive an email",
        inputSchema: {
          type: "object" as const,
          properties: { emailId: { type: "string" as const } },
          required: ["emailId"],
          additionalProperties: false,
        },
      },
    ];
    const reply = JSON.stringify({
      text: "Archiving.",
      toolCalls: [{ name: "archive", argumentsJson: '{"emailId":"e1"}' }],
    });
    const fake = await fakeBinary(dir, "codex", { run: { lines: codexMessage(reply) } });
    const client = new HostAgentLlmClient({
      kind: "codex",
      binaryPath: fake.path,
      cwd: join(dir, "scratch"),
      env: { HOME: dir, PATH: "/usr/bin:/bin" },
    });
    const result = await client.complete({
      system: "S",
      tools,
      messages: [
        { role: "user", content: "Archive e0 and e1" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c0", name: "archive", arguments: { emailId: "e0" } }],
        },
        { role: "tool", toolCallId: "c0", content: '{"ok":true}' },
      ],
    });
    expect(result.text).toBe("Archiving.");
    expect(result.toolCalls).toEqual([
      { id: expect.stringMatching(/^call_/), name: "archive", arguments: { emailId: "e1" } },
    ]);
    const [call] = await fake.log();
    expect(call!.stdin).toContain('<tool_call id="c0" name="archive">{"emailId":"e0"}</tool_call>');
    expect(call!.stdin).toContain('<tool_result id="c0">');
    expect(call!.args.find((arg) => arg.startsWith("developer_instructions="))).toContain(
      "archive",
    );
    // Arguments that violate the tool's schema are rejected before Passport runs anything.
    await writeFile(
      `${fake.path}.json`,
      JSON.stringify({
        run: {
          lines: codexMessage(
            JSON.stringify({ text: "", toolCalls: [{ name: "archive", argumentsJson: "{}" }] }),
          ),
        },
      }),
    );
    await expect(
      client.complete({ system: "S", tools, messages: [{ role: "user", content: "go" }] }),
    ).rejects.toMatchObject({ code: "LLM_SCHEMA" });
  });
  it("rejects JSON and tools in one request", async () => {
    const client = new HostAgentLlmClient({ kind: "codex" });
    await expect(
      client.complete({
        system: "",
        messages: [],
        json: { type: "object" },
        tools: [{ name: "t", description: "", inputSchema: {} }],
      }),
    ).rejects.toMatchObject({ code: "LLM_CONFIG" });
  });
  it("never surfaces stderr in errors and classifies login failures", async () => {
    const dir = await temp();
    const fake = await fakeBinary(dir, "codex", {
      run: { stderr: "fatal: token sk-live-0123456789abcdef leaked\n", exit: 2 },
    });
    const client = new HostAgentLlmClient({
      kind: "codex",
      binaryPath: fake.path,
      cwd: join(dir, "scratch"),
      env: { HOME: dir, PATH: "/usr/bin:/bin" },
    });
    const error = await client
      .complete({ system: "", messages: [{ role: "user", content: "x" }] })
      .then(
        () => {
          throw new Error("expected failure");
        },
        (e: Error & { code: string }) => e,
      );
    expect(error).toMatchObject({ code: "HOST_AGENT_FAILED" });
    expect(String(error.message)).not.toContain("sk-live");
    expect(String(error.message)).not.toContain("fatal");
    await writeFile(
      `${fake.path}.json`,
      JSON.stringify({ run: { stderr: "Error: Not logged in. token=abc123secret", exit: 1 } }),
    );
    const auth = await client
      .complete({ system: "", messages: [{ role: "user", content: "x" }] })
      .then(
        () => {
          throw new Error("expected failure");
        },
        (e: Error & { code: string }) => e,
      );
    expect(auth).toMatchObject({ code: "HOST_AGENT_AUTH" });
    expect(auth.message).toContain("codex login");
    expect(auth.message).not.toContain("abc123secret");
  });
  it("times out and kills the CLI", async () => {
    const dir = await temp();
    const fake = await fakeBinary(dir, "claude", { run: { sleepMs: 30_000 } });
    const client = new HostAgentLlmClient({
      kind: "claude-code",
      binaryPath: fake.path,
      cwd: join(dir, "scratch"),
      timeoutMs: 400,
      env: { HOME: dir, PATH: "/usr/bin:/bin" },
    });
    await expect(
      client.complete({ system: "", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ code: "HOST_AGENT_TIMEOUT" });
    const [call] = await fake.log();
    expect(() => process.kill(call!.pid, 0)).toThrow();
  });
  it("reports a missing CLI with an install hint", async () => {
    const dir = await temp();
    const client = new HostAgentLlmClient({
      kind: "claude-code",
      cwd: join(dir, "scratch"),
      env: { HOME: dir, PATH: dir, PASSPORT_CLAUDE_PATH: join(dir, "missing") },
    });
    await expect(
      client.complete({ system: "", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({
      code: "HOST_AGENT_NOT_INSTALLED",
      message: expect.stringContaining("Install Claude Code"),
    });
  });
  it("is selected by createLlmClient for host-agent providers without an API key", () => {
    expect(createLlmClient({ provider: "codex", model: "gpt-6.1-sol" })).toBeInstanceOf(
      HostAgentLlmClient,
    );
    expect(
      createLlmClient({ provider: "claude-code", model: "sonnet" }, { hostAgentCwd: "/tmp/x" }),
    ).toBeInstanceOf(HostAgentLlmClient);
  });
});

describe("runHostAgentSession", () => {
  it("streams parsed events and resolves with the final message", async () => {
    const dir = await temp();
    const fake = await fakeBinary(dir, "claude", { run: { lines: fixture("claude-mcp.jsonl") } });
    const events: HostAgentEvent[] = [];
    const session = runHostAgentSession(
      {
        kind: "claude-code",
        prompt: "Get the code word",
        cwd: join(dir, "work"),
        mcpServers: { probe: { command: "node", args: ["x.mjs"] } },
      },
      (event) => events.push(event),
      { binaryPath: fake.path, env: { HOME: dir, PATH: "/usr/bin:/bin" } },
    );
    const result = await session.done;
    expect(result).toMatchObject({
      kind: "claude-code",
      ok: true,
      text: "The code word is **ZEBRA**.",
      sessionId: "41e79ef5-6092-45ed-b88e-f93afde2e516",
    });
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "tool_call",
      "tool_result",
      "text",
      "completed",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      text: "The code word is **ZEBRA**.",
      usage: { costUsd: null },
    });
  });
  it("cancels a running session and kills the child", async () => {
    const dir = await temp();
    const fake = await fakeBinary(dir, "codex", { run: { sleepMs: 30_000 } });
    const events: HostAgentEvent[] = [];
    const session = runHostAgentSession(
      { kind: "codex", prompt: "wait", cwd: join(dir, "work") },
      (event) => events.push(event),
      { binaryPath: fake.path, env: { HOME: dir, PATH: "/usr/bin:/bin" } },
    );
    for (let i = 0; i < 100 && !(await fake.log()).length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    session.cancel();
    const result = await session.done;
    expect(result).toMatchObject({ ok: false, error: { code: "HOST_AGENT_CANCELLED" } });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "HOST_AGENT_CANCELLED" });
    const [call] = await fake.log();
    expect(() => process.kill(call!.pid, 0)).toThrow();
  });
  it("honours an AbortSignal that is already aborted", async () => {
    const dir = await temp();
    const fake = await fakeBinary(dir, "codex", { run: { lines: codexMessage("never") } });
    const result = await runHostAgentSession(
      { kind: "codex", prompt: "x", cwd: join(dir, "work"), signal: AbortSignal.abort() },
      undefined,
      { binaryPath: fake.path },
    ).done;
    expect(result.error?.code).toBe("HOST_AGENT_CANCELLED");
    expect(await fake.log()).toEqual([]);
  });
  it("surfaces a typed configuration error", async () => {
    const dir = await temp();
    const result = await runHostAgentSession(
      {
        kind: "codex",
        prompt: "x",
        cwd: join(dir, "work"),
        mcpServers: { "bad name": { command: "x" } },
      },
      undefined,
      { binaryPath: "/bin/echo" },
    ).done;
    expect(result.error?.code).toBe("HOST_AGENT_CONFIG");
  });
});

describe("detectHostAgents", () => {
  it("reports version, login and account for installed CLIs", async () => {
    const dir = await temp();
    await fakeBinary(dir, "claude", {
      version: "2.1.304 (Claude Code)",
      auth: {
        code: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          subscriptionType: "max",
          email: "me@example.com",
        }),
      },
    });
    await fakeBinary(dir, "codex", {
      version: "codex-cli 0.163.0",
      auth: { code: 0, stderr: "Logged in using ChatGPT\n" },
    });
    const statuses = await detectHostAgents({ env: { HOME: dir, PATH: dir } });
    expect(statuses.map((status) => status.kind)).toEqual(["codex", "claude-code"]);
    expect(statuses[0]).toMatchObject({
      installed: true,
      version: "0.163.0",
      loggedIn: true,
      ready: true,
      account: "ChatGPT",
      binaryPath: expect.stringContaining("codex"),
    });
    expect(statuses[1]).toMatchObject({
      installed: true,
      version: "2.1.304",
      loggedIn: true,
      ready: true,
      account: "claude.ai (max)",
    });
    expect(JSON.stringify(statuses)).not.toContain("me@example.com");
    expect(preferredHostAgent(statuses)?.kind).toBe("codex");
  });
  it("gives actionable fixes when a CLI is missing or signed out", async () => {
    const dir = await temp();
    await fakeBinary(dir, "codex", { auth: { code: 1, stderr: "Not logged in\n" } });
    const statuses = await detectHostAgents({
      env: { HOME: dir, PATH: dir, PASSPORT_CLAUDE_PATH: join(dir, "missing") },
    });
    expect(statuses[0]).toMatchObject({
      kind: "codex",
      installed: true,
      loggedIn: false,
      ready: false,
      fix: expect.stringContaining("codex login"),
    });
    expect(statuses[1]).toMatchObject({
      kind: "claude-code",
      installed: false,
      binaryPath: null,
      ready: false,
      fix: expect.stringContaining("Install Claude Code"),
    });
    expect(preferredHostAgent(statuses)).toBeUndefined();
  });
  it("never reports a masked API key as the Codex account", async () => {
    const dir = await temp();
    await fakeBinary(dir, "codex", {
      auth: { code: 0, stderr: "Logged in using an API key - sk-proj-***ABCDE\n" },
    });
    const [codex] = await detectHostAgents({
      env: { HOME: dir, PATH: dir, PASSPORT_CLAUDE_PATH: join(dir, "missing") },
    });
    expect(codex).toMatchObject({ loggedIn: true, account: "API key" });
  });
  it("treats unparseable auth output as signed out", async () => {
    const dir = await temp();
    await fakeBinary(dir, "claude", { auth: { code: 0, stdout: "something odd" } });
    const [, claude] = await detectHostAgents({ env: { HOME: dir, PATH: dir } });
    expect(claude).toMatchObject({
      installed: true,
      loggedIn: false,
      fix: expect.stringContaining("claude auth login"),
    });
  });
});
