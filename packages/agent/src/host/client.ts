import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HostAgentEvent,
  HostAgentKind,
  HostAgentMcpServer,
  HostAgentReasoning,
  HostAgentSessionResult,
} from "@passport/types";
import { LlmError } from "../errors.js";
import { extractJson, validateJson } from "../llm/json.js";
import type {
  CompleteOptions,
  JsonSchema,
  LlmClient,
  LlmCompletion,
  LlmMessage,
  LlmTool,
  LlmToolCall,
} from "../llm/types.js";
import { runHostAgent, runHostAgentSession } from "./session.js";

/** Defaults per host agent: a capable main model and a cheaper one for `model: "fast"`. */
export const HOST_AGENT_DEFAULT_MODELS: Record<HostAgentKind, { main: string; fast: string }> = {
  "claude-code": { main: "claude-sonnet-5-5", fast: "claude-haiku-5-5" },
  codex: { main: "gpt-6.1-sol", fast: "gpt-5.6-luna" },
};

/** Models offered through the subscriptions, for pickers. Any model the CLI accepts works. */
export const HOST_AGENT_MODELS: Record<HostAgentKind, readonly string[]> = {
  "claude-code": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  codex: [
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ],
};

export interface HostAgentLlmClientOptions {
  log?: (message: string) => void;
  kind: HostAgentKind;
  model?: string;
  fastModel?: string;
  /** Reasoning effort per tier. Codex defaults to medium/low; Claude Code uses its own default. */
  reasoning?: { main?: HostAgentReasoning; fast?: HostAgentReasoning };
  /** Scratch working directory, created on demand. Defaults to a directory under the OS temp dir. */
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  binaryPath?: string;
  /**
   * Codex: rewrite the CLI's model catalog so sessions and completions get no code-mode `exec`,
   * `apply_patch`, sub-agents or clock tools (one `codex debug models` per binary).
   * `createLlmClient` turns it on; off by default so scripted test CLIs see only real runs.
   */
  restrictCodexTools?: boolean;
}

/** One agentic session turn on the client's CLI, model and scratch directory. */
export interface HostAgentSessionInput {
  prompt: string;
  systemPrompt: string;
  mcpServers: Record<string, HostAgentMcpServer>;
  allowedTools?: string[];
  /** Resume this provider session; a resumed session keeps its transcript. */
  resumeSessionId?: string;
  /**
   * Keep the CLI transcript so a later run can resume the session. Default false: the run uses
   * `--no-session-persistence` (Claude Code) or `--ephemeral` (Codex) and leaves no transcript.
   */
  persist?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** An `LlmClient` that can also run a whole agentic session (the host agents). */
export interface SessionLlmClient extends LlmClient {
  readonly hostKind: HostAgentKind;
  session(
    input: HostAgentSessionInput,
    onEvent: (event: HostAgentEvent) => void,
  ): { done: Promise<HostAgentSessionResult>; cancel(): void };
}

export function isSessionLlmClient(client: LlmClient): client is SessionLlmClient {
  const candidate = client as Partial<SessionLlmClient>;
  return typeof candidate.session === "function" && typeof candidate.hostKind === "string";
}

function toolSchema(tools: LlmTool[]): JsonSchema {
  // Arguments travel as a JSON string so the schema stays strict-mode compatible.
  return {
    type: "object",
    additionalProperties: false,
    required: ["text", "toolCalls"],
    properties: {
      text: { type: "string" },
      toolCalls: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "argumentsJson"],
          properties: {
            name: { type: "string", enum: tools.map((tool) => tool.name) },
            argumentsJson: { type: "string" },
          },
        },
      },
    },
  };
}

function toolInstructions(tools: LlmTool[]): string {
  return [
    "",
    "## Tools",
    "You cannot run tools yourself. To use one, list it in `toolCalls` with `argumentsJson` set to a JSON-encoded object matching its input schema; the results arrive in the next message. Put any message for the user in `text`. When no further tool is needed, return an empty `toolCalls` array.",
    ...tools.map(
      (tool) =>
        `- ${tool.name}: ${tool.description}\n  input schema: ${JSON.stringify(tool.inputSchema)}`,
    ),
  ].join("\n");
}

/** Host CLIs take one prompt, so a multi-message exchange is rendered as a transcript. */
function transcript(messages: LlmMessage[]): string {
  if (messages.length === 1 && messages[0]!.role === "user") {
    return messages[0]!.content;
  }
  const parts = messages.map((message) => {
    if (message.role === "tool") {
      return `<tool_result id="${message.toolCallId ?? ""}"${message.isError ? ' error="true"' : ""}>\n${message.content}\n</tool_result>`;
    }
    const calls = (message.toolCalls ?? [])
      .map(
        (call) =>
          `<tool_call id="${call.id}" name="${call.name}">${JSON.stringify(call.arguments)}</tool_call>`,
      )
      .join("\n");
    return `<${message.role}>\n${[message.content, calls].filter(Boolean).join("\n")}\n</${message.role}>`;
  });
  return `${parts.join("\n\n")}\n\nContinue as the assistant, responding to the latest message.`;
}

