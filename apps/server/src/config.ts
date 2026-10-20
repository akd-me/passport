import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Account, LlmConfig } from "@passport/types";
import { ApiError } from "./errors.js";

export interface PassportConfig {
  dataDir: string;
  host: string;
  port: number;
  mcpPort?: number;
  syncIntervalSeconds: number;
  dailyDigestHour: number;
  llm: LlmConfig;
  accounts: Account[];
}

export function defaultConfig(
  dataDir = resolve(
    process.env.PASSPORT_DATA_DIR || join(homedir(), ".passport"),
  ),
): PassportConfig {
  return {
    dataDir,
    host: "127.0.0.1",
    port: 3000,
    mcpPort: 4318,
    syncIntervalSeconds: 120,
    dailyDigestHour: 8,
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    },
    accounts: [],
  };
}

export function validateConfig(config: PassportConfig): PassportConfig {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
    throw new ApiError("INVALID_CONFIG", "port must be 0–65535");
  if (
    config.mcpPort !== undefined &&
    (!Number.isInteger(config.mcpPort) ||
      config.mcpPort < 0 ||
      config.mcpPort > 65535)
  )
    throw new ApiError("INVALID_CONFIG", "mcpPort must be 0–65535");
  if (
    !Number.isFinite(config.syncIntervalSeconds) ||
    config.syncIntervalSeconds < 1 ||
    config.syncIntervalSeconds > 2147483
  )
    throw new ApiError(
      "INVALID_CONFIG",
      "syncIntervalSeconds must be 1–2147483 (within Node timer limits)",
    );
  if (
    !Number.isInteger(config.dailyDigestHour) ||
    config.dailyDigestHour < 0 ||
    config.dailyDigestHour > 23
  )
    throw new ApiError("INVALID_CONFIG", "dailyDigestHour must be 0–23");
  if (
    !["anthropic", "openai", "openai-compatible", "ollama"].includes(
      config.llm.provider,
    ) ||
    !config.llm.model?.trim()
  )
    throw new ApiError(
      "INVALID_CONFIG",
      "A valid LLM provider and model are required",
    );
  return config;
}

export function llmConfigured(llm: LlmConfig): boolean {
  return (
    llm.provider === "ollama" ||
    (llm.provider === "openai-compatible" && !!llm.baseUrl?.trim()) ||
    !!llm.apiKey?.trim()
  );
}

/** Environment overrides win. Public API responses always omit API keys. */
export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PassportConfig> {
  const dataDir = resolve(
    env.PASSPORT_DATA_DIR || join(homedir(), ".passport"),
  );
  let saved: Partial<PassportConfig> = {};
  try {
    saved = JSON.parse(
      await readFile(join(dataDir, "passport.config.json"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const base = defaultConfig(dataDir);
  const config = {
    ...base,
    ...saved,
    dataDir,
    llm: { ...base.llm, ...saved.llm },
  };
  if (env.PASSPORT_HOST) config.host = env.PASSPORT_HOST;
  if (env.PASSPORT_PORT) config.port = Number(env.PASSPORT_PORT);
  if (env.PASSPORT_MCP_PORT) config.mcpPort = Number(env.PASSPORT_MCP_PORT);
  if (env.PASSPORT_SYNC_INTERVAL_SECONDS)
    config.syncIntervalSeconds = Number(env.PASSPORT_SYNC_INTERVAL_SECONDS);
  if (env.PASSPORT_DIGEST_HOUR)
    config.dailyDigestHour = Number(env.PASSPORT_DIGEST_HOUR);
  if (env.PASSPORT_LLM_PROVIDER)
    config.llm.provider = env.PASSPORT_LLM_PROVIDER as LlmConfig["provider"];
  if (saved.llm?.provider && saved.llm.provider !== config.llm.provider)
    delete config.llm.apiKey;
  if (!saved.llm?.model && !env.PASSPORT_LLM_MODEL)
    config.llm.model = {
      anthropic: "claude-sonnet-4-5",
      openai: "gpt-4.1",
      "openai-compatible": "local-model",
      ollama: "llama3.2",
    }[config.llm.provider];
  if (env.PASSPORT_LLM_MODEL) config.llm.model = env.PASSPORT_LLM_MODEL;
  if (env.PASSPORT_LLM_BASE_URL) config.llm.baseUrl = env.PASSPORT_LLM_BASE_URL;
  if (env.PASSPORT_LLM_FAST_MODEL)
    config.llm.fastModel = env.PASSPORT_LLM_FAST_MODEL;
  config.llm.apiKey =
    env.PASSPORT_LLM_API_KEY ||
    (config.llm.provider === "anthropic"
      ? env.ANTHROPIC_API_KEY
      : config.llm.provider === "openai" ||
          config.llm.provider === "openai-compatible"
        ? env.OPENAI_API_KEY
        : undefined) ||
    config.llm.apiKey;
  return validateConfig(config);
}

export async function saveConfig(config: PassportConfig): Promise<void> {
  validateConfig(config);
  const { apiKey: _secret, ...llm } = config.llm;
  // Preserve an operator-authored file key, but never copy an environment override to disk.
  try {
    const saved = JSON.parse(
      await readFile(join(config.dataDir, "passport.config.json"), "utf8"),
    );
    if (
      saved.llm?.provider === config.llm.provider &&
      typeof saved.llm.apiKey === "string"
    )
      Object.assign(llm, { apiKey: saved.llm.apiKey });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
  await writeFile(
    temp,
    JSON.stringify({ ...config, llm, accounts }, null, 2) + "\n",
    { mode: 0o600 },
  );
  await rename(temp, path);
}
