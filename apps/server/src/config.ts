import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { HOST_AGENT_DEFAULT_MODELS } from "@passport/agent";
import type { Account, LlmConfig, LlmSelection } from "@passport/types";
import { type AgentBudgetConfig, budgetFromEnv, validateAgentBudget } from "./agent-session.js";
import { ApiError } from "./errors.js";
import { warnDeprecatedSyncConfig, watchIntervalSeconds } from "./onboarding/config.js";

export interface PassportConfig {
  dataDir: string;
  host: string;
  port: number;
  mcpPort?: number;
  syncIntervalSeconds: number;
  calendarMaxSyncAgeMinutes?: number;
  /** Deprecated and ignored (v0.3 never backfills); accepted with a one-time warning. */
  sync?: { initialDays?: number };
  /** New-mail watcher. `intervalSeconds` defaults to 30. */
  watch?: { intervalSeconds?: number };
  dailyDigestHour: number;
  llm: LlmConfig;
  /**
   * `auto` (the default) picks a logged-in host agent at startup (Codex, then Claude Code),
   * falling back to `llm`; `explicit` uses `llm` as chosen. See llm-selection.ts.
   */
  llmSelection?: LlmSelection;
  /**
   * Absolute paths to host CLIs outside the discovered locations (Settings → Model).
   * `PASSPORT_CLAUDE_PATH` / `PASSPORT_CODEX_PATH` take precedence.
   */
  hostAgents?: { claudePath?: string; codexPath?: string };
  /** Run budget of task runs (default 200 tool calls, 30 minutes); see agent-session.ts. */
  agentBudget?: AgentBudgetConfig;
  /** One-release arrival fallback; session is the default. */
  triage?: { mode: "session" | "pipeline" };
  accounts: Account[];
}

export const LLM_PROVIDERS = [
  "anthropic",
  "openai",
  "openai-compatible",
  "ollama",
  "claude-code",
  "codex",
] as const;
export const isHostAgentProvider = (provider: string): provider is "claude-code" | "codex" =>
  provider === "claude-code" || provider === "codex";
/** Runtime-only: in auto mode the configured `llm` the file keeps while a host agent is in use. */
export const AUTO_FALLBACK = Symbol("passport.llmAutoFallback");
export type ConfigWithFallback = PassportConfig & { [AUTO_FALLBACK]?: LlmConfig };

export function defaultConfig(
  dataDir = resolve(process.env.PASSPORT_DATA_DIR || join(homedir(), ".passport")),
): PassportConfig {
  return {
    dataDir,
    host: "127.0.0.1",
    port: 3000,
    mcpPort: 4318,
    syncIntervalSeconds: 120,
    calendarMaxSyncAgeMinutes: 10,
    watch: { intervalSeconds: 30 },
    dailyDigestHour: 8,
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    },
    accounts: [],
  };
}

export function validateConfig(config: PassportConfig): PassportConfig {
  warnDeprecatedSyncConfig(config);
  watchIntervalSeconds(config);
  if (
    config.calendarMaxSyncAgeMinutes !== undefined &&
    (!Number.isFinite(config.calendarMaxSyncAgeMinutes) || config.calendarMaxSyncAgeMinutes <= 0)
  ) {
    throw new ApiError("INVALID_CONFIG", "calendarMaxSyncAgeMinutes must be positive");
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new ApiError("INVALID_CONFIG", "port must be 0–65535");
  }
  if (
    config.mcpPort !== undefined &&
    (!Number.isInteger(config.mcpPort) || config.mcpPort < 0 || config.mcpPort > 65535)
  ) {
    throw new ApiError("INVALID_CONFIG", "mcpPort must be 0–65535");
  }
  if (
    !Number.isFinite(config.syncIntervalSeconds) ||
    config.syncIntervalSeconds < 1 ||
    config.syncIntervalSeconds > 2147483
  ) {
    throw new ApiError(
      "INVALID_CONFIG",
      "syncIntervalSeconds must be 1–2147483 (within Node timer limits)",
    );
  }
  if (
    !Number.isInteger(config.dailyDigestHour) ||
    config.dailyDigestHour < 0 ||
    config.dailyDigestHour > 23
  ) {
    throw new ApiError("INVALID_CONFIG", "dailyDigestHour must be 0–23");
  }
  if (
    !(LLM_PROVIDERS as readonly string[]).includes(config.llm.provider) ||
    !config.llm.model?.trim()
  ) {
    throw new ApiError("INVALID_CONFIG", "A valid LLM provider and model are required");
  }
  if (
    config.llmSelection !== undefined &&
    config.llmSelection !== "auto" &&
    config.llmSelection !== "explicit"
  ) {
    throw new ApiError("INVALID_CONFIG", "llmSelection must be auto or explicit");
  }
  validateHostAgentPaths(config.hostAgents);
  validateAgentBudget(config.agentBudget);
  if (
    config.triage !== undefined &&
    (!config.triage || !["session", "pipeline"].includes(config.triage.mode))
  ) {
    throw new ApiError("INVALID_CONFIG", 'triage.mode must be "session" or "pipeline"');
  }
  return config;
}