/**
 * `LlmClient` backed by the host's Claude Code or Codex CLI and its subscription login.
 * Every call is a fresh, tool-less, non-persisted CLI run; JSON mode uses the CLI's schema
 * enforcement and is validated locally. Interactive tools are emulated as structured output,
 * so Passport (not the CLI) executes them under policy.
 */
export class HostAgentLlmClient implements SessionLlmClient {
  readonly hostKind: HostAgentKind;

  constructor(private readonly options: HostAgentLlmClientOptions) {
    this.hostKind = options.kind;
    if (options.kind !== "claude-code" && options.kind !== "codex") {
      throw new LlmError("Unsupported host agent", "LLM_CONFIG");
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new LlmError("Invalid host agent timeout", "LLM_CONFIG");
    }
  }

  /**
   * A task run as one native session: the CLI calls the supplied MCP tools itself and streams
   * events. Uses the main model and reasoning; the session is resumable only with `persist`.
   */
  session(
    input: HostAgentSessionInput,
    onEvent: (event: HostAgentEvent) => void,
  ): { done: Promise<HostAgentSessionResult>; cancel(): void } {
    const { kind } = this.options;
    const reasoning =
      this.options.reasoning?.main ?? (kind === "codex" ? ("medium" as const) : undefined);
    return runHostAgentSession(
      {
        kind,
        model: this.options.model?.trim() || HOST_AGENT_DEFAULT_MODELS[kind].main,
        ...(reasoning ? { reasoning } : {}),
        prompt: input.prompt,
        systemPrompt: input.systemPrompt,
        cwd: this.options.cwd ?? join(tmpdir(), "passport-host-agent"),
        mcpServers: input.mcpServers,
        ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        ...(input.persist || input.resumeSessionId ? { persistSession: true } : {}),
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      onEvent,
      {
        log: this.options.log,
        env: this.options.env,
        binaryPath: this.options.binaryPath,
        ...(this.options.restrictCodexTools ? { restrictCodexTools: true } : {}),
      },
    );
  }

  async complete(opts: CompleteOptions): Promise<LlmCompletion> {
    if (opts.json && opts.tools?.length) {
      throw new LlmError(
        "JSON output and interactive tools must be requested separately",
        "LLM_CONFIG",
      );
    }
    const { kind } = this.options;
    const fast = opts.model === "fast";
    const model =
      (fast ? this.options.fastModel : this.options.model)?.trim() ||
      HOST_AGENT_DEFAULT_MODELS[kind][fast ? "fast" : "main"];
    const reasoning =
      this.options.reasoning?.[fast ? "fast" : "main"] ??
      (kind === "codex" ? (fast ? "low" : "medium") : undefined);
    const tools = opts.tools?.length ? opts.tools : undefined;
    const schema = opts.json ?? (tools ? toolSchema(tools) : undefined);
    let system = opts.system + (tools ? toolInstructions(tools) : "");
    // Codex enforces only strict-compatible schemas; describe any schema in the prompt as well.
    if (schema && kind === "codex") {
      system += `\n\nReturn only JSON matching this schema: ${JSON.stringify(schema)}`;
    }
    const run = runHostAgent(
      {
        kind,
        model,
        ...(reasoning ? { reasoning } : {}),
        prompt: transcript(opts.messages),
        systemPrompt: system,
        cwd: this.options.cwd ?? join(tmpdir(), "passport-host-agent"),
        ...(schema ? { jsonSchema: schema } : {}),
        completion: true,
      },
      {
        log: this.options.log,
        env: this.options.env,
        binaryPath: this.options.binaryPath,
        timeoutMs: this.options.timeoutMs ?? 180_000,
        ...(this.options.restrictCodexTools ? { restrictCodexTools: true } : {}),
      },
    );
    const outcome = await run.done;
    if (outcome.error) {
      throw new LlmError(outcome.error.message, outcome.error.code);
    }
    const usage = outcome.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
    };
    const result: LlmCompletion = {
      text: outcome.text,
      toolCalls: [],
      usage,
      model: outcome.model ?? model,
    };
    if (tools) {
      const parsed = outcome.structured ?? extractJson(outcome.text);
      validateJson(parsed, schema!);
      const value = parsed as {
        text: string;
        toolCalls: Array<{ name: string; argumentsJson: string }>;
      };
      result.text = value.text;
      result.toolCalls = value.toolCalls.map((call): LlmToolCall => {
        const tool = tools.find((item) => item.name === call.name);
        if (!tool) {
          throw new LlmError("Model requested an unknown tool", "LLM_TOOL");
        }
        const args = extractJson(call.argumentsJson);
        validateJson(args, tool.inputSchema);
        return { id: `call_${randomUUID()}`, name: call.name, arguments: args };
      });
    } else if (opts.json) {
      result.json = outcome.structured ?? extractJson(outcome.text);
      validateJson(result.json, opts.json);
    }
    return result;
  }
}
