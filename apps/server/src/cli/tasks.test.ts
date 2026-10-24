import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionRecord, Page, Task, TaskDetail, TaskItem, TaskRun } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../auth.test-client.js";
import { main } from "../cli.js";
import type { RealBackend } from "../compose.js";
import { logger } from "../logger.js";
import { acquireOwner } from "../owner-lock.js";
import { gate, taskBackend, toolCall, waitFor } from "../tasks/test-support.js";

type Started = { task: Task; run: TaskRun };
const backends: RealBackend[] = [];
const directories: string[] = [];
const originalExitCode = process.exitCode;

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.exitCode = originalExitCode;
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "passport-task-cli-"));
  directories.push(dataDir);
  vi.stubEnv("PASSPORT_DATA_DIR", dataDir);
  vi.stubEnv("PASSPORT_API_TOKEN", "");
  const env = await taskBackend(backends);
  const app = createApp(env.backend, { staticDir: join(dataDir, "no-ui") });
  // Read the helper's injected random bearer so the CLI crosses real authentication too.
  app.get("/fixture/bearer", (c) => c.text(c.req.header("authorization") ?? ""));
  const bearer = await (await app.request("/fixture/bearer")).text();
  await writeFile(join(dataDir, "api-token"), `${bearer.slice(7)}\n`);
  const fetcher = vi.fn((url: string, init?: RequestInit) => app.request(url, init));
  vi.stubGlobal("fetch", fetcher);
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  // The running server's logs would be in its own process, outside the CLI's stderr.
  vi.spyOn(logger, "error").mockImplementation(() => {});
  async function invoke<T = Started>(args: string[], json = true) {
    output.mockClear();
    errors.mockClear();
    process.exitCode = 0;
    await main(["task", ...args, ...(json ? ["--json"] : [])]);
    const text = output.mock.calls.map(([value]) => String(value)).join("\n");
    return {
      data: (json && text ? JSON.parse(text) : undefined) as T,
      text,
      error: errors.mock.calls.map(([value]) => String(value)).join("\n"),
      code: process.exitCode,
    };
  }
  return { ...env, app, dataDir, fetcher, output, errors, invoke, bearer };
}

