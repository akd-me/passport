import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRun, Page, Task, TaskDetail, TaskItem, TaskRun } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../auth.test-client.js";
import type { RealBackend } from "../compose.js";
import { defaultConfig } from "../config.js";
import { createDemoBackend } from "../demo/index.js";
import { startServer } from "../server.js";
import { taskBackend, waitFor } from "./test-support.js";

const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("task HTTP API", () => {
  const backends: RealBackend[] = [];
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.close()));
    vi.unstubAllEnvs();
  });

  it("creates, reads, pages, messages, patches and moves tasks through the lifecycle", async () => {
    const { app, llm } = await taskBackend(backends);
    llm.script.push("Hello from the agent.");
    const unauthenticated = await app.request("/api/tasks", {
      headers: { Authorization: "Bearer nope" },
    });
    expect(unauthenticated.status).toBe(401);
    const created = await app.request(
      "/api/tasks",
      json({ message: "  Say hello  ", permissionMode: "supervised" }),
    );
    expect(created.status).toBe(201);
    const { task, run } = (await created.json()) as { task: Task; run: TaskRun };
    expect(task).toMatchObject({ title: "Say hello", permissionMode: "supervised", kind: "task" });
    expect(run.taskId).toBe(task.id);
    await waitFor(async () => {
      const detail = (await (await app.request(`/api/tasks/${task.id}`)).json()) as TaskDetail;
      return detail.runs[0]?.status === "completed";
    });
    const page1 = (await (await app.request(`/api/tasks/${task.id}/items?limit=1`)).json()) as {
      items: TaskItem[];
      lastSeq: number;
    };
    expect(page1.items.map((i) => i.kind)).toEqual(["user_message"]);
    const page2 = (await (
      await app.request(`/api/tasks/${task.id}/items?afterSeq=${page1.lastSeq}`)
    ).json()) as {
      items: TaskItem[];
    };
    expect(page2.items[0]).toMatchObject({
      kind: "assistant_message",
      payload: { text: "Hello from the agent." },
    });
    const message = await app.request(
      `/api/tasks/${task.id}/messages`,
      json({ text: "And again", mode: "queue" }),
    );
    expect(message.status).toBe(202);
    expect((await app.request(`/api/tasks/${task.id}/messages`, json({ text: "" }))).status).toBe(
      400,
    );
    expect(
      (await app.request(`/api/tasks/${task.id}/messages`, json({ text: "x", mode: "now" })))
        .status,
    ).toBe(400);
    const patched = await app.request(
      `/api/tasks/${task.id}`,
      json({ title: "Renamed", interactionMode: "plan" }, "PATCH"),
    );
    expect(await patched.json()).toMatchObject({ title: "Renamed", interactionMode: "plan" });
    expect(
      (await app.request(`/api/tasks/${task.id}`, json({ status: "inbox" }, "PATCH"))).status,
    ).toBe(400);
    for (const [path, expected] of [
      ["pin", { pinned: true }],
      ["unpin", { pinned: false }],
      ["settle", { status: "settled" }],
      ["unwatch", { watches: [] }],
      ["archive", { status: "archived" }],
      ["interrupt", { id: task.id }],
    ] as const) {
      const response = await app.request(`/api/tasks/${task.id}/${path}`, { method: "POST" });
      expect(await response.json()).toMatchObject(expected);
    }
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect(
      await (await app.request(`/api/tasks/${task.id}/snooze`, json({ until }))).json(),
    ).toMatchObject({
      status: "snoozed",
    });
    const listed = (await (
      await app.request("/api/tasks?status=snoozed&limit=10")
    ).json()) as Page<Task>;
    expect(listed.items.map((t) => t.id)).toEqual([task.id]);
    expect((await app.request("/api/tasks?status=bogus")).status).toBe(400);
    expect((await app.request("/api/tasks/missing")).status).toBe(404);
  });

  it("keeps /api/agent/run working by creating a task per instruction", async () => {
    const { app, llm, service } = await taskBackend(backends);
    llm.script.push("Reviewed.");
    const response = await app.request(
      "/api/agent/run",
      json({ instruction: "Review my matters" }),
    );
    expect(response.status).toBe(200);
    const run = (await response.json()) as AgentRun & { taskId: string };
    expect(run.summary).toContain("Manual instruction completed");
    expect(await service.task(run.taskId)).toMatchObject({
      title: "Review my matters",
      kind: "task",
    });
  });

  it("answers 501 on the demo backend", async () => {
    const backend = await createDemoBackend({ ...defaultConfig(), port: 0 });
    try {
      const response = await createApp(backend).request("/api/tasks");
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ error: { code: "TASKS_UNAVAILABLE" } });
    } finally {
      await backend.close();
    }
  });

  it("streams task events over the WebSocket", async () => {
    const token = "a".repeat(64);
    vi.stubEnv("PASSPORT_API_TOKEN", token);
    const env = await taskBackend(backends);
    backends.pop();
    const dataDir = await mkdtemp(join(tmpdir(), "passport-tasks-ws-"));
    Object.assign(env.backend.config, { dataDir, port: 0, mcpPort: 0 });
    const handle = startServer(env.backend);
    await once(handle.server, "listening");
    const address = handle.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP listener");
    }
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    try {
      await once(socket, "open");
      const types = new Set<string>();
      socket.on("message", (data) =>
        types.add((JSON.parse(String(data)) as { type: string }).type),
      );
      env.llm.script.push("Hi.");
      const { done } = await env.service.create({ message: "Ping" });
      await done;
      await waitFor(
        async () =>
          types.has("task.item.appended") &&
          types.has("task.run.updated") &&
          types.has("task.updated"),
      );
    } finally {
      socket.terminate();
      await handle.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
