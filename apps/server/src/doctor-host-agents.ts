import { join } from "node:path";
import { HostAgentLlmClient } from "@passport/agent";
import type { HostAgentStatus } from "@passport/types";
import { isHostAgentProvider, llmConfigured, type PassportConfig } from "./config.js";
import type { DoctorCheck } from "./doctor.js";
import { hostAgents } from "./llm-selection.js";
import { logger } from "./logger.js";

export interface HostAgentDoctorOptions {
  hostAgents?: () => Promise<HostAgentStatus[]>;
  /** Replaces the live test completion for a selected host agent. */
  pingHostAgent?: (config: PassportConfig) => Promise<void>;
}

/** One row per host CLI, with the fix (`codex login`, install link) when it is not usable. */
export async function hostAgentChecks(
  config: PassportConfig,
  options: HostAgentDoctorOptions = {},
): Promise<DoctorCheck[]> {
  const statuses = await (options.hostAgents ?? hostAgents)().catch(() => {
    // Host-agent discovery failed during diagnostics.
    logger.warn("Host-agent discovery failed during diagnostics");
    return [];
  });
  const anyAgent = statuses.some((status) => status.ready) || llmConfigured(config.llm);
  return statuses.map((status): DoctorCheck => {
    const selected = config.llm.provider === status.kind;
    if (status.ready) {
      return {
        name: status.label,
        status: "ok",
        detail: [status.version, status.account && `${status.account} login`, selected && "in use"]
          .filter(Boolean)
          .join(" · "),
      };
    }
    const state = status.installed ? "Not logged in." : "Not installed.";
    return {
      name: status.label,
      status: selected ? "error" : anyAgent ? "ok" : "warning",
      detail: `${state}${!selected && anyAgent ? " (optional)" : ""} ${status.fix ?? ""}`.trim(),
    };
  });
}

/** A one-word completion through the selected host agent's fast model. */
export async function pingHostAgent(
  config: PassportConfig,
  options: HostAgentDoctorOptions = {},
): Promise<DoctorCheck> {
  const { llm } = config;
  if (!isHostAgentProvider(llm.provider)) {
    throw new Error("Not a host agent");
  }
  const name = llm.provider === "codex" ? "Codex" : "Claude Code";
  try {
    if (options.pingHostAgent) {
      await options.pingHostAgent(config);
    } else {
      await new HostAgentLlmClient({
        kind: llm.provider,
        model: llm.model,
        ...(llm.fastModel ? { fastModel: llm.fastModel } : {}),
        cwd: join(config.dataDir, "host-agent"),
        timeoutMs: 90_000,
      }).complete({
        system: "Reply with the single word OK.",
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        model: "fast",
      });
    }
    return {
      name: "LLM",
      status: "ok",
      detail: `${name} (${llm.model}) answered a test request using your subscription`,
    };
  } catch (error) {
    // Host-agent diagnostic request failed.
    logger.warn("Host-agent diagnostic request failed");

    // Host-agent errors are composed by Passport (stderr is never included); keep them actionable.
    const code = (error as { code?: unknown }).code;
    const message =
      typeof code === "string" && code.startsWith("HOST_AGENT")
        ? (error as Error).message
        : `${name} test request failed`;
    return { name: "LLM", status: "error", detail: message };
  }
}
