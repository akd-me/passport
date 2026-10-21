import { describe, expect, it, vi } from "vitest";
import { AnthropicClient, createLlmClient, OpenAiCompatibleClient } from "./client.js";
import { extractJson, validateJson } from "./json.js";
import type { CompleteOptions, JsonSchema } from "./types.js";

const schema: JsonSchema = {
  type: "object",
  properties: { category: { type: "string", enum: ["newsletters"] } },
  required: ["category"],
  additionalProperties: false,
};
const opts: CompleteOptions = {
  system: "Read carefully.",
  messages: [{ role: "user", content: "Classify this email." }],
  json: schema,
  model: "fast",
};
function response(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), { status, headers });
}
function openai(
  content = '{"category":"newsletters"}',
  usage: unknown = { prompt_tokens: 100, completion_tokens: 20 },
): unknown {
  return {
    model: "cheap-model",
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage,
  };
}
const readTool = {
  name: "read_email",
  description: "Read email",
  inputSchema: {
    type: "object",
    properties: { emailId: { type: "string" } },
    required: ["emailId"],
    additionalProperties: false,
  } satisfies JsonSchema,
};

describe("JSON extraction and validation", () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ['```json\n{"a":1}\n```', { a: 1 }],
    [
      'Here is the result:\n{"a":[{"b":"a } brace [ in a string"}]}\nDone.',
      { a: [{ b: "a } brace [ in a string" }] },
    ],
    ['\uFEFF [1, {"value":2}]', [1, { value: 2 }]],
    ['Ignore {invalid}; actual JSON: {"ok":true}', { ok: true }],
    ['Prose [citation] then {"ok":true}', { ok: true }],
    [
      '```json\n{"quoted":"a \\"quote\\" and \\\\ slash"}\n```',
      { quoted: 'a "quote" and \\ slash' },
    ],
  ])("extracts structured data from %s", (source, expected) => {
    expect(extractJson(source)).toEqual(expected);
  });

  it.each(["not JSON", '{"truncated":', "```json\n{bad}\n```", "{]"])(
    "rejects malformed JSON: %s",
    (source) => {
      expect(() => extractJson(source)).toThrow(
        expect.objectContaining({ code: "LLM_INVALID_JSON" }),
      );
    },
  );

  it("validates enums, required fields, unknown properties, and nested array types", () => {
    expect(() => validateJson({ category: "newsletters" }, schema)).not.toThrow();
    for (const value of [{}, { category: "other" }, { category: "newsletters", injected: true }])
      expect(() => validateJson(value, schema)).toThrow(
        expect.objectContaining({ code: "LLM_SCHEMA" }),
      );
    expect(() => validateJson(["text", 2], { type: "array", items: { type: "string" } })).toThrow();
    expect(() =>
      validateJson(
        { constructor: "injected" },
        { type: "object", properties: {}, additionalProperties: false },
      ),
    ).toThrow();
  });
});

