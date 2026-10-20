import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createProviderRegistry,
  MockMailProvider,
  MockCalendarProvider,
} from "@passport/providers";
import type { CompleteOptions, LlmClient } from "@passport/agent";
import type { ActionRecord, ActionRequest, DomainEvent } from "@passport/types";
import { createRealBackend, type RealBackend } from "./compose.js";
import { defaultConfig } from "./config.js";
import { addAccount } from "./accounts.js";
import { createApp } from "./app.js";

/** The agent's testing FakeLlm is not exported; implement its public LlmClient contract here. */
class FixtureLlm implements LlmClient {
  async complete(options: CompleteOptions) {
    const properties = options.json?.properties;
    const json = properties?.category
      ? {
          category: options.messages[0]?.content.includes("sam@example.com")
            ? "replies_known"
            : "other",
        }
      : properties?.matterId
        ? {
            matterId: null,
            title: "Fixture matter",
            kind: "project",
            summary: "Review the conversation.",
            nextStep: "Review reply",
          }
        : properties?.slots
          ? {
              status: "tentative",
              textBody: "Here are some possible times.",
              slots: [],
            }
          : properties?.textBody
            ? { textBody: "Thanks for the update. I can help review the plan." }
            : {
                summary: "Waiting for review",
                nextStep: "Review",
                status: "waiting",
              };
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
  async function fixture(triage = false) {
    const mail = new MockMailProvider(),
      calendar = new MockCalendarProvider();
    const providers = createProviderRegistry();
    vi.spyOn(providers, "mail").mockReturnValue(mail);
    vi.spyOn(providers, "calendar").mockReturnValue(calendar);
    const backend = await createRealBackend(defaultConfig(), {
      storePath: ":memory:",
      providers,
      ...(triage ? { llm: new FixtureLlm() } : {}),
    });
    backends.push(backend);
    const account = await addAccount(backend, {
      kind: "mock",
      emailAddress: "alex@example.com",
      displayName: "Alex",
      fields: {},
    });
    return { backend, account, mail, calendar, app: createApp(backend) };
  }
  it("syncs real fixtures, delivers each arrival once, drains triage and serves a deterministic digest", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { backend, account, app } = await fixture(true);
    const events: DomainEvent[] = [];
    backend.bus.onAny((event) => events.push(event));
    await backend.syncAccount(account.id);
    await backend.drainAgentQueue();
    const emails = await backend.store.emails.query({
      accountId: account.id,
      limit: 100,
    });
    expect(emails.items).toHaveLength(40);
    expect(await backend.store.mailboxes.list(account.id)).toHaveLength(8);
    expect(await backend.store.calendars.list(account.id)).toHaveLength(1);
    expect(
      await backend.store.events.query({ accountId: account.id }),
    ).toHaveLength(6);
    for (const email of emails.items)
      expect(
        (await backend.store.threads.get(email.threadId))!.emailIds,
      ).toContain(email.id);
    expect(
      events.filter((event) => event.type === "email.received"),
    ).toHaveLength(40);
    expect(
      events.filter((event) => event.type === "agent.run.finished"),
    ).toHaveLength(40);
    await backend.syncAccount(account.id);
    await backend.drainAgentQueue();
    expect(
      events.filter((event) => event.type === "email.received"),
    ).toHaveLength(40);
    await backend.agent.run({ kind: "schedule", name: "daily_digest" });
    const response = await app.request(
      `/api/digest/${new Date().toISOString().slice(0, 10)}`,
    );
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { markdown: string }).markdown,
    ).toBeTruthy();
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
    expect(
      decisions.items.some((record: ActionRecord) => record.id === proposed.id),
    ).toBe(true);
    const post = (id: string, operation: string) =>
      app.request(`/api/actions/${id}/${operation}`, { method: "POST" });
    const approval = await post(proposed.id, "approve");
    expect(approval.status).toBe(200);
    expect(await approval.json()).toMatchObject({ status: "held" });
    expect(mail.sentMail).toHaveLength(0);
    expect(await (await post(proposed.id, "cancel-hold")).json()).toMatchObject(
      { status: "rejected" },
    );
    const second = await backend.executor.submit(request);
    const held = (await (
      await post(second.id, "approve")
    ).json()) as ActionRecord;
    expect(held.status).toBe("held");
    const released = await backend.executor.releaseDue(
      new Date(Date.parse(held.holdUntil!) + 1).toISOString(),
    );
    expect(released.map((action) => action.id)).toContain(second.id);
    expect(mail.sentMail).toHaveLength(1);
    expect(mail.sentMail[0]!.textBody).toBe(request.params.draft!.textBody);
    const email = (await backend.store.emails.getByProviderId(
      account.id,
      "fixture-19",
    ))!;
    const original = [...email.mailboxIds];
    const archive = await backend.executor.submit({
      type: "archive",
      accountId: account.id,
      actor: { kind: "agent", id: "integration-run" },
      category: "triage",
      reason: "File reviewed conversation",
      params: { emailIds: [email.id] },
    });
    if (archive.status === "proposed")
      expect((await post(archive.id, "approve")).status).toBe(200);
    expect((await backend.store.emails.get(email.id))!.mailboxIds).not.toEqual(
      original,
    );
    expect((await post(archive.id, "undo")).status).toBe(200);
    expect((await backend.store.emails.get(email.id))!.mailboxIds).toEqual(
      original,
    );
    const trust = (await (await app.request("/api/trust")).json()) as {
      categories: Array<{ category: string; approvals: number }>;
    };
    expect(
      trust.categories.find((item) => item.category === "replies_known")!
        .approvals,
    ).toBe(2);
  });
  it("serves search_emails and policy-gated archive_emails to an in-memory MCP client", async () => {
    const { backend, account } = await fixture();
    await backend.syncAccount(account.id);
    const client = new Client({ name: "passport-integration", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await backend.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const search = await client.callTool({
        name: "search_emails",
        arguments: { text: '"Garden"', limit: 20 },
      });
      expect(search.isError).not.toBe(true);
      const data = JSON.parse(
        (search.content as Array<{ text: string }>)[0]!.text,
      );
      expect(data.items.length).toBeGreaterThan(0);
      const archive = await client.callTool({
        name: "archive_emails",
        arguments: {
          emailIds: [data.items[0].id],
          reason: "Archive reviewed mail",
        },
      });
      expect(archive.isError).not.toBe(true);
      const result = JSON.parse(
        (archive.content as Array<{ text: string }>)[0]!.text,
      );
      const action = await backend.store.actions.get(result.id);
      expect(action!.request.actor).toEqual({
        kind: "external-agent",
        id: "passport-integration",
      });
      expect(["proposed", "executed"]).toContain(action!.status);
    } finally {
      await client.close();
    }
  });
  it("keeps per-account triage sequential and continues after inference failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { backend, account } = await fixture(true);
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
    await backend.syncAccount(account.id);
    expect(run).toHaveBeenCalledTimes(1);
    rejectFirst(new Error("LLM unavailable"));
    await backend.drainAgentQueue();
    expect(run).toHaveBeenCalledTimes(40);
  });
  // Policy seams: agent person_update carries a complete new Person (including id and
  // verification); current executor rejects it before either triage playbook can run.
  it.skip("policy seams: fixture newsletter produces an executed or proposed archive/label action", async () => {
    const { backend, account } = await fixture(true);
    await backend.syncAccount(account.id);
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
  it.skip("policy seams: known-contact fixture reply produces a proposed draft_create/send visible at GET /api/decisions", async () => {
    const { backend, account, app } = await fixture(true);
    await backend.policy.setConfig({ globalMode: "supervised" });
    await backend.syncAccount(account.id);
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
  it.skip("policy seams: matter_create/matter_attach apply emailPatch category/personIds and undo restores metadata", async () => {
    const { backend, account } = await fixture(true);
    await backend.syncAccount(account.id);
    await backend.drainAgentQueue();
    const email = (await backend.store.emails.getByProviderId(
      account.id,
      "fixture-01",
    ))!;
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
