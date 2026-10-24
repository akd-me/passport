import type { Tool, ToolContext, ToolResult } from "@passport/tools";
import type {
  ActionExecutor,
  ActionRecord,
  AgentRun,
  AgentRunBudget,
  AgentRunObserver,
  AgentRunOptions,
  EventBus,
  LlmConfig,
  MailReaderResolver,
  PolicyEngine,
  QuotaLane,
  Store,
} from "@passport/types";
import type { RunBudget } from "./budget.js";
import type { AgentDecision, DailyDigest } from "./integration.js";
import type {
  CompleteOptions,
  JsonSchema,
  LlmClient,
  LlmCompletion,
  LlmUsage,
} from "./llm/types.js";
import type { DraftSettings } from "./profile.js";
import type { ReadUsage, RunReads } from "./reads.js";

export interface AgentRuntimeOptions {
  log?: (message: string) => void;
  store: Store;
  executor: ActionExecutor;
  policy: PolicyEngine;
  bus: EventBus;
  llm: LlmConfig | LlmClient;
  selfAddresses: string[];
  /** Inactivity threshold, default seven days. */
  matterReviewDays?: number;
  drafts?: DraftSettings;
  /** Injectable clock for schedulers and tests. */
  now?: () => string;
  freeBusy?: import("@passport/tools").FreeBusyResolver;
  /** Host-owned durable arrival checkpoints; ordinary/manual runs can run the task directly. */
  triageStep?: <T>(step: string, task: () => Promise<T>) => Promise<T>;
  /** A host may supply a stable identity for retries of the same durable trigger. */
  runId?: (trigger: import("@passport/types").AgentTrigger) => string | undefined;
  /**
   * On-demand readers (v0.3). When an account resolves to a reader, people evidence, matter
   * candidates and reply threads come from the provider instead of local mirror scans.
   */
  readers?: MailReaderResolver;
  /**
   * Exposes a run's tools to host-agent sessions over MCP (v0.4). With it, task runs on Codex or
   * Claude Code are one native session (`AgentRunOptions.session`); without it they use the
   * completion loop.
   */
  toolBelt?: import("./session-run.js").ToolBeltHost;
  /** Per-run ceiling for task and manual runs; default 200 tool calls and 30 minutes. */
  budget?: Partial<AgentRunBudget>;
  /** One-release fallback for arrival inference; defaults to session. */
  triage?: { mode: "session" | "pipeline" };
}

export interface RunContext {
  run: AgentRun;
  store: Store;
  profile: string;
  policy: PolicyEngine;
  selfAddresses: Set<string>;
  drafts: DraftSettings;
  actions: ActionRecord[];
  decisions: AgentDecision[];
  downgrades: string[];
  notes: string[];
  usages: LlmUsage[];
  digest?: DailyDigest;
  now: () => string;
  freeBusy?: import("@passport/tools").FreeBusyResolver;
  triageStep?: AgentRuntimeOptions["triageStep"];
  /** Quota lane for this run's provider reads (interactive runs use `"interactive"`). */
  lane: QuotaLane;
  /** Metered provider reads, shared across the run's steps. */
  reads: RunReads;
  complete: (opts: CompleteOptions) => Promise<LlmCompletion>;
  structured: (
    schema: JsonSchema,
    content: string,
    model?: "main" | "fast",
  ) => Promise<Record<string, unknown>>;
  tools: Tool[];
  toolCalls: number;
  /** Tool-call and time ceiling of manual and task runs. */
  budget: RunBudget;
  /** The task runner's timeline hooks, when the run belongs to a task. */
  observer?: AgentRunObserver;
  /** Code-derived arrival evidence, retained across native tool calls. */
  arrival?: {
    email: import("@passport/types").Email;
    people: import("@passport/types").Person[];
    personIds: string[];
    category?: import("@passport/types").ActionCategory;
    alwaysAsk: import("@passport/types").ActionCategory[];
  };
  readOnly?: boolean;
  callTool: (name: string, input: unknown, context?: ToolContext) => Promise<ToolResult>;
}

export interface AgentRunResult extends AgentRun {
  toolBudget: {
    callsMade: number;
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** Provider reads through the injected `readers`; absent when none were attempted. */
    reads?: ReadUsage;
  };
}
export interface RegistryAgentRuntime extends Omit<import("@passport/types").AgentRuntime, "run"> {
  /** Queue a run. Manual triggers default to `"interactive"` priority, everything else `"background"`. */
  run(
    trigger: import("@passport/types").AgentTrigger,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult>;
  /** Runs waiting to start, by priority (the run in progress is not counted). */
  queued(): Record<import("@passport/types").AgentRunPriority, number>;
}
