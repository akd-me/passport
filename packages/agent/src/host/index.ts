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
export { redact } from "./env.js";
export { runHostAgentSession } from "./session.js";
