/**
 * Agentic task runs (v0.4, W1A): the tool belt host-agent sessions call, and the run budget
 * from configuration. Task runs on Codex or Claude Code become one session with Passport's
 * tools attached over in-process Streamable HTTP (a per-run bearer on 127.0.0.1), so every
 * call keeps the run's actor, task id, permission ceiling and on-demand readers.
 */
import type { AgentRuntimeOptions } from "@passport/agent";
import { ToolBeltListener } from "@passport/mcp";
import type { AgentRunBudget } from "@passport/types";
import { ApiError } from "./errors.js";
import { logger } from "./logger.js";

/** `agentBudget` in config.json; `PASSPORT_AGENT_MAX_TOOL_CALLS` / `_MAX_RUN_MINUTES` override. */
export interface AgentBudgetConfig {
  maxToolCalls?: number;
  maxRunMinutes?: number;
}

/** Let the runtime report its budget before the scheduler's outer cancellation fires. */
export function agentJobTimeout(config: AgentBudgetConfig | undefined): number {
  return ((config?.maxRunMinutes ?? 30) + 1) * 60_000;
}

/** The tool belt and budget the agent runtime takes. */
export function agentSessionOptions(
  budget: AgentBudgetConfig | undefined,
): Pick<AgentRuntimeOptions, "toolBelt" | "budget"> {
  return {
    toolBelt: new ToolBeltListener({ log: logger.warn }),
    budget: runBudget(budget),
  };
}

export function runBudget(config: AgentBudgetConfig | undefined): Partial<AgentRunBudget> {
  return {
    ...(config?.maxToolCalls ? { maxToolCalls: config.maxToolCalls } : {}),
    ...(config?.maxRunMinutes ? { maxDurationMs: config.maxRunMinutes * 60_000 } : {}),
  };
}

/** Environment overrides, applied while loading the config. */
export function budgetFromEnv(
  saved: AgentBudgetConfig | undefined,
  env: NodeJS.ProcessEnv,
): AgentBudgetConfig | undefined {
  const next = { ...saved };
  if (env.PASSPORT_AGENT_MAX_TOOL_CALLS) {
    next.maxToolCalls = Number(env.PASSPORT_AGENT_MAX_TOOL_CALLS);
  }
  if (env.PASSPORT_AGENT_MAX_RUN_MINUTES) {
    next.maxRunMinutes = Number(env.PASSPORT_AGENT_MAX_RUN_MINUTES);
  }
  return Object.keys(next).length ? next : undefined;
}

export function validateAgentBudget(config: unknown): void {
  if (config === undefined) {
    return;
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new ApiError("INVALID_CONFIG", "agentBudget must be an object");
  }
  const { maxToolCalls, maxRunMinutes } = config as Record<string, unknown>;
  if (
    maxToolCalls !== undefined &&
    !(
      Number.isInteger(maxToolCalls) &&
      (maxToolCalls as number) >= 1 &&
      (maxToolCalls as number) <= 10_000
    )
  ) {
    throw new ApiError("INVALID_CONFIG", "agentBudget.maxToolCalls must be an integer 1–10000");
  }
  if (
    maxRunMinutes !== undefined &&
    !(
      Number.isInteger(maxRunMinutes) &&
      (maxRunMinutes as number) >= 1 &&
      (maxRunMinutes as number) <= 1440
    )
  ) {
    throw new ApiError("INVALID_CONFIG", "agentBudget.maxRunMinutes must be an integer 1–1440");
  }
}
