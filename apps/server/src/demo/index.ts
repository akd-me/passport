import type {
  ActionRequest,
  AgentRuntime,
  DomainEvent,
  EventBus,
  ProviderRegistry,
} from "@passport/types";
import type { Backend } from "../backend.js";
import { defaultConfig, type PassportConfig, validateConfig } from "../config.js";
import { NotImplementedError, required } from "../errors.js";
import { createDemoExecutor } from "./executor.js";
import { demoCapabilities, seedDemo } from "./fixtures.js";
import { createDemoPolicy } from "./policy.js";
import { createDemoStore } from "./store.js";

export function createDemoBus(): EventBus {
  const listeners = new Set<(event: DomainEvent) => void>();
  return {
    emit: (event) => {
      for (const listener of listeners) {
        listener(structuredClone(event));
      }
    },
    onAny: (handler) => {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    on: (type, handler) => {
      const listener = (event: DomainEvent) => {
        if (event.type === type) {
          (handler as (event: DomainEvent) => void)(event);
        }
      };
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Complete isolated demo. Mutations and credentials disappear on restart. No LLM/network calls. */
export async function createDemoBackend(
  config: PassportConfig = defaultConfig(),
): Promise<Backend> {
  const store = createDemoStore(),
    bus = createDemoBus();
  await seedDemo(store);
  const policy = createDemoPolicy(store, bus),
    executor = createDemoExecutor(store, policy, bus);
  const providers: ProviderRegistry = {
    describe: (kind) => {
      if (kind !== "mock") {
        throw new NotImplementedError(
          `Only the mock provider is available in demo mode (${kind} requested)`,
        );
      }
      return {
        kind,
        label: "Demo mailbox",
        fields: [
          {
            id: "emailAddress",
            label: "Email address",
            secret: false,
            required: true,
            placeholder: "you@example.com",
          },
          {
            id: "displayName",
            label: "Display name",
            secret: false,
            required: false,
            placeholder: "Personal mailbox",
          },
          {
            id: "demoToken",
            label: "Demo token (optional)",
            secret: true,
            required: false,
            help: "Stored in memory only in the demo.",
          },
        ],
      };
    },
    mail: () => {
      throw new NotImplementedError(
        "Demo sync is local; real mail adapters are wired during integration",
      );
    },
    calendar: () => {
      throw new NotImplementedError("Real calendar adapters are wired during integration");
    },
  };
  const draftRequest = async (
    index: number,
    type: "send" | "draft_create" = "send",
  ): Promise<ActionRequest> => {
    const email = required(
      await store.emails.get(`email-${index}`, { includeBodies: true }),
      "Fixture email",
    );
    return {
      type,
      accountId: "account-demo",
      actor: { kind: "agent", id: "demo-agent" },
      category: "replies_known",
      matterId: email.matterId,
      reason:
        [
          "Maya just needs a quick confirmation to keep Thursday’s launch on track.",
          "Share your arrival time so Sam can plan the first afternoon.",
          "Ask Priya to separate the two expenses before closing the books.",
          "Nina is waiting on feedback. This keeps the next round moving.",
        ][index] ?? "A short reply will move this matter forward.",
      params: {
        draft: {
          accountId: "account-demo",
          inReplyToEmailId: email.id,
          to: email.from,
          subject: `Re: ${email.subject}`,
          textBody:
            [
              "Hi Maya,\n\nThursday at 10 works perfectly. The final assets look great — thanks for pulling everything together. Excited to get this out into the world.\n\nAlex",
              "Hey Sam,\n\nMy train gets in around 2 on Friday. Coffee by the water sounds like the perfect way to start the weekend. See you soon!\n\nAlex",
              "Hi Priya,\n\nThanks for flagging these. The studio equipment is for Northstar, and the travel was personal. I’ll forward the missing receipt this afternoon.\n\nAlex",
              "Hi Nina,\n\nDirection two feels right. I love the quieter typography and the space around it. Let’s develop that one, keeping the palette a little warmer.\n\nAlex",
            ][index] ??
            "Thanks for the update. I’ll take a look and get back to you shortly.\n\nAlex",
        },
      },
    };
  };
  const agent: AgentRuntime = {
    getUserProfile: async () => (await store.kv.get("user-profile")) ?? "",
    setUserProfile: (markdown) => store.kv.set("user-profile", markdown),
    run: async (trigger) => {
      const id = crypto.randomUUID(),
        startedAt = new Date().toISOString();
      bus.emit({ type: "agent.run.started", runId: id, trigger: trigger.kind });
      const actionIds: string[] = [];
      if (trigger.kind === "schedule" && trigger.name === "daily_digest") {
        const pending = await store.actions.query({
          status: ["proposed", "held"],
        });
        await store.kv.set(
          `digest:${startedAt.slice(0, 10)}`,
          `# Your daily brief\n\n${pending.total ?? pending.items.length} decisions and held actions.\n\n${(await store.matters.list({ status: ["active", "waiting"] })).map((m) => `- **${m.title}**: ${m.nextStep ?? m.summary}`).join("\n")}`,
        );
      } else {
        const pending = await store.actions.query({
          status: ["proposed", "held"],
          limit: 200,
        });
        const matterId = trigger.kind === "manual" ? trigger.matterId : undefined;
        const match = [0, 1, 3, 4].find(
          (i) =>
            (!matterId || matterId === `matter-${i}`) &&
            !pending.items.some((a) => a.request.matterId === `matter-${i}`),
        );
        if (match !== undefined) {
          const request = await draftRequest(match);
          const action = await executor.submit({ ...request, runId: id });
          actionIds.push(action.id);
        }
      }
      const finishedAt = new Date().toISOString();
      bus.emit({
        type: "agent.run.finished",
        runId: id,
        proposed: actionIds.length,
        executed: 0,
      });
      return {
        id,
        trigger,
        startedAt,
        finishedAt,
        actionIds,
        summary: actionIds.length
          ? "Demo agent prepared a reply from fixture context. No model was called."
          : "Demo review complete. Existing decisions are ready for you.",
      };
    },
  };
  // Seed decisions through the action gate, including a held send and undoable history.
  for (const i of [0, 2, 3]) {
    await executor.submit(await draftRequest(i));
  }
  const held = await executor.submit(await draftRequest(1));
  await executor.approve(held.id);
  await executor.submit({
    type: "archive",
    accountId: "account-demo",
    actor: { kind: "agent", id: "demo-agent" },
    category: "newsletters",
    matterId: "matter-5",
    reason: "Filed this week’s Field Notes in your reading room.",
    params: { emailIds: ["email-5"] },
  });
  await executor.submit({
    type: "mark_read",
    accountId: "account-demo",
    actor: { kind: "agent", id: "demo-agent" },
    category: "triage",
    matterId: "matter-0",
    reason: "Marked the earlier launch updates as read.",
    params: { emailIds: ["email-6", "email-12"] },
  });
  await executor.submit(await draftRequest(4));
  await agent.run({ kind: "schedule", name: "daily_digest" });
  const backend: Backend = {
    mode: "demo",
    store,
    executor,
    policy,
    agent,
    providers,
    providerKinds: ["mock"],
    bus,
    config: {
      ...structuredClone(config),
      accounts: await store.accounts.list(),
    },
    updateConfig: async (patch) => {
      const next = validateConfig({ ...backend.config, ...patch });
      Object.assign(backend.config, next);
    },
    syncAccount: async (id) => {
      const account = required(await store.accounts.get(id), "Account"),
        at = new Date().toISOString();
      await store.accounts.upsert({
        ...account,
        lastSyncAt: at,
        lastSyncError: null,
        updatedAt: at,
      });
      await store.syncState.set({
        accountId: id,
        cursor: `demo:${at}`,
        updatedAt: at,
      });
      bus.emit({
        type: "account.synced",
        accountId: id,
        at,
        emailsUpserted: 0,
      });
    },
    // Demo mail is static: report a healthy watcher so the UI shows its steady state.
    watchStatus: async (account) =>
      account.capabilities.mail
        ? {
            since: account.createdAt,
            lastTickAt: account.lastSyncAt ?? account.createdAt,
            cursorAgeSeconds: 0,
            status: "watching" as const,
          }
        : null,
    close: () => store.close(),
  };
  return backend;
}
export { demoCapabilities };
