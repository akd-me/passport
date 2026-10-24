/**
 * Review R1 hardening of the host CLIs: Codex native tools (R1-7), failure classification
 * (R1-6, R1-33) and transcript persistence (R1-5).
 */
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { claudeInvocation } from "./claude.js";
import { HostAgentLlmClient } from "./client.js";
import { CODEX_RESIDUAL_TOOLS, codexInvocation, codexToolCatalog } from "./codex.js";
import { detectHostAgents } from "./detect.js";
import { hostAgentEnv } from "./env.js";
import { runHostAgent } from "./session.js";
import type { HostRunSpec } from "./types.js";

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "passport-hardening-"));
  dirs.push(dir);
  return dir;
}

const session = (overrides: Partial<HostRunSpec> = {}): HostRunSpec => ({
  kind: "codex",
  prompt: "hi",
  cwd: tmpdir(),
  completion: false,
  systemPrompt: "SYS",
  mcpServers: { passport: { url: "http://127.0.0.1:1/mcp" } },
  allowedTools: ["mcp__passport"],
  ...overrides,
});

const CATALOG = {
  models: [
    {
      slug: "gpt-6.1-sol",
      tool_mode: "code_mode_only",
      multi_agent_version: "v2",
      apply_patch_tool_type: "freeform",
      experimental_supported_tools: ["clock"],
      base_instructions: "keep me",
    },
  ],
};

