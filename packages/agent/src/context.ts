import type { Tool, ToolContext, ToolResult } from "@passport/tools";
import type {
  ActionExecutor,
  ActionRecord,
  AgentRun,
  EventBus,
  LlmConfig,
  PolicyEngine,
  Store,
} from "@passport/types";
import type { AgentDecision, DailyDigest } from "./integration.js";
import type {
  CompleteOptions,
  JsonSchema,
  LlmClient,
  LlmCompletion,
  LlmUsage,
} from "./llm/types.js";
import type { DraftSettings } from "./profile.js";

export interface AgentRuntimeOptions {
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
  complete: (opts: CompleteOptions) => Promise<LlmCompletion>;
  structured: (
    schema: JsonSchema,
    content: string,
    model?: "main" | "fast",
  ) => Promise<Record<string, unknown>>;
  tools: Tool[];
  toolCalls: number;
  callTool: (name: string, input: unknown, context?: ToolContext) => Promise<ToolResult>;
}

export interface AgentRunResult extends AgentRun {
  toolBudget: {
    callsMade: number;
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}
export interface RegistryAgentRuntime extends Omit<import("@passport/types").AgentRuntime, "run"> {
  run(trigger: import("@passport/types").AgentTrigger): Promise<AgentRunResult>;
}
