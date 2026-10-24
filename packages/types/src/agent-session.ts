/**
 * Additive contract (v0.4, W1A): agentic task runs. A task run on a host agent (Codex or Claude
 * Code) is one streamed session with Passport's tool belt attached over MCP; follow-ups resume
 * the provider's session. Every run, host or API provider, shares one budget. See
 * `docs/tasks.md` §Runs and `docs/tools.md` §Host integration. Re-exported from `./index.ts`.
 */

import type { HostAgentKind } from "./index.js";

/** Ceiling of one agent run: tool calls and wall time. Hitting either ends it (`BUDGET_EXHAUSTED`). */
export interface AgentRunBudget {
  maxToolCalls: number;
  maxDurationMs: number;
}

/** 200 tool calls or 30 minutes, whichever comes first. */
export const DEFAULT_AGENT_RUN_BUDGET: AgentRunBudget = {
  maxToolCalls: 200,
  maxDurationMs: 30 * 60_000,
};

/** A provider-side conversation a later run can resume (`claude --resume`, `codex exec resume`). */
export interface ProviderSessionRef {
  kind: HostAgentKind;
  id: string;
}

/** `AgentRunOptions.session`: run a manual trigger as one agentic host session when possible. */
export interface AgentSessionRunOptions {
  /**
   * Resume this provider session with `instruction` as the next turn. Ignored, and the trigger's
   * full instruction used instead, when the configured host agent is a different kind or the
   * resume fails before the session did anything.
   */
  resume?: ProviderSessionRef & { instruction: string };
  /**
   * Resolves `resume` when the run starts rather than when it was queued, so a follow-up queued
   * behind the task's first run resumes the session that run opened. Used when `resume` is absent.
   */
  resolveResume?: () => Promise<(ProviderSessionRef & { instruction: string }) | undefined>;
}

/** A run notice for the timeline (`system_notice`), e.g. `BUDGET_EXHAUSTED`. */
export interface AgentRunNotice {
  code: string;
  text: string;
}

declare module "./agent-ondemand.js" {
  interface AgentRunOptions {
    /** Task runs: prefer one host-agent session with the tool belt over the completion loop. */
    session?: AgentSessionRunOptions;
  }
}

declare module "./tasks.js" {
  interface Task {
    /** The provider session of the task's latest host-agent run; follow-ups resume it. */
    providerSessionId?: string | null;
    /** Host agent that owns `providerSessionId`; another kind starts a fresh session. */
    providerSessionKind?: HostAgentKind | null;
  }
  interface AgentRunObserver {
    /** A notice the timeline should show (`system_notice` with `code`). */
    notice?(notice: AgentRunNotice): void;
    /** The host agent opened (or resumed) a provider session for this run. */
    providerSession?(session: ProviderSessionRef): void;
  }
}

declare module "./index.js" {
  interface HostAgentSessionRequest {
    /** Resume this provider session (Claude `--resume`, Codex `exec resume`); implies persistence. */
    resumeSessionId?: string;
    /**
     * Keep the session on disk so it can be resumed (drops `--no-session-persistence` and
     * `--ephemeral`). Default false.
     */
    persistSession?: boolean;
  }
}
