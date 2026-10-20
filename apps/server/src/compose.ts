import type { Backend } from "./backend.js";
import type { PassportConfig } from "./config.js";
import { NotImplementedError } from "./errors.js";

/** INTEGRATION SEAM — intentionally no imports of unfinished workspace packages.
 * Expected package-root factories (adapt their signatures at integration):
 * @passport/store: openStore({ dataDir, masterKey }) -> Store (plus its EventBus).
 * @passport/providers: createProviderRegistry({ store, bus }) -> ProviderRegistry.
 * @passport/policy: createPolicyEngine({ store, bus }) -> PolicyEngine;
 *   createActionExecutor({ store, providers, policy, bus }) -> ActionExecutor.
 * @passport/agent: createAgentRuntime({ store, providers, policy, executor, bus, llm }) -> AgentRuntime.
 * @passport/mcp: createMailboxMcpServer({ store, providers, policy, executor, bus }) -> MCP server.
 * Return Backend with those six interfaces; implement syncAccount (consume mail/calendar
 * deltas, persist cursor after data, emit account.synced/email.received, trigger agent),
 * optional abortable waitForChanges, updateConfig via saveConfig, and close all resources.
 * Hydrate config.accounts into Store; credentials must be read from Store, never JSON.
 * Wire mailbox MCP stdio in cli.ts, and restore package dependencies only in integration.
 * Factory signatures above express dependencies, not assertions about unfinished APIs.
 */
export async function createRealBackend(
  _config: PassportConfig,
): Promise<Backend> {
  throw new NotImplementedError(
    "Real backend composition is reserved for integration. Run `passport demo` for the complete in-memory experience.",
  );
}
