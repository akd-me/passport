import {
  type AgentRunBudget,
  type AgentRunNotice,
  DEFAULT_AGENT_RUN_BUDGET,
} from "@passport/types";
import { AgentError } from "./errors.js";

/** Validated budget: the defaults with any positive integer overrides. */
export function resolveBudget(overrides: Partial<AgentRunBudget> = {}): AgentRunBudget {
  const budget = { ...DEFAULT_AGENT_RUN_BUDGET, ...overrides };
  for (const value of [budget.maxToolCalls, budget.maxDurationMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AgentError("Run budget limits must be positive integers", "AGENT_CONFIG");
    }
  }
  return budget;
}

/**
 * One run's ceiling, shared by the completion loop and host sessions: a tool call is taken
 * before it runs, and the clock starts when the run does. Once exhausted it stays exhausted.
 */
export class RunBudget {
  private calls = 0;
  private readonly started: number;
  exhausted?: "tool_calls" | "time";

  constructor(
    readonly limits: AgentRunBudget,
    private readonly clock: () => number = Date.now,
  ) {
    this.started = clock();
  }

  get used(): number {
    return this.calls;
  }

  /** Milliseconds left before the time limit (at least 0). */
  remainingMs(): number {
    return Math.max(0, this.started + this.limits.maxDurationMs - this.clock());
  }

  /** False (and exhausted) when the clock ran out. */
  checkTime(): boolean {
    if (!this.exhausted && this.remainingMs() <= 0) {
      this.exhausted = "time";
    }
    return !this.exhausted;
  }

  /** Reserve one tool call; false when the budget is spent. */
  take(): boolean {
    if (!this.checkTime()) {
      return false;
    }
    if (this.calls >= this.limits.maxToolCalls) {
      this.exhausted = "tool_calls";
      return false;
    }
    this.calls++;
    return true;
  }

  /** Mark the time limit reached (a session's timer fired). */
  expire(): void {
    this.exhausted ??= "time";
  }

  notice(): AgentRunNotice {
    const minutes = Math.round(this.limits.maxDurationMs / 60_000);
    const limit =
      this.exhausted === "time"
        ? `${minutes} minute${minutes === 1 ? "" : "s"}`
        : `${this.limits.maxToolCalls} tool calls`;
    return {
      code: "BUDGET_EXHAUSTED",
      text: `Stopped at the run budget (${limit}). Work done so far is kept; send a message to continue.`,
    };
  }
}
