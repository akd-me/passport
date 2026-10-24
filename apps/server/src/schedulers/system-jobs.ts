import type { JobDefinition, Schedule } from "@passport/scheduler";
import type { Store } from "@passport/types";
import { agentJobTimeout } from "../agent-session.js";
import type { Backend } from "../backend.js";
import { registerTaskJobs, routineBinding } from "../tasks/jobs.js";
import type { SecretReferenceStore } from "./secret-references.js";
export async function registerSystemJobs(
  backend: Backend,
  register: (def: JobDefinition) => Promise<void>,
  reconcileAccounts: () => Promise<void>,
  accountCount: () => number,
): Promise<void> {
  const system = (
    id: string,
    name: string,
    schedule: Schedule,
    run: JobDefinition["run"],
    extra: Partial<JobDefinition> = {},
  ) => register({ id, name, kind: "system", schedule, run, ...extra });
  await system(
    "outbox.release",
    "Release delayed outbox",
    { type: "interval", everyMs: 30000 },
    async () => ({
      summary: `Released ${(await backend.executor.releaseDue()).length} actions`,
    }),
    { retry: { maxAttempts: 5, baseMs: 30000, maxMs: 3600000 } },
  );
  await system(
    "agent.arrivals",
    "Retry email triage",
    { type: "interval", everyMs: 30000 },
    async ({ signal }) => {
      await backend.processArrivals?.(signal);
      return { summary: "Processed due email arrivals" };
    },
    { concurrency: "single" },
  );
  await system("trust.decay", "Trust decay", { type: "daily", at: "03:00" }, async () => ({
    summary: `Reviewed ${(await backend.policy.applyDecay()).length} trust categories`,
  }));
  await system(
    "agent.daily_digest",
    "Daily digest",
    {
      type: "daily",
      at: `${String(backend.config.dailyDigestHour).padStart(2, "0")}:00`,
    },
    async ({ agentRunOptions }) => {
      const run = await backend.agent.run(
        { kind: "schedule", name: "daily_digest" },
        agentRunOptions,
      );
      if (run.error) {
        throw new Error(run.error);
      }
      return { summary: run.summary };
    },
    {
      timeoutMs: agentJobTimeout(backend.config.agentBudget),
      ...(await routineBinding(backend, "agent.daily_digest", "Daily digest")),
    },
  );
  await system(
    "agent.matter_review",
    "Review active matters",
    { type: "daily", at: "04:00" },
    async ({ agentRunOptions }) => {
      const run = await backend.agent.run(
        { kind: "schedule", name: "matter_review" },
        agentRunOptions,
      );
      if (run.error) {
        throw new Error(run.error);
      }
      return { summary: run.summary };
    },
    {
      timeoutMs: agentJobTimeout(backend.config.agentBudget),
      ...(await routineBinding(backend, "agent.matter_review", "Review active matters")),
    },
  );
  await registerTaskJobs(backend, register);
  await system(
    "store.maintenance",
    "Store maintenance",
    { type: "weekly", days: [0], at: "03:30" },
    async () => {
      const store = backend.store as Store & {
        maintenance?: () => Promise<void>;
        vacuum?: () => Promise<void>;
        optimizeFts?: () => Promise<void>;
      };
      // The envelope/body cache is bounded: TTL+LRU bodies, then LRU envelopes; vacuum after.
      const bodies = await store.emails.evictBodies?.();
      const envelopes = await store.emails.evictEnvelopes?.();
      const secrets = await (store.secrets as SecretReferenceStore | undefined)?.sweepExpired?.();
      const evicted =
        bodies || envelopes
          ? `; evicted ${bodies?.evicted ?? 0} bodies and ${envelopes?.evicted ?? 0} envelopes`
          : "";
      if (store.maintenance) {
        await store.maintenance();
      } else if (store.vacuum || store.optimizeFts) {
        await store.vacuum?.();
        await store.optimizeFts?.();
      } else if (!evicted && secrets === undefined) {
        return {
          status: "skipped",
          summary: "This store does not expose maintenance operations",
        };
      }
      return {
        summary: `Store maintenance complete${evicted}; expired ${secrets ?? 0} secret references`,
      };
    },
  );
  // Reconcile non-HTTP account changes too, without another ad-hoc timer loop.
  await system(
    "accounts.refresh",
    "Discover account changes",
    { type: "interval", everyMs: backend.config.syncIntervalSeconds * 1000 },
    async () => {
      await reconcileAccounts();
      return { summary: `${accountCount()} accounts registered` };
    },
  );
}
