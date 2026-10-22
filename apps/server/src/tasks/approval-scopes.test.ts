import type { ActionRecord, ApprovalScopeResult, TaskApprovalGrant } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealBackend } from "../compose.js";
import { grantCovers } from "./approvals.js";
import { deliver, taskBackend, toolCall, waitFor } from "./test-support.js";

type Env = Awaited<ReturnType<typeof taskBackend>>;
const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("task-scoped approvals", () => {
  const backends: RealBackend[] = [];
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.close()));
    vi.restoreAllMocks();
  });

  async function setup() {
    const env = await taskBackend(backends);
    const emails = [];
    for (const id of ["m1", "m2", "m3"]) {
      emails.push(await deliver(env, { providerId: id, from: [{ email: "sam@example.com" }] }));
    }
    await env.backend.drainAgentQueue();
    return { env, emails };
  }

  /** Runs one message on the task (a new one when `taskId` is null) that makes `call`. */
  async function step(
    env: Env,
    taskId: string | null,
    call: ReturnType<typeof toolCall>,
    mode: "supervised" | "auto_accept_edits" = "supervised",
  ) {
    env.llm.script.push(call, "Ok.");
    const started = taskId
      ? await env.service.sendMessage(taskId, { text: "Go on" })
      : await env.service.create({ message: "Tidy up", permissionMode: mode });
    const run = await waitFor(async () => {
      const current = await env.service.tasks.runs.get(started.run.id);
      return current?.status === "completed" && current;
    });
    // Task-scoped approvals finish before the run does.
    const [action] = (await env.backend.store.actions.query({ runId: run.agentRunId })).items;
    return { task: started.task, action: action as ActionRecord };
  }
  const archive = (env: Env, taskId: string | null, emailId: string) =>
    step(env, taskId, toolCall("archive_emails", { emailIds: [emailId], reason: "Tidy" }));
  const send = (env: Env, taskId: string | null) =>
    step(
      env,
      taskId,
      toolCall("send", {
        draft: {
          accountId: env.account.id,
          to: [{ email: "sam@example.com" }],
          subject: "Hello",
          textBody: "Hi",
        },
        reason: "Reply",
      }),
      "auto_accept_edits",
    );

  async function approve(env: Env, id: string, body: unknown) {
    const response = await env.app.request(`/api/actions/${id}/approve`, json(body));
    return {
      status: response.status,
      body: (await response.json()) as ActionRecord & {
        approvalScope?: ApprovalScopeResult;
        error?: { code: string };
      },
    };
  }

  const notices = async (env: Env, taskId: string) =>
    (await env.service.items(taskId, 0, 500)).flatMap((item) =>
      item.kind === "system_notice" ? [item.payload.code] : [],
    );

  it("once: the next proposal of the same category still asks", async () => {
    const { env, emails } = await setup();
    const first = await archive(env, null, emails[0]!.id);
    expect(first.action.status).toBe("proposed");
    const approved = await approve(env, first.action.id, { scope: "once" });
    expect(approved.status).toBe(200);
    expect(approved.body.approvalScope).toBeUndefined();
    const second = await archive(env, first.task.id, emails[1]!.id);
    expect(second.action.status).toBe("proposed");
    expect((await env.service.task(first.task.id)).approvalGrants).toBeUndefined();
  });

  it("task: later proposals of the category in that task are approved, without training the ladder", async () => {
    const { env, emails } = await setup();
    const first = await archive(env, null, emails[0]!.id);
    const category = first.action.request.category;
    const approved = await approve(env, first.action.id, { scope: "task" });
    expect(approved.body.approvalScope).toEqual({
      requested: "task",
      applied: "task",
      taskId: first.task.id,
    });
    expect((await env.service.task(first.task.id)).approvalGrants).toEqual([
      expect.objectContaining({ category, actionId: first.action.id, trustLevel: "supervised" }),
    ]);
    const ladder = (await env.backend.policy.getTrustFor(category)).approvals;

    const second = await archive(env, first.task.id, emails[1]!.id);
    expect(second.action.status).toBe("executed");
    const task = await env.service.task(first.task.id);
    expect(task.pendingActionIds).toEqual([]);
    expect(task.needsUser).toBeNull();
    const timeline = await env.service.items(first.task.id, 0, 500);
    expect(
      timeline.filter((item) => item.kind === "approval_request").map((i) => i.payload),
    ).toEqual([expect.objectContaining({ actionId: first.action.id })]);
    expect(await notices(env, first.task.id)).toEqual(["APPROVAL_SCOPE", "TASK_APPROVED"]);
    expect((await env.backend.policy.getTrustFor(category)).approvals).toBe(ladder);

    // Another task keeps asking.
    const other = await archive(env, null, emails[2]!.id);
    expect(other.action.status).toBe("proposed");
  });

  it("always: pins the category for reversible actions; falls back to task with a notice", async () => {
    const { env, emails } = await setup();
    const first = await archive(env, null, emails[0]!.id);
    const category = first.action.request.category;
    const approved = await approve(env, first.action.id, { scope: "always" });
    expect(approved.body.approvalScope).toMatchObject({
      requested: "always",
      applied: "always",
      pinnedLevel: "auto_accept_edits",
    });
    expect((await env.backend.policy.getTrustFor(category)).pinnedLevel).toBe("auto_accept_edits");
    expect((await env.service.task(first.task.id)).approvalGrants).toHaveLength(1);

    // The global mode asks before every action: no pin can express "always".
    const second = await archive(env, null, emails[1]!.id);
    await env.backend.policy.pinLevel(category, null);
    await env.backend.policy.setConfig({ globalMode: "supervised" });
    const fallback = await approve(env, second.action.id, { scope: "always" });
    expect(fallback.body.approvalScope).toMatchObject({
      requested: "always",
      applied: "task",
      code: "ALWAYS_UNAVAILABLE",
      taskId: second.task.id,
    });
    expect((await env.backend.policy.getTrustFor(category)).pinnedLevel ?? null).toBeNull();
    expect(await notices(env, second.task.id)).toEqual(["ALWAYS_UNAVAILABLE"]);
    expect((await env.service.task(second.task.id)).approvalGrants).toHaveLength(1);
  });

  it("rejects scopes for actions outside tasks and unknown scopes", async () => {
    const { env, emails } = await setup();
    const first = await archive(env, null, emails[0]!.id);
    expect((await approve(env, first.action.id, { scope: "forever" })).status).toBe(400);
    const outside = await env.backend.executor.submit({
      ...first.action.request,
      params: { emailIds: [emails[1]!.id] },
      runId: undefined,
    });
    expect(outside.status).toBe("proposed");
    const refused = await approve(env, outside.id, { scope: "task" });
    expect(refused).toMatchObject({ status: 400, body: { error: { code: "NOT_A_TASK_ACTION" } } });
    expect((await env.backend.store.actions.get(outside.id))?.status).toBe("proposed");
  });

  it("never escalates: a lowered task mode or an always-ask category keeps asking", async () => {
    const { env, emails } = await setup();
    await env.backend.policy.setConfig({ globalMode: "full_access" });
    for (const category of ["replies_known", "replies_stranger", "other"] as const) {
      await env.backend.policy.pinLevel(category, "full_access");
    }
    const first = await send(env, null);
    expect(first.action).toMatchObject({
      status: "proposed",
      decision: { trustLevel: "auto_accept_edits", reversibility: "delayed" },
    });
    await approve(env, first.action.id, { scope: "task" });
    const second = await send(env, first.task.id);
    expect(second.action.status).toBe("held");
    // Lowering the task's mode voids the grant: it was given at auto_accept_edits.
    await env.service.patch(first.task.id, { permissionMode: "supervised" });
    const lowered = await send(env, first.task.id);
    expect(lowered.action).toMatchObject({
      status: "proposed",
      decision: { trustLevel: "supervised" },
    });

    // The person's always-ask rule outranks a grant.
    const tidy = await archive(env, null, emails[0]!.id);
    const category = tidy.action.request.category;
    await env.backend.policy.pinLevel(category, null);
    await approve(env, tidy.action.id, { scope: "task" });
    await env.backend.policy.setConfig({ alwaysAsk: [category] });
    const asked = await archive(env, tidy.task.id, emails[1]!.id);
    expect(asked.action.status).toBe("proposed");
    expect(asked.action.decision.reason).toContain("always requires approval");
  });
});

