import type { ActionRecord, DomainEvent, Task, TaskItem } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealBackend } from "../compose.js";
import { deliver, gate, taskBackend, toolCall, waitFor } from "./test-support.js";

describe("TaskService", () => {
  const backends: RealBackend[] = [];
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.close()));
    vi.restoreAllMocks();
  });
  const setup = () => taskBackend(backends);
  const items = (env: Awaited<ReturnType<typeof setup>>, id: string) =>
    env.service.items(id, 0, 500);

  it("records tool calls, links proposals and surfaces the task for approval", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = await setup();
    const email = await deliver(env, { providerId: "m1", from: [{ email: "sam@example.com" }] });
    await env.backend.drainAgentQueue();
    const events: DomainEvent[] = [];
    env.backend.bus.onAny((event) => events.push(event));
    env.llm.script.push(
      toolCall("get_email", { emailId: email.id }, "Reading it."),
      toolCall("send", {
        draft: {
          accountId: env.account.id,
          to: [{ email: "stranger@elsewhere.example" }],
          subject: "Hello",
          textBody: "Hi",
        },
        reason: "Reply as asked",
      }),
      "I drafted a reply for your approval.",
    );
    const { task, run, done } = await env.service.create({ message: "Reply to Sam's message" });
    expect(task).toMatchObject({
      kind: "task",
      status: "working",
      title: "Reply to Sam's message",
    });
    expect(run).toMatchObject({
      status: "queued",
      priority: "interactive",
      trigger: { kind: "message" },
    });
    await done;
    const detail = await waitFor(async () => {
      const d = await env.service.get(task.id);
      return d.runs[0]?.status === "completed" && d;
    });
    const timeline = await items(env, task.id);
    expect(timeline.map((item) => item.kind)).toEqual([
      "user_message",
      "assistant_message",
      "tool_call",
      "approval_request",
      "tool_call",
      "assistant_message",
    ]);
    const call = timeline.find((item) => item.kind === "tool_call")!;
    expect(call).toMatchObject({ untrusted: true, payload: { name: "get_email", isError: false } });
    expect((call.payload as { inputSummary: string }).inputSummary.length).toBeLessThanOrEqual(200);
    const approval = timeline.find((item) => item.kind === "approval_request") as Extract<
      TaskItem,
      { kind: "approval_request" }
    >;
    expect(detail.runs[0]!.actionIds).toEqual([approval.payload.actionId]);
    expect(detail.task).toMatchObject({
      status: "inbox",
      needsUser: "approval",
      pendingActionIds: [approval.payload.actionId],
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["task.updated", "task.run.updated", "task.item.appended"]),
    );
    const action = (await env.backend.store.actions.get(approval.payload.actionId)) as ActionRecord;
    expect(action.request.runId).toBe(detail.runs[0]!.agentRunId);
    const rejected = await env.app.request(`/api/actions/${action.id}/reject`, { method: "POST" });
    expect(rejected.status).toBe(200);
    await waitFor(async () => !(await env.service.task(task.id)).pendingActionIds?.length);
    expect(await env.service.task(task.id)).toMatchObject({ needsUser: null, status: "inbox" });
  });

  it("queues follow-ups after the active run and steers by restarting with both messages", async () => {
    const env = await setup();
    const first = gate();
    env.llm.script.push(async () => {
      await first.opened;
      return "First answer.";
    });
    const { task, done } = await env.service.create({ message: "Find the invoice" });
    await waitFor(async () => (await env.service.get(task.id)).runs[0]?.status === "running");
    const queued = await env.service.sendMessage(task.id, { text: "Then file it", mode: "queue" });
    expect(queued.run.status).toBe("queued");
    first.open();
    await done;
    await waitFor(async () =>
      (await env.service.get(task.id)).runs.every((r) => r.status === "completed"),
    );
    expect(env.llm.prompts.at(-1)).toContain("Then file it");

    const second = gate();
    env.llm.script.push(async () => {
      await second.opened;
      return "Never shown.";
    }, "Steered answer.");
    const slow = await env.service.sendMessage(task.id, { text: "Search 2025 too", mode: "queue" });
    await waitFor(
      async () => (await env.tasks.service.tasks.runs.get(slow.run.id))?.status === "running",
    );
    await env.service.sendMessage(task.id, { text: "Only the Hetzner ones", mode: "steer" });
    second.open();
    const runs = await waitFor(async () => {
      const list = (await env.service.get(task.id)).runs;
      return (
        list.length === 4 &&
        list.every((r) => ["completed", "cancelled"].includes(r.status)) &&
        list
      );
    });
    expect(runs.find((r) => r.id === slow.run.id)?.status).toBe("cancelled");
    expect(env.llm.prompts.at(-1)).toContain("Search 2025 too");
    expect(env.llm.prompts.at(-1)).toContain("Only the Hetzner ones");
    expect((await items(env, task.id)).some((i) => i.kind === "system_notice")).toBe(true);
  });

  it("plan mode records writes as planned without submitting actions", async () => {
    const env = await setup();
    const email = await deliver(env, { providerId: "m1", from: [{ email: "sam@example.com" }] });
    await env.backend.drainAgentQueue();
    env.llm.script.push(
      toolCall("archive_emails", { emailIds: [email.id], reason: "Tidy" }),
      "1. Archive it.",
    );
    const { task, done } = await env.service.create({
      message: "Plan the cleanup",
      interactionMode: "plan",
    });
    const run = await done;
    expect(run.actionIds).toEqual([]);
    const call = (await items(env, task.id)).find((item) => item.kind === "tool_call");
    expect(call?.payload).toMatchObject({ name: "archive_emails", planned: true });
    expect((await env.backend.store.actions.query({ runId: run.id })).items).toEqual([]);
  });

  it("clamps permission modes to the trust dial and the parent, and enforces them in policy", async () => {
    const env = await setup();
    const email = await deliver(env, { providerId: "m1", from: [{ email: "sam@example.com" }] });
    await env.backend.drainAgentQueue();
    await env.backend.policy.setConfig({ globalMode: "auto_accept_edits" });
    await env.backend.policy.pinLevel("other", "full_access");
    await env.backend.policy.pinLevel("triage", "full_access");
    const parent = await env.service.create({ message: "Parent", permissionMode: "supervised" });
    await parent.done;
    const wide = await env.service.create({ message: "Wide", permissionMode: "full_access" });
    expect(wide.task.permissionMode).toBe("auto_accept_edits");
    await wide.done;
    const child = await env.service.create({
      message: "Child",
      permissionMode: "auto",
      parentTaskId: parent.task.id,
    });
    expect(child.task.permissionMode).toBe("supervised");
    await child.done;
    const patched = await env.service.patch(child.task.id, { permissionMode: "full_access" });
    expect(patched.permissionMode).toBe("supervised");

    env.llm.script.push(toolCall("archive_emails", { emailIds: [email.id], reason: "Tidy" }));
    const supervised = await env.service.create({
      message: "Archive it",
      permissionMode: "supervised",
    });
    const proposed = await supervised.done;
    const [action] = (await env.backend.store.actions.query({ runId: proposed.id })).items;
    expect(action).toMatchObject({ status: "proposed", decision: { trustLevel: "supervised" } });
  });

  it("records arrival triage on the account's inbox task", async () => {
    const env = await setup();
    await deliver(env, {
      providerId: "m1",
      subject: "Invoice $100",
      from: [{ email: "billing@acme.example" }],
    });
    await env.backend.drainAgentQueue();
    const inbox = (await waitFor(() => env.service.tasks.inboxFor(env.account.id))) as Task;
    expect(inbox).toMatchObject({
      kind: "inbox",
      createdBy: "system",
      accountIds: [env.account.id],
    });
    const run = await waitFor(async () => {
      const runs = await env.service.tasks.runs.list(inbox.id);
      return runs[0]?.status === "completed" && runs[0];
    });
    expect(run).toMatchObject({ trigger: { kind: "arrival" }, priority: "background" });
    expect(run.agentRunId).toMatch(/^arrival:/);
    const notification = (await items(env, inbox.id)).find((item) => item.kind === "notification");
    expect(notification).toMatchObject({ untrusted: true, payload: { source: "arrival" } });
    const payload = notification!.payload as { summary: string; row: { subject: string } };
    expect(payload.row.subject).toBe("Invoice $​100");
    expect(payload.summary).toContain("billing@acme.example");
  });

  it("binds model-backed jobs to routine tasks and records their runs", async () => {
    const env = await setup();
    const { getSchedulerService } = await import("../schedulers/service.js");
    const service = getSchedulerService(env.backend);
    await service.ready;
    const job = service.scheduler.get("agent.daily_digest")!;
    const routine = (await env.service.tasks.routineFor("agent.daily_digest"))!;
    expect(job.taskId).toBe(routine.id);
    expect(routine).toMatchObject({ kind: "routine", title: "Daily digest" });
    await service.scheduler.runNow("agent.daily_digest");
    const [run] = await env.service.tasks.runs.list(routine.id);
    expect(run).toMatchObject({
      status: "completed",
      trigger: { kind: "schedule", jobId: "agent.daily_digest" },
    });
    await service.stop();
  });

  it("snoozes, wakes, settles and auto-settles idle tasks", async () => {
    const env = await setup();
    const { task, done } = await env.service.create({ message: "Hello" });
    await done;
    await waitFor(async () => (await env.service.task(task.id)).status === "inbox");
    const until = new Date(Date.now() + 60_000).toISOString();
    expect(await env.service.snooze(task.id, until)).toMatchObject({
      status: "snoozed",
      snoozedUntil: until,
    });
    await expect(env.service.snooze(task.id, "2000-01-01T00:00:00Z")).rejects.toMatchObject({
      code: "INVALID_FIELD",
    });
    await env.service.tasks.update(task.id, {
      snoozedUntil: new Date(Date.now() - 1000).toISOString(),
    });
    await env.tasks.maintain();
    expect(await env.service.task(task.id)).toMatchObject({ status: "inbox", snoozedUntil: null });
    const old = new Date(Date.now() - 4 * 86_400_000).toISOString();
    await env.service.tasks.update(task.id, { lastActivityAt: old });
    expect(await env.tasks.maintain()).toContain("1 settled");
    expect((await env.service.task(task.id)).status).toBe("settled");
    expect(await env.service.pin(task.id, true)).toMatchObject({ pinned: true });
    expect(await env.service.archive(task.id)).toMatchObject({ status: "archived", watches: [] });
  });
});
