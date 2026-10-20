import { createToolRegistry } from "@passport/tools";
import { describe, expect, it, vi } from "vitest";
import type { ActionParams, Email } from "@passport/types";
import { createAgentRuntime } from "./runtime.js";
import type { AgentFinishedEvent } from "./integration.js";
import { FakeExecutor, FakePolicy, MemoryBus } from "./testing/collaborators.js";
import { FakeLlm, toolOutput } from "./testing/fake-llm.js";
import { accountFixture, emailFixture, eventFixture, matterFixture, newMatterOutput, personFixture, TEST_NOW, trustFixture } from "./testing/fixtures.js";
import { MemoryStore } from "./testing/memory-store.js";

async function setup(script: unknown[], email: Email = emailFixture()) {
  const store = new MemoryStore(), policy = new FakePolicy(), bus = new MemoryBus(), llm = new FakeLlm(script);
  await store.accounts.upsert(accountFixture());
  await store.emails.upsertMany([email]);
  const executor = new FakeExecutor(store, policy);
  const options = { store, executor, policy, bus, llm, selfAddresses: ["ME@example.com"], now: () => TEST_NOW };
  return { ...options, runtime: createAgentRuntime(options) };
}

describe("email triage", () => {
  it("labels and archives a newsletter with its policy category and run actor", async () => {
    const email = emailFixture({ headers: { messageId: null, inReplyTo: null, references: [], listId: "news.example", listUnsubscribe: "<https://example.com/unsubscribe>" } });
    const env = await setup([newMatterOutput], email);
    const run = await env.runtime.run({ kind: "email.received", emailId: email.id });
    const actions = env.executor.requests.filter(request => request.type === "label" || request.type === "archive");
    expect(actions.map(action => action.type)).toEqual(["label", "archive"]);
    expect(actions.every(action => action.category === "newsletters")).toBe(true);
    expect(env.executor.requests.every(action => action.actor.kind === "agent" && action.actor.id === run.id && action.runId === run.id)).toBe(true);
    expect((await env.store.emails.get(email.id))).toMatchObject({ category: "newsletters", mailboxIds: [], keywords: { "label:Newsletters": true } });
    expect(env.llm.calls).toHaveLength(1);
    expect(JSON.parse((await env.store.kv.get(`run:${run.id}`))!)).toMatchObject({ id: run.id, finishedAt: TEST_NOW, actionIds: run.actionIds });
    expect(env.bus.events.map(event => event.type)).toEqual(["agent.run.started", "agent.run.finished"]);
  });

  it("files receipts under Purchases/vendor", async () => {
    const env = await setup([newMatterOutput], emailFixture({ subject: "Your order confirmation", from: [{ name: "Acme", email: "orders@acme.test" }] }));
    await env.runtime.run({ kind: "email.received", emailId: "email-1" });
    expect((await env.store.matters.list())[0]).toMatchObject({ title: "Purchases/Acme", kind: "purchase" });
    expect(env.executor.requests.find(action => action.type === "label")).toMatchObject({ category: "receipts", params: { label: "Receipts" } });
  });

  it("reuses a vendor purchase matter", async () => {
    const env = await setup([newMatterOutput], emailFixture({ subject: "Payment receipt", from: [{ name: "Acme", email: "orders@acme.test" }] }));
    await env.store.matters.upsert(matterFixture({ title: "Purchases/Acme", kind: "purchase" }));
    await env.runtime.run({ kind: "email.received", emailId: "email-1" });
    expect(env.executor.requests.some(request => request.type === "matter_create")).toBe(false);
    expect(env.executor.requests.find(request => request.type === "matter_attach")).toMatchObject({ params: { matterId: "matter-1", emailPatch: { category: "receipts" } } });
  });

  it("marks no-reply notifications read before archiving", async () => {
    const env = await setup([newMatterOutput], emailFixture({ from: [{ email: "no-reply@status.test" }], subject: "Build completed" }));
    await env.runtime.run({ kind: "email.received", emailId: "email-1" });
    expect(env.executor.requests.filter(request => ["mark_read", "archive"].includes(request.type)).map(request => [request.type, request.category])).toEqual([["mark_read", "notifications"], ["archive", "notifications"]]);
  });

  it("proposes calendar_respond for a linked invitation", async () => {
    const env = await setup([newMatterOutput, { status: "accepted", textBody: "The calendar is clear for this invitation.", slots: [] }], emailFixture({ subject: "Invitation: Planning meeting" }));
    await env.store.events.upsertMany([eventFixture()]);
    await env.runtime.run({ kind: "email.received", emailId: "email-1" });
    expect(env.executor.records.find(record => record.request.type === "calendar_respond")).toMatchObject({ status: "proposed", request: { category: "scheduling", params: { eventId: "event-1", status: "accepted" } } });
  });

  it("downgrades acceptance to tentative when another calendar account is busy", async () => {
    const env = await setup([newMatterOutput, { status: "accepted", textBody: "Please review the calendar conflict.", slots: [] }], emailFixture({ attachments: [{ id: "ics", name: "event.ics", type: "text/calendar", size: 100, blobId: "blob" }] }));
    await env.store.events.upsertMany([eventFixture(), eventFixture({ id: "busy", accountId: "another-calendar-account", sourceEmailId: null })]);
    await env.runtime.run({ kind: "email.received", emailId: "email-1" });
    expect(env.executor.requests.find(request => request.type === "calendar_respond")).toMatchObject({ params: { status: "tentative" } });
  });

  it("submits calendar_propose when an invitation has no linked event", async () => {
    const slots = [{ start: "2026-10-22T14:00:00.000Z", end: "2026-10-22T14:30:00.000Z" }];
    const env = await setup([newMatterOutput, { status: "tentative", textBody: "Would this slot work?", slots }], emailFixture({ subject: "Meeting invite" }));
    await env.runtime.run({ kind: "email.received", emailId: "email-1" });
    expect(env.executor.requests.find(request => request.type === "calendar_propose")).toMatchObject({ params: { slots, draft: { inReplyToEmailId: "email-1" } } });
    expect(env.executor.requests.some(request => request.type === "send")).toBe(false);
  });

  it("rejects a model-proposed busy meeting slot", async () => {
    const slot = { start: "2026-10-22T14:00:00.000Z", end: "2026-10-22T14:30:00.000Z" };
    const env = await setup([newMatterOutput, { status: "tentative", textBody: "This slot works.", slots: [slot] }], emailFixture({ subject: "Meeting invite" }));
    await env.store.events.upsertMany([eventFixture({ ...slot, sourceEmailId: null })]);
    await expect(env.runtime.run({ kind: "email.received", emailId: "email-1" })).rejects.toMatchObject({ code: "LLM_SCHEDULE" });
    expect(env.executor.requests.some(request => request.type === "calendar_propose")).toBe(false);
  });

  it("drafts a known-contact reply with the correct inReplyTo and USER.md", async () => {
    const env = await setup([{ category: "replies_known" }, newMatterOutput, { textBody: "I can help coordinate a review of the proposal." }]);
    await env.store.people.upsert(personFixture());
    await env.runtime.setUserProfile("# USER.md\nTone: brief and warm.\nSignature: Morgan\nassistant_attribution: false");
    await env.store.emails.upsertMany([emailFixture({ id: "previous", receivedAt: "2026-10-10T00:00:00.000Z", textBody: "The user's prior thread context." })]);
    await env.store.threads.upsertMany([{ id: "thread-1", accountId: "account-1", emailIds: ["previous", "email-1"] }]);
    const run = await env.runtime.run({ kind: "email.received", emailId: "email-1" });
    const action = env.executor.requests.find(request => request.type === "draft_create")!;
    expect(action).toMatchObject({ category: "replies_known", params: { draft: { inReplyToEmailId: "email-1", accountId: "account-1", to: [{ email: "alice@example.com" }], subject: "Re: A quick question" } } });
    expect((action.params as ActionParams["draft_create"]).draft.textBody).not.toContain("drafted by my assistant");
    expect(env.llm.calls.every(call => call.system.includes("Tone: brief and warm") && call.system.includes("Never claim to be the human"))).toBe(true);
    expect(env.llm.calls[0]?.model).toBe("fast");
    expect(env.llm.calls[2]?.messages[0]?.content).toContain("prior thread context");
    expect(JSON.parse((await env.store.kv.get(`run_usage:${run.id}`))!)).toMatchObject({ calls: 3, inputTokens: 30, outputTokens: 15, costUsd: 0 });
  });

  it("surfaces a stranger decision, creates a matter, and never drafts or sends", async () => {
    const env = await setup([{ category: "replies_stranger" }, newMatterOutput]);
    const run = await env.runtime.run({ kind: "email.received", emailId: "email-1" });
    expect(env.executor.requests.some(request => request.type === "matter_create")).toBe(true);
    expect(env.executor.requests.some(request => ["send", "draft_create"].includes(request.type))).toBe(false);
    const decision = JSON.parse((await env.store.kv.get(`decision:${run.id}:email-1`))!);
    expect(decision).toMatchObject({ emailId: "email-1", summary: "Alice asks for a review." });
    expect((env.bus.events.at(-1) as AgentFinishedEvent).decisions).toEqual([decision]);
  });

  it("corrects replies_known classifications for unestablished strangers", async () => {
    const env = await setup([{ category: "replies_known" }, newMatterOutput]);
    await env.runtime.run({ kind: "email.received", emailId: "email-1" });
    expect((await env.store.emails.get("email-1"))?.category).toBe("replies_stranger");
    expect(env.llm.calls).toHaveLength(2);
  });

  it("keeps a blue-verified but unestablished stranger out of the reply playbook", async () => {
    const env = await setup([{ category: "replies_known" }, newMatterOutput], emailFixture({ verification: { dkim: "pass", spf: "pass", dmarc: "pass", passport: "blue" } }));
    await env.runtime.run({ kind: "email.received", emailId: "email-1" });
    expect((await env.store.emails.get("email-1"))?.category).toBe("replies_stranger");
    expect(env.executor.requests.some(request => request.type === "draft_create")).toBe(false);
  });

  it("leaves domain state unchanged when all actions need approval", async () => {
    const env = await setup([newMatterOutput], emailFixture({ subject: "Invoice #123" }));
    env.policy.outcome = "ask";
    await env.runtime.run({ kind: "email.received", emailId: "email-1" });
    expect(await env.store.people.list()).toEqual([]);
    expect(await env.store.matters.list()).toEqual([]);
    expect(await env.store.emails.get("email-1")).toMatchObject({ personIds: [], mailboxIds: ["inbox"] });
    expect((await env.store.emails.get("email-1"))?.category).toBeUndefined();
    expect(env.executor.requests.filter(request => request.type === "archive").every(request => !request.matterId)).toBe(true);
  });

  it("selects a matter from thread candidates and rejects invented IDs", async () => {
    const env = await setup([{ category: "replies_stranger" }, { ...newMatterOutput, matterId: "matter-1" }]);
    await env.store.matters.upsert(matterFixture({ emailIds: ["earlier"] }));
    await env.store.emails.upsertMany([emailFixture({ id: "earlier", matterId: "matter-1", receivedAt: "2026-10-01T00:00:00.000Z" })]);
    await env.runtime.run({ kind: "email.received", emailId: "email-1" });
    expect(env.executor.requests.find(request => request.type === "matter_attach")).toMatchObject({ params: { matterId: "matter-1" } });
    expect(env.llm.calls[1]?.messages[0]?.content).toContain('"id":"matter-1"');
    const bad = await setup([{ category: "replies_stranger" }, { ...newMatterOutput, matterId: "invented-id" }]);
    await expect(bad.runtime.run({ kind: "email.received", emailId: "email-1" })).rejects.toMatchObject({ code: "LLM_MATTER" });
  });
});

