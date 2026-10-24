import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CompleteOptions, LlmClient, LlmCompletion } from "@passport/agent";
import {
  createMockEmails,
  createProviderRegistry,
  MockCalendarProvider,
  MockMailProvider,
} from "@passport/providers";
import {
  type Account,
  type ActionRecord,
  type ActionRequest,
  type DomainEvent,
  mailHandle,
} from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "./accounts.js";
import { createApp } from "./auth.test-client.js";
import { createRealBackend, type RealBackend } from "./compose.js";
import { defaultConfig } from "./config.js";

/** The agent's testing FakeLlm is not exported; implement its public LlmClient contract here. */
class FixtureLlm implements LlmClient {
  async complete(options: CompleteOptions): Promise<LlmCompletion> {
    const properties = options.json?.properties;
    function fixtureResponse() {
      if (properties?.category) {
        return {
          category: options.messages[0]?.content.includes("sam@example.com")
            ? "replies_known"
            : "other",
        };
      }
      if (properties?.matterId) {
        return {
          matterId: null,
          title: "Fixture matter",
          kind: "project",
          summary: "Review the conversation.",
          nextStep: "Review reply",
        };
      }
      if (properties?.slots) {
        return {
          status: "tentative",
          textBody: "Here are some possible times.",
          slots: [],
        };
      }
      if (properties?.textBody) {
        return { textBody: "Thanks for the update. I can help review the plan." };
      }
      return {
        summary: "Waiting for review",
        nextStep: "Review",
        status: "waiting",
      };
    }
    const json = fixtureResponse();
    return {
      text: JSON.stringify(json),
      json,
      toolCalls: [],
      model: "fixture",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
    };
  }
}

