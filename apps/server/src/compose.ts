import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentRuntime,
  createLlmClient,
  DEFAULT_USER_PROFILE,
  type LlmClient,
} from "@passport/agent";
import { createMailboxMcpServer } from "@passport/mcp";
import { createActionExecutor, createPolicyEngine } from "@passport/policy";
import { createProviderRegistry, type PassportVerifier } from "@passport/providers";
import { InMemoryEventBus, openStore } from "@passport/store";
import type {
  ActionExecutor,
  AgentRunOptions,
  AgentRuntime,
  CalendarEvent,
  Email,
  ProviderRegistry,
} from "@passport/types";
import { type Arrival, ArrivalQueue, type ArrivalTrigger } from "./arrivals.js";
import type { Backend, PassportAgent } from "./backend.js";
import { calendarSafeStore } from "./calendar-safety.js";
import { llmConfigured, type PassportConfig, saveConfig, validateConfig } from "./config.js";
import { ApiError } from "./errors.js";
import { logger } from "./logger.js";
import { checkMasterKey, resolveMasterKey } from "./master-key.js";
import { persistOAuthCredentials } from "./onboarding/oauth.js";
import { AccountSyncService, attachAccountSync } from "./onboarding/sync.js";
import { withMcpReaders } from "./ondemand-wiring.js";
import { installReaderTokenSecret } from "./reader-tokens.js";
import { attachSetupTasks } from "./setup/routes.js";
import { ProviderConnections } from "./sync/connections.js";
import { createTaskSystem, LaneQueue, RunCeilings, runPriority } from "./tasks/wiring.js";
import { backendWatchHooks } from "./watch/backend.js";
import { attachMailWatcher } from "./watch/watcher.js";
import { createOnDemandWiring } from "./watch/wiring.js";

export interface RealBackendOptions {
  /** Client processes may submit Actions, but never run automatic arrivals/jobs. */
  clientMode?: boolean;
  /** Opens without a master key when none can be had (credentials stay sealed). */
  readOnly?: boolean;
  /** Isolated SQLite and dependency injection for offline integration tests. */
  storePath?: string;
  providers?: ProviderRegistry;
  llm?: LlmClient;
  verifier?: PassportVerifier;
}
export interface RealBackend extends Backend {
  readonly mcp: ReturnType<typeof createMailboxMcpServer>;
  createMcpServer(): ReturnType<typeof createMailboxMcpServer>;
  drainAgentQueue(): Promise<void>;
}