describe("schedules and run lifecycle", () => {
  it("generates and emits a digest of completed/pending work, matters, and trust changes", async () => {
    const env = await setup([{ category: "replies_stranger" }, newMatterOutput]);
    env.policy.states = [trustFixture()];
    await env.runtime.run({ kind: "email.received", emailId: "email-1" });
    env.policy.states = [trustFixture({ score: 0.6, level: "auto", stage: "trusted" })];
    await env.executor.submit({ type: "calendar_respond", accountId: "account-1", params: { eventId: "event-1", status: "tentative" }, actor: { kind: "agent", id: "prior-run" }, category: "scheduling", reason: "Review this calendar invitation" });
    await env.runtime.run({ kind: "schedule", name: "daily_digest" });
    const markdown = (await env.store.kv.get("digest:2026-10-20"))!;
    expect(markdown).toContain("What the agent did");
    expect(markdown).toContain("matter_create");
    expect(markdown).toContain("[proposed] Review this calendar invitation");
    expect(markdown).toContain("Correspondence");
    expect(markdown).toContain("0.20 → 0.60");
    expect(markdown).toContain("Alice asks for a review");
    expect((env.bus.events.at(-1) as AgentFinishedEvent).digest).toEqual({ date: "2026-10-20", markdown });
  });

  it("includes identity downgrades in the daily digest", async () => {
    const env = await setup([{ category: "replies_known" }, newMatterOutput]);
    await env.store.people.upsert(personFixture({ verification: "blue" }));
    await env.runtime.run({ kind: "email.received", emailId: "email-1" });
    await env.runtime.run({ kind: "schedule", name: "daily_digest" });
    expect(await env.store.kv.get("digest:2026-10-20")).toContain("Alice: previously blue verification is now green");
  });

  it("paginates the action log in digests", async () => {
    const env = await setup([]);
    for (let i = 0; i < 205; i++) await env.executor.submit({ type: "archive", accountId: "account-1", params: { emailIds: [] }, actor: { kind: "agent", id: "prior-run" }, category: "triage", reason: `Action ${i}` });
    await env.runtime.run({ kind: "schedule", name: "daily_digest" });
    expect(await env.store.kv.get("digest:2026-10-20")).toContain("Action 204");
  });

  it("includes actions created yesterday and executed today", async () => {
    const env = await setup([]);
    const action = await env.executor.submit({ type: "archive", accountId: "account-1", params: { emailIds: [] }, actor: { kind: "agent", id: "prior-run" }, category: "triage", reason: "Released from yesterday's queue" });
    await env.store.actions.update(action.id, { createdAt: "2026-10-19T23:58:00.000Z", executedAt: TEST_NOW });
    await env.runtime.run({ kind: "schedule", name: "daily_digest" });
    expect(await env.store.kv.get("digest:2026-10-20")).toContain("Released from yesterday's queue");
  });

  it("carries unresolved decisions across days and stops showing dismissed items", async () => {
    const env = await setup([{ category: "replies_stranger" }, newMatterOutput]);
    let instant = TEST_NOW;
    const runtime = createAgentRuntime({ ...env, now: () => instant });
    const run = await runtime.run({ kind: "email.received", emailId: "email-1" });
    instant = "2026-10-21T14:00:00.000Z";
    await runtime.run({ kind: "schedule", name: "daily_digest" });
    expect(await env.store.kv.get("digest:2026-10-21")).toContain("Decision needed for email-1: Alice asks for a review");
    await env.store.kv.delete(`decision:${run.id}:email-1`);
    await runtime.run({ kind: "schedule", name: "daily_digest" });
    expect(await env.store.kv.get("digest:2026-10-21")).not.toContain("Decision needed for email-1");
    expect(await env.store.kv.get("agent:pending_decisions")).toBe("[]");
  });

  it("reviews old active matters and leaves recently active matters alone", async () => {
    const env = await setup([{ summary: "Waiting for Alice's response", nextStep: "Follow up next week", status: "waiting" }]);
    await env.store.matters.upsert(matterFixture());
    await env.store.matters.upsert(matterFixture({ id: "recent", emailIds: ["email-1"] }));
    await env.store.matters.upsert(matterFixture({ id: "done", status: "done" }));
    await env.runtime.run({ kind: "schedule", name: "matter_review" });
    expect(env.executor.requests).toHaveLength(1);
    expect(await env.store.matters.get("matter-1")).toMatchObject({ status: "waiting", summary: "Waiting for Alice's response" });
    expect(await env.store.matters.get("recent")).toMatchObject({ status: "active" });
  });

  it("persists a failed run and finishes its event lifecycle without leaking collaborator errors", async () => {
    const env = await setup([]);
    vi.spyOn(env.policy, "getTrust").mockRejectedValueOnce(new Error("authorization=private-token"));
    await expect(env.runtime.run({ kind: "manual", instruction: "Read my mail" })).rejects.toMatchObject({ code: "AGENT_COLLABORATOR" });
    const finished = env.bus.events.at(-1) as AgentFinishedEvent;
    expect(finished).toMatchObject({ type: "agent.run.finished", error: "Agent operation failed" });
    const saved = await env.store.kv.get(`run:${finished.runId}`);
    expect(saved).toContain('"finishedAt"');
    expect(saved).not.toContain("private-token");
    env.llm.script.push("Nothing pending.");
    await expect(env.runtime.run({ kind: "manual", instruction: "Try again" })).resolves.toMatchObject({ finishedAt: TEST_NOW });
  });

  it("keeps successful action IDs when a later LLM call fails", async () => {
    const env = await setup([new Error("private provider error")]);
    await expect(env.runtime.run({ kind: "email.received", emailId: "email-1" })).rejects.toMatchObject({ code: "AGENT_COLLABORATOR" });
    const finished = env.bus.events.at(-1) as AgentFinishedEvent;
    const saved = JSON.parse((await env.store.kv.get(`run:${finished.runId}`))!);
    expect(saved.actionIds).toHaveLength(2);
    expect(saved.error).not.toContain("private");
  });

  it("fails clearly for missing mail and routes outbox schedules to the executor", async () => {
    const env = await setup([]);
    await expect(env.runtime.run({ kind: "email.received", emailId: "absent" })).rejects.toMatchObject({ code: "EMAIL_NOT_FOUND" });
    await env.runtime.run({ kind: "schedule", name: "outbox" });
    expect(env.executor.releaseCalls).toBe(1);
  });
});

