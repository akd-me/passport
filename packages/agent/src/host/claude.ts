import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostAgentEvent, HostAgentMcpServer } from "@passport/types";
import { LlmError } from "../errors.js";
import { redact } from "./env.js";
import {
  count,
  emptyUsage,
  type HostInvocation,
  type HostRunOutcome,
  type HostRunSpec,
  type HostStreamParser,
  record,
  SERVER_NAME,
} from "./types.js";

/**
 * `claude -p --output-format stream-json --verbose`. Completions run in safe mode with every
 * tool disabled and the system prompt replaced. Sessions load only the supplied MCP servers
 * (`--strict-mcp-config`) and ignore user/project settings; anything not allowed is denied
 * rather than prompted.
 */
export async function claudeInvocation(spec: HostRunSpec): Promise<HostInvocation> {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--permission-prompts",
    "none",
    "--strict-mcp-config",
  ];
  if (spec.model) args.push("--model", spec.model);
  if (spec.reasoning) args.push("--effort", spec.reasoning);
  if (spec.systemPrompt !== undefined) args.push("--system-prompt", spec.systemPrompt);
  if (spec.jsonSchema) args.push("--json-schema", JSON.stringify(spec.jsonSchema));
  let dir: string | undefined;
  const env: Record<string, string> = {};
  if (spec.completion) {
    args.push("--safe-mode", "--tools", "", "--max-turns", "1");
  } else {
    const servers = spec.mcpServers ?? {};
    const mcpServers: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(servers)) {
      if (!SERVER_NAME.test(name))
        throw new LlmError(
          "MCP server names may contain only letters, digits, - and _",
          "HOST_AGENT_CONFIG",
        );
      mcpServers[name] =
        "url" in server
          ? {
              type: "http",
              url: server.url,
              ...(server.headers ? { headers: server.headers } : {}),
            }
          : {
              type: "stdio",
              command: server.command,
              args: server.args ?? [],
              ...(server.env ? { env: server.env } : {}),
            };
    }
    // Claude Code reads MCP startup and tool-call timeouts (milliseconds) from its environment.
    const longest = (pick: (server: HostAgentMcpServer) => number | undefined) =>
      Math.max(
        0,
        ...Object.values(servers)
          .map((server) => pick(server) ?? 0)
          .filter((value) => Number.isFinite(value)),
      );
    const startup = longest((server) => server.timeouts?.startupSec),
      tool = longest((server) => server.timeouts?.toolSec);
    if (startup > 0) env.MCP_TIMEOUT = String(Math.ceil(startup * 1000));
    if (tool > 0) env.MCP_TOOL_TIMEOUT = String(Math.ceil(tool * 1000));
    if (Object.keys(mcpServers).length) {
      // A private file keeps MCP env and headers out of the process list.
      dir = await mkdtemp(join(tmpdir(), "passport-claude-"));
      const path = join(dir, "mcp.json");
      await writeFile(path, JSON.stringify({ mcpServers }), { mode: 0o600 });
      args.push("--mcp-config", path);
    }
    const allowed = spec.allowedTools ?? Object.keys(servers).map((name) => `mcp__${name}`);
    const builtins = allowed.filter((tool) => !tool.startsWith("mcp__"));
    args.push("--tools", builtins.join(","));
    if (allowed.length) args.push("--allowedTools", allowed.join(","));
    if (spec.maxTurns !== undefined) args.push("--max-turns", String(spec.maxTurns));
  }
  return {
    args,
    input: spec.prompt,
    env,
    schemaEnforced: !!spec.jsonSchema,
    cleanup: async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    },
  };
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const block = record(item);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function errorCode(result: Record<string, unknown>): string {
  const status = count(result.api_error_status);
  if (result.subtype === "error_max_turns") return "HOST_AGENT_MAX_TURNS";
  if (status === 401 || status === 403) return "HOST_AGENT_AUTH";
  if (status === 404) return "HOST_AGENT_MODEL";
  if (status === 429) return "HOST_AGENT_RATE_LIMIT";
  return "HOST_AGENT_FAILED";
}

/** Parse Claude Code stream-json lines into host-agent events. */
export function createClaudeParser(): HostStreamParser {
  const toolNames = new Map<string, string>();
  const state: HostRunOutcome = { text: "", finished: false };
  let lastText = "";
  return {
    push(line) {
      let message: Record<string, unknown> | undefined;
      try {
        message = record(JSON.parse(line));
      } catch {
        return [];
      }
      if (!message) return [];
      const events: HostAgentEvent[] = [];
      if (message.type === "system" && message.subtype === "init") {
        if (typeof message.session_id === "string") state.sessionId = message.session_id;
        if (typeof message.model === "string") state.model = message.model;
        events.push({
          type: "started",
          ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        });
      } else if (message.type === "assistant") {
        const body = record(message.message);
        if (typeof body?.model === "string" && body.model !== "<synthetic>")
          state.model = body.model;
        for (const item of Array.isArray(body?.content) ? body.content : []) {
          const block = record(item);
          if (block?.type === "text" && typeof block.text === "string" && block.text) {
            lastText = block.text;
            events.push({ type: "text", text: block.text });
          } else if (block?.type === "tool_use" && typeof block.name === "string") {
            if (typeof block.id === "string") toolNames.set(block.id, block.name);
            // Structured output is delivered through an internal tool; it is not agent activity.
            if (block.name !== "StructuredOutput")
              events.push({ type: "tool_call", name: block.name, input: block.input ?? {} });
          }
        }
      } else if (message.type === "user") {
        const body = record(message.message);
        for (const item of Array.isArray(body?.content) ? body.content : []) {
          const block = record(item);
          if (block?.type !== "tool_result") continue;
          const name =
            (typeof block.tool_use_id === "string" && toolNames.get(block.tool_use_id)) ||
            "unknown";
          if (name === "StructuredOutput") continue;
          events.push({
            type: "tool_result",
            name,
            ok: block.is_error !== true,
            summary: redact(text(block.content), 200),
          });
        }
      } else if (message.type === "result") {
        state.finished = true;
        if (typeof message.session_id === "string") state.sessionId = message.session_id;
        const usage = record(message.usage);
        if (usage) {
          const cached = count(usage.cache_read_input_tokens),
            written = count(usage.cache_creation_input_tokens);
          const input = count(usage.input_tokens) + cached + written,
            output = count(usage.output_tokens);
          // total_cost_usd is a list-price estimate; subscription runs have no per-call cost.
          state.usage = {
            ...emptyUsage(),
            inputTokens: input,
            outputTokens: output,
            totalTokens: input + output,
            cachedInputTokens: cached,
            cacheWriteTokens: written,
          };
        }
        const result = typeof message.result === "string" ? message.result : "";
        if (
          message.is_error === true ||
          (typeof message.subtype === "string" && message.subtype !== "success")
        ) {
          const detail =
            result ||
            (Array.isArray(message.errors)
              ? message.errors.filter((e) => typeof e === "string").join("; ")
              : "");
          state.error = {
            code: errorCode(message),
            message: `Claude Code run failed${detail ? `: ${redact(detail)}` : ""}`,
          };
        } else {
          state.text = result || lastText;
          if (message.structured_output !== undefined) state.structured = message.structured_output;
        }
      }
      return events;
    },
    outcome() {
      return { ...state, text: state.text || lastText };
    },
  };
}
