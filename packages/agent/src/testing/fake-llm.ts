import { AgentError } from "../errors.js";
import type { CompleteOptions, LlmClient, LlmCompletion } from "../llm/types.js";

type Script = unknown | ((opts: CompleteOptions) => unknown);

/** Script JSON objects, text, or full completions; calls are captured without network access. */
export class FakeLlm implements LlmClient {
  readonly calls: CompleteOptions[] = [];
  constructor(readonly script: Script[] = []) {}

  async complete(opts: CompleteOptions): Promise<LlmCompletion> {
    this.calls.push(structuredClone(opts));
    if (!this.script.length) throw new AgentError("FakeLlm script exhausted", "FAKE_LLM_EXHAUSTED");
    const next = this.script.shift();
    const value: unknown = typeof next === "function" ? next(opts) : next;
    if (value instanceof Error) throw value;
    if (value && typeof value === "object" && "toolCalls" in value) return value as LlmCompletion;
    return { text: typeof value === "string" ? value : JSON.stringify(value), ...(typeof value !== "string" ? { json: value } : {}), toolCalls: [], model: opts.model ?? "main", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 0, cacheWriteTokens: 0, costUsd: 0 } };
  }
}

export function toolOutput(name: string, args: unknown, id = "call-1"): LlmCompletion {
  return { text: "", toolCalls: [{ name, arguments: args, id }], model: "main", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 0, cacheWriteTokens: 0, costUsd: 0 } };
}