describe("grantCovers", () => {
  const grant: TaskApprovalGrant = {
    category: "replies_known",
    actionId: "a1",
    trustLevel: "auto_accept_edits",
    risk: "medium",
    reversibility: "delayed",
    grantedAt: "2026-10-22T00:00:00Z",
  };
  const action = (patch: Partial<ActionRecord["decision"]>, category = "replies_known") =>
    ({
      request: { category },
      decision: {
        trustLevel: "auto_accept_edits",
        risk: "medium",
        reversibility: "delayed",
        ...patch,
      },
    }) as unknown as ActionRecord;

  it("covers the same or a lesser action and nothing above the grant", () => {
    expect(grantCovers(grant, action({}))).toBe(true);
    expect(grantCovers(grant, action({ risk: "low", reversibility: "reversible" }))).toBe(true);
    expect(grantCovers(grant, action({ trustLevel: "auto" }))).toBe(true);
    // A lowered task mode, global dial or ladder voids it.
    expect(grantCovers(grant, action({ trustLevel: "supervised" }))).toBe(false);
    // Riskier, less reversible, or another category: ask.
    expect(grantCovers(grant, action({ risk: "high" }))).toBe(false);
    expect(grantCovers(grant, action({ reversibility: "irreversible" }))).toBe(false);
    expect(grantCovers(grant, action({}, "replies_stranger"))).toBe(false);
  });
});
