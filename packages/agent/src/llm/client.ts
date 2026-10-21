import type { LlmConfig } from "@passport/types";
import { LlmError } from "../errors.js";
import { HostAgentLlmClient } from "../host/client.js";
import { extractJson, isObject, validateJson } from "./json.js";
import type {
  CompleteOptions,
  LlmClient,
  LlmClientOptions,
  LlmCompletion,
  LlmMessage,
  LlmToolCall,
  LlmUsage,
} from "./types.js";

function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new LlmError("Invalid LLM response envelope", "LLM_RESPONSE");
  }
  return value;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function endpoint(base: string, suffix: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new LlmError("LLM base URL must be a valid HTTP URL", "LLM_CONFIG");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["https:", "http:"].includes(url.protocol)
  ) {
    throw new LlmError(
      "LLM base URL must be an HTTP URL without credentials or query parameters",
      "LLM_CONFIG",
    );
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (!path) {
    path = "/v1";
  }
  if (!path.endsWith(`/${suffix}`)) {
    path += `/${suffix}`;
  }
  url.pathname = path;
  return url.toString();
}

abstract class HttpLlmClient implements LlmClient {
  protected readonly options: LlmClientOptions;
  constructor(
    protected readonly config: LlmConfig,
    options: LlmClientOptions = {},
  ) {
    if (!config.model.trim()) {
      throw new LlmError("An LLM model is required", "LLM_CONFIG");
    }
    if ((config.provider === "anthropic" || config.provider === "openai") && !config.apiKey) {
      throw new LlmError("The selected LLM provider requires an API key", "LLM_CONFIG");
    }
    for (const value of [options.maxRetries, options.retryBaseMs, options.maxRetryDelayMs]) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        throw new LlmError("Invalid LLM retry configuration", "LLM_CONFIG");
      }
    }
    for (const value of [options.timeoutMs, options.maxTokens]) {
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        throw new LlmError("Invalid LLM timeout or token configuration", "LLM_CONFIG");
      }
    }
    for (const rate of Object.values(options.pricing ?? {})) {
      if (!Number.isFinite(rate.inputUsdPerMillion) || !Number.isFinite(rate.outputUsdPerMillion)) {
        throw new LlmError("Model pricing requires input and output rates", "LLM_CONFIG");
      }
      for (const value of Object.values(rate)) {
        if (!Number.isFinite(value) || value < 0) {
          throw new LlmError("Invalid model pricing", "LLM_CONFIG");
        }
      }
    }
    this.options = options;
  }

  protected model(opts: CompleteOptions): string {
    if (opts.json && opts.tools?.length) {
      throw new LlmError(
        "JSON output and interactive tools must be requested separately",
        "LLM_CONFIG",
      );
    }
    return opts.model === "fast" ? (this.config.fastModel ?? this.config.model) : this.config.model;
  }

  protected async post(
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const fetcher = this.options.fetch ?? globalThis.fetch;
    const sleep = this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const retries = this.options.maxRetries ?? 3;
    const maxDelay = this.options.maxRetryDelayMs ?? 30_000;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
          redirect: "error",
        });
      } catch {
        if (attempt >= retries) {
          throw new LlmError("LLM transport failed", "LLM_TRANSPORT");
        }
        await sleep(Math.min(maxDelay, (this.options.retryBaseMs ?? 250) * 2 ** attempt));
        continue;
      }
      if (response.ok) {
        try {
          return object(await response.json());
        } catch (error) {
          if (error instanceof LlmError) {
            throw error;
          }
          throw new LlmError("LLM returned an invalid response envelope", "LLM_RESPONSE");
        }
      }
      // Never include the response body, authorization header, or URL in an error/log.
      await response.body?.cancel();
      if (
        attempt >= retries ||
        (response.status !== 429 && (response.status < 500 || response.status > 599))
      ) {
        throw new LlmError(
          `LLM request failed (HTTP ${response.status})`,
          "LLM_HTTP",
          response.status,
        );
      }
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const serverDelay =
        retryAfter === null
          ? 0
          : Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(retryAfter) - Date.now();
      const backoff = (this.options.retryBaseMs ?? 250) * 2 ** attempt;
      await sleep(
        Math.min(maxDelay, Math.max(backoff, Number.isFinite(serverDelay) ? serverDelay : 0)),
      );
    }
  }

  protected usage(raw: unknown, model: string, anthropic: boolean): LlmUsage {
    const usage = isObject(raw) ? raw : {};
    const cached = anthropic
      ? number(usage.cache_read_input_tokens)
      : isObject(usage.prompt_tokens_details)
        ? number(usage.prompt_tokens_details.cached_tokens)
        : 0;
    const cacheWrite = anthropic ? number(usage.cache_creation_input_tokens) : 0;
    const input = anthropic
      ? number(usage.input_tokens) + cached + cacheWrite
      : number(usage.prompt_tokens);
    const output = number(anthropic ? usage.output_tokens : usage.completion_tokens);
    const rate = this.options.pricing?.[model];
    let cost: number | null =
      typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
        ? usage.cost
        : null;
    if (cost === null && rate) {
      cost =
        (Math.max(0, input - cached - cacheWrite) * rate.inputUsdPerMillion +
          cached * (rate.cachedInputUsdPerMillion ?? rate.inputUsdPerMillion) +
          cacheWrite * (rate.cacheWriteUsdPerMillion ?? rate.inputUsdPerMillion) +
          output * rate.outputUsdPerMillion) /
        1_000_000;
    }
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
      cachedInputTokens: cached,
      cacheWriteTokens: cacheWrite,
      costUsd: cost,
    };
  }

  protected finish(opts: CompleteOptions, result: LlmCompletion): LlmCompletion {
    for (const call of result.toolCalls) {
      const tool = opts.tools?.find((item) => item.name === call.name);
      if (!tool) {
        throw new LlmError("Model requested an unknown tool", "LLM_TOOL");
      }
      validateJson(call.arguments, tool.inputSchema);
    }
    if (opts.json) {
      result.json ??= extractJson(result.text);
      validateJson(result.json, opts.json);
    }
    return result;
  }

  abstract complete(opts: CompleteOptions): Promise<LlmCompletion>;
}

