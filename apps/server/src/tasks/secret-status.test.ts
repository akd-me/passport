/** R1-18: `request_secret` and `ask_user` keep separate Input state on the task. */
import { afterEach, describe, expect, it } from "vitest";
import type { RealBackend } from "../compose.js";
import { taskBackend, toolCall, waitFor } from "./test-support.js";

const backends: RealBackend[] = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
});
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function setup(expired = false) {
  const env = await taskBackend(backends);
  env.llm.script.push(toolCall("ask_user", { text: "Which account?" }), "Asked.");
  const { task, done } = await env.service.create({ message: "Connect my bank" });
  await done;
  await waitFor(async () => env.service.runner.activeRuns(task.id).length === 0);
  const now = new Date().toISOString();
  const { request } = await env.backend.store.secrets!.requests.create({
    taskId: task.id,
    clientRequestId: "bank",
    text: "Bank password",
    createdAt: now,
    expiresAt: new Date(Date.now() + (expired ? -1000 : 60_000)).toISOString(),
  });
  await env.service.runner.updateTask(task.id, (current) => ({
    pendingSecretRequestIds: [...(current.pendingSecretRequestIds ?? []), request.id],
  }));
  const question = (await env.service.task(task.id)).pendingQuestions![0]!;
  return { env, task, request, question };
}

describe("secret requests and questions", () => {
  it.each(["saved", "declined", "cancelled", "timed_out"] as const)(
    "removes a %s secret request after its run has ended",
    async (status) => {
      const { env, task, request, question } = await setup(status === "timed_out");
      await env.app.request(`/api/tasks/${task.id}/questions/${question.itemId}/dismiss`, post({}));
      expect(env.service.runner.activeRuns(task.id)).toEqual([]);
      expect((await env.service.task(task.id)).needsUser).toBe("question");
      const res = await env.app.request(
        `/api/tasks/${task.id}/secrets/${request.id}`,
        status === "timed_out"
          ? undefined
          : post(status === "saved" ? { value: "private-value" } : { status }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status });
      expect(await env.service.task(task.id)).toMatchObject({
        needsUser: null,
        pendingSecretRequestIds: [],
        pendingQuestions: [],
      });
    },
  );

  it("resolving a secret keeps Input while a question is open", async () => {
    const { env, task, request } = await setup();
    const res = await env.app.request(
      `/api/tasks/${task.id}/secrets/${request.id}`,
      post({ value: "hunter2" }),
    );
    expect(res.status).toBe(200);
    const after = await env.service.task(task.id);
    expect(after.needsUser).toBe("question");
    expect(after.pendingSecretRequestIds ?? []).toEqual([]);
    expect(after.pendingQuestions).toHaveLength(1);
  });

  it("dismissing the last question keeps Input while a secret request is open", async () => {
    const { env, task, request, question } = await setup();
    const res = await env.app.request(
      `/api/tasks/${task.id}/questions/${question.itemId}/dismiss`,
      post({}),
    );
    expect(res.status).toBe(200);
    expect(await env.service.task(task.id)).toMatchObject({
      needsUser: "question",
      pendingQuestions: [],
      pendingSecretRequestIds: [request.id],
    });
    // Declining the secret then clears it.
    await env.app.request(
      `/api/tasks/${task.id}/secrets/${request.id}`,
      post({ status: "declined" }),
    );
    expect((await env.service.task(task.id)).needsUser).toBeNull();
  });
});
