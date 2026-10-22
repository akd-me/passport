import type { StoreTasks, Task, TaskRun } from "@passport/types";
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "./store.js";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 22, 9, minute)).toISOString();
const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  title: id,
  accountIds: ["acc"],
  status: "inbox",
  pinned: false,
  permissionMode: "supervised",
  interactionMode: "default",
  createdBy: "user",
  kind: "task",
  needsUser: null,
  lastActivityAt: at(0),
  createdAt: at(0),
  watches: [],
  ...patch,
});
const run = (id: string, taskId: string, patch: Partial<TaskRun> = {}): TaskRun => ({
  id,
  taskId,
  status: "queued",
  trigger: { kind: "wake", reason: "test" },
  priority: "background",
  agentRunId: id,
  createdAt: at(1),
  actionIds: [],
  ...patch,
});

describe("store.tasks", () => {
  const stores: ReturnType<typeof openStore>[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });
  async function tasks(): Promise<StoreTasks> {
    const store = openStore({ path: ":memory:" });
    stores.push(store);
    await store.migrate();
    return store.tasks!;
  }

  it("inserts, updates with revisions and pages by last activity", async () => {
    const repo = await tasks();
    for (let i = 0; i < 5; i++) {
      await repo.insert(
        task(`t${i}`, { lastActivityAt: at(i), status: i % 2 ? "working" : "inbox" }),
      );
    }
    const first = await repo.list({ limit: 2 });
    expect(first.items.map((t) => t.id)).toEqual(["t4", "t3"]);
    expect(first.total).toBe(5);
    const second = await repo.list({ limit: 2, cursor: first.nextCursor });
    expect(second.items.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect((await repo.list({ status: ["working"] })).items.map((t) => t.id)).toEqual(["t3", "t1"]);
    const updated = await repo.update("t0", (current) => ({ pinned: !current.pinned }));
    expect(updated).toMatchObject({ pinned: true, revision: 2 });
    expect((await repo.list({ pinned: true })).items.map((t) => t.id)).toEqual(["t0"]);
    await expect(repo.update("missing", {})).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("finds inbox, routine and watching tasks", async () => {
    const repo = await tasks();
    await repo.insert(task("inbox", { kind: "inbox", accountIds: ["acc-1"] }));
    await repo.insert(task("routine", { kind: "routine", jobId: "agent.daily_digest" }));
    await repo.insert(
      task("watch", {
        watches: [
          { threadHandle: "acc:thread:1", account: "acc", since: at(0), consecutiveWakes: 0 },
        ],
      }),
    );
    expect((await repo.inboxFor("acc-1"))?.id).toBe("inbox");
    expect(await repo.inboxFor("acc-2")).toBeNull();
    expect((await repo.routineFor("agent.daily_digest"))?.id).toBe("routine");
    expect((await repo.watching()).map((t) => t.id)).toEqual(["watch"]);
    await repo.update("watch", { watches: [] });
    expect(await repo.watching()).toEqual([]);
    await expect(
      repo.insert(task("inbox-2", { kind: "inbox", accountIds: ["acc-1"] })),
    ).rejects.toThrow();
  });

  it("stores runs and pages items by sequence", async () => {
    const repo = await tasks();
    await repo.insert(task("t"));
    await repo.runs.insert(run("r1", "t", { agentRunId: "arrival:e1" }));
    await repo.runs.insert(run("r2", "t", { createdAt: at(2), status: "completed" }));
    expect((await repo.runs.list("t")).map((r) => r.id)).toEqual(["r2", "r1"]);
    expect((await repo.runs.byAgentRunId("arrival:e1"))?.id).toBe("r1");
    expect((await repo.runs.unfinished()).map((r) => r.id)).toEqual(["r1"]);
    await repo.runs.update("r1", (current) => ({
      actionIds: [...current.actionIds, "a1"],
      status: "completed",
    }));
    expect(await repo.runs.unfinished()).toEqual([]);
    expect((await repo.runs.get("r1"))?.actionIds).toEqual(["a1"]);
    await expect(repo.runs.insert(run("r3", "missing"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    for (let i = 0; i < 5; i++) {
      await repo.items.append({
        taskId: "t",
        runId: "r1",
        kind: i % 2 ? "assistant_message" : "user_message",
        at: at(i),
        payload: { text: `m${i}` },
      });
    }
    const page = await repo.items.list({ taskId: "t", afterSeq: 2, limit: 2 });
    expect(page.map((item) => item.seq)).toEqual([3, 4]);
    expect((await repo.items.recent("t", ["assistant_message"], 5)).map((i) => i.seq)).toEqual([
      4, 2,
    ]);
  });
});
