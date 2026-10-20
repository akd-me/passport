import type { ActionExecutor, ActionRecord, ActionRequest, ActionType, AgentRun, EventBus, LlmConfig, PolicyEngine, Store } from "@passport/types";
import type { AgentDecision, DailyDigest } from "./integration.js";
import type { CompleteOptions, JsonSchema, LlmClient, LlmCompletion, LlmUsage } from "./llm/types.js";
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
}

export interface RunContext {
  run: AgentRun;
  store: Store;
  profile: string;
  selfAddresses: Set<string>;
  drafts: DraftSettings;
  actions: ActionRecord[];
  decisions: AgentDecision[];
  downgrades: string[];
  notes: string[];
  usages: LlmUsage[];
  digest?: DailyDigest;
  now: () => string;
  complete: (opts: CompleteOptions) => Promise<LlmCompletion>;
  structured: (schema: JsonSchema, content: string, model?: "main" | "fast") => Promise<Record<string, unknown>>;
  submit: <T extends ActionType>(request: Omit<ActionRequest<T>, "actor" | "runId">) => Promise<ActionRecord>;
}
