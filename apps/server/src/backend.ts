import type { createMailboxMcpServer } from "@passport/mcp";
import type {
  Account,
  ActionExecutor,
  AgentRun,
  AgentRunOptions,
  AgentRuntime,
  AgentTrigger,
  EventBus,
  MailReaderResolver,
  PolicyEngine,
  ProviderKind,
  ProviderRegistry,
  Store,
} from "@passport/types";
import type { PassportConfig } from "./config.js";
import type { WatchStatus } from "./watch/status.js";
import type { WatchTickResult } from "./watch/watcher.js";

/** The agent runtime with run priorities: `interactive` (composer) starts before `background`. */
export type PassportAgent = Omit<AgentRuntime, "run"> & {
  run(trigger: AgentTrigger, options?: AgentRunOptions): Promise<AgentRun>;
};

/** The only server dependency: implementations are composed outside the HTTP layer. */
export interface Backend {
  readonly mode: "demo" | "real";
  readonly store: Store;
  readonly executor: ActionExecutor;
  readonly policy: PolicyEngine;
  readonly agent: PassportAgent;
  readonly providers: ProviderRegistry;
  readonly providerKinds: readonly ProviderKind[];
  readonly bus: EventBus;
  readonly config: PassportConfig;
  /** Fresh protocol state per transport/session; shares policy and persistence. */
  createMcpServer?(): ReturnType<typeof createMailboxMcpServer>;
  updateConfig(
    patch: Partial<Pick<PassportConfig, "llm" | "llmSelection" | "accounts" | "hostAgents">>,
  ): Promise<void>;
  /** "Sync now": bounded calendar sync plus an immediate new-mail check. */
  syncAccount(accountId: string): Promise<void>;
  /** Bounded calendar sync only (`sync:<accountId>`); falls back to `syncAccount`. */
  syncCalendar?(accountId: string): Promise<void>;
  /** One new-mail watcher tick (`watch:<accountId>` job). Owner process only. */
  watchAccount?(accountId: string): Promise<WatchTickResult>;
  /** Watcher health for `GET /api/accounts` and doctor; null for non-mail accounts. */
  watchStatus?(account: Account): Promise<WatchStatus | null>;
  /** On-demand readers; absent in the demo backend. */
  readers?: MailReaderResolver;
  /** Optional connected-provider push. Must settle on abort. */
  waitForChanges?(accountId: string, signal: AbortSignal): Promise<void>;
  /** Drain due persisted arrivals, sharing the immediate triage queue. */
  processArrivals?(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
