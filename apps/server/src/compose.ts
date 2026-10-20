import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, mkdir, link, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryEventBus, openStore } from "@passport/store";
import {
  createProviderRegistry,
  type PassportVerifier,
} from "@passport/providers";
import { createActionExecutor, createPolicyEngine } from "@passport/policy";
import {
  createAgentRuntime,
  createLlmClient,
  DEFAULT_USER_PROFILE,
  type LlmClient,
} from "@passport/agent";
import { createMailboxMcpServer } from "@passport/mcp";
import type {
  AgentRuntime,
  ActionExecutor,
  CalendarEvent,
  Email,
  ProviderRegistry,
} from "@passport/types";
import type { Backend } from "./backend.js";
import {
  saveConfig,
  validateConfig,
  llmConfigured,
  type PassportConfig,
} from "./config.js";
import { ApiError } from "./errors.js";
import { logger } from "./logger.js";
import { persistOAuthCredentials } from "./onboarding/oauth.js";
import { AccountSyncService, attachAccountSync } from "./onboarding/sync.js";
import { ProviderConnections } from "./sync/connections.js";
import { ArrivalQueue, type ArrivalTrigger } from "./arrivals.js";
import { calendarSafeStore } from "./calendar-safety.js";

export interface RealBackendOptions {
  /** Client processes may submit Actions, but never run automatic arrivals/jobs. */
  clientMode?: boolean;
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

async function masterKey(dataDir: string): Promise<string> {
  if (process.env.PASSPORT_MASTER_KEY) return process.env.PASSPORT_MASTER_KEY;
  const path = join(dataDir, "master.key");
  try {
    await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temp, randomBytes(32).toString("base64url") + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      try {
        await link(temp, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await rm(temp, { force: true });
    }
  }
  await chmod(path, 0o600);
  const key = (await readFile(path, "utf8")).trim();
  if (!key)
    throw new ApiError("INVALID_MASTER_KEY", "Master key file is empty");
  return key;
}

/** The sole composition root: providers, persistence, policy, agent and MCP share one gate. */
export async function createRealBackend(
  config: PassportConfig,
  options: RealBackendOptions = {},
): Promise<RealBackend> {
  validateConfig(config);
  const memory = options.storePath === ":memory:";
  if (!memory) await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const store = openStore({
    path: options.storePath ?? join(config.dataDir, "passport.sqlite"),
    ...(memory ? {} : { masterKey: await masterKey(config.dataDir) }),
  });
  try {
    await store.migrate();
    if (await store.kv.get("user_profile") === null) await store.kv.set("user_profile", DEFAULT_USER_PROFILE);
    for (const account of config.accounts)
      if (!(await store.accounts.get(account.id)))
        await store.accounts.upsert(account);
    config.accounts = await store.accounts.list();
    const bus = new InMemoryEventBus();
    const providers =
      options.providers ??
      createProviderRegistry({
        onCredentials: (id, credentials) =>
          persistOAuthCredentials(store, id, credentials),
        resolveEmail: (id) => store.emails.get(id, { includeBodies: true }),
        verifier: options.verifier,
      });
    let sync: AccountSyncService;
    const connections = new ProviderConnections(
      store,
      providers,
      async (id, method, result) => {
        if (
          ["getEmail", "createDraft", "updateDraft"].includes(method) &&
          result
        )
          return sync.email(id, result as Email);
        if (["createEvent", "updateEvent"].includes(method) && result)
          return sync.event(id, result as CalendarEvent);
        return result;
      },
    );
    sync = new AccountSyncService(store, bus, connections.mail, connections.calendar, config);
    const policy = createPolicyEngine({ store, bus });
    const evaluate = policy.evaluate.bind(policy);
    policy.evaluate = async request => {
      const decision = await evaluate(request);
      if (options.clientMode && ["send", "calendar_propose"].includes(request.type) &&
          (decision.outcome === "allow" || decision.outcome === "hold") &&
          (await policy.getConfig()).outboxHoldMinutes <= 0)
        return { ...decision, outcome: "ask", reason: "Start passport serve and approve this outward action; client mode has no delayed outbox owner." };
      return request.type === "profile_update" && request.actor.kind === "human"
        ? { ...decision, outcome: "allow", reason: "Human profile edit; reversible and logged." }
        : decision;
    };
    const releasing = new AsyncLocalStorage<boolean>();
    const executor = createActionExecutor({
      store: calendarSafeStore(store, bus, () => releasing.getStore() === true),
      bus,
      policy,
      mailProviderFor: connections.mail,
      calendarProviderFor: connections.calendar,
    });
    const releaseDue = executor.releaseDue;
    executor.releaseDue = at => releasing.run(true, () => releaseDue(at));
    const agentJobs = new Set<Promise<unknown>>();
    let closing: Promise<void> | undefined;
    let stopped = false;
    let runtime: AgentRuntime;
    let runQueue: Promise<unknown> = Promise.resolve();
    let enabled = false;
    let currentTrigger: ArrivalTrigger | undefined;
    const agentExecutor: ActionExecutor = {
      ...executor,
      submit: request => executor.submit({
        ...request,
        ...(currentTrigger?.runId ? { runId: currentTrigger.runId } : {}),
        ...(currentTrigger?.availabilityUnverified && request.category === "scheduling"
          ? { reason: `${request.reason}\ncalendar not synced, availability unverified` } : {}),
      }),
    };
    // Mirror runtime checkpoints under the caller's stable identity as well as
    // its generated ID, without depending on a cross-package signature change.
    const runtimeStore = Object.assign(Object.create(store), {
      kv: {
        ...store.kv,
        async set(key: string, value: string) {
          await store.kv.set(key, value);
          if (currentTrigger?.runId && key.startsWith("run:"))
            await store.kv.set(`run:${currentTrigger.runId}`, value);
        },
      },
    });
    const configureAgent = () => {
      enabled = !!options.llm || llmConfigured(config.llm);
      runtime = createAgentRuntime({
        store: runtimeStore,
        executor: agentExecutor,
        policy,
        bus,
        llm:
          options.llm ??
          (enabled
            ? createLlmClient(config.llm)
            : {
                complete: async () => {
                  throw new ApiError(
                    "LLM_NOT_CONFIGURED",
                    "LLM not configured",
                  );
                },
              }),
        selfAddresses: config.accounts.map((account) => account.emailAddress),
      });
      if (!enabled)
        logger.warn(
          "LLM not configured; agent disabled. Configure an API key or a local model.",
        );
    };
    configureAgent();
    const agent: AgentRuntime = {
      getUserProfile: () => runtime.getUserProfile(),
      setUserProfile: (markdown) => runtime.setUserProfile(markdown),
      run: (trigger) => {
        if (stopped)
          return Promise.reject(
            new ApiError("BACKEND_CLOSED", "Backend is closed"),
          );
        // Digests and outbox processing remain useful without inference.
        if (
          !enabled &&
          (trigger.kind !== "schedule" || trigger.name === "matter_review")
        )
          return Promise.reject(
            new ApiError("LLM_NOT_CONFIGURED", "LLM not configured"),
          );
        // Keep one serialization boundary even when account/model settings replace the runtime.
        const job = runQueue.then(async () => {
          currentTrigger = trigger as ArrivalTrigger;
          try { return await runtime.run(trigger); }
          finally { currentTrigger = undefined; }
        });
        runQueue = job.catch(() => undefined);
        agentJobs.add(job);
        void job.then(
          () => agentJobs.delete(job),
          () => agentJobs.delete(job),
        );
        return job;
      },
    };
    const arrivals = options.clientMode ? undefined : new ArrivalQueue(store, bus, agent, () => enabled && !stopped);
    const unsubscribe = options.clientMode ? () => {} : bus.on("email.received", ({ email }) => {
      if (!enabled || stopped) return;
      void arrivals!.enqueue(email.id, email.accountId);
    });
    const drainAgentQueue = async () => {
      await arrivals?.drain();
      while (agentJobs.size) await Promise.allSettled([...agentJobs]);
    };
    const dependencies = { store, executor, policy, bus };
    const mcp = createMailboxMcpServer(dependencies);
    const servers = new Set([mcp]);
    return attachAccountSync<RealBackend>({
      mode: "real",
      ...dependencies,
      providers,
      config,
      agent,
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
        const server = createMailboxMcpServer(dependencies);
        servers.add(server);
        return server;
      },
      async updateConfig(patch) {
        await drainAgentQueue();
        const next = validateConfig({ ...config, ...patch });
        if (!memory) await saveConfig(next);
        Object.assign(config, next);
        configureAgent();
      },
      syncAccount: (id) =>
        stopped
          ? Promise.reject(new ApiError("BACKEND_CLOSED", "Backend is closed"))
          : sync.syncAccount(id),
      async waitForChanges(id, signal) {
        if (signal.aborted) return;
        const provider = await connections.mail(id);
        if (provider.waitForChanges) await provider.waitForChanges(signal);
        else
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else
              signal.addEventListener("abort", () => resolve(), { once: true });
          });
      },
      drainAgentQueue,
      processArrivals: (signal) => arrivals?.drainDue(signal) ?? Promise.resolve(),
      close: () =>
        (closing ??= (async () => {
          await sync.drain();
          unsubscribe();
          await drainAgentQueue();
          stopped = true;
          await Promise.allSettled(
            [...servers].map((server) => server.close()),
          );
          await connections.close();
          await store.close();
        })()),
    }, sync);
  } catch (error) {
    await store.close();
    throw error;
  }
}
