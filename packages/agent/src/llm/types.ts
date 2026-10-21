/** Deliberately small JSON Schema subset, validated locally on every structured response. */
export interface JsonSchema {
  type?:
    | "object"
    | "array"
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "null"
    | Array<"object" | "array" | "string" | "number" | "integer" | "boolean" | "null">;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}

export interface LlmTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface LlmMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
  isError?: boolean;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** Null means the provider did not report a cost and no rate was configured. */
  costUsd: number | null;
}

export interface LlmCompletion {
  text: string;
  json?: unknown;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  model: string;
}

export interface CompleteOptions {
  system: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  json?: JsonSchema;
  model?: "fast" | "main";
}

/** Provider-neutral, non-streaming completions. No provider SDK is required. */
export interface LlmClient {
  complete(opts: CompleteOptions): Promise<LlmCompletion>;
}

export interface ModelPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
}

export interface LlmClientOptions {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  retryBaseMs?: number;
  maxRetryDelayMs?: number;
  timeoutMs?: number;
  maxTokens?: number;
  /** Exact model IDs mapped to operator-supplied rates; no stale hard-coded pricing. */
  pricing?: Record<string, ModelPricing>;
  /** Host-agent providers (`claude-code`, `codex`): scratch working directory for CLI runs. */
  hostAgentCwd?: string;
}
