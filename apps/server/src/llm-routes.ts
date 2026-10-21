import type { LlmConfig } from "@passport/types";
import type { Hono } from "hono";
import type { Backend } from "./backend.js";
import {
  AUTO_FALLBACK,
  type ConfigWithFallback,
  isHostAgentProvider,
  LLM_PROVIDERS,
  type PassportConfig,
} from "./config.js";
import { ApiError } from "./errors.js";
import { hostAgentLlm, hostAgents, publicLlm, resolveLlmSelection } from "./llm-selection.js";
import { member, object, string } from "./validation.js";

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    return object(JSON.parse(await request.text()));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("INVALID_JSON", "Expected a JSON object");
  }
}

/**
 * `GET /api/host-agents` (detected Claude Code / Codex CLIs) and `PUT /api/settings/llm`.
 * Host agents and `auto` need no key; HTTP providers still read keys from the environment.
 */
export function installLlmRoutes(app: Hono, backend: Backend): void {
  app.get("/api/host-agents", async (c) =>
    c.json(await hostAgents({ refresh: c.req.query("refresh") === "1" })),
  );
  app.put("/api/settings/llm", async (c) => {
    const input = await body(c.req.raw);
    for (const key of Object.keys(input))
      if (!["provider", "model", "baseUrl", "fastModel"].includes(key))
        throw new ApiError(
          "INVALID_FIELD",
          `Unknown LLM setting ${key}; API keys use PASSPORT_LLM_API_KEY`,
        );
    const provider =
      input.provider === undefined
        ? undefined
        : member(input.provider, [...LLM_PROVIDERS, "auto"] as const, "LLM provider");
    const text = (key: "model" | "baseUrl" | "fastModel") =>
      input[key] === undefined ? undefined : string(input[key], key);
    const current = backend.config;
    if (provider === "auto") {
      // Re-detect now; the configured HTTP settings stay as the fallback.
      const probe = { ...current, llmSelection: "auto" } as ConfigWithFallback;
      await resolveLlmSelection(probe, {
        refresh: true,
        env: { ...process.env, PASSPORT_LLM_PROVIDER: "" },
      });
      await backend.updateConfig({
        llm: probe.llm,
        llmSelection: "auto",
        [AUTO_FALLBACK]: probe[AUTO_FALLBACK],
      } as Partial<PassportConfig>);
      return c.json(publicLlm(backend.config));
    }
    let llm: LlmConfig;
    const next = provider ?? current.llm.provider;
    if (isHostAgentProvider(next)) {
      const same = next === current.llm.provider;
      llm = hostAgentLlm(
        next,
        text("model") ?? (same ? current.llm.model : undefined),
        text("fastModel") ?? (same ? current.llm.fastModel : undefined),
      );
    } else {
      llm = { ...current.llm };
      if (provider !== undefined && provider !== llm.provider) {
        delete llm.apiKey;
        llm.apiKey =
          process.env.PASSPORT_LLM_API_KEY ||
          (provider === "anthropic"
            ? process.env.ANTHROPIC_API_KEY
            : provider === "openai" || provider === "openai-compatible"
              ? process.env.OPENAI_API_KEY
              : undefined);
        if (isHostAgentProvider(current.llm.provider)) {
          delete llm.fastModel;
          if (text("model") === undefined)
            llm.model = {
              anthropic: "claude-sonnet-5-5",
              openai: "gpt-4.1",
              "openai-compatible": "local-model",
              ollama: "llama3.2",
            }[provider as "anthropic"];
        }
      }
      llm.provider = next;
      for (const key of ["model", "baseUrl", "fastModel"] as const) {
        const value = text(key);
        if (value !== undefined) llm[key] = value;
      }
    }
    // Any edit is the user's explicit choice and is persisted as such.
    await backend.updateConfig({ llm, llmSelection: "explicit" });
    return c.json(publicLlm(backend.config));
  });
}
