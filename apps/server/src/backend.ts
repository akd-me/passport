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
  updateConfig(
    patch: Partial<Pick<PassportConfig, "llm" | "accounts">>,
  ): Promise<void>;
  syncAccount(accountId: string): Promise<void>;
  /** Optional connected-provider push. Must settle on abort. */
  waitForChanges?(accountId: string, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
