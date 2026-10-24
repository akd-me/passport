import type {
  HostAgentEvent,
  HostAgentKind,
  HostAgentMcpServer,
  HostAgentReasoning,
  HostAgentUsage,
} from "@passport/types";
import { LlmError } from "../errors.js";
import type { JsonSchema } from "../llm/types.js";

/** Everything one CLI invocation needs; shared by sessions and completions. */
export interface HostRunSpec {
  kind: HostAgentKind;
  model?: string;
  reasoning?: HostAgentReasoning;
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  mcpServers?: Record<string, HostAgentMcpServer>;
  allowedTools?: string[];
  maxTurns?: number;
  /** Resume this provider session (sessions only); implies `persistSession`. */
  resumeSessionId?: string;
  /** Keep the session resumable on disk (sessions only). */
  persistSession?: boolean;
  /** Structured final output. */
  jsonSchema?: JsonSchema;
  /** A single completion: no tools, no MCP, no user customizations. */
  completion: boolean;
}

/** Arguments plus any private files/env the invocation needs; `cleanup` removes the files. */
export interface HostInvocation {
  args: string[];
  input: string;
  env: Record<string, string>;
  /** Whether `jsonSchema` is enforced by the CLI (otherwise it is only described in the prompt). */
  schemaEnforced: boolean;
  cleanup(): Promise<void>;
}

export interface HostRunOutcome {
  sessionId?: string;
  /** Final assistant message. */
  text: string;
  structured?: unknown;
  usage?: HostAgentUsage;
  model?: string;
  error?: { message: string; code: string };
  /** A terminal result/turn event was seen. */
  finished: boolean;
}

export interface HostStreamParser {
  push(line: string): HostAgentEvent[];
  outcome(): HostRunOutcome;
}

export function emptyUsage(): HostAgentUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
  };
}

export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** MCP server names become tool-name prefixes and TOML keys; keep them simple. */
export const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Provider session ids travel in argv; never let one read as a flag. */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The resume id of a session spec, validated; undefined for completions and fresh sessions. */
export function resumeId(spec: HostRunSpec): string | undefined {
  if (spec.completion || spec.resumeSessionId === undefined) {
    return undefined;
  }
  if (!SESSION_ID.test(spec.resumeSessionId)) {
    throw new LlmError("Invalid provider session id", "HOST_AGENT_CONFIG");
  }
  return spec.resumeSessionId;
}