/** A fake `codex` that prints a catalog for `debug models` and records every other call. */
async function fakeCodex(dir: string, catalog: unknown, stderr = "", exit = 0) {
  const path = join(dir, "codex"),
    log = join(dir, "codex.log");
  await writeFile(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "debug" && args[1] === "models") {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args }) + "\\n");
  process.stdout.write(${JSON.stringify(JSON.stringify(catalog))});
  process.exit(0);
}
let stdin = "";
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  const at = args.indexOf("-c");
  const catalogArg = args.find((arg) => arg.startsWith("model_catalog_json="));
  const file = catalogArg ? JSON.parse(catalogArg.slice("model_catalog_json=".length)) : null;
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, catalog: file ? JSON.parse(fs.readFileSync(file, "utf8")) : null }) + "\\n");
  if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});
  if (${exit} !== 0) process.exit(${exit});
  process.stdout.write('{"type":"thread.started","thread_id":"t-1"}\\n{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"ok"}}\\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\\n');
  process.exit(0);
});
`,
  );
  await chmod(path, 0o755);
  return {
    path,
    calls: async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args: string[]; catalog?: typeof CATALOG }),
  };
}

describe("Codex native tools (R1-7)", () => {
  it("turns off every native-tool feature and request_user_input for sessions", async () => {
    const { args } = await codexInvocation(session());
    for (const feature of [
      "view_image",
      "sleep_tool",
      "code_mode_host",
      "multi_agent",
      "multi_agent_v2",
      "browser_use",
      "in_app_browser",
      "goals",
      "skill_search",
      "tool_suggest",
      "shell_tool",
      "unified_exec",
    ]) {
      expect(args).toContain(`features.${feature}=false`);
    }
    expect(args).toContain("tools.experimental_request_user_input={ enabled = false }");
  });

  it("rewrites the model catalog so models call tools directly, with no exec, patch or sub-agents", () => {
    const patched = JSON.parse(codexToolCatalog(JSON.stringify(CATALOG))!);
    expect(patched.models[0]).toEqual({
      slug: "gpt-6.1-sol",
      tool_mode: "direct_model_only",
      multi_agent_version: null,
      apply_patch_tool_type: null,
      experimental_supported_tools: [],
      base_instructions: "keep me",
    });
    expect(codexToolCatalog("not json")).toBeUndefined();
    expect(codexToolCatalog('{"models":[]}')).toBeUndefined();
  });

  it("loads the rewritten catalog from a private file when restricted", async () => {
    const dir = await temp();
    const codex = await fakeCodex(dir, CATALOG);
    const options = { binaryPath: codex.path, timeoutMs: 20_000, restrictCodexTools: true };
    for (const completion of [false, true]) {
      const result = await runHostAgent(
        session({ completion, cwd: join(dir, "work"), mcpServers: completion ? {} : undefined }),
        options,
      ).done;
      expect(result.error).toBeUndefined();
    }
    const calls = await codex.calls();
    // The catalog is fetched once per binary.
    expect(calls.filter((call) => call.args[0] === "debug")).toHaveLength(1);
    const runs = calls.filter((call) => call.args[0] === "exec");
    expect(runs).toHaveLength(2);
    for (const call of runs) {
      expect(call.catalog?.models[0]).toMatchObject({
        tool_mode: "direct_model_only",
        multi_agent_version: null,
      });
    }
  });

  it("leaves the catalog alone unless asked (scripted test CLIs)", async () => {
    const dir = await temp();
    const codex = await fakeCodex(dir, CATALOG);
    await runHostAgent(session({ cwd: join(dir, "work") }), {
      binaryPath: codex.path,
      timeoutMs: 20_000,
    }).done;
    const calls = await codex.calls();
    expect(calls.map((call) => call.args[0])).toEqual(["exec"]);
    expect(calls[0]!.args.some((arg) => arg.startsWith("model_catalog_json="))).toBe(false);
  });
});

describe("host failure classification (R1-6, R1-33)", () => {
  it("reports Codex's missing rollout as HOST_AGENT_SESSION_MISSING", async () => {
    const dir = await temp();
    const codex = await fakeCodex(
      dir,
      CATALOG,
      "Error: thread/resume failed: no rollout found for thread id abc\n",
      1,
    );
    const result = await runHostAgent(session({ cwd: join(dir, "work"), resumeSessionId: "abc" }), {
      binaryPath: codex.path,
      timeoutMs: 20_000,
    }).done;
    expect(result.error?.code).toBe("HOST_AGENT_SESSION_MISSING");
  });

  it("classifies a limit reported only on stderr and forwards just its reset time", async () => {
    const dir = await temp();
    const codex = await fakeCodex(
      dir,
      CATALOG,
      "token=sk-secret You've hit your usage limit. Try again in 3 hours 20 minutes.\n",
      1,
    );
    const result = await runHostAgent(session({ cwd: join(dir, "work") }), {
      binaryPath: codex.path,
      timeoutMs: 20_000,
    }).done;
    expect(result.error).toEqual({
      code: "HOST_AGENT_RATE_LIMIT",
      message: "Codex usage limit reached (try again in 3 hours 20 minutes)",
    });
  });
});

describe("transcript persistence (R1-5)", () => {
  it("runs sessions without a transcript unless they may be resumed", async () => {
    const ephemeral = await claudeInvocation({ ...session(), kind: "claude-code" });
    expect(ephemeral.args).toContain("--no-session-persistence");
    await ephemeral.cleanup();
    const kept = await claudeInvocation({
      ...session(),
      kind: "claude-code",
      persistSession: true,
    });
    expect(kept.args).not.toContain("--no-session-persistence");
    await kept.cleanup();
    expect((await codexInvocation(session())).args).toContain("--ephemeral");
    expect((await codexInvocation(session({ persistSession: true }))).args).not.toContain(
      "--ephemeral",
    );
  });

  it("asks the CLI to persist only when the session input says so", async () => {
    const dir = await temp();
    const codex = await fakeCodex(dir, CATALOG);
    const client = new HostAgentLlmClient({
      kind: "codex",
      binaryPath: codex.path,
      cwd: join(dir, "work"),
    });
    const input = {
      prompt: "hi",
      systemPrompt: "SYS",
      mcpServers: { passport: { url: "http://127.0.0.1:1/mcp" } },
      timeoutMs: 20_000,
    };
    await client.session(input, () => {}).done;
    await client.session({ ...input, persist: true }, () => {}).done;
    const calls = (await codex.calls()).filter((call) => call.args[0] === "exec");
    expect(calls.map((call) => call.args.includes("--ephemeral"))).toEqual([true, false]);
  });
});

// Live: the installed Codex's own prompt assembly, so an upgrade cannot widen the tool surface.
const codexBinary = process.env.PASSPORT_SKIP_LIVE_HOST_AGENTS
  ? null
  : ((await detectHostAgents()).find((status) => status.kind === "codex" && status.installed)
      ?.binaryPath ?? null);
const codexReady = !!codexBinary;

describe.skipIf(!codexReady)("Codex tool surface (live CLI)", () => {
  it("offers nothing but Passport's MCP tools and the MCP resource readers", async () => {
    const dir = await temp();
    const work = join(dir, "work");
    const binary = codexBinary!;
    const env = hostAgentEnv(process.env, binary);
    const models = await run(binary, ["debug", "models"], {
      env,
      cwd: tmpdir(),
      maxBuffer: 64 * 1024 * 1024,
    });
    const catalog = codexToolCatalog(models.stdout);
    expect(catalog).toBeTruthy();
    const invocation = await codexInvocation(
      session({ cwd: work, model: "gpt-6.1-sol", modelCatalog: catalog }),
    );
    try {
      // `debug prompt-input` takes only `-c` overrides: translate the exec flags.
      const pairs: string[] = ["-c", 'sandbox_mode="read-only"', "-c", 'model="gpt-6.1-sol"'];
      invocation.args.forEach((arg, index) => {
        if (invocation.args[index - 1] === "-c" && !arg.startsWith("mcp_servers.")) {
          pairs.push("-c", arg);
        }
      });
      const home = await mkdtemp(join(tmpdir(), "passport-codex-home-"));
      dirs.push(home);
      const output = await run(binary, ["debug", "prompt-input", ...pairs, "hi"], {
        env: { ...env, CODEX_HOME: home },
        cwd: tmpdir(),
        maxBuffer: 64 * 1024 * 1024,
      });
      const items = JSON.parse(output.stdout) as Array<{ type?: string; tools?: unknown[] }>;
      const names: string[] = [];
      const walk = (tool: unknown, prefix = "") => {
        const value = tool as { type?: string; name?: string; tools?: unknown[] };
        if (value.type === "namespace") {
          for (const child of value.tools ?? []) {
            walk(child, `${value.name}/`);
          }
        } else if (value.name) {
          names.push(prefix + value.name);
        }
      };
      for (const item of items) {
        if (item.type === "additional_tools") {
          for (const tool of item.tools ?? []) {
            walk(tool);
          }
        }
      }
      const allowed = new Set(CODEX_RESIDUAL_TOOLS);
      const extra = names
        .map((name) => name.split("/").at(-1)!)
        .filter((name) => !name.startsWith("mcp__passport__") && !allowed.has(name));
      expect(extra).toEqual([]);
      expect(output.stdout).not.toMatch(/declare const tools/);
    } finally {
      await invocation.cleanup();
    }
  }, 60_000);
});
