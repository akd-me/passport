import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostAgentEvent } from "@passport/types";
import { LlmError } from "../errors.js";
import type { JsonSchema } from "../llm/types.js";
import { isForwardedEnv, redact } from "./env.js";
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

/** JSON strings are valid TOML basic strings, so `-c` values reuse JSON encoding. */
const toml = (value: string | string[]): string => JSON.stringify(value);
const tomlTable = (entries: Record<string, string>): string =>
  `{ ${Object.entries(entries)
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
    .join(", ")} }`;

/** A positive TOML float; MCP timeouts are seconds. */
const seconds = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new LlmError("MCP timeouts must be positive numbers of seconds", "HOST_AGENT_CONFIG");
  }
  return Number.isInteger(value) ? `${value}.0` : String(value);
};

/** Codex features that reach outside the model call. `-c features.x=false` tolerates unknown names. */
const COMPLETION_FEATURES_OFF = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "multi_agent",
  "image_generation",
  "browser_use",
  "computer_use",
  "hooks",
  "goals",
  "skill_search",
  "tool_suggest",
  "view_image",
];
const SESSION_FEATURES_OFF = [
  "apps",
  "plugins",
  "multi_agent",
  "image_generation",
  "computer_use",
  "hooks",
];

/** Recursive property compatibility; scalar and array properties are allowed. */
function strictProperties(schema: JsonSchema): boolean {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.includes("object") || schema.properties) {
    const keys = Object.keys(schema.properties ?? {});
    if (schema.additionalProperties !== false) {
      return false;
    }
    if (
      keys.length !== (schema.required ?? []).length ||
      keys.some((key) => !(schema.required ?? []).includes(key))
    ) {
      return false;
    }
    if (Object.values(schema.properties ?? {}).some((child) => !strictProperties(child))) {
      return false;
    }
  }
  if (schema.items && !strictProperties(schema.items)) {
    return false;
  }
  return true;
}

/** Codex strict output requires an object root, closed objects and all properties required. */
export function strictCompatible(schema: JsonSchema): boolean {
  return schema.type === "object" && strictProperties(schema);
}

/**
 * `codex exec --json` in a read-only sandbox outside any repository, with the user's
 * config.toml ignored so only the supplied MCP servers load. Completions also disable the
 * shell and every other tool so untrusted mail cannot drive local commands.
 */
