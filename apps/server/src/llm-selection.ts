import type { HostAgentStatus, LlmConfig, LlmSelection } from "@passport/types";
import { detectHostAgents, preferredHostAgent, HOST_AGENT_DEFAULT_MODELS } from "@passport/agent";
import { AUTO_FALLBACK, isHostAgentProvider, llmConfigured, type ConfigWithFallback, type PassportConfig } from "./config.js";
import { logger } from "./logger.js";

export type HostAgentDetector = (options?: { refresh?: boolean }) => Promise<HostAgentStatus[]>;
let detector: HostAgentDetector = options => detectHostAgents(options);

/** Tests replace host-agent detection; returns the previous detector. */
export function setHostAgentDetector(next: HostAgentDetector): HostAgentDetector {
  const previous = detector;
  detector = next;
  return previous;
}
export function hostAgents(options?: { refresh?: boolean }): Promise<HostAgentStatus[]> {
  return detector(options).catch(() => []);
}

const NAMES = { "claude-code": "Claude Code", codex: "Codex" } as const;

export function hostAgentLlm(kind: "claude-code" | "codex", model?: string, fastModel?: string): LlmConfig {
  const defaults = HOST_AGENT_DEFAULT_MODELS[kind];
  return { provider: kind, model: model?.trim() || defaults.main, fastModel: fastModel?.trim() || defaults.fast };
}

export interface LlmResolution {
  selection: LlmSelection;
  /** Why this provider: an env pin, the saved choice, a detected host agent, or the fallback. */
  source: "env" | "explicit" | "host-agent" | "fallback" | "none";
  llm: LlmConfig;
  statuses?: HostAgentStatus[];
}

/**
 * Apply `auto` selection: a logged-in Codex, else Claude Code, else the configured HTTP
 * provider, else no agent (mail still works). `PASSPORT_LLM_PROVIDER` pins the provider and
 * an explicit saved choice is kept. Mutates `config.llm`; the configured fallback is kept
 * out of band so saving never persists the detected agent over it.
 */
export async function resolveLlmSelection(
  config: PassportConfig,
  options: { env?: NodeJS.ProcessEnv; refresh?: boolean; log?: boolean } = {},
): Promise<LlmResolution> {
  const env = options.env ?? process.env;
  const report = (resolution: LlmResolution) => {
    if (options.log) logger.info(describeLlm(resolution));
    return resolution;
  };
  if (env.PASSPORT_LLM_PROVIDER) return report({ selection: "explicit", source: "env", llm: config.llm });
  if ((config.llmSelection ?? "auto") === "explicit") return report({ selection: "explicit", source: "explicit", llm: config.llm });
  const target = config as ConfigWithFallback;
  const fallback = (target[AUTO_FALLBACK] ??= config.llm);
  const statuses = await hostAgents({ refresh: options.refresh });
  const pick = preferredHostAgent(statuses);
  if (pick) {
    const keep = fallback.provider === pick.kind ? fallback : undefined;
    config.llm = hostAgentLlm(pick.kind, keep?.model, keep?.fastModel);
    return report({ selection: "auto", source: "host-agent", llm: config.llm, statuses });
  }
  // A host agent saved as the fallback but now unavailable leaves only environment keys.
  config.llm = isHostAgentProvider(fallback.provider)
    ? { provider: "anthropic", model: "claude-sonnet-5-5", ...(env.PASSPORT_LLM_API_KEY || env.ANTHROPIC_API_KEY ? { apiKey: env.PASSPORT_LLM_API_KEY || env.ANTHROPIC_API_KEY } : {}) }
    : fallback;
  return report({ selection: "auto", source: llmConfigured(config.llm) ? "fallback" : "none", llm: config.llm, statuses });
}

export function describeLlm(resolution: LlmResolution): string {
  const { llm } = resolution;
  if (isHostAgentProvider(llm.provider)) {
    const status = resolution.statuses?.find(item => item.kind === llm.provider);
    return `Agent model: ${NAMES[llm.provider]} (${llm.model})${status?.account ? ` via ${status.account} login` : ""}${resolution.source === "host-agent" ? ", detected automatically" : ""}.`;
  }
  if (resolution.source === "none") return "No agent model available: log in to Codex (`codex login`) or Claude Code (`claude auth login`). Mail sync still works.";
  return `Agent model: ${llm.provider} (${llm.model}).`;
}

/** The browser-safe view of the LLM settings. Keys never leave the server. */
export function publicLlm(config: PassportConfig): Omit<LlmConfig, "apiKey"> & { apiKeyConfigured: boolean; configured: boolean; selection: LlmSelection } {
  const { apiKey, ...llm } = config.llm;
  return { ...llm, apiKeyConfigured: !!apiKey, configured: llmConfigured(config.llm), selection: config.llmSelection ?? "auto" };
}
