export type {
  HostAgentEvent,
  HostAgentKind,
  HostAgentMcpServer,
  HostAgentReasoning,
  HostAgentSessionRequest,
  HostAgentSessionResult,
  HostAgentStatus,
  HostAgentUsage,
} from "@passport/types";
export type { AgentRunResult, AgentRuntimeOptions, RegistryAgentRuntime } from "./context.js";
export { AgentError, LlmError } from "./errors.js";
export type {
  DetectHostAgentsOptions,
  HostAgentLlmClientOptions,
  ProbeShellEnvironmentOptions,
  ShellEnvironment,
  ShellEnvironmentSource,
} from "./host/index.js";
export {
  applyShellEnvironment,
  detectHostAgents,
  extraBinDirs,
  HOST_AGENT_DEFAULT_MODELS,
  HOST_AGENT_FIXES,
  HOST_AGENT_KINDS,
  HOST_AGENT_MODELS,
  HostAgentLlmClient,
  preferredHostAgent,
  probeShellEnvironment,
  redact,
  resolveHostAgentBinary,
  runHostAgentSession,
  SHELL_ENV_NAMES,
} from "./host/index.js";
export type {
  AgentDecision,
  AgentEmailPatch,
  AgentFinishedEvent,
  AgentMatterAttachParams,
  AgentMatterCreateParams,
  DailyDigest,
} from "./integration.js";
export { getAgentEmailPatch } from "./integration.js";
export { AnthropicClient, createLlmClient, OpenAiCompatibleClient } from "./llm/client.js";
export { extractJson, validateJson } from "./llm/json.js";
export type {
  CompleteOptions,
  JsonSchema,
  LlmClient,
  LlmClientOptions,
  LlmCompletion,
  LlmMessage,
  LlmTool,
  LlmToolCall,
  LlmUsage,
  ModelPricing,
} from "./llm/types.js";
export type { DraftSettings } from "./profile.js";
export { DEFAULT_USER_PROFILE, getUserProfile, setUserProfile } from "./profile.js";
export type { ReadUsage } from "./reads.js";
export { RUN_READ_BUDGET } from "./reads.js";
export { createAgentRuntime } from "./runtime.js";
