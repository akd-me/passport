import type { Email, TaskItem } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealBackend } from "../compose.js";
import { deliver, taskBackend, toolCall, waitFor } from "./test-support.js";
import { classifyWake } from "./watches.js";

describe("conversation watches", () => {
  const backends: RealBackend[] = [];
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.close()));
    vi.restoreAllMocks();
  });

  /** A task that asked to watch the thread of a first message from Sam. */
  async function watching() {
    const env = await taskBackend(backends);
    const first = await deliver(env, {
      providerId: "q1",
      subject: "Quote",
      from: [{ email: "sam@example.com" }],
    });
    await env.backend.drainAgentQueue();
    env.llm.script.push(
      toolCall("watch_conversation", { threadHandle: first.threadId }),
      "Watching for Sam.",
    );
    const { task, done } = await env.service.create({ message: "Ask Sam for a quote" });
    await done;
    await waitFor(async () => (await env.service.get(task.id)).runs[0]?.status === "completed");
    const reply = (providerId: string, input: Partial<Email> = {}) =>
      deliver(env, {
        providerId,
        threadId: first.threadId,
        subject: "Re: Quote",
        from: [{ email: "sam@example.com" }],
        // Strictly after the watch's `since`, even when the test runs within one millisecond.
        receivedAt: new Date(Date.now() + 1000).toISOString(),
        ...input,
      });
    const wakes = async () =>
      (await env.service.tasks.runs.list(task.id)).filter((run) => run.trigger.kind === "watch");
    const settle = async () => {
      await env.tasks.watches.flush();
      await env.backend.drainAgentQueue();
      await waitFor(async () =>
        (await env.service.tasks.runs.list(task.id)).every(
          (r) => r.status !== "queued" && r.status !== "running",
        ),
      );
    };
    return { env, task, first, reply, wakes, settle };
  }

  it("keeps a watching task in Working and wakes it when someone else replies", async () => {
    const { env, task, first, reply, wakes, settle } = await watching();
    expect(await env.service.task(task.id)).toMatchObject({
      status: "working",
      watches: [{ threadHandle: first.threadId, account: env.account.id, consecutiveWakes: 0 }],
    });
    await reply("self-1", { from: [{ email: "alex@example.com" }] });
    await settle();
    expect(await wakes()).toHaveLength(0);
    const sam = await reply("r1");
    await settle();
    const [wake] = await wakes();
    expect(wake).toMatchObject({
      priority: "background",
      trigger: { kind: "watch", emailId: sam.id },
    });
    const notification = (await env.service.items(task.id, 0, 500)).find(
      (item): item is Extract<TaskItem, { kind: "notification" }> => item.kind === "notification",
    );
    expect(notification).toMatchObject({
      untrusted: true,
      runId: wake!.id,
      payload: { source: "watch" },
    });
    expect(notification!.payload.summary).toContain("New reply from sam@example.com");
    expect((await env.service.task(task.id)).status).toBe("working");
    expect(await env.service.unwatch(task.id)).toMatchObject({ status: "inbox", watches: [] });
  });

  it("dedupes on Message-ID and coalesces a burst on one thread into one wake with the latest", async () => {
    const { env, reply, wakes, settle } = await watching();
    const one = await reply("r1", {
      headers: { messageId: "<r1@x>", inReplyTo: null, references: [] },
    });
    await settle();
    await env.tasks.watches.observe(env.account.id, [one]);
    await settle();
    expect(await wakes()).toHaveLength(1);
    await reply("r2", { headers: { messageId: "<r2@x>", inReplyTo: null, references: [] } });
    const latest = await reply("r3", {
      headers: { messageId: "<r3@x>", inReplyTo: null, references: [] },
    });
    await settle();
    const all = await wakes();
    expect(all).toHaveLength(2);
    expect(all[0]!.trigger).toMatchObject({ emailId: latest.id });
  });

  it("stops after repeated automatic replies with a notice", async () => {
    const { env, task, reply, settle } = await watching();
    for (const id of ["a1", "a2", "a3"]) {
      await reply(id, {
        subject: "Automatic reply: Quote",
        headers: {
          messageId: `<${id}@x>`,
          inReplyTo: null,
          references: [],
          extra: { "auto-submitted": "auto-replied" },
        },
      });
      await settle();
    }
    const current = await env.service.task(task.id);
    expect(current.watches).toEqual([]);
    expect(current.status).toBe("inbox");
    const notice = (await env.service.items(task.id, 0, 500)).find(
      (item) => item.kind === "system_notice",
    );
    expect(notice?.payload).toMatchObject({ code: "WATCH_LOOP_GUARD" });
  });

  it("ends watches older than 14 days with one wake", async () => {
    const { env, task, settle } = await watching();
    const old = new Date(Date.now() - 15 * 86_400_000).toISOString();
    await env.service.tasks.update(task.id, (t) => ({
      watches: t.watches.map((w) => ({ ...w, since: old })),
    }));
    expect(await env.tasks.watches.expire()).toBe(1);
    await settle();
    await env.backend.drainAgentQueue();
    const runs = await waitFor(async () => {
      const list = await env.service.tasks.runs.list(task.id);
      return list.some((r) => r.trigger.kind === "wake" && r.status === "completed") && list;
    });
    expect(runs[0]!.trigger).toEqual({ kind: "wake", reason: "watch_expired" });
    expect((await env.service.task(task.id)).watches).toEqual([]);
  });

  it("classifies bounces and auto-replies from headers and conventions", () => {
    const base = {
      headers: { messageId: null, inReplyTo: null, references: [] },
      from: [{ email: "a@b.example" }],
      subject: "Re: x",
    } as unknown as Email;
    expect(classifyWake(base)).toBe("reply");
    expect(classifyWake({ ...base, from: [{ email: "MAILER-DAEMON@b.example" }] })).toBe("bounce");
    expect(classifyWake({ ...base, subject: "Out of office: back Monday" })).toBe("auto_reply");
    expect(
      classifyWake({
        ...base,
        headers: { ...base.headers, extra: { "Auto-Submitted": "auto-replied" } },
      }),
    ).toBe("auto_reply");
  });
});
