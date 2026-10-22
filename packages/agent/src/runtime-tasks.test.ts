import type { ToolCallEvent } from "@passport/types";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "./runtime.js";
import { FakeExecutor, FakePolicy, MemoryBus } from "./testing/collaborators.js";
import { FakeLlm, toolOutput } from "./testing/fake-llm.js";
import { accountFixture, emailFixture, TEST_NOW } from "./testing/fixtures.js";
import { MemoryStore } from "./testing/memory-store.js";

async function setup(script: unknown[]) {
  const store = new MemoryStore();
  const policy = new FakePolicy();
  await store.accounts.upsert(accountFixture());
  await store.emails.upsertMany([emailFixture()]);
  const executor = new FakeExecutor(store, policy);
  const runtime = createAgentRuntime({
    store,
    executor,
    policy,
    bus: new MemoryBus(),
    llm: new FakeLlm(script),
    selfAddresses: ["me@example.com"],
    now: () => TEST_NOW,
  });
  return { runtime, executor };
}

describe("task run options", () => {
  it("uses the given run id, reports tool calls and assistant text, and forwards taskId", async () => {
    const email = emailFixture();
    const { runtime } = await setup([
      { ...toolOutput("get_email", { emailId: email.id }), text: "Looking it up." },
      "Done: it is a project update.",
    ]);
    const calls: ToolCallEvent[] = [];
    const texts: string[] = [];
    const run = await runtime.run(
      { kind: "manual", instruction: "What is this?" },
      {
        runId: "task-run-1",
        taskId: "task-1",
        observer: {
          toolCall: (event) => calls.push(event),
          assistantMessage: (t) => texts.push(t),
        },
      },
    );
    expect(run.id).toBe("task-run-1");
    expect(calls).toEqual([
      expect.objectContaining({ name: "get_email", runId: "task-run-1", taskId: "task-1" }),
    ]);
    expect(texts).toEqual(["Looking it up.", "Done: it is a project update."]);
  });

  it("read-only runs never submit writes", async () => {
    const email = emailFixture();
    const { runtime, executor } = await setup([
      toolOutput("archive_emails", { emailIds: [email.id], reason: "Tidy" }),
      "Plan: archive it.",
    ]);
    const calls: ToolCallEvent[] = [];
    await runtime.run(
      { kind: "manual", instruction: "Plan the cleanup" },
      { readOnly: true, observer: { toolCall: (event) => calls.push(event) } },
    );
    expect(executor.requests).toEqual([]);
    expect(calls[0]).toMatchObject({ name: "archive_emails", planned: true });
  });

  it("stops at the next model call once the signal aborts", async () => {
    const { runtime } = await setup(["never"]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime.run({ kind: "manual", instruction: "x" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "RUN_CANCELLED" });
  });
});
