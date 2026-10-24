/** Errors expose stable codes without retaining provider payloads or credentials. */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly code = "AGENT_ERROR",
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export class LlmError extends AgentError {
  constructor(
    message: string,
    code = "LLM_ERROR",
    readonly status?: number,
    /** HTTP 429: when the provider said to retry (`Retry-After`), as an ISO timestamp. */
    readonly retryAfter?: string,
  ) {
    super(message, code);
    this.name = "LlmError";
  }
}