function validateHostAgentPaths(hostAgents: unknown): void {
  if (hostAgents === undefined) {
    return;
  }
  if (typeof hostAgents !== "object" || hostAgents === null || Array.isArray(hostAgents)) {
    throw new ApiError("INVALID_CONFIG", "hostAgents must be an object");
  }
  for (const key of ["claudePath", "codexPath"] as const) {
    const value = (hostAgents as Record<string, unknown>)[key];
    if (value !== undefined && (typeof value !== "string" || !isAbsolute(value))) {
      throw new ApiError("INVALID_CONFIG", `hostAgents.${key} must be an absolute path`);
    }
  }
}

export function llmConfigured(llm: LlmConfig): boolean {
  return (
    isHostAgentProvider(llm.provider) ||
    llm.provider === "ollama" ||
    (llm.provider === "openai-compatible" && !!llm.baseUrl?.trim()) ||
    !!llm.apiKey?.trim()
  );
}

/** Environment overrides win. Public API responses always omit API keys. */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<PassportConfig> {
  const dataDir = resolve(env.PASSPORT_DATA_DIR || join(homedir(), ".passport"));
  let saved: Partial<PassportConfig> = {};
  try {
    saved = JSON.parse(await readFile(join(dataDir, "passport.config.json"), "utf8"));
  } catch (error) {
    // An absent configuration uses defaults; other filesystem errors propagate.

    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const base = defaultConfig(dataDir);
  const config = {
    ...base,
    ...saved,
    dataDir,
    llm: { ...base.llm, ...saved.llm },
  };
  if (env.PASSPORT_HOST) {
    config.host = env.PASSPORT_HOST;
  }
  if (env.PASSPORT_PORT) {
    config.port = Number(env.PASSPORT_PORT);
  }
  if (env.PASSPORT_MCP_PORT) {
    config.mcpPort = Number(env.PASSPORT_MCP_PORT);
  }
  if (env.PASSPORT_SYNC_INTERVAL_SECONDS) {
    config.syncIntervalSeconds = Number(env.PASSPORT_SYNC_INTERVAL_SECONDS);
  }
  if (env.PASSPORT_WATCH_INTERVAL_SECONDS) {
    config.watch = {
      ...config.watch,
      intervalSeconds: Number(env.PASSPORT_WATCH_INTERVAL_SECONDS),
    };
  }
  if (env.PASSPORT_CALENDAR_MAX_SYNC_AGE_MINUTES) {
    config.calendarMaxSyncAgeMinutes = Number(env.PASSPORT_CALENDAR_MAX_SYNC_AGE_MINUTES);
  }
  if (env.PASSPORT_DIGEST_HOUR) {
    config.dailyDigestHour = Number(env.PASSPORT_DIGEST_HOUR);
  }
  if (env.PASSPORT_LLM_PROVIDER) {
    config.llm.provider = env.PASSPORT_LLM_PROVIDER as LlmConfig["provider"];
  }
  if (saved.llm?.provider && saved.llm.provider !== config.llm.provider) {
    delete config.llm.apiKey;
  }
  if (!saved.llm?.model && !env.PASSPORT_LLM_MODEL) {
    config.llm.model = {
      anthropic: "claude-sonnet-5-5",
      openai: "gpt-4.1",
      "openai-compatible": "local-model",
      ollama: "llama3.2",
      "claude-code": HOST_AGENT_DEFAULT_MODELS["claude-code"].main,
      codex: HOST_AGENT_DEFAULT_MODELS.codex.main,
    }[config.llm.provider];
  }
  // A host agent switched in by environment must not inherit another provider's endpoint or fast model.
  if (isHostAgentProvider(config.llm.provider) && saved.llm?.provider !== config.llm.provider) {
    delete config.llm.baseUrl;
    delete config.llm.fastModel;
    if (!env.PASSPORT_LLM_MODEL) {
      config.llm.model = HOST_AGENT_DEFAULT_MODELS[config.llm.provider].main;
    }
  }
  if (env.PASSPORT_LLM_MODEL) {
    config.llm.model = env.PASSPORT_LLM_MODEL;
  }
  if (env.PASSPORT_LLM_BASE_URL) {
    config.llm.baseUrl = env.PASSPORT_LLM_BASE_URL;
  }
  if (env.PASSPORT_LLM_FAST_MODEL) {
    config.llm.fastModel = env.PASSPORT_LLM_FAST_MODEL;
  }
  config.llm.apiKey =
    env.PASSPORT_LLM_API_KEY ||
    (config.llm.provider === "anthropic"
      ? env.ANTHROPIC_API_KEY
      : config.llm.provider === "openai" || config.llm.provider === "openai-compatible"
        ? env.OPENAI_API_KEY
        : undefined) ||
    config.llm.apiKey;
  if (isHostAgentProvider(config.llm.provider)) {
    delete config.llm.apiKey;
  }
  config.llmSelection = saved.llmSelection ?? inferSelection(saved.llm);
  config.agentBudget = budgetFromEnv(saved.agentBudget, env);
  return validateConfig(config);
}

/**
 * Pre-v0.2 files have no `llmSelection`. Anything other than the old placeholder default
 * (Anthropic Sonnet with no key, written even by `passport init` with no model) is a choice.
 */
function inferSelection(llm: Partial<LlmConfig> | undefined): LlmSelection {
  if (!llm) {
    return "auto";
  }
  const placeholder =
    (llm.provider ?? "anthropic") === "anthropic" &&
    (llm.model ?? "claude-sonnet-5-5") === "claude-sonnet-5-5" &&
    !llm.apiKey &&
    !llm.baseUrl &&
    !llm.fastModel;
  return placeholder ? "auto" : "explicit";
}

export async function saveConfig(config: PassportConfig): Promise<void> {
  validateConfig(config);
  // In auto mode the detected host agent is runtime state; persist the configured fallback.
  const source =
    (config.llmSelection !== "explicit" && (config as ConfigWithFallback)[AUTO_FALLBACK]) ||
    config.llm;
  const { apiKey: _secret, ...llm } = source;
  // Preserve an operator-authored file key, but never copy an environment override to disk.
  try {
    const saved = JSON.parse(await readFile(join(config.dataDir, "passport.config.json"), "utf8"));
    if (saved.llm?.provider === source.provider && typeof saved.llm.apiKey === "string") {
      Object.assign(llm, { apiKey: saved.llm.apiKey });
    }
  } catch (error) {
    // An absent configuration has no prior values to merge.

    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  // Whitelist account metadata; credentials only ever go through Store.accounts.
  const accounts = config.accounts.map(
    ({
      id,
      kind,
      displayName,
      emailAddress,
      capabilities,
      settings,
      createdAt,
      updatedAt,
      lastSyncAt,
      lastSyncError,
    }) => ({
      id,
      kind,
      displayName,
      emailAddress,
      capabilities,
      settings,
      createdAt,
      updatedAt,
      lastSyncAt,
      lastSyncError,
    }),
  );
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const path = join(config.dataDir, "passport.config.json");
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  // The retired `sync` block is not written back, so its deprecation warning stops (R4-30).
  const { sync: _retired, ...kept } = config as typeof config & { sync?: unknown };
  await writeFile(temp, JSON.stringify({ ...kept, llm, accounts }, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temp, path);
}