describe("task CLI against the authenticated app (offline)", () => {
  it("start forwards account, permission and plan options and authenticates with the existing token", async () => {
    const env = await fixture();
    const result = await env.invoke([
      "start",
      "Review my day",
      "--account",
      env.account.id,
      "--mode",
      "full_access",
      "--plan",
    ]);
    expect(result.code, result.error).toBe(0);
    expect(result.data.task).toMatchObject({
      title: "Review my day",
      accountIds: [env.account.id],
      interactionMode: "plan",
    });
    const [, init] = env.fetcher.mock.calls.find(
      ([url, init]) => url.endsWith("/api/tasks") && init?.method === "POST",
    )!;
    expect(JSON.parse(String(init?.body))).toEqual({
      message: "Review my day",
      accountIds: [env.account.id],
      permissionMode: "full_access",
      interactionMode: "plan",
    });
    for (const [, init] of env.fetcher.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe(env.bearer);
    }
    expect((await readdir(env.dataDir)).some((name) => name.endsWith(".sqlite"))).toBe(false);
  });

  it("start --wait prints the finished run summary and exits 0", async () => {
    const env = await fixture();
    env.llm.script.push("Reviewed your day.");
    const result = await env.invoke(["start", "Review my day", "--wait"], false);
    expect(result.code, result.error).toBe(0);
    expect(result.text).toContain("Review my day");
    expect(result.text).toContain(": completed");
    expect(result.text).toContain("Manual instruction completed");
    expect(result.error).toBe("");
  });

  it("send queues a message by default and --wait returns that run as JSON", async () => {
    const env = await fixture();
    const initial = await env.service.create({ message: "First" });
    await initial.done;
    const result = await env.invoke(["send", initial.task.id, "Again", "--wait"]);
    expect(result.code, result.error).toBe(0);
    expect(result.data.run).toMatchObject({
      taskId: initial.task.id,
      status: "completed",
      trigger: { mode: "queue" },
    });
    expect(result.data.run.id).not.toBe(initial.run.id);
    expect(result.data.run.summary).toBeTruthy();
  });

  it("send --steer cancels the active run and waits for its replacement", async () => {
    const env = await fixture();
    const blocked = gate();
    const entered = gate();
    env.llm.script.push(async () => {
      entered.open();
      await blocked.opened;
      return "Discard this";
    }, "Replacement");
    const first = await env.service.create({ message: "First" });
    const result = await (async () => {
      try {
        await entered.opened;
        const sending = env.invoke(["send", first.task.id, "Only today", "--steer", "--wait"]);
        await waitFor(async () =>
          env.fetcher.mock.calls.some(([url]) => url.endsWith("/messages")),
        );
        blocked.open();
        return await sending;
      } finally {
        blocked.open();
      }
    })();
    expect(result.data.run).toMatchObject({ status: "completed", trigger: { mode: "steer" } });
    expect(
      (await env.service.get(first.task.id)).runs.find((run) => run.id === first.run.id)?.status,
    ).toBe("cancelled");
    expect(result.code, result.error).toBe(0);
  });

  it("wait tracks the submitted run while a newer follow-up is still active", async () => {
    const env = await fixture();
    const firstGate = gate();
    const secondGate = gate();
    env.llm.script.push(
      async () => {
        await firstGate.opened;
        return "First done";
      },
      async () => {
        await secondGate.opened;
        return "Second done";
      },
    );
    let submitted: Started | undefined;
    const requestApp = env.app.request.bind(env.app);
    env.fetcher.mockImplementation(async (url, init) => {
      const response = await requestApp(url, init);
      if (url.endsWith("/api/tasks") && init?.method === "POST") {
        submitted = (await response.clone().json()) as Started;
        await env.service.sendMessage(submitted.task.id, { text: "Second" });
        firstGate.open();
      }
      return response;
    });
    try {
      const result = await env.invoke(["start", "First", "--wait"]);
      expect(result.data.run).toMatchObject({ id: submitted?.run.id, status: "completed" });
      expect(result.code, result.error).toBe(0);
      expect((await env.service.get(result.data.task.id)).runs[0]?.id).not.toBe(result.data.run.id);
    } finally {
      firstGate.open();
      secondGate.open();
    }
  });

  it("wait does not finish early on an approval and exits 2 after the run ends", async () => {
    const env = await fixture();
    const blocked = gate();
    env.llm.script.push(
      toolCall("add_standing_rule", { rule: "Prefer short replies", reason: "Preference" }),
      async () => {
        await blocked.opened;
        return "Proposed";
      },
    );
    let finished = false;
    const waiting = env.invoke(["start", "Save a preference", "--wait"]).then((value) => {
      finished = true;
      return value;
    });
    try {
      await waitFor(async () =>
        (await env.service.list({})).items.find((task) => task.needsUser === "approval"),
      );
      expect(finished).toBe(false);
    } finally {
      blocked.open();
    }
    const result = await waiting;
    expect(result.code).toBe(2);
    expect(result.data.task.needsUser).toBe("approval");
    expect(result.data.task.pendingActionIds).toHaveLength(1);
    expect(result.data.run.status).toBe("completed");
  });

  it("wait exits 2 for a question, including future question producers", async () => {
    const env = await fixture();
    const original = env.app.request.bind(env.app);
    env.fetcher.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (url.endsWith("/api/tasks") && init?.method === "POST") {
        const { task, run } = (await response.clone().json()) as Started;
        await waitFor(
          async () =>
            (await env.service.get(task.id)).runs.find((r) => r.id === run.id)?.status ===
            "completed",
        );
        await env.service.tasks.update(task.id, { needsUser: "question" });
        await env.service.tasks.items.append({
          taskId: task.id,
          runId: run.id,
          kind: "question",
          at: new Date().toISOString(),
          payload: { text: "Which account?" },
        });
      }
      return response;
    });
    const result = await env.invoke(["start", "Review", "--wait"]);
    expect(result.code).toBe(2);
    expect(result.data.task.needsUser).toBe("question");
  });

  it("wait exits 2 for run failure with a readable error and summary", async () => {
    const env = await fixture();
    env.llm.script.push(async () => {
      throw new Error("offline model failure");
    });
    const result = await env.invoke(["start", "Fail", "--wait"], false);
    expect(result.code).toBe(2);
    expect(result.text).toContain(": failed");
    expect(result.text).toContain("Error:");
  });

  it("wait ends for a cancelled run with exit 2", async () => {
    const env = await fixture();
    const blocked = gate();
    env.llm.script.push(async () => {
      await blocked.opened;
      return "Stopped";
    });
    const waiting = env.invoke(["start", "Stop me", "--wait"]);
    const task = await waitFor(async () => (await env.service.list({})).items[0]);
    await env.service.interrupt(task.id);
    blocked.open();
    const result = await waiting;
    expect(result.code).toBe(2);
    expect(result.data.run.status).toBe("cancelled");
  });

  it("wait finishes even when the task remains working to watch a conversation", async () => {
    const env = await fixture();
    const original = env.app.request.bind(env.app);
    env.fetcher.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (url.endsWith("/api/tasks") && init?.method === "POST") {
        const { task } = (await response.clone().json()) as Started;
        await waitFor(async () => (await env.service.get(task.id)).runs[0]?.status === "completed");
        await env.service.tasks.update(task.id, {
          status: "working",
          watches: [
            {
              threadHandle: "fixture:thread:1",
              account: env.account.id,
              since: new Date().toISOString(),
              consecutiveWakes: 0,
            },
          ],
        });
      }
      return response;
    });
    const result = await env.invoke(["start", "Watch", "--wait"]);
    expect(result.code, result.error).toBe(0);
    expect(result.data.task.status).toBe("working");
  });

  it("show reads the latest N items across pages, with a default of 20 and zero to omit them", async () => {
    const env = await fixture();
    const created = await env.service.create({ message: "Long timeline" });
    await created.done;
    for (let i = 0; i < 503; i++) {
      await env.service.tasks.items.append({
        taskId: created.task.id,
        runId: null,
        kind: "system_notice",
        at: new Date().toISOString(),
        payload: { text: `Notice ${i}` },
      });
    }
    const result = await env.invoke<TaskDetail & { items: TaskItem[]; lastSeq: number }>([
      "show",
      created.task.id,
      "--items",
      "3",
    ]);
    expect(result.data.items.map((item) => item.payload)).toEqual(
      [500, 501, 502].map((i) => ({ text: `Notice ${i}` })),
    );
    expect(result.data.lastSeq).toBeGreaterThan(500);
    expect(
      (await env.invoke<{ items: TaskItem[] }>(["show", created.task.id])).data.items,
    ).toHaveLength(20);
    env.fetcher.mockClear();
    expect(
      (await env.invoke<{ items: TaskItem[] }>(["show", created.task.id, "--items", "0"])).data
        .items,
    ).toEqual([]);
    expect(env.fetcher.mock.calls.some(([url]) => url.includes("/items?"))).toBe(false);
    const human = await env.invoke(["show", created.task.id, "--items", "2"], false);
    expect(human.text).toContain(`Mode: ${created.task.permissionMode} · default`);
    expect(human.text).toContain("system_notice: Notice 502");
    expect(human.text).not.toContain("system_notice: Notice 500");
  });

  it("list filters comma-separated statuses and retrieves every page", async () => {
    const env = await fixture();
    const created = await env.service.create({ message: "Template" });
    await created.done;
    for (let i = 0; i < 503; i++) {
      await env.service.tasks.insert({
        ...created.task,
        id: `fixture-${String(i).padStart(4, "0")}`,
        status: "settled",
        title: `Archived work ${i}`,
      });
    }
    const listed = await env.invoke<Page<Task>>(["list", "--status", "settled,archived"]);
    expect(listed.code).toBe(0);
    expect(listed.data.items).toHaveLength(503);
    expect(listed.data.nextCursor).toBeNull();
    const human = await env.invoke(["list", "--status", "inbox"], false);
    expect(human.text).toContain("Template");
    expect(human.text).not.toContain("Archived work");
    expect((await env.invoke(["list", "--status", "snoozed"], false)).text).toBe("No tasks.");
  });

  it.each(["approve", "reject"])(
    "%s sends the existing action route and reports its actual result",
    async (command) => {
      const env = await fixture();
      const proposed = await env.backend.executor.submit({
        type: "profile_update",
        accountId: env.account.id,
        actor: { kind: "agent", id: "fixture" },
        category: "matters",
        params: { markdown: "Prefer concise replies" },
        reason: "Preference",
      });
      expect(proposed.status).toBe("proposed");
      const result = await env.invoke<ActionRecord>([command, proposed.id]);
      expect(result.code, result.error).toBe(0);
      expect(result.data.status).toBe(command === "approve" ? "executed" : "rejected");
      expect((await env.backend.store.actions.get(proposed.id))?.status).toBe(result.data.status);
      const humanAction = await env.backend.executor.submit({
        ...proposed.request,
        params: { markdown: "Prefer short paragraphs" },
      });
      const human = await env.invoke([command, humanAction.id], false);
      expect(human.text).toContain(
        `Action ${humanAction.id}: ${command === "approve" ? "executed" : "rejected"}`,
      );
    },
  );

  it.each([
    ["show", "missing"],
    ["send", "missing", "Hello"],
    ["approve", "missing"],
    ["reject", "missing"],
    ["start", "Hello", "--account", "missing"],
  ])("reports server errors for %j with exit 1 and JSON stderr", async (...args) => {
    const env = await fixture();
    const result = await env.invoke(args);
    expect(result.code).toBe(1);
    expect(result.text).toBe("");
    expect(JSON.parse(result.error)).toMatchObject({
      error: { code: expect.any(String), message: expect.any(String) },
    });
  });

  it.each([
    ["start"],
    ["start", ""],
    ["send", "id"],
    ["start", "hello", "--mode", "unsafe"],
    ["start", "hello", "--account"],
    ["show", "id", "--items", "-1"],
    ["show", "id", "--items", "1.5"],
    ["show", "id", "--items", "Infinity"],
    ["list", "--status", "bogus"],
    ["list", "--status", ""],
    ["list", "extra"],
    ["send", "id", "hello", "--plan"],
    ["approve"],
    ["reject", "id", "extra"],
    ["bogus"],
  ])("validates arguments before touching a server: %j", async (...args) => {
    const env = await fixture();
    const result = await env.invoke(args);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.error).error.code).toBe("INVALID_COMMAND");
    expect(env.fetcher).not.toHaveBeenCalled();
  });

  it("offers help without a server or store", async () => {
    const env = await fixture();
    const result = await env.invoke(["--help"], false);
    expect(result.text).toContain("passport task reject <actionId>");
    expect(result.text).toContain("--json");
    expect(env.fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])("never falls back when unreachable (live owner=%s)", async (liveOwner) => {
    const env = await fixture();
    env.fetcher.mockRejectedValue(new TypeError("Connection refused"));
    const owner = liveOwner ? acquireOwner(env.dataDir) : undefined;
    try {
      const result = await env.invoke(["list"], false);
      expect(result.code).toBe(1);
      expect(result.error).toMatch(liveOwner ? /live owner.*unreachable/ : /Start passport serve/);
      expect(result.error).not.toContain("using the local store");
      expect(await readdir(env.dataDir)).not.toContain("passport.sqlite");
    } finally {
      owner?.release();
    }
  });

  it("reports stale API tokens with existing recovery guidance", async () => {
    const env = await fixture();
    vi.stubEnv("PASSPORT_API_TOKEN", "wrong-token");
    const result = await env.invoke(["list"], false);
    expect(result.code).toBe(1);
    expect(result.error).toContain("run passport token");
    expect(result.error).toContain("stale environment override");
  });

  it("reports a disconnected server during --wait as error 1", async () => {
    const env = await fixture();
    const original = env.app.request.bind(env.app);
    env.fetcher.mockImplementation((url, init) => {
      if (/\/api\/tasks\/[^/]+$/.test(url)) throw new TypeError("Connection lost");
      return original(url, init);
    });
    const result = await env.invoke(["start", "Hello", "--wait"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.error).error.code).toBe("SERVER_UNAVAILABLE");
  });
});
