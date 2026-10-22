export type { HostAgentLlmClientOptions } from "./client.js";
export { HOST_AGENT_DEFAULT_MODELS, HOST_AGENT_MODELS, HostAgentLlmClient } from "./client.js";

export type { DetectHostAgentsOptions } from "./detect.js";
export {
  detectHostAgents,
  HOST_AGENT_FIXES,
  HOST_AGENT_KINDS,
  preferredHostAgent,
  resolveHostAgentBinary,
} from "./detect.js";
export { extraBinDirs, redact } from "./env.js";
export { runHostAgentSession } from "./session.js";
export type {
  ProbeShellEnvironmentOptions,
  ShellEnvironment,
  ShellEnvironmentSource,
} from "./shell-env.js";
export {
  applyShellEnvironment,
  probeShellEnvironment,
  SHELL_ENV_NAMES,
} from "./shell-env.js";