describe("OpenAI-compatible adapter", () => {
  it("uses fastModel, JSON mode, and token/rate accounting", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        openai(undefined, {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 40 },
        }),
      ),
    );
    const client = createLlmClient(
      { provider: "openai", model: "main-model", fastModel: "cheap-model", apiKey: "private-key" },
      {
        fetch: fetcher,
        pricing: {
          "cheap-model": {
            inputUsdPerMillion: 2,
            outputUsdPerMillion: 5,
            cachedInputUsdPerMillion: 0.5,
          },
        },
      },
    );
    const result = await client.complete(opts);
    expect(result.json).toEqual({ category: "newsletters" });
    expect(result.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 40,
    });
    expect(result.usage.costUsd).toBeCloseTo(0.00024);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/chat/completions");
    const init = fetcher.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "cheap-model", response_format: { type: "json_object" } });
    expect(body.messages[0].content).toContain("JSON");
    expect(init?.headers).toMatchObject({ authorization: "Bearer private-key" });
    expect(init?.redirect).toBe("error");
  });

  it("reports unknown costs honestly and uses provider-reported costs when present", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(openai()))
      .mockResolvedValueOnce(
        response(openai(undefined, { prompt_tokens: 3, completion_tokens: 2, cost: 0.01 })),
      );
    const client = createLlmClient(
      { provider: "openai-compatible", model: "local", baseUrl: "https://openrouter.ai/api/v1/" },
      { fetch: fetcher },
    );
    expect((await client.complete(opts)).usage.costUsd).toBeNull();
    expect((await client.complete(opts)).usage.costUsd).toBe(0.01);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("supports Ollama defaults without an API key and falls back to the main model", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(openai()));
    const client = createLlmClient(
      { provider: "ollama", model: "local-model" },
      { fetch: fetcher },
    );
    await client.complete(opts);
    expect(client).toBeInstanceOf(OpenAiCompatibleClient);
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://localhost:11434/v1/chat/completions");
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).model).toBe("local-model");
  });

  it("retries 429/503 with bounded backoff and Retry-After", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({}, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response(openai()));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const client = createLlmClient(
      { provider: "ollama", model: "local" },
      { fetch: fetcher, sleep, retryBaseMs: 100, maxRetryDelayMs: 1000 },
    );
    await client.complete(opts);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1000, 200]);
  });

  it("stops after the configured retry budget and never includes API secrets in errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ error: "private-key and full message body" }, 500));
    const client = createLlmClient(
      { provider: "openai", model: "model", apiKey: "private-key" },
      { fetch: fetcher, sleep: async () => {}, maxRetries: 2 },
    );
    await expect(client.complete(opts)).rejects.toMatchObject({
      code: "LLM_HTTP",
      status: 500,
      message: "LLM request failed (HTTP 500)",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not retry an unauthorized request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error: "bad secret" }, 401));
    const client = createLlmClient({ provider: "ollama", model: "local" }, { fetch: fetcher });
    await expect(client.complete(opts)).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("sanitizes network errors after retry exhaustion", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("fetch failed with private-key"));
    const client = createLlmClient(
      { provider: "ollama", model: "local" },
      { fetch: fetcher, maxRetries: 0 },
    );
    await expect(client.complete(opts)).rejects.toMatchObject({
      code: "LLM_TRANSPORT",
      message: "LLM transport failed",
    });
  });

  it("extracts tool calls and serializes subsequent tool results", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "read_email", arguments: '{"emailId":"email-1"}' },
                  },
                ],
              },
            },
          ],
          usage: {},
        }),
      )
      .mockResolvedValueOnce(response(openai("Done.")));
    const client = createLlmClient({ provider: "ollama", model: "local" }, { fetch: fetcher });
    const first = await client.complete({ ...opts, json: undefined, tools: [readTool] });
    expect(first.toolCalls).toEqual([
      { id: "call-1", name: "read_email", arguments: { emailId: "email-1" } },
    ]);
    await client.complete({
      system: "Read.",
      tools: [readTool],
      messages: [
        { role: "user", content: "Read email" },
        { role: "assistant", content: "", toolCalls: first.toolCalls },
        { role: "tool", content: '{"subject":"hello"}', toolCallId: "call-1" },
      ],
    });
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-1" });
    expect(body.messages[2].tool_calls[0].function.arguments).toBe('{"emailId":"email-1"}');
  });

  it("rejects schema violations, truncated output, refusals, and malformed envelopes", async () => {
    const replies = [
      openai('{"category":"other"}'),
      { choices: [{ finish_reason: "length", message: { content: "{}" } }] },
      { choices: [{ message: { refusal: "Cannot comply" } }] },
      { choices: [] },
    ];
    const codes = ["LLM_SCHEMA", "LLM_TRUNCATED", "LLM_REFUSAL", "LLM_RESPONSE"];
    const fetcher = vi.fn<typeof fetch>();
    for (const reply of replies) fetcher.mockResolvedValueOnce(response(reply));
    const client = createLlmClient({ provider: "ollama", model: "local" }, { fetch: fetcher });
    for (const code of codes) await expect(client.complete(opts)).rejects.toMatchObject({ code });
  });

  it("does not forward credentials to a URL containing user-info or query parameters", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const baseUrl of [
      "https://user:secret@host.test/v1",
      "https://host.test/v1?apiKey=secret",
    ]) {
      const client = createLlmClient(
        { provider: "openai-compatible", model: "model", baseUrl },
        { fetch: fetcher },
      );
      await expect(client.complete(opts)).rejects.toMatchObject({ code: "LLM_CONFIG" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Anthropic adapter", () => {
  it("forces structured tool output and accounts for cached tokens", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        model: "claude-fast",
        content: [
          {
            type: "tool_use",
            id: "structured-1",
            name: "structured_output",
            input: { category: "newsletters" },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 10,
        },
      }),
    );
    const client = createLlmClient(
      {
        provider: "anthropic",
        model: "claude-main",
        fastModel: "claude-fast",
        apiKey: "private-key",
      },
      {
        fetch: fetcher,
        pricing: {
          "claude-fast": {
            inputUsdPerMillion: 2,
            outputUsdPerMillion: 5,
            cachedInputUsdPerMillion: 0.5,
            cacheWriteUsdPerMillion: 3,
          },
        },
      },
    );
    expect(client).toBeInstanceOf(AnthropicClient);
    const result = await client.complete(opts);
    expect(result.json).toEqual({ category: "newsletters" });
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toMatchObject({
      inputTokens: 150,
      outputTokens: 20,
      totalTokens: 170,
      cachedInputTokens: 40,
      cacheWriteTokens: 10,
    });
    expect(result.usage.costUsd).toBeCloseTo(0.00035);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: "claude-fast",
      tool_choice: { type: "tool", name: "structured_output" },
      max_tokens: 4096,
    });
    expect(body.tools[0].input_schema).toEqual(schema);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/messages");
  });

  it("round-trips tool-use blocks and groups tool results into the following user message", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          content: [
            { type: "text", text: "Reading." },
            { type: "tool_use", id: "tool-1", name: "read_email", input: { emailId: "one" } },
            { type: "tool_use", id: "tool-2", name: "read_email", input: { emailId: "two" } },
          ],
          usage: {},
        }),
      )
      .mockResolvedValueOnce(response({ content: [{ type: "text", text: "Done." }], usage: {} }));
    const client = createLlmClient(
      { provider: "anthropic", model: "claude", apiKey: "private-key" },
      { fetch: fetcher },
    );
    const first = await client.complete({
      system: "Read.",
      messages: [{ role: "user", content: "Read two messages." }],
      tools: [readTool],
    });
    expect(first.toolCalls).toHaveLength(2);
    await client.complete({
      system: "Read.",
      tools: [readTool],
      messages: [
        { role: "user", content: "Read two messages." },
        { role: "assistant", content: first.text, toolCalls: first.toolCalls },
        { role: "tool", toolCallId: "tool-1", content: "one" },
        { role: "tool", toolCallId: "tool-2", content: "missing", isError: true },
      ],
    });
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(body.messages).toHaveLength(3);
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool-1", content: "one" },
        { type: "tool_result", tool_use_id: "tool-2", content: "missing", is_error: true },
      ],
    });
  });

  it("rejects unknown tool names, even inside a structured-output response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        content: [{ type: "tool_use", id: "bad", name: "send_directly", input: {} }],
        usage: {},
      }),
    );
    const client = createLlmClient(
      { provider: "anthropic", model: "claude", apiKey: "private-key" },
      { fetch: fetcher },
    );
    await expect(client.complete(opts)).rejects.toMatchObject({ code: "LLM_TOOL" });
  });

  it("requires cloud-provider API keys without reporting key values", () => {
    expect(() => createLlmClient({ provider: "anthropic", model: "claude" })).toThrow(
      expect.objectContaining({ code: "LLM_CONFIG" }),
    );
    expect(() => createLlmClient({ provider: "openai", model: "model" })).toThrow(
      expect.objectContaining({ code: "LLM_CONFIG" }),
    );
  });
});
