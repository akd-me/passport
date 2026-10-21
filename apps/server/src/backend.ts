import type {
  ActionExecutor,
  AgentRuntime,
  EventBus,
  PolicyEngine,
  ProviderKind,
  ProviderRegistry,
  Store,
} from "@passport/types";
import type { PassportConfig } from "./config.js";
import type { createMailboxMcpServer } from "@passport/mcp";

/** The only server dependency: implementations are composed outside the HTTP layer. */
export interface Backend {
  readonly mode: "demo" | "real";
  readonly store: Store;
  readonly executor: ActionExecutor;
  readonly policy: PolicyEngine;
  readonly agent: AgentRuntime;
  readonly providers: ProviderRegistry;
  readonly providerKinds: readonly ProviderKind[];
  readonly bus: EventBus;
  readonly config: PassportConfig;
  /** Fresh protocol state per transport/session; shares policy and persistence. */
  createMcpServer?(): ReturnType<typeof createMailboxMcpServer>;
  updateConfig(
    patch: Partial<Pick<PassportConfig, "llm" | "llmSelection" | "accounts">>,
  ): Promise<void>;
  syncAccount(accountId: string): Promise<void>;
  /** Optional connected-provider push. Must settle on abort. */
  waitForChanges?(accountId: string, signal: AbortSignal): Promise<void>;
  /** Drain due persisted arrivals, sharing the immediate triage queue. */
  processArrivals?(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
