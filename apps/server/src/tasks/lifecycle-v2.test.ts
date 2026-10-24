import type {
  DomainEvent,
  Task,
  TaskItem,
  TaskQueue,
  TaskRun,
  TaskWithPrevious,
} from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealBackend } from "../compose.js";
import { gate, taskBackend, waitFor } from "./test-support.js";

const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** v0.4 W1B: seen state, reopen routes and the follow-up queue over HTTP. */
describe("task lifecycle v2", () => {
  const backends: RealBackend[] = [];
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((b) => b.close()));
    vi.restoreAllMocks();
  });

  async function setup() {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    return taskBackend(backends);
  }
  type Env = Awaited<ReturnType<typeof setup>>;
  const post = async <T>(env: Env, path: string, body?: unknown) => {
    const response = await env.app.request(
      path,
      body === undefined ? { method: "POST" } : json(body),
    );
    return { status: response.status, body: (await response.json()) as T };
  };
  /** No run is queued or running, apart from entries waiting in a held queue. */
  const idle = (env: Env, taskId: string) =>
    waitFor(async () => {
      const queued = new Set((await env.service.task(taskId)).queue?.map((e) => e.runId));
      return (await env.service.tasks.runs.list(taskId)).every(
        (r) => queued.has(r.id) || (r.status !== "queued" && r.status !== "running"),
      );
    });
  /** A task whose first run blocks until `open()`. */
  async function busyTask(env: Env) {
    const g = gate();
    env.llm.script.push(async () => {
      await g.opened;
      return "First done.";
    });
    const { task } = await env.service.create({ message: "Long thing" });
    await waitFor(async () => (await env.service.get(task.id)).runs[0]?.status === "running");
    return { task, open: g.open };
  }

  it("records returnedAt and a Done outcome, and clears it with seen / mark-unread", async () => {
    const env = await setup();
    env.llm.script.push("Hello.");
    const { task, done } = await env.service.create({ message: "Say hello" });
    await done;
    await idle(env, task.id);
    const back = await env.service.task(task.id);
    expect(back).toMatchObject({ status: "inbox", unseenOutcome: "done" });
    expect(back.returnedAt).toBe(back.lastActivityAt);
    const events: DomainEvent[] = [];
    env.backend.bus.onAny((event) => events.push(event));
    const seen = await post<Task>(env, `/api/tasks/${task.id}/seen`);
    expect(seen.body).toMatchObject({ unseenOutcome: null });
    expect(seen.body.seenAt).toBeTruthy();
    const unread = await post<Task>(env, `/api/tasks/${task.id}/mark-unread`);
    expect(unread.body).toMatchObject({ unseenOutcome: "done", seenAt: null });
    expect(events.filter((e) => e.type === "task.updated")).toHaveLength(2);
    expect((await post(env, "/api/tasks/missing/seen")).status).toBe(404);
  });

  it("settle, snooze and archive return the previous state; the reopen routes undo them", async () => {
    const env = await setup();
    env.llm.script.push("Ok.");
    const { task, done } = await env.service.create({ message: "Thing" });
    await done;
    await idle(env, task.id);
    const settled = await post<TaskWithPrevious>(env, `/api/tasks/${task.id}/settle`);
    expect(settled.body).toMatchObject({
      status: "settled",
      previous: { status: "inbox", snoozedUntil: null, settledAt: null },
    });
    const before = settled.body.returnedAt;
    const unsettled = await post<TaskWithPrevious>(env, `/api/tasks/${task.id}/unsettle`);
    expect(unsettled.body).toMatchObject({
      status: "inbox",
      settledAt: null,
      previous: { status: "settled" },
    });
    expect(unsettled.body.returnedAt! >= before!).toBe(true);
    // Repeating an undo is harmless.
    expect(
      (await post<TaskWithPrevious>(env, `/api/tasks/${task.id}/unsettle`)).body,
    ).toMatchObject({ status: "inbox", previous: { status: "inbox" } });
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const snoozed = await post<TaskWithPrevious>(env, `/api/tasks/${task.id}/snooze`, { until });
    expect(snoozed.body).toMatchObject({ status: "snoozed", previous: { status: "inbox" } });
    const unsnoozed = await post<TaskWithPrevious>(env, `/api/tasks/${task.id}/unsnooze`);
    expect(unsnoozed.body).toMatchObject({
      status: "inbox",
      snoozedUntil: null,
      previous: { status: "snoozed", snoozedUntil: until },
    });
    const archived = await post<TaskWithPrevious>(env, `/api/tasks/${task.id}/archive`);
    expect(archived.body).toMatchObject({ status: "archived", previous: { status: "inbox" } });
    const unarchived = await post<TaskWithPrevious>(env, `/api/tasks/${task.id}/unarchive`);
    expect(unarchived.body).toMatchObject({ status: "inbox", previous: { status: "archived" } });
  });

  it("queues follow-ups behind the active run, edits, reorders, removes and runs them in order", async () => {
    const env = await setup();
    const { task, open } = await busyTask(env);
    const sent: TaskRun[] = [];
    for (const text of ["one", "two", "three"]) {
      const response = await post<{ task: Task; run: TaskRun }>(
        env,
        `/api/tasks/${task.id}/messages`,
        { text },
      );
      expect(response.status).toBe(202);
      expect(response.body.run).toMatchObject({ status: "queued", trigger: { kind: "message" } });
      sent.push(response.body.run);
    }
    const queue = (await (
      await env.app.request(`/api/tasks/${task.id}/queue`)
    ).json()) as TaskQueue;
    expect(queue).toMatchObject({ taskId: task.id, held: false });
    expect(queue.entries.map((e) => e.text)).toEqual(["one", "two", "three"]);
    expect(queue.entries.map((e) => e.runId)).toEqual(sent.map((r) => r.id));
    // Queued messages are not on the timeline yet.
    const before = await env.service.items(task.id, 0, 100);
    expect(before.filter((i) => i.kind === "user_message")).toHaveLength(1);

    const [one, two, three] = sent.map((r) => r.id);
    const edited = await env.app.request(
      `/api/tasks/${task.id}/queue/${two}`,
      json({ text: "two, edited" }, "PATCH"),
    );
    expect(((await edited.json()) as TaskQueue).entries[1]?.text).toBe("two, edited");
    const reordered = await post<TaskQueue>(env, `/api/tasks/${task.id}/queue/reorder`, {
      runIds: [three, one, two],
    });
    expect(reordered.body.entries.map((e) => e.runId)).toEqual([three, one, two]);
    expect(
      (await post(env, `/api/tasks/${task.id}/queue/reorder`, { runIds: [one, two] })).status,
    ).toBe(409);
    const removed = await env.app.request(`/api/tasks/${task.id}/queue/${one}`, {
      method: "DELETE",
    });
    expect(((await removed.json()) as TaskQueue).entries.map((e) => e.runId)).toEqual([three, two]);
    expect(await env.service.tasks.runs.get(one!)).toMatchObject({
      status: "cancelled",
      error: "QUEUE_REMOVED",
    });
    expect(
      (await env.app.request(`/api/tasks/${task.id}/queue/${one}`, json({ text: "x" }, "PATCH")))
        .status,
    ).toBe(404);

    env.llm.script.push("Third done.", "Second done.");
    open();
    await waitFor(async () => (await env.service.tasks.runs.get(two!))?.status === "completed");
    await idle(env, task.id);
    const timeline = await env.service.items(task.id, 0, 100);
    const messages = timeline.filter(
      (i): i is Extract<TaskItem, { kind: "user_message" }> => i.kind === "user_message",
    );
    expect(messages.map((i) => i.payload.text)).toEqual(["Long thing", "three", "two, edited"]);
    expect(messages[1]?.runId).toBe(three);
    expect(await env.service.tasks.runs.get(three!)).toMatchObject({
      status: "completed",
      trigger: { kind: "message", itemId: messages[1]?.id },
    });
    const final = await env.service.task(task.id);
    expect(final).toMatchObject({ status: "inbox", queue: [], unseenOutcome: "done" });
  });

  it("holds the queue after interrupt until resume, and a new message releases it", async () => {
    const env = await setup();
    const first = await busyTask(env);
    await post(env, `/api/tasks/${first.task.id}/messages`, { text: "later" });
    const stopped = await post<Task>(env, `/api/tasks/${first.task.id}/interrupt`);
    expect(stopped.body.queueHeld).toBe(true);
    first.open();
    await idle(env, first.task.id);
    let held = await env.service.task(first.task.id);
    expect(held).toMatchObject({ queueHeld: true });
    expect(held.queue?.map((e) => e.text)).toEqual(["later"]);
    env.llm.script.push("Later done.");
    const resumed = await post<TaskQueue>(env, `/api/tasks/${first.task.id}/queue/resume`);
    expect(resumed.body).toMatchObject({ held: false, entries: [] });
    await idle(env, first.task.id);
    held = await env.service.task(first.task.id);
    expect(held).toMatchObject({ status: "inbox", queueHeld: false });

    const second = await busyTask(env);
    await post(env, `/api/tasks/${second.task.id}/messages`, { text: "queued" });
    await post(env, `/api/tasks/${second.task.id}/interrupt`);
    second.open();
    await idle(env, second.task.id);
    env.llm.script.push("Queued done.", "New done.");
    const next = await post<{ task: Task; run: TaskRun }>(
      env,
      `/api/tasks/${second.task.id}/messages`,
      { text: "new" },
    );
    expect(next.body.task.queueHeld).toBe(false);
    await waitFor(
      async () => (await env.service.tasks.runs.get(next.body.run.id))?.status === "completed",
    );
    const texts = (await env.service.items(second.task.id, 0, 100))
      .filter((i): i is Extract<TaskItem, { kind: "user_message" }> => i.kind === "user_message")
      .map((i) => i.payload.text);
    expect(texts).toEqual(["Long thing", "queued", "new"]);
  });

  it("promotes a queued message to a steer", async () => {
    const env = await setup();
    const { task, open } = await busyTask(env);
    const queued = await post<{ run: TaskRun }>(env, `/api/tasks/${task.id}/messages`, {
      text: "actually this",
    });
    env.llm.script.push("Steered.");
    const promoted = await post<{ task: Task; run: TaskRun }>(
      env,
      `/api/tasks/${task.id}/queue/${queued.body.run.id}/promote-to-steer`,
    );
    expect(promoted.status).toBe(202);
    expect(promoted.body.run).toMatchObject({
      id: queued.body.run.id,
      trigger: { kind: "message", mode: "steer" },
    });
    expect(promoted.body.task.queue).toEqual([]);
    open();
    await idle(env, task.id);
    const runs = await env.service.tasks.runs.list(task.id);
    expect(runs.find((r) => r.id === queued.body.run.id)?.status).toBe("completed");
    expect(runs.find((r) => r.id !== queued.body.run.id)?.status).toBe("cancelled");
    expect(
      (await post(env, `/api/tasks/${task.id}/queue/${queued.body.run.id}/promote-to-steer`))
        .status,
    ).toBe(404);
  });

  it("settle holds the queue so stopped runs do not start the next message", async () => {
    const env = await setup();
    const { task, open } = await busyTask(env);
    await post(env, `/api/tasks/${task.id}/messages`, { text: "after" });
    const settled = await post<TaskWithPrevious>(env, `/api/tasks/${task.id}/settle`);
    expect(settled.body).toMatchObject({ status: "settled", queueHeld: true });
    open();
    await idle(env, task.id);
    expect(await env.service.task(task.id)).toMatchObject({
      status: "settled",
      queueHeld: true,
    });
  });
});