export async function codexInvocation(spec: HostRunSpec): Promise<HostInvocation> {
  if (spec.maxTurns !== undefined && (!Number.isSafeInteger(spec.maxTurns) || spec.maxTurns <= 0)) {
    throw new LlmError("Codex maxTurns must be a positive safe integer", "HOST_AGENT_CONFIG");
  }
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "-s",
    "read-only",
    "--color",
    "never",
  ];
  const env: Record<string, string> = {};
  if (spec.model) {
    args.push("-m", spec.model);
  }
  if (spec.reasoning) {
    args.push("-c", `model_reasoning_effort=${toml(spec.reasoning)}`);
  }
  if (spec.systemPrompt) {
    args.push("-c", `developer_instructions=${toml(spec.systemPrompt)}`);
  }
  const allowed = spec.allowedTools;
  const shell = !spec.completion && !!allowed?.some((tool) => tool === "Bash" || tool === "shell");
  for (const feature of spec.completion ? COMPLETION_FEATURES_OFF : SESSION_FEATURES_OFF) {
    args.push("-c", `features.${feature}=false`);
  }
  if (!shell && !spec.completion) {
    args.push("-c", "features.shell_tool=false", "-c", "features.unified_exec=false");
  }
  if (spec.completion || !allowed?.some((tool) => tool === "WebSearch" || tool === "web_search")) {
    args.push("-c", `web_search=${toml("disabled")}`);
  }
  if (!spec.completion) {
    let envIndex = 0;
    for (const [name, server] of Object.entries(spec.mcpServers ?? {})) {
      if (!SERVER_NAME.test(name)) {
        throw new LlmError(
          "MCP server names may contain only letters, digits, - and _",
          "HOST_AGENT_CONFIG",
        );
      }
      const key = `mcp_servers.${name}`;
      // Secrets travel in the child environment, never in argv (visible in process lists).
      const secret = (value: string) => {
        const variable = `PASSPORT_HOST_MCP_${envIndex++}`;
        env[variable] = value;
        return variable;
      };
      if ("url" in server) {
        args.push("-c", `${key}.url=${toml(server.url)}`);
        const headers = Object.fromEntries(
          Object.entries(server.headers ?? {}).map(([header, value]) => [header, secret(value)]),
        );
        if (Object.keys(headers).length) {
          args.push("-c", `${key}.env_http_headers=${tomlTable(headers)}`);
        }
      } else {
        args.push(
          "-c",
          `${key}.command=${toml(server.command)}`,
          "-c",
          `${key}.args=${toml(server.args ?? [])}`,
        );
        // Variables Codex itself relies on (PATH, HOME, ...) are set inline for the server only.
        const inline: Record<string, string> = {},
          forwarded: string[] = [];
        for (const [variable, value] of Object.entries(server.env ?? {})) {
          if (isForwardedEnv(variable)) {
            inline[variable] = value;
            continue;
          }
          if (env[variable] !== undefined && env[variable] !== value) {
            throw new LlmError(
              "Two MCP servers set the same environment variable differently",
              "HOST_AGENT_CONFIG",
            );
          }
          env[variable] = value;
          forwarded.push(variable);
        }
        if (Object.keys(inline).length) {
          args.push("-c", `${key}.env=${tomlTable(inline)}`);
        }
        if (forwarded.length) {
          args.push("-c", `${key}.env_vars=${toml(forwarded)}`);
        }
      }
      if (server.timeouts?.startupSec) {
        args.push("-c", `${key}.startup_timeout_sec=${seconds(server.timeouts.startupSec)}`);
      }
      if (server.timeouts?.toolSec) {
        args.push("-c", `${key}.tool_timeout_sec=${seconds(server.timeouts.toolSec)}`);
      }
      args.push("-c", `${key}.default_tools_approval_mode=${toml("approve")}`);
      if (allowed) {
        const prefix = `mcp__${name}__`;
        if (!allowed.includes(`mcp__${name}`)) {
          args.push(
            "-c",
            `${key}.enabled_tools=${toml(allowed.filter((tool) => tool.startsWith(prefix)).map((tool) => tool.slice(prefix.length)))}`,
          );
        }
      }
    }
  }
  let dir: string | undefined;
  const schemaEnforced = !!spec.jsonSchema && strictCompatible(spec.jsonSchema);
  if (spec.jsonSchema && schemaEnforced) {
    dir = await mkdtemp(join(tmpdir(), "passport-codex-"));
    const path = join(dir, "schema.json");
    await writeFile(path, JSON.stringify(spec.jsonSchema), { mode: 0o600 });
    args.push("--output-schema", path);
  }
  args.push("-");
  return {
    args,
    input: spec.prompt,
    env,
    schemaEnforced,
    cleanup: async () => {
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function failure(raw: unknown): { message: string; code: string } {
  let message = typeof raw === "string" ? raw : "";
  let status = 0,
    code = "";
  // API errors arrive as a JSON document inside the message string.
  try {
    const parsed = record(JSON.parse(message));
    const inner = record(parsed?.error);
    status = count(parsed?.status);
    code = typeof inner?.code === "string" ? inner.code : "";
    if (typeof inner?.message === "string") {
      message = inner.message;
    }
  } catch (error) {
    // Malformed JSON is expected here; retain the existing text or stream fallback.
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    /* plain text */
  }
  const lower = message.toLowerCase();
  function failureCode() {
    if (code === "invalid_json_schema") {
      return "HOST_AGENT_SCHEMA";
    }
    if (
      status === 401 ||
      status === 403 ||
      /\bunauthori[sz]ed\b|\bnot logged in\b|\blog ?in\b|\bsign in\b|\bauthenticat/.test(lower)
    ) {
      return "HOST_AGENT_AUTH";
    }
    if (status === 429 || /rate limit|usage limit|quota/.test(lower)) {
      return "HOST_AGENT_RATE_LIMIT";
    }
    if (
      /model/.test(lower) &&
      /not (found|supported|exist)|unknown|invalid|does not exist/.test(lower)
    ) {
      return "HOST_AGENT_MODEL";
    }
    return "HOST_AGENT_FAILED";
  }
  const kind = failureCode();
  return { code: kind, message: `Codex run failed${message ? `: ${redact(message)}` : ""}` };
}

function mcpResultText(result: unknown): string {
  const content = record(result)?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      const block = record(item);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Parse `codex exec --json` lines into host-agent events. */
export function createCodexParser(maxTurns?: number): HostStreamParser {
  const state: HostRunOutcome = { text: "", finished: false };
  let lastError: { message: string; code: string } | undefined;
  let failed = false;
  let turns = 0;
  return {
    push(line) {
      // Cancellation is asynchronous: ignore any further buffered output after the limit.
      if (state.error?.code === "HOST_AGENT_MAX_TURNS") {
        return [];
      }
      let message: Record<string, unknown> | undefined;
      try {
        message = record(JSON.parse(line));
      } catch (error) {
        // Malformed JSON is expected here; retain the existing text or stream fallback.
        if (!(error instanceof SyntaxError)) {
          throw error;
        }

        return [];
      }
      if (!message) {
        return [];
      }
      const events: HostAgentEvent[] = [];
      const item = record(message.item);
      switch (message.type) {
        case "turn.started":
          turns++;
          break;
        case "thread.started":
          if (typeof message.thread_id === "string") {
            state.sessionId = message.thread_id;
          }
          events.push({
            type: "started",
            ...(state.sessionId ? { sessionId: state.sessionId } : {}),
          });
          break;
        case "item.started":
          if (item?.type === "mcp_tool_call") {
            events.push({
              type: "tool_call",
              name: `mcp__${String(item.server)}__${String(item.tool)}`,
              input: item.arguments ?? {},
            });
          } else if (item?.type === "command_execution") {
            events.push({ type: "tool_call", name: "shell", input: { command: item.command } });
          } else if (item?.type === "web_search") {
            events.push({ type: "tool_call", name: "web_search", input: { query: item.query } });
          }
          break;
        case "item.completed":
          if (item?.type === "agent_message" && typeof item.text === "string") {
            state.text = item.text;
            events.push({ type: "text", text: item.text });
          } else if (item?.type === "mcp_tool_call") {
            const error = record(item.error);
            const ok = item.status === "completed" && !error;
            events.push({
              type: "tool_result",
              name: `mcp__${String(item.server)}__${String(item.tool)}`,
              ok,
              summary: redact(
                ok ? mcpResultText(item.result) : String(error?.message ?? "Tool call failed"),
                200,
              ),
            });
          } else if (item?.type === "command_execution") {
            events.push({
              type: "tool_result",
              name: "shell",
              ok: item.exit_code === 0,
              summary: redact(String(item.aggregated_output ?? ""), 200),
            });
          } else if (item?.type === "file_change") {
            events.push({
              type: "tool_result",
              name: "apply_patch",
              ok: item.status === "completed",
              summary: "File change",
            });
          }
          break;
        case "turn.completed": {
          state.finished = true;
          const usage = record(message.usage);
          if (usage) {
            const previous = state.usage ?? emptyUsage();
            const input = count(usage.input_tokens),
              output = count(usage.output_tokens);
            state.usage = {
              ...previous,
              inputTokens: previous.inputTokens + input,
              outputTokens: previous.outputTokens + output,
              totalTokens: previous.totalTokens + input + output,
              cachedInputTokens: previous.cachedInputTokens + count(usage.cached_input_tokens),
              cacheWriteTokens: previous.cacheWriteTokens + count(usage.cache_write_input_tokens),
            };
          }
          break;
        }
        case "turn.failed":
          state.finished = true;
          failed = true;
          lastError = failure(record(message.error)?.message);
          break;
        case "error":
          // Also emitted for transient reconnects; only fatal if the turn never completes.
          lastError = failure(message.message);
          break;
      }
      turns += events.filter((event) => event.type === "tool_call").length;
      if (maxTurns !== undefined && turns > maxTurns) {
        state.finished = false;
        state.error = {
          code: "HOST_AGENT_MAX_TURNS",
          message: `Codex exceeded maxTurns (${maxTurns}); the initial turn and each tool call count toward the limit`,
        };
      }
      return events;
    },
    outcome() {
      const outcome = { ...state };
      if (!outcome.error && (failed || (!state.finished && lastError))) {
        outcome.error = lastError;
      }
      return outcome;
    },
  };
}
