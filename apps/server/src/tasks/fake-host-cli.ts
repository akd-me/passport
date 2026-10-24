/**
 * Test helper: a fake `claude` / `codex` executable that replays a scripted session in the CLI's
 * own stream-json format. Tool steps are real MCP calls to the server the runtime attached (read
 * from `--mcp-config` or the Codex `-c mcp_servers.*` flags), so results come from Passport's
 * tool belt. The child environment is allowlisted, so the script reads its plan from a file.
 */
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostAgentKind } from "@passport/types";

export type FakeStep =
  | { tool: string; args?: Record<string, unknown> }
  | { text: string }
  | { sleepMs: number };

export interface FakeInvocation {
  sessionId?: string;
  steps?: FakeStep[];
  /** Fail like the real CLI when asked to resume a session it does not have. */
  resumeMissing?: boolean;
}

export interface FakeCall {
  args: string[];
  stdin: string;
  pid: number;
  /** Tool results the fake received, in order. */
  results?: string[];
}

const SCRIPT = String.raw`
const fs = require("node:fs");
const [planPath, logPath] = [process.env.FAKE_PLAN || __PLAN__, __LOG__];
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const args = process.argv.slice(2);
const kind = plan.kind;
const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => { main().catch((error) => { process.stderr.write(String(error)); process.exit(3); }); });

function target() {
  if (kind === "claude-code") {
    const config = JSON.parse(fs.readFileSync(after("--mcp-config"), "utf8"));
    return config.mcpServers.passport;
  }
  const values = args.filter((_, i) => args[i - 1] === "-c");
  const url = JSON.parse(values.find((v) => v.startsWith("mcp_servers.passport.url=")).split("=").slice(1).join("="));
  const table = values.find((v) => v.startsWith("mcp_servers.passport.env_http_headers=")) || "";
  const headers = {};
  for (const match of table.matchAll(/"([^"]+)" = "([^"]+)"/g)) headers[match[1]] = process.env[match[2]];
  return { url, headers };
}

async function rpc(server, id, method, params) {
  const response = await fetch(server.url, {
    method: "POST",
    headers: { ...server.headers, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error("MCP HTTP " + response.status);
  const messages = (response.headers.get("content-type") || "").includes("text/event-stream")
    ? body.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
    : [JSON.parse(body)];
  return messages.find((message) => message.id === id);
}

async function main() {
  // Title completions run concurrently with sessions. They must not consume the session plan
  // or race a session's append-only log (W1A fixtures previously flaked here).
  if (args.join(" ").includes("You name tasks")) {
    const title = JSON.stringify({ title: "Fixture task" });
    if (kind === "claude-code") out({ type: "result", subtype: "success", is_error: false, result: title, structured_output: { title: "Fixture task" }, session_id: "title-fixture" });
    else { out({ type: "item.completed", item: { id: "title", type: "agent_message", text: title } }); out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }); }
    process.exit(0);
  }
  const prior = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).length : 0;
  const entry = { args, stdin, pid: process.pid, results: [] };
  const invocation = plan.invocations[Math.min(prior, plan.invocations.length - 1)];
  const resume = kind === "claude-code" ? after("--resume") : args[1] === "resume" ? args[2] : undefined;
  const log = () => fs.writeFileSync(logPath, (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).slice(0, prior).join("\n") + (prior ? "\n" : "") : "") + JSON.stringify(entry) + "\n");
  log();
  if (resume && invocation.resumeMissing) {
    if (kind === "claude-code") {
      out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: resume, errors: ["No conversation found with session ID: " + resume] });
    } else {
      process.stderr.write("Error: thread/resume: thread/resume failed: no rollout found for thread id " + resume + " (code -32600)\n");
    }
    process.exit(1);
  }
  const session = resume || invocation.sessionId || "session-" + prior;
  if (kind === "claude-code") out({ type: "system", subtype: "init", session_id: session, model: "claude-sonnet-5-5", tools: [] });
  else { out({ type: "thread.started", thread_id: session }); out({ type: "turn.started" }); }
  const server = target();
  await rpc(server, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } });
  let id = 2, last = "";
  for (const step of invocation.steps || []) {
    if (step.sleepMs) { await sleep(step.sleepMs); continue; }
    if (step.text) {
      last = step.text;
      if (kind === "claude-code") out({ type: "assistant", message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: step.text }] }, session_id: session });
      else out({ type: "item.completed", item: { id: "item_" + id++, type: "agent_message", text: step.text } });
      continue;
    }
    const callId = "toolu_" + id;
    if (kind === "claude-code") out({ type: "assistant", message: { content: [{ type: "tool_use", id: callId, name: "mcp__passport__" + step.tool, input: step.args || {} }] }, session_id: session });
    else out({ type: "item.started", item: { id: callId, type: "mcp_tool_call", server: "passport", tool: step.tool, arguments: step.args || {}, status: "in_progress" } });
    const reply = await rpc(server, id++, "tools/call", { name: step.tool, arguments: step.args || {} });
    const result = reply.result || { content: [{ type: "text", text: JSON.stringify(reply.error) }], isError: true };
    const text = (result.content || []).map((block) => block.text || "").join("\n");
    entry.results.push(text);
    log();
    if (kind === "claude-code") out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: callId, content: [{ type: "text", text }], is_error: !!result.isError }] }, session_id: session });
    else out({ type: "item.completed", item: { id: callId, type: "mcp_tool_call", server: "passport", tool: step.tool, arguments: step.args || {}, result: { content: [{ type: "text", text }] }, error: null, status: "completed" } });
  }
  if (kind === "claude-code") out({ type: "result", subtype: "success", is_error: false, result: last, session_id: session, usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  else out({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 30 } });
  process.exit(0);
}
`;

/** Writes the fake CLI into `dir`; `calls()` reads what each invocation saw. */
export async function fakeHostCli(
  dir: string,
  kind: HostAgentKind,
  invocations: FakeInvocation[],
): Promise<{
  path: string;
  calls(): Promise<FakeCall[]>;
  plan(next: FakeInvocation[]): Promise<void>;
}> {
  const path = join(dir, kind === "claude-code" ? "claude" : "codex");
  const planPath = `${path}.plan.json`;
  const logPath = `${path}.log`;
  const plan = (next: FakeInvocation[]) =>
    writeFile(planPath, JSON.stringify({ kind, invocations: next }));
  await plan(invocations);
  await writeFile(
    path,
    `#!${process.execPath}\n${SCRIPT.replace("__PLAN__", JSON.stringify(planPath)).replace("__LOG__", JSON.stringify(logPath))}`,
  );
  await chmod(path, 0o755);
  return {
    path,
    plan,
    calls: async () =>
      (await readFile(logPath, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeCall),
  };
}
