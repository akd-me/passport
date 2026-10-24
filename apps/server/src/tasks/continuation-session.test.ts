/**
 * R1-4: restart continuations and limit resumes stay in the session runtime on host agents (the
 * tool belt and the provider-session resume), like every other task run.
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
import type { AgentRunOptions, HostAgentKind, TaskRun } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "../accounts.js";
import { createRealBackend, type RealBackend } from "../compose.js";
import { defaultConfig } from "../config.js";
import { fakeHostCli } from "./fake-host-cli.js";
import { recoverRuns } from "./restart.js";
import { waitFor } from "./test-support.js";

const backends: RealBackend[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function sessionBackend(kind: HostAgentKind) {
  const dir = await mkdtemp(join(tmpdir(), "passport-continuation-"));
  dirs.push(dir);
  const cli = await fakeHostCli(dir, kind, [
    { sessionId: "first-session", steps: [{ text: "Started." }] },
    { steps: [{ text: "Carried on." }] },
  ]);
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
  const tasks = backend.tasks!;
  const seen: Array<AgentRunOptions | undefined> = [];
  const agent = tasks.service.options.agent;
  const run = agent.run.bind(agent);
  agent.run = (trigger, options) => {
    seen.push(options);
    return run(trigger, options);
  };
  // A first run records the provider session the continuation resumes.
  const { task, done } = await tasks.service.create({ message: "Find the Hetzner invoices" });
  await done;
  const [message] = (await tasks.service.items(task.id, 0, 10)).filter(
    (item) => item.kind === "user_message",
  );
  return { cli, tasks, task, seen, itemId: message!.id };
}

const kinds: HostAgentKind[] = ["claude-code", "codex"];
const resumeArgs = (kind: HostAgentKind) =>
  kind === "claude-code" ? ["--resume", "first-session"] : ["exec", "resume", "first-session"];

async function openRun(
  env: Awaited<ReturnType<typeof sessionBackend>>,
  trigger: TaskRun["trigger"],
  status: TaskRun["status"] = "running",
) {
  return env.tasks.service.tasks.runs.insert({
    id: `cut-${trigger.kind}`,
    taskId: env.task.id,
    status,
    trigger,
    priority: trigger.kind === "message" ? "interactive" : "background",
    agentRunId: `cut-${trigger.kind}`,
    createdAt: new Date().toISOString(),
    actionIds: [],
    ...(status === "failed" ? { endedAt: new Date().toISOString(), error: "USAGE_LIMITED" } : {}),
    ...(trigger.kind === "message" ? { request: ["Find the Hetzner invoices", "only PDFs"] } : {}),
  });
}

async function continued(env: Awaited<ReturnType<typeof sessionBackend>>) {
  await waitFor(async () => {
    const runs = (await env.tasks.service.get(env.task.id)).runs;
    return runs.length >= 3 && runs.every((run) => run.endedAt) && runs;
  }, 10_000);
  const calls = await env.cli.calls();
  expect(calls).toHaveLength(2);
  return calls[1]!;
}

describe.each(kinds)("%s continuations", (kind) => {
  it("continue a restarted message run as a resumed session with its whole request", async () => {
    const env = await sessionBackend(kind);
    await openRun(env, { kind: "message", itemId: env.itemId, mode: "queue" });
    await recoverRuns(env.tasks.service, env.tasks.queue);
    const call = await continued(env);
    expect(call.args.join(" ")).toContain(resumeArgs(kind).join(" "));
    expect(call.stdin).toMatch(/^Follow-up on the task/);
    expect(call.stdin).toContain("Passport restarted");
    expect(call.stdin).toContain("Find the Hetzner invoices\n\nonly PDFs");
    expect(env.seen).toHaveLength(2);
    expect(env.seen.every((options) => options?.session)).toBe(true);
    const runs = (await env.tasks.service.get(env.task.id)).runs;
    expect(runs.find((run) => run.restartOf)).toMatchObject({
      restartOf: "cut-message",
      status: "completed",
    });
  });

  it("continue a restarted wake run as a session", async () => {
    const env = await sessionBackend(kind);
    await openRun(env, { kind: "wake", reason: "subtasks" });
    await recoverRuns(env.tasks.service, env.tasks.queue);
    const call = await continued(env);
    expect(call.args.join(" ")).toContain(resumeArgs(kind).join(" "));
    expect(env.seen.every((options) => options?.session)).toBe(true);
  });

  it("resume a limited run as a session", async () => {
    const env = await sessionBackend(kind);
    const stopped = await openRun(
      env,
      { kind: "message", itemId: env.itemId, mode: "queue" },
      "failed",
    );
    await env.tasks.service.runner.updateTask(env.task.id, {
      needsUser: "limited",
      limited: {
        runId: stopped.id,
        resetAt: null,
        autoResume: false,
        source: "host_agent",
        at: new Date().toISOString(),
      },
    });
    await env.tasks.limits.resume(env.task.id);
    const call = await continued(env);
    expect(call.args.join(" ")).toContain(resumeArgs(kind).join(" "));
    expect(call.stdin).toContain("usage limit was reached");
    expect(env.seen.every((options) => options?.session)).toBe(true);
  });
});