/** OpenAI chat-completions wire protocol, also used by Ollama and OpenRouter. */
export class OpenAiCompatibleClient extends HttpLlmClient {
  async complete(opts: CompleteOptions): Promise<LlmCompletion> {
    const model = this.model(opts);
    const base =
      this.config.baseUrl ??
      (this.config.provider === "ollama"
        ? "http://localhost:11434/v1"
        : "https://api.openai.com/v1");
    const system = opts.json
      ? `${opts.system}\nReturn only JSON matching this schema: ${JSON.stringify(opts.json)}`
      : opts.system;
    const messages = opts.messages.map((message) => {
      if (message.role === "tool") {
        if (!message.toolCallId) {
          throw new LlmError("Tool result is missing a call ID", "LLM_CONFIG");
        }
        return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
      }
      return {
        role: message.role,
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }
          : {}),
      };
    });
    const raw = await this.post(
      endpoint(base, "chat/completions"),
      this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {},
      {
        model,
        messages: [{ role: "system", content: system }, ...messages],
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        ...(opts.tools?.length
          ? {
              tools: opts.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
              tool_choice: "auto",
            }
          : {}),
      },
    );
    const choice = object(Array.isArray(raw.choices) ? raw.choices[0] : undefined);
    if (choice.finish_reason === "length") {
      throw new LlmError("LLM output was truncated", "LLM_TRUNCATED");
    }
    const message = object(choice.message);
    if (message.refusal) {
      throw new LlmError("LLM declined the request", "LLM_REFUSAL");
    }
    const text = typeof message.content === "string" ? message.content : "";
    const toolCalls: LlmToolCall[] = (
      Array.isArray(message.tool_calls) ? message.tool_calls : []
    ).map((item) => {
      const call = object(item);
      const fn = object(call.function);
      if (
        typeof call.id !== "string" ||
        typeof fn.name !== "string" ||
        typeof fn.arguments !== "string"
      ) {
        throw new LlmError("Invalid LLM tool call", "LLM_RESPONSE");
      }
      return { id: call.id, name: fn.name, arguments: extractJson(fn.arguments) };
    });
    return this.finish(opts, {
      text,
      toolCalls,
      usage: this.usage(raw.usage, model, false),
      model: typeof raw.model === "string" ? raw.model : model,
    });
  }
}