describe("real backend end to end", () => {
  const backends: RealBackend[] = [];
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.close()));
    vi.restoreAllMocks();
  });
  /** `fixtures: false` starts with an empty mailbox so `deliver` can replay fixtures as new mail. */
  async function fixture(triage = false, fixtures = true) {
    const mail = new MockMailProvider({ fixtures }),
      calendar = new MockCalendarProvider();
    const providers = createProviderRegistry();
    vi.spyOn(providers, "mail").mockReturnValue(mail);
    vi.spyOn(providers, "calendar").mockReturnValue(calendar);
    const backend = await createRealBackend(
      { ...defaultConfig(), triage: { mode: "pipeline" } },
      {
        storePath: ":memory:",
        providers,
        ...(triage ? { llm: new FixtureLlm() } : {}),
      },
    );
    backends.push(backend);
    const account = await addAccount(backend, {
      kind: "mock",
      emailAddress: "alex@example.com",
      displayName: "Alex",
      fields: {},
    });
    return { backend, account, mail, calendar, app: createApp(backend) };
  }
  /**
   * Watching starts at "now"; the 40 fixtures then arrive as new mail on the next tick, each also
   * in the Inbox (like Gmail category labels) so every one is triaged.
   */
  async function deliver(backend: RealBackend, account: Account, mail: MockMailProvider) {
    await backend.syncAccount(account.id);
    const inbox = `${account.id}:mailbox:Inbox`;
    for (const email of createMockEmails(account.id, account.emailAddress)) {
      mail.injectEmail({ ...email, mailboxIds: [...new Set([...email.mailboxIds, inbox])] });
    }
    await backend.syncAccount(account.id);
  }
  it("watches from now without backfill, delivers each new inbox arrival once, drains triage and serves a deterministic digest", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { backend, account, mail, app } = await fixture(true, false);
    const events: DomainEvent[] = [];
    backend.bus.onAny((event) => events.push(event));
    await backend.syncAccount(account.id);
    expect((await backend.store.emails.query({ accountId: account.id })).items).toHaveLength(0);
    expect(events.filter((event) => event.type === "account.watch.started")).toHaveLength(1);
    expect(await backend.store.mailboxes.list(account.id)).toHaveLength(8);
    expect(await backend.store.calendars.list(account.id)).toHaveLength(1);
    expect(await backend.store.events.query({ accountId: account.id })).toHaveLength(6);
    for (const email of createMockEmails(account.id, account.emailAddress)) {
      mail.injectEmail(email);
    }
    await backend.syncAccount(account.id);
    await backend.drainAgentQueue();
    const emails = await backend.store.emails.query({
      accountId: account.id,
      limit: 100,
    });
    expect(emails.items).toHaveLength(40);
    for (const email of emails.items) {
      expect((await backend.store.threads.get(email.threadId))!.emailIds).toContain(email.id);
    }
    const received = events.filter((event) => event.type === "email.received");
    // Sent mail, drafts and mail outside the inbox are cached but never triaged.
    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBeLessThan(40);
    expect(events.filter((event) => event.type === "agent.run.finished")).toHaveLength(
      received.length,
    );
    await backend.syncAccount(account.id);
    await backend.drainAgentQueue();
    expect(events.filter((event) => event.type === "email.received")).toHaveLength(received.length);
    await backend.agent.run({ kind: "schedule", name: "daily_digest" });
    const response = await app.request(`/api/digest/${new Date().toISOString().slice(0, 10)}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { markdown: string }).markdown).toBeTruthy();
  });
  it("exposes proposed sends, holds approvals, cancels and releases delivery, learns trust and undoes archive exactly", async () => {
    const { backend, account, mail, app } = await fixture();
    await backend.syncAccount(account.id);
    const request: ActionRequest<"send"> = {
      type: "send",
      accountId: account.id,
      actor: { kind: "agent", id: "integration-run" },
      category: "replies_known",
      counterparty: { class: "green_known", emails: ["sam@example.com"] },
      reason: "Human reviewed follow-up",
      params: {
        draft: {
          accountId: account.id,
          to: [{ email: "sam@example.com" }],
          subject: "Project update",
          textBody: "Here is the reviewed project update.",
        },
      },
    };
    const proposed = await backend.executor.submit(request);
    expect(proposed.status).toBe("proposed");
    const decisions = (await (await app.request("/api/decisions")).json()) as {
      items: ActionRecord[];
    };
    expect(decisions.items.some((record: ActionRecord) => record.id === proposed.id)).toBe(true);
    const post = (id: string, operation: string) =>
      app.request(`/api/actions/${id}/${operation}`, { method: "POST" });
    const approval = await post(proposed.id, "approve");
    expect(approval.status).toBe(200);
    expect(await approval.json()).toMatchObject({ status: "held" });
    expect(mail.sentMail).toHaveLength(0);
    expect(await (await post(proposed.id, "cancel-hold")).json()).toMatchObject({
      status: "rejected",
    });
    const second = await backend.executor.submit(request);
    const held = (await (await post(second.id, "approve")).json()) as ActionRecord;
    expect(held.status).toBe("held");
    const released = await backend.executor.releaseDue(
      new Date(Date.parse(held.holdUntil!) + 1).toISOString(),
    );
    expect(released.map((action) => action.id)).toContain(second.id);
    expect(mail.sentMail).toHaveLength(1);
    expect(mail.sentMail[0]!.textBody).toBe(request.params.draft!.textBody);
    const email = (await backend.store.emails.getByProviderId(account.id, "fixture-19"))!;
    const original = [...email.mailboxIds];
    const archive = await backend.executor.submit({
      type: "archive",
      accountId: account.id,
      actor: { kind: "agent", id: "integration-run" },
      category: "triage",
      reason: "File reviewed conversation",
      params: { emailIds: [email.id] },
    });
    if (archive.status === "proposed") {
      expect((await post(archive.id, "approve")).status).toBe(200);
    }
    expect((await backend.store.emails.get(email.id))!.mailboxIds).not.toEqual(original);
    expect((await post(archive.id, "undo")).status).toBe(200);
    expect((await backend.store.emails.get(email.id))!.mailboxIds).toEqual(original);
    const trust = (await (await app.request("/api/trust")).json()) as {
      categories: Array<{ category: string; approvals: number }>;
    };
    expect(trust.categories.find((item) => item.category === "replies_known")!.approvals).toBe(2);
  });
  it("serves search_emails and policy-gated archive_emails to an in-memory MCP client", async () => {
    const { backend, account, mail } = await fixture(false, false);
    await deliver(backend, account, mail);
    const client = new Client({ name: "passport-integration", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await backend.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const search = await client.callTool({
        name: "search_emails",
        arguments: { text: '"Garden"', limit: 20 },
      });
      expect(search.isError).not.toBe(true);
      const data = JSON.parse((search.content as Array<{ text: string }>)[0]!.text);
      expect(data.items.length).toBeGreaterThan(0);
      const archive = await client.callTool({
        name: "archive_emails",
        arguments: {
          emailIds: [data.items[0].id],
          reason: "Archive reviewed mail",
        },
      });
      expect(archive.isError).not.toBe(true);
      const result = JSON.parse((archive.content as Array<{ text: string }>)[0]!.text);
      const action = await backend.store.actions.get(result.id);
      // Actor id is bound to the transport session, not the client-supplied name (R8).
      expect(action!.request.actor.kind).toBe("external-agent");
      expect(action!.request.actor.id).not.toBe("passport-integration");
      expect(action!.request.reason).toContain("passport-integration");
      expect(["proposed", "executed"]).toContain(action!.status);
    } finally {
      await client.close();
    }
  });
  it.each(["supervised", "auto_accept_edits", "auto", "full_access"] as const)(
    "R13: human profile edits execute and undo under %s",
    async (globalMode) => {
      const { backend, app } = await fixture();
      await backend.policy.setConfig({ globalMode, alwaysAsk: ["matters"] });
      const before = await backend.agent.getUserProfile();
      const response = await app.request("/api/user-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: "# New preferences" }),
      });
      expect(response.status).toBe(200);
      const action = (await response.json()) as ActionRecord;
      expect(action).toMatchObject({
        status: "executed",
        request: { type: "profile_update", actor: { kind: "human", id: "user" } },
      });
      expect(action.inverse).toBeTruthy();
      expect(await backend.agent.getUserProfile()).toBe("# New preferences");
      await backend.executor.undo(action.id);
      expect(await backend.agent.getUserProfile()).toBe(before);
    },
  );

  it("R5: a new conflict returns a held calendar proposal to review without sending", async () => {
    const { backend, account, mail } = await fixture();
    await backend.syncAccount(account.id);
    const slot = { start: "2090-01-01T10:00:00Z", end: "2090-01-01T11:00:00Z" };
    const proposed = await backend.executor.submit({
      type: "calendar_propose",
      accountId: account.id,
      category: "scheduling",
      actor: { kind: "agent", id: "run" },
      reason: "Offer a time",
      params: {
        slots: [slot],
        draft: {
          accountId: account.id,
          to: [{ email: "sam@example.com" }],
          subject: "Meeting",
          textBody: "Does this time work?",
        },
      },
    });
    const held = await backend.executor.approve(proposed.id);
    expect(held.status).toBe("held");
    const calendar = (await backend.store.calendars.list(account.id))[0]!;
    await backend.store.events.upsertMany([
      {
        ...slot,
        id: "new-conflict",
        accountId: account.id,
        calendarId: calendar.id,
        providerId: "new-conflict",
        title: "Another meeting",
        allDay: false,
        status: "confirmed",
        participants: [],
        updatedAt: new Date().toISOString(),
      },
    ]);
    expect(await backend.executor.releaseDue("2099-01-01T00:00:00Z")).toEqual([]);
    expect(await backend.store.actions.get(held.id)).toMatchObject({
      status: "proposed",
      error: "AVAILABILITY_CHANGED",
      decision: { reason: "AVAILABILITY_CHANGED" },
    });
    expect(mail.sentMail).toHaveLength(0);
    await backend.store.events.deleteMany(["new-conflict"]);
    await backend.executor.approve(held.id);
    await backend.executor.releaseDue("2099-01-01T00:00:00Z");
    expect(mail.sentMail).toHaveLength(1);
  });

  it("R2/R5: runtime actions retain the stable arrival identity and unverified availability note through a late journal failure", async () => {
    const slot = {
      start: new Date(Date.now() + 86400000).toISOString(),
      end: new Date(Date.now() + 90000000).toISOString(),
    };
    const llm = new FixtureLlm();
    const complete = llm.complete.bind(llm);
    vi.spyOn(llm, "complete").mockImplementation(async (options) => {
      if (!options.json?.properties?.slots) {
        return complete(options);
      }
      const result = await complete(options);
      return { ...result, json: { status: "tentative", textBody: "Can we meet?", slots: [slot] } };
    });
    const backend = await createRealBackend(
      { ...defaultConfig(), triage: { mode: "pipeline" } },
      {
        storePath: ":memory:",
        clientMode: true,
        llm,
      },
    );
    backends.push(backend);
    const account = await addAccount(backend, {
      kind: "mock",
      emailAddress: "alex@example.com",
      fields: {},
    });
    await backend.syncAccount(account.id);
    // Read-through: the first fixture is fetched from the provider and cached.
    const email = (await backend.store.emails.getByProviderId(account.id, "fixture-19"))!;
    await backend.store.emails.upsertMany([
      {
        ...email,
        subject: "Meeting request",
        headers: { ...email.headers, listUnsubscribe: null },
        preview: "Let's talk",
      },
    ]);
    await backend.policy.setConfig({ globalMode: "full_access" });
    await backend.policy.pinLevel("scheduling", "full_access");
    const set = backend.store.kv.set.bind(backend.store.kv);
    vi.spyOn(backend.store.kv, "set").mockImplementation(async (key, value) => {
      if (
        key.startsWith("agent:journal:") &&
        (await backend.store.actions.query({ category: "scheduling", status: ["held"] })).items
          .length
      ) {
        throw new Error("Journal unavailable");
      }
      await set(key, value);
    });
    const trigger = {
      kind: "email.received" as const,
      emailId: email.id,
      runId: `arrival:${email.id}`,
      availabilityUnverified: true,
    };
    await expect(backend.agent.run(trigger)).rejects.toThrow("Journal unavailable");
    const actions = (await backend.store.actions.query({ runId: trigger.runId, limit: 100 })).items;
    const proposal = actions.find((action) => action.request.type === "calendar_propose")!;
    expect(proposal).toMatchObject({ status: "held" });
    expect(proposal.request.reason).toContain("calendar not synced, availability unverified");
  });

  it.each(["conflict", "expired", "cancelled", "declined", "override"])(
    "R5: release checks recurring availability (%s) and still permits cancellation",
    async (scenario) => {
      const { backend, account, mail } = await fixture();
      await backend.syncAccount(account.id);
      const slot = { start: "2090-01-01T10:00:00.000Z", end: "2090-01-01T11:00:00.000Z" };
      const request: ActionRequest = {
        type: "calendar_propose",
        accountId: account.id,
        category: "scheduling",
        actor: { kind: "agent", id: "run" },
        reason: "Offer a time",
        params: {
          slots: [slot],
          draft: {
            accountId: account.id,
            to: [{ email: "sam@example.com" }],
            subject: "Meeting",
            textBody: "Does this time work?",
          },
        },
      };
      const action = await backend.executor.submit(request);
      await backend.executor.approve(action.id);
      const calendarId = (await backend.store.calendars.list(account.id))[0]!.id;
      const master = {
        id: "series",
        accountId: account.id,
        calendarId,
        providerId: "series-provider",
        title: "Daily meeting",
        start: "2089-12-31T10:00:00.000Z",
        end: "2089-12-31T11:00:00.000Z",
        allDay: false,
        status: scenario === "cancelled" ? ("cancelled" as const) : ("confirmed" as const),
        myStatus: scenario === "declined" ? ("declined" as const) : ("accepted" as const),
        participants: [],
        recurrenceRule: `FREQ=DAILY;COUNT=${scenario === "expired" ? 1 : 3}`,
        updatedAt: new Date().toISOString(),
      };
      await backend.store.events.upsertMany([master]);
      if (scenario === "override") {
        await backend.store.events.upsertMany([
          {
            ...master,
            ...slot,
            id: "override",
            providerId: "override-provider",
            recurringEventId: master.providerId,
            originalStart: slot.start,
            recurrenceRule: null,
            status: "cancelled",
          },
        ]);
      }
      const cancelled = await backend.executor.submit(request);
      await backend.executor.approve(cancelled.id);
      expect((await backend.executor.cancelHold(cancelled.id)).status).toBe("rejected");
      await backend.executor.releaseDue("2099-01-01T00:00:00Z");
      expect((await backend.store.actions.get(action.id))!.status).toBe(
        scenario === "conflict" ? "proposed" : "executed",
      );
      expect(mail.sentMail).toHaveLength(scenario === "conflict" ? 0 : 1);
    },
  );

  it("R9: client mode queues outward submissions even when the configured hold is zero", async () => {
    const backend = await createRealBackend(
      { ...defaultConfig(), triage: { mode: "pipeline" } },
      {
        storePath: ":memory:",
        clientMode: true,
      },
    );
    backends.push(backend);
    const account = await addAccount(backend, {
      kind: "mock",
      emailAddress: "alex@example.com",
      fields: {},
    });
    await backend.policy.setConfig({ globalMode: "full_access", outboxHoldMinutes: 0 });
    await backend.policy.pinLevel("scheduling", "full_access");
    const action = await backend.executor.submit({
      type: "calendar_propose",
      accountId: account.id,
      category: "scheduling",
      actor: { kind: "agent", id: "run" },
      reason: "Schedule",
      params: {
        slots: [],
        draft: {
          accountId: account.id,
          to: [{ email: "sam@example.com" }],
          subject: "Meeting",
          textBody: "Can we meet?",
        },
      },
    });
    expect(action.status).toBe("proposed");
  });
  it("creates an MCP reply draft through the default registry using mail handles and the original thread", async () => {
    const backend = await createRealBackend(
      { ...defaultConfig(), triage: { mode: "pipeline" } },
      {
        storePath: ":memory:",
      },
    );
    backends.push(backend);
    const account = await addAccount(backend, {
      kind: "mock",
      emailAddress: "alex@example.com",
      displayName: "Alex",
      fields: {},
    });
    await backend.syncAccount(account.id);
    const original = (await backend.store.emails.getByProviderId(account.id, "fixture-19"))!;
    expect(original.id).toBe(mailHandle(account.id, "email", "fixture-19"));
    expect(original.threadId).toBeTruthy();
    const client = new Client({
      name: "passport-reply-integration",
      version: "1",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await backend.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "reply_draft",
        arguments: {
          emailId: original.id,
          textBody: "Thanks, Sam. I will review it.",
          reason: "Draft a reply to the reviewed conversation",
        },
      });
      expect(result.isError).not.toBe(true);
      const { id } = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
        id: string;
      };
      let action = (await backend.store.actions.get(id))!;
      if (action.status === "proposed") {
        action = await backend.executor.approve(id);
      }
      expect(action).toMatchObject({
        status: "executed",
        request: {
          type: "draft_create",
          actor: { kind: "external-agent" },
          params: { draft: { inReplyToEmailId: original.id } },
        },
      });
      const reply = (await backend.store.emails.get(action.result!.emailId as string, {
        includeBodies: true,
      }))!;
      expect(reply).toMatchObject({
        threadId: original.threadId,
        keywords: { $draft: true },
        headers: { inReplyTo: original.headers.messageId },
      });
      expect(reply.headers.references).toEqual([
        ...original.headers.references,
        original.headers.messageId,
      ]);
      expect(reply.textBody).toContain("Thanks, Sam.");
      await backend.syncAccount(account.id);
      expect((await backend.store.emails.get(reply.id))!.threadId).toBe(original.threadId);
      expect((await backend.store.threads.get(original.threadId))!.emailIds).toContain(reply.id);
    } finally {
      await client.close();
    }
  });
  it("keeps per-account triage sequential and continues after inference failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { backend, account, mail } = await fixture(true, false);
    let rejectFirst!: (error: Error) => void;
    const run = vi
      .spyOn(backend.agent, "run")
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValue({
        id: "run",
        trigger: { kind: "manual", instruction: "fixture" },
        startedAt: new Date().toISOString(),
        actionIds: [],
        summary: "Done",
      });
    const received: string[] = [];
    backend.bus.on("email.received", ({ email }) => received.push(email.id));
    await deliver(backend, account, mail);
    expect(run).toHaveBeenCalledTimes(1);
    rejectFirst(new Error("LLM unavailable"));
    await backend.drainAgentQueue();
    expect(received.length).toBeGreaterThan(1);
    expect(run).toHaveBeenCalledTimes(received.length);
  });
  // Policy seams: agent person_update carries a complete new Person (including id and
  // verification); current executor rejects it before either triage playbook can run.
  it("policy seams: fixture newsletter produces an executed or proposed archive/label action", async () => {
    const { backend, account, mail } = await fixture(true, false);
    await deliver(backend, account, mail);
    await backend.drainAgentQueue();
    const actions = await backend.store.actions.query({
      category: "newsletters",
      limit: 500,
    });
    expect(
      actions.items.some(
        (action) =>
          ["archive", "label"].includes(action.request.type) &&
          ["executed", "proposed"].includes(action.status),
      ),
    ).toBe(true);
  });
  it("policy seams: known-contact fixture reply produces a proposed draft_create/send visible at GET /api/decisions", async () => {
    const { backend, account, app, mail } = await fixture(true, false);
    await backend.policy.setConfig({ globalMode: "supervised" });
    await deliver(backend, account, mail);
    await backend.drainAgentQueue();
    const decisions = (await (await app.request("/api/decisions")).json()) as {
      items: ActionRecord[];
    };
    expect(
      decisions.items.some(
        (action: ActionRecord) =>
          action.request.category === "replies_known" &&
          ["draft_create", "send"].includes(action.request.type) &&
          action.status === "proposed",
      ),
    ).toBe(true);
  });
  it("policy seams: matter_create/matter_attach apply emailPatch category/personIds and undo restores metadata", async () => {
    const { backend, account, mail } = await fixture(true, false);
    await deliver(backend, account, mail);
    await backend.drainAgentQueue();
    const email = (await backend.store.emails.getByProviderId(account.id, "fixture-01"))!;
    expect(email.category).toBe("newsletters");
    expect(email.personIds.length).toBeGreaterThan(0);
    const actions = await backend.store.actions.query({
      category: "matters",
      limit: 500,
    });
    const action = actions.items.find(
      (action) =>
        action.status === "executed" &&
        action.request.type === "matter_create" &&
        action.request.params &&
        "matter" in action.request.params &&
        action.request.params.matter.emailIds.includes(email.id),
    )!;
    await backend.executor.undo(action.id);
    expect(await backend.store.emails.get(email.id)).toMatchObject({
      category: null,
      personIds: [],
      matterId: null,
    });
  });
});
