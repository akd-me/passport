import { randomBytes } from "node:crypto";
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
  type LlmClient,
} from "@passport/agent";
import { createMailboxMcpServer } from "@passport/mcp";
import type {
  AgentRuntime,
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

export interface RealBackendOptions {
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
    const executor = createActionExecutor({
      store,
      bus,
      policy,
      mailProviderFor: connections.mail,
      calendarProviderFor: connections.calendar,
    });
    const queues = new Map<string, Promise<void>>();
    const agentJobs = new Set<Promise<unknown>>();
    let closing: Promise<void> | undefined;
    let stopped = false;
    let runtime: AgentRuntime;
    let runQueue: Promise<unknown> = Promise.resolve();
    let enabled = false;
    const configureAgent = () => {
      enabled = !!options.llm || llmConfigured(config.llm);
      runtime = createAgentRuntime({
        store,
        executor,
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
        const job = runQueue.then(() => runtime.run(trigger));
        runQueue = job.catch(() => undefined);
        agentJobs.add(job);
        void job.then(
          () => agentJobs.delete(job),
          () => agentJobs.delete(job),
        );
        return job;
      },
    };
    const unsubscribe = bus.on("email.received", ({ email }) => {
      if (!enabled || stopped) return;
      const job = (queues.get(email.accountId) ?? Promise.resolve()).then(
        async () => {
          try {
            await agent.run({ kind: "email.received", emailId: email.id });
          } catch {
            logger.warn("Email triage failed; continuing with the next email");
          }
        },
      );
      queues.set(email.accountId, job);
      void job.then(() => {
        if (queues.get(email.accountId) === job) queues.delete(email.accountId);
      });
    });
    const drainAgentQueue = async () => {
      while (queues.size || agentJobs.size)
        await Promise.allSettled([...queues.values(), ...agentJobs]);
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