function anthropicMessages(
  messages: LlmMessage[],
): Array<{ role: "user" | "assistant"; content: unknown[] }> {
  const result: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  for (const message of messages) {
    const role = message.role === "tool" ? "user" : message.role;
    const content: unknown[] = [];
    if (message.role === "tool") {
      if (!message.toolCallId) {
        throw new LlmError("Tool result is missing a call ID", "LLM_CONFIG");
      }
      content.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError ? { is_error: true } : {}),
      });
    } else {
      if (message.content) {
        content.push({ type: "text", text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
    }
    const previous = result.at(-1);
    if (previous?.role === role) {
      previous.content.push(...content);
    } else {
      result.push({ role, content });
    }
  }
  return result;
}

/** Anthropic Messages API. A forced tool provides structured JSON output. */
export class AnthropicClient extends HttpLlmClient {
  async complete(opts: CompleteOptions): Promise<LlmCompletion> {
    const model = this.model(opts);
    const tools = opts.json
      ? [
          {
            name: "structured_output",
            description: "Return the requested structured result",
            input_schema: opts.json,
          },
        ]
      : opts.tools?.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        }));
    const raw = await this.post(
      endpoint(this.config.baseUrl ?? "https://api.anthropic.com/v1", "messages"),
      {
        "x-api-key": this.config.apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      {
        model,
        system: opts.system,
        max_tokens: this.options.maxTokens ?? 4096,
        messages: anthropicMessages(opts.messages),
        ...(tools?.length ? { tools } : {}),
        ...(opts.json ? { tool_choice: { type: "tool", name: "structured_output" } } : {}),
      },
    );
    if (raw.stop_reason === "max_tokens") {
      throw new LlmError("LLM output was truncated", "LLM_TRUNCATED");
    }
    if (raw.stop_reason === "refusal") {
      throw new LlmError("LLM declined the request", "LLM_REFUSAL");
    }
    if (!Array.isArray(raw.content)) {
      throw new LlmError("Invalid LLM response content", "LLM_RESPONSE");
    }
    let text = "";
    let json: unknown;
    const toolCalls: LlmToolCall[] = [];
    for (const item of raw.content) {
      const block = object(item);
      if (block.type === "text" && typeof block.text === "string") {
        text += block.text;
      }
      if (block.type === "tool_use") {
        if (opts.json && block.name === "structured_output") {
          json = block.input;
        } else {
          if (typeof block.id !== "string" || typeof block.name !== "string") {
            throw new LlmError("Invalid LLM tool call", "LLM_RESPONSE");
          }
          toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
        }
      }
    }
    return this.finish(opts, {
      text,
      ...(json !== undefined ? { json } : {}),
      toolCalls,
      usage: this.usage(raw.usage, model, true),
      model: typeof raw.model === "string" ? raw.model : model,
    });
  }
}

/** Select a wire adapter from the shared configuration. Pass a client instead for tests. */
export function createLlmClient(config: LlmConfig, options?: LlmClientOptions): LlmClient {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicClient(config, options);
    case "openai":
    case "openai-compatible":
    case "ollama":
      return new OpenAiCompatibleClient(config, options);
    case "claude-code":
    case "codex":
      return new HostAgentLlmClient({
        kind: config.provider,
        model: config.model,
        ...(config.fastModel ? { fastModel: config.fastModel } : {}),
        ...(options?.hostAgentCwd ? { cwd: options.hostAgentCwd } : {}),
      });
    default:
      throw new LlmError("Unsupported LLM provider", "LLM_CONFIG");
  }
}
