/** Errors expose stable codes without retaining provider payloads or credentials. */
export class AgentError extends Error {
  constructor(message: string, readonly code = "AGENT_ERROR") {
    super(message);
    this.name = "AgentError";
  }
}

export class LlmError extends AgentError {
  constructor(message: string, code = "LLM_ERROR", readonly status?: number) {
    super(message, code);
    this.name = "LlmError";
  }
}
