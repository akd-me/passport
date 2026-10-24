/**
 * W2A on the session path: the fake Claude Code and Codex CLIs call ask_user, task_delegate and
 * task_status through the real MCP tool belt, as in `session.test.ts`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostAgentLlmClient } from "@passport/agent";
import {
  createProviderRegistry,
  MockCalendarProvider,
  MockMailProvider,
} from "@passport/providers";
import type { HostAgentKind, Task } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "../accounts.js";
import { createApp } from "../auth.test-client.js";
import { createRealBackend, type RealBackend } from "../compose.js";
import { defaultConfig } from "../config.js";
import { type FakeInvocation, fakeHostCli } from "./fake-host-cli.js";
import { waitFor } from "./test-support.js";

const backends: RealBackend[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function sessionBackend(kind: HostAgentKind, invocations: FakeInvocation[]) {
  const dir = await mkdtemp(join(tmpdir(), "passport-w2a-session-"));
  dirs.push(dir);
  const cli = await fakeHostCli(dir, kind, invocations);
  const providers = createProviderRegistry();
  vi.spyOn(providers, "mail").mockReturnValue(new MockMailProvider({ fixtures: false }));
  vi.spyOn(providers, "calendar").mockReturnValue(new MockCalendarProvider());
  const llm = new HostAgentLlmClient({
    kind,
    binaryPath: cli.path,
    cwd: join(dir, "work"),
    env: { HOME: dir, PATH: "/usr/bin:/bin" },
  });
  const backend = await createRealBackend(defaultConfig(dir), {
    storePath: ":memory:",
    providers,
    llm,
  });
  backends.push(backend);
  const account = await addAccount(backend, {
    kind: "mock",
    emailAddress: "alex@example.com",
    displayName: "Alex",
    fields: {},
  });
  await backend.syncAccount(account.id);
  return { backend, cli, service: backend.tasks!.service, app: createApp(backend) };
}

describe.each(["claude-code", "codex"] as const)(
  "%s sessions with questions and subtasks",
  (kind) => {
    it("delegates, asks, hears back from the subtask and takes the answer", async () => {
      const env = await sessionBackend(kind, [
        {
          sessionId: "parent",
          steps: [
            {
              tool: "task_delegate",
              args: { message: "Check the invoice", title: "Invoice check" },
            },
            { tool: "ask_user", args: { text: "Pay it today?", options: ["Yes", "No"] } },
            { text: "Started a check and asked you." },
          ],
        },
        { sessionId: "child", steps: [{ text: "The invoice is due Friday." }] },
        { steps: [{ tool: "task_status", args: {} }, { text: "The check is done." }] },
        { steps: [{ text: "Paying it today." }] },
      ]);
      const { task } = await env.service.create({ message: "Deal with the Hetzner invoice" });
      const child = await waitFor(async () => {
        const [found] = (await env.service.tasks.list({ parentTaskId: task.id })).items;
        return found;
      });
      await waitFor(async () => (await env.cli.calls()).length >= 3, 10_000);
      await waitFor(async () => {
        const runs = [
          ...(await env.service.get(task.id)).runs,
          ...(await env.service.get(child.id)).runs,
        ];
        return runs.length === 3 && runs.every((run) => run.endedAt);
      }, 10_000);
      const calls = await env.cli.calls();
      const [delegated, asked] = calls[0]!.results!;
      expect(delegated).toContain(`"taskId":"${child.id}"`);
      expect(asked).toContain('"status":"pending"');
      expect(calls[1]!.stdin).toContain("The request from your parent task");
      expect(calls[2]!.results![0]).toContain('"workState":"result_available"');
      expect(calls[2]!.results![0]).toContain("due Friday");

      const parent: Task = await env.service.task(task.id);
      expect(parent).toMatchObject({ status: "inbox", needsUser: "question" });
      const items = await env.service.items(task.id, 0, 500);
      expect(items.map((item) => item.kind)).toEqual(
        expect.arrayContaining(["question", "notification"]),
      );
      expect((await env.service.task(child.id)).delegation).toMatchObject({ depth: 1 });

      const answered = await env.app.request(
        `/api/tasks/${task.id}/questions/${parent.pendingQuestions![0]!.itemId}/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "Yes" }),
        },
      );
      expect(answered.status).toBe(202);
      await waitFor(async () => (await env.cli.calls()).length === 4, 10_000);
      await waitFor(async () => (await env.service.get(task.id)).runs.every((run) => run.endedAt));
      const last = (await env.cli.calls())[3]!;
      expect(last.args.join(" ")).toContain("parent");
      expect(last.stdin).toContain('You asked:\n- "Pay it today?"');
      expect(last.stdin).toContain("The person's answer:\nYes");
      expect(await env.service.task(task.id)).toMatchObject({
        needsUser: null,
        pendingQuestions: [],
      });
    });
  },
);