describe("manual tools", () => {
  it("runs a read/draft loop and routes writes through the executor", async () => {
    const draft = { accountId: "account-1", inReplyToEmailId: "email-1", to: [{ email: "alice@example.com" }], subject: "Re: A quick question", textBody: "I can help arrange a review." };
    const env = await setup([toolOutput("get_email", { emailId: "email-1" }), toolOutput("create_draft", { draft, reason: "Draft for review" }, "call-2"), "Draft submitted."]);
    await env.runtime.run({ kind: "manual", instruction: "Draft a reply to Alice", emailIds: ["email-1"] });
    expect(env.executor.requests).toHaveLength(1);
    expect(env.executor.requests[0]).toMatchObject({ type: "draft_create", actor: { kind: "agent" }, params: { draft } });
    expect(env.llm.calls[1]?.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-1" });
    expect(env.llm.calls.every(call => call.system.includes("USER.md"))).toBe(true);
  });

  it("caps total tool invocations across multiple rounds at twelve", async () => {
    const env = await setup(Array.from({ length: 13 }, (_, i) => toolOutput("archive_emails", { reason: "Organize mail", emailIds: ["email-1"] }, `call-${i}`)));
    const run = await env.runtime.run({ kind: "manual", instruction: "Keep organizing" });
    expect(env.llm.calls).toHaveLength(12);
    expect(env.executor.requests).toHaveLength(12);
    expect(run.summary).toContain("limit reached (12)");
  });

  it("caps a single batch of thirteen tool calls at twelve", async () => {
    const response = toolOutput("archive_emails", { reason: "Organize mail", emailIds: ["email-1"] });
    response.toolCalls = Array.from({ length: 13 }, (_, i) => ({ id: `call-${i}`, name: "archive_emails", arguments: { reason: "Organize mail", emailIds: ["email-1"] } }));
    const env = await setup([response]);
    await env.runtime.run({ kind: "manual", instruction: "Archive selected mail" });
    expect(env.executor.requests).toHaveLength(12);
    expect(env.llm.calls).toHaveLength(1);
  });

  it("returns repairable read errors to the model", async () => {
    const env = await setup([toolOutput("get_email", { emailId: "missing" }), toolOutput("get_email", { emailId: "email-1" }, "call-2"), "Read complete."]);
    await env.runtime.run({ kind: "manual", instruction: "Read the email" });
    expect(env.llm.calls[1]?.messages.at(-1)).toMatchObject({ isError: true });
    expect(env.executor.requests).toEqual([]);
  });

  it("keeps manual sends in the policy-controlled outbox", async () => {
    const env = await setup([toolOutput("send", { reason: "Send reviewed draft", draftEmailId: "draft-1" }), "The send is held."]);
    await env.store.emails.upsertMany([emailFixture({ id: "draft-1", keywords: { $draft: true } })]);
    await env.runtime.run({ kind: "manual", instruction: "Send my reviewed draft" });
    expect(env.executor.records[0]).toMatchObject({ status: "held", request: { type: "send" } });
  });

  it("rejects unknown or malformed tool calls before submitting actions", async () => {
    const env = await setup([toolOutput("provider_send", { actor: { kind: "human" } })]);
    await expect(env.runtime.run({ kind: "manual", instruction: "Send mail" })).rejects.toMatchObject({ code: "LLM_TOOL" });
    expect(env.executor.requests).toEqual([]);
    const bad = await setup([toolOutput("archive_emails", { reason: "Organize mail", emailIds: "email-1" })]);
    await expect(bad.runtime.run({ kind: "manual", instruction: "Archive mail" })).rejects.toMatchObject({ code: "LLM_SCHEMA" });
    expect(bad.executor.requests).toEqual([]);
  });
});


describe("registry integration and tool budgets", () => {
  it("makes newly registered tools available automatically and reports token/call usage", async () => {
    const env = await setup([toolOutput("get_standing_rules", {}), "Read the standing instructions."]);
    const run = await env.runtime.run({ kind: "manual", instruction: "Read standing rules" });
    const registry = createToolRegistry({ ...env, actor: { kind: "agent", id: run.id } });
    expect(env.llm.calls[0]?.tools).toEqual(registry.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
    expect(registry.every(tool => env.llm.calls[0]?.system.includes(tool.name))).toBe(true);
    expect(run.toolBudget).toEqual({ callsMade: 1, llmCalls: 2, inputTokens: 20, outputTokens: 10, totalTokens: 30 });
    expect(JSON.parse((await env.store.kv.get(`run:${run.id}`))!).toolBudget).toEqual(run.toolBudget);
  });
  it("counts triage registry calls and avoids submitting empty scheduling proposals", async () => {
    const env = await setup([newMatterOutput, { status: "tentative", textBody: "Please suggest a convenient time.", slots: [] }], emailFixture({ subject: "Meeting invite" }));
    const run = await env.runtime.run({ kind: "email.received", emailId: "email-1" });
    expect(run.toolBudget.callsMade).toBe(4);
    expect(env.executor.requests.at(-1)).toMatchObject({ type: "draft_create", category: "scheduling" });
    expect(env.executor.requests.some(request => request.type === "calendar_propose")).toBe(false);
  });
});