/** The sole composition root: providers, persistence, policy, agent and MCP share one gate. */
export async function createRealBackend(
  config: PassportConfig,
  options: RealBackendOptions = {},
): Promise<RealBackend> {
  validateConfig(config);
  const memory = options.storePath === ":memory:";
  if (!memory) {
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  }
  const master = memory
    ? undefined
    : await resolveMasterKey(config.dataDir, { readOnly: options.readOnly });
  const store = openStore({
    path: options.storePath ?? join(config.dataDir, "passport.sqlite"),
    ...(master ? { masterKey: master.key } : {}),
  });
  try {
    await store.migrate();
    if (master) {
      await checkMasterKey(store, master);
      // Sealed reader page tokens stay valid across restarts (R1-4 follow-up).
      installReaderTokenSecret(master.key);
    }
    if ((await store.kv.get("user_profile")) === null) {
      await store.kv.set("user_profile", DEFAULT_USER_PROFILE);
    }
    for (const account of config.accounts) {
      if (!(await store.accounts.get(account.id))) {
        await store.accounts.upsert(account);
      }
    }
    config.accounts = await store.accounts.list();
    const bus = new InMemoryEventBus();
    const providers =
      options.providers ??
      createProviderRegistry({
        onCredentials: (id, credentials) => persistOAuthCredentials(store, id, credentials),
        resolveEmail: (id) => store.emails.get(id, { includeBodies: true }),
        verifier: options.verifier,
      });
    let sync: AccountSyncService;
    const connections = new ProviderConnections(store, providers, async (id, method, result) => {
      if (["getEmail", "createDraft", "updateDraft"].includes(method) && result) {
        return sync.email(id, result as Email);
      }
      if (["createEvent", "updateEvent"].includes(method) && result) {
        return sync.event(id, result as CalendarEvent);
      }
      return result;
    });
    sync = new AccountSyncService(store, bus, connections.mail, connections.calendar);
    const { readers, watcher, freeBusy } = createOnDemandWiring({
      store,
      bus,
      mailFor: connections.mail,
      calendarFor: connections.calendar,
      sync,
    });
    const ceilings = new RunCeilings();
    const policy = createPolicyEngine({ store, bus, ceiling: ceilings.lookup });
    const evaluate = policy.evaluate.bind(policy);
    policy.evaluate = async (request) => {
      const decision = await evaluate(request);
      if (
        options.clientMode &&
        ["send", "calendar_propose"].includes(request.type) &&
        (decision.outcome === "allow" || decision.outcome === "hold") &&
        (await policy.getConfig()).outboxHoldMinutes <= 0
      ) {
        return {
          ...decision,
          outcome: "ask",
          reason:
            "Start passport serve and approve this outward action; client mode has no delayed outbox owner.",
        };
      }
      return request.type === "profile_update" && request.actor.kind === "human"
        ? { ...decision, outcome: "allow", reason: "Human profile edit; reversible and logged." }
        : decision;
    };
    const releasing = new AsyncLocalStorage<boolean>();
    const executor = createActionExecutor({
      log: logger.warn,
      store: calendarSafeStore(
        store,
        bus,
        () => releasing.getStore() === true,
        () => config.calendarMaxSyncAgeMinutes ?? 10,
      ),
      bus,
      policy,
      mailProviderFor: connections.mail,
      calendarProviderFor: connections.calendar,
    });
    const releaseDue = executor.releaseDue;
    executor.releaseDue = (at) => releasing.run(true, () => releaseDue(at));
    const agentJobs = new Set<Promise<unknown>>();
    let closing: Promise<void> | undefined;
    let stopped = false;
    let runtime: AgentRuntime;
    let llm: LlmClient | undefined;
    const lanes = new LaneQueue();
    let enabled = false;
    let currentTrigger: ArrivalTrigger | undefined;
    let currentStep: string | undefined;
    const agentExecutor: ActionExecutor = {
      ...executor,
      submit: async (request) => {
        const runId = currentTrigger?.runId;
        // People may require several actions in one step. Address identity survives
        // retries even when a partial step already created a person's local ID.
        const params = request.params as { patch?: { emails?: string[] }; personId?: string };
        const identity =
          request.type === "person_update"
            ? (params.patch?.emails
                ?.map((email) => email.toLowerCase())
                .sort()
                .join(",") ??
              params.personId ??
              "")
            : "";
        const marker =
          runId && currentStep
            ? `[arrival-step=${currentStep};action=${request.type};identity=${encodeURIComponent(identity)}]`
            : "";
        if (marker) {
          const previous = (await store.actions.query({ runId, limit: 2147483647 })).items.find(
            (action) => action.request.reason.endsWith(marker),
          );
          if (previous) {
            if (["failed", "executing"].includes(previous.status)) {
              throw new ApiError("TRIAGE_ACTION_INCOMPLETE", "Prior triage action requires review");
            }
            return previous;
          }
        }
        return executor.submit({
          ...request,
          ...(runId ? { runId } : {}),
          reason: `${request.reason}${currentTrigger?.availabilityUnverified && request.category === "scheduling" ? "\ncalendar not synced, availability unverified" : ""}${marker ? `\n${marker}` : ""}`,
        });
      },
    };
    const configureAgent = () => {
      enabled = !!options.llm || llmConfigured(config.llm);
      llm =
        options.llm ??
        (enabled
          ? createLlmClient(config.llm, {
              log: logger.warn,
              hostAgentCwd: join(config.dataDir, "host-agent"),
            })
          : undefined);
      runtime = createAgentRuntime({
        log: logger.warn,
        store,
        executor: agentExecutor,
        policy,
        bus,
        llm: llm ?? {
          complete: async () => {
            throw new ApiError("LLM_NOT_CONFIGURED", "LLM not configured");
          },
        },
        selfAddresses: config.accounts.map((account) => account.emailAddress),
        freeBusy,
        readers,
        runId: () => currentTrigger?.runId,
        triageStep: async <T>(step: string, task: () => Promise<T>): Promise<T> => {
          if (currentTrigger?.kind !== "email.received" || !currentTrigger.runId) {
            return task();
          }
          const key = `arrival:${currentTrigger.emailId}`;
          const entry: Arrival | null = JSON.parse((await store.kv.get(key)) ?? "null");
          // Explicit one-off runs need no arrival journal.
          if (!entry) {
            return task();
          }
          if (entry.checkpoints?.[step]) {
            return entry.checkpoints[step].value as T;
          }
          entry.step = step;
          await store.kv.set(key, JSON.stringify(entry));
          currentStep = step;
          try {
            // Recover a step whose action committed before its checkpoint did.
            const actions = (
              await store.actions.query({ runId: currentTrigger.runId, limit: 2147483647 })
            ).items;
            const stepActions = actions.filter((action) =>
              action.request.reason.split("\n").at(-1)?.startsWith(`[arrival-step=${step};`),
            );
            const previous =
              step === "playbook"
                ? stepActions.find((action) =>
                    ["archive", "draft_create"].includes(action.request.type),
                  )
                : stepActions[0];
            let value: T;
            if (previous && ["matter", "scheduling", "playbook"].includes(step)) {
              if (["failed", "executing"].includes(previous.status)) {
                throw new ApiError(
                  "TRIAGE_ACTION_INCOMPLETE",
                  "Prior triage action requires review",
                );
              }
              const email = await store.emails.get(currentTrigger.emailId);
              const matter = email?.matterId ? await store.matters.get(email.matterId) : null;
              value = (
                step === "matter"
                  ? {
                      ...(matter ? { id: matter.id } : {}),
                      summary: matter?.summary ?? "Review this email",
                    }
                  : undefined
              ) as T;
            } else {
              value = await task();
            }
            entry.checkpoints = { ...entry.checkpoints, [step]: { value } };
            await store.kv.set(key, JSON.stringify(entry));
            return value;
          } finally {
            currentStep = undefined;
          }
        },
      });
      if (!enabled) {
        logger.warn("LLM not configured; agent disabled. Configure an API key or a local model.");
      }
    };
    configureAgent();
    const agent: PassportAgent = {
      getUserProfile: () => runtime.getUserProfile(),
      setUserProfile: (markdown) => runtime.setUserProfile(markdown),
      run: (trigger, runOptions?: AgentRunOptions) => {
        if (stopped) {
          return Promise.reject(new ApiError("BACKEND_CLOSED", "Backend is closed"));
        }
        // Digests and outbox processing remain useful without inference.
        if (!enabled && (trigger.kind !== "schedule" || trigger.name === "matter_review")) {
          return Promise.reject(new ApiError("LLM_NOT_CONFIGURED", "LLM not configured"));
        }
        // Keep one serialization boundary even when account/model settings replace the runtime.
        const job = lanes.enqueue(
          runPriority(trigger, runOptions?.priority),
          async () => {
            currentTrigger = trigger as ArrivalTrigger;
            try {
              return await runtime.run(trigger, runOptions);
            } finally {
              currentTrigger = undefined;
            }
          },
          runOptions?.signal,
        );
        agentJobs.add(job);
        void job.then(
          () => agentJobs.delete(job),
          () => agentJobs.delete(job),
        );
        return job;
      },
    };
    const tasks = options.clientMode
      ? undefined
      : createTaskSystem({
          store,
          bus,
          policy,
          agent,
          ceilings,
          executor,
          watcher,
          titleModel: async (request) => {
            if (!llm || stopped) {
              throw new ApiError("LLM_NOT_CONFIGURED", "LLM not configured");
            }
            return llm.complete(request);
          },
        });
    const arrivals = options.clientMode
      ? undefined
      : new ArrivalQueue(
          store,
          bus,
          tasks?.triggers.arrivalAgent(agent) ?? agent,
          () => enabled && !stopped,
          tasks ? (counts) => tasks.triggers.reportDroppedArrivals(counts) : undefined,
        );
    const unsubscribe = options.clientMode
      ? () => {}
      : bus.on("email.received", ({ email }) => {
          if (!enabled || stopped) {
            return;
          }
          void arrivals!.enqueue(email.id, email.accountId);
        });
    const drainAgentQueue = async () => {
      await arrivals?.drain();
      while (agentJobs.size) {
        await Promise.allSettled([...agentJobs]);
      }
    };
    const dependencies = { store, executor, policy, bus, log: logger.warn };
    const mcpDependencies = withMcpReaders({ ...dependencies, freeBusy }, readers, config.dataDir);
    const mcp = createMailboxMcpServer(mcpDependencies);
    const servers = new Set([mcp]);
    return attachSetupTasks(
      attachMailWatcher(
        attachAccountSync<RealBackend>(
          {
            mode: "real",
            ...dependencies,
            providers,
            config,
            agent,
            tasks,
            mcp,
            providerKinds: [
              "gmail",
              "graph",
              "imap",
              "jmap",
              "google-calendar",
              "graph-calendar",
              "caldav",
              "mock",
            ],
            createMcpServer() {
              const server = createMailboxMcpServer(mcpDependencies);
              servers.add(server);
              return server;
            },
            async updateConfig(patch) {
              await drainAgentQueue();
              const next = validateConfig({ ...config, ...patch });
              if (!memory) {
                await saveConfig(next);
              }
              Object.assign(config, next);
              configureAgent();
            },
            ...backendWatchHooks({ store, config, readers, sync, watcher, closed: () => stopped }),
            async waitForChanges(id, signal) {
              if (signal.aborted) {
                return;
              }
              const provider = await connections.mail(id);
              if (provider.waitForChanges) {
                await provider.waitForChanges(signal);
              } else {
                await new Promise<void>((resolve) => {
                  if (signal.aborted) {
                    resolve();
                  } else {
                    signal.addEventListener("abort", () => resolve(), { once: true });
                  }
                });
              }
            },
            drainAgentQueue,
            processArrivals: (signal) => arrivals?.drainDue(signal) ?? Promise.resolve(),
            close: () =>
              (closing ??= (async () => {
                await sync.drain();
                await watcher.stop();
                unsubscribe();
                // Pending watch wakes stay persisted for the next start instead of firing now.
                await tasks?.watches.close();
                await drainAgentQueue();
                await tasks?.close();
                stopped = true;
                await Promise.allSettled([...servers].map((server) => server.close()));
                await connections.close();
                await store.close();
              })()),
          },
          sync,
        ),
        watcher,
      ),
    );
  } catch (error) {
    // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

    await store.close();
    throw error;
  }
}
