/** R1 review, runner (C2): R1-8 settling runs, R1-9 the live ceiling, R1-10 run accounts. */
import type { AgentRunOptions } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealBackend } from "../compose.js";
import { gate, taskBackend, waitFor } from "./test-support.js";

const backends: RealBackend[] = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  vi.restoreAllMocks();
});
type Env = Awaited<ReturnType<typeof taskBackend>>;
const idle = (env: Env, taskId: string) =>
  waitFor(async () =>
    (await env.service.tasks.runs.list(taskId)).every(
      (run) => run.status !== "queued" && run.status !== "running",
    ),
  );

describe("task runner", () => {
  it("a steer that lands after the run finished neither re-sends it nor skips its hooks", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = await taskBackend(backends);
    env.llm.script.push("Archived the newsletters.", "Archived the PDFs.");
    let steered: Promise<unknown> | undefined;
    const off = env.backend.bus.on("agent.run.finished", () => {
      off();
      steered = env.tasks.queue.send(task.id, { text: "Also the PDFs", mode: "steer" });
    });
    const { task, done } = await env.service.create({ message: "Archive the newsletters" });
    await done;
    await steered;
    await idle(env, task.id);
    const runs = (await env.service.get(task.id)).runs;
    expect(runs.map((run) => run.status)).toEqual(["completed", "completed"]);
    const prompt = env.llm.prompts.at(-1) ?? "";
    expect(prompt).toContain("Also the PDFs");
    expect(prompt).not.toContain("while you worked");
    // The first run's hooks ran: the status rules handed it back once both ended.
    expect((await env.service.task(task.id)).status).toBe("inbox");
  });

  it("lowering the mode or switching to plan reaches a running session", async () => {
    const env = await taskBackend(backends);
    const ceilings = env.service.options.ceilings;
    const hold = gate();
    env.llm.script.push(async () => {
      await hold.opened;
      return "Done.";
    });
    const { task } = await env.service.create({
      message: "Tidy up",
      permissionMode: "auto_accept_edits",
    });
    const run = await waitFor(async () =>
      env.service.runner.activeRuns(task.id).find((r) => r.status === "running"),
    );
    expect(await ceilings.lookup({ runId: run.agentRunId })).toBe("auto_accept_edits");
    await env.service.patch(task.id, { permissionMode: "supervised" });
    expect(await ceilings.lookup({ runId: run.agentRunId })).toBe("supervised");
    // Raising waits for the next run.
    await env.service.patch(task.id, { permissionMode: "auto_accept_edits" });
    expect(await ceilings.lookup({ runId: run.agentRunId })).toBe("auto_accept_edits");
    await env.service.patch(task.id, { interactionMode: "plan" });
    expect(await ceilings.lookup({ runId: run.agentRunId })).toBe("supervised");
    hold.open();
    await idle(env, task.id);
    expect(await ceilings.lookup({ runId: run.agentRunId })).toBeUndefined();
  });

  it("a lowered parent caps its running subtask", async () => {
    const env = await taskBackend(backends);
    const ceilings = env.service.options.ceilings;
    env.llm.script.push("Parent done.");
    const { task: parent, done } = await env.service.create({ message: "Parent" });
    await done;
    const hold = gate();
    env.llm.script.push(async () => {
      await hold.opened;
      return "Child done.";
    });
    const { task: child } = await env.service.create({
      message: "Child",
      parentTaskId: parent.id,
      createdBy: "agent",
    });
    const run = await waitFor(async () =>
      env.service.runner.activeRuns(child.id).find((r) => r.status === "running"),
    );
    await env.service.patch(parent.id, { permissionMode: "supervised" });
    expect(await ceilings.lookup({ runId: run.agentRunId })).toBe("supervised");
    hold.open();
    await idle(env, child.id);
  });

  it("passes the task's accounts to the run", async () => {
    const env = await taskBackend(backends);
    const seen: Array<AgentRunOptions | undefined> = [];
    const agent = env.service.options.agent;
    const run = agent.run.bind(agent);
    agent.run = (trigger, options?: AgentRunOptions) => {
      seen.push(options);
      return run(trigger, options);
    };
    const { done } = await env.service.create({
      message: "Scoped",
      accountIds: [env.account.id],
    });
    await done;
    expect(seen[0]?.accountIds).toEqual([env.account.id]);
  });
});
