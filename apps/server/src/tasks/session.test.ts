/**
 * W1A: task runs on a host agent are one native session with Passport's tool belt. The fake
 * CLIs replay Claude Code and Codex stream-json while making real MCP calls to the belt.
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
import type { HostAgentKind, TaskItem } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "../accounts.js";
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

async function sessionBackend(
  kind: HostAgentKind,
  invocations: FakeInvocation[],
  budget?: { maxToolCalls?: number },
) {
  const dir = await mkdtemp(join(tmpdir(), "passport-session-"));
  dirs.push(dir);
  const cli = await fakeHostCli(dir, kind, invocations);
  const mail = new MockMailProvider({ fixtures: false });
  const providers = createProviderRegistry();
  vi.spyOn(providers, "mail").mockReturnValue(mail);
  vi.spyOn(providers, "calendar").mockReturnValue(new MockCalendarProvider());
  const llm = new HostAgentLlmClient({
    kind,
    binaryPath: cli.path,
    cwd: join(dir, "work"),
    env: { HOME: dir, PATH: "/usr/bin:/bin" },
  });
  const config = { ...defaultConfig(dir), ...(budget ? { agentBudget: budget } : {}) };
  const backend = await createRealBackend(config, { storePath: ":memory:", providers, llm });
  backends.push(backend);
  const account = await addAccount(backend, {
    kind: "mock",
    emailAddress: "alex@example.com",
    displayName: "Alex",
    fields: {},
  });
  await backend.syncAccount(account.id);
  // After the first tick: on the provider only, never triaged, found by mail_search.
  mail.injectEmail({
    providerId: "invoice",
    mailboxIds: [`${account.id}:mailbox:Inbox`],
    from: [{ name: "Alice", email: "alice@example.com" }],
    to: [{ email: "alex@example.com" }],
    subject: "Invoice due Friday",
    textBody: "Please pay by Friday. Token tk_test_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    receivedAt: new Date().toISOString(),
  });
  const service = backend.tasks!.service;
  const items = async (taskId: string) => service.items(taskId, 0, 500);
  return { backend, cli, mail, service, items, account };
}

const search = { tool: "mail_search", args: { query: "from:alice@example.com", limit: 5 } };
const kinds: HostAgentKind[] = ["claude-code", "codex"];
const resumeArgs = (kind: HostAgentKind, id: string) =>
  kind === "claude-code" ? ["--resume", id] : ["exec", "resume", id];
const kinds_of = (items: TaskItem[]) => items.map((item) => item.kind);

describe.each(kinds)("%s task sessions", (kind) => {
  it("runs one session whose native tool calls reach the provider reader, then resumes it", async () => {
    const env = await sessionBackend(kind, [
      {
        sessionId: "11111111-aaaa-4bbb-8ccc-000000000001",
        steps: [
          { text: "Searching your mail." },
          search,
          { text: "Alice's invoice is due Friday." },
        ],
      },
      { steps: [{ text: "Nothing from Bob." }] },
    ]);
    const { task, done } = await env.service.create({ message: "Anything due this week?" });
    await done;
    const [first] = await env.cli.calls();
    // The MCP call was served by the provider reader (the v0.3.1 regression, through a session).
    expect(first?.results?.[0]).toContain("Invoice due Friday");
    expect(first?.results?.[0]).not.toContain("ON_DEMAND_UNSUPPORTED");
    expect(env.mail.reader().costLog.map((entry) => entry.method)).toContain("search");
    // Native tool use: no JSON tool protocol, and the session stays resumable.
    const args = first!.args;
    expect(first!.stdin).not.toContain("argumentsJson");
    if (kind === "claude-code") {
      expect(args).not.toContain("--no-session-persistence");
      expect(args).not.toContain("--json-schema");
      expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__passport");
      // The session's system prompt (with USER.md) is read from a private file, not argv.
      expect(args).toContain("--system-prompt-file");
      expect(args.join(" ")).not.toContain("How Passport runs you");
    } else {
      expect(args).not.toContain("--ephemeral");
      expect(args).not.toContain("--output-schema");
      expect(args.find((arg) => arg.startsWith("developer_instructions="))).toContain(
        "How Passport runs you",
      );
    }
    expect(first!.stdin).toContain("Anything due this week?");

    const timeline = await env.items(task.id);
    expect(kinds_of(timeline)).toEqual([
      "user_message",
      "assistant_message",
      "tool_call",
      "assistant_message",
    ]);
    // Mail-derived secrets never reach the timeline.
    expect(JSON.stringify(timeline)).not.toContain("tk_test_");
    const call = timeline[2] as Extract<TaskItem, { kind: "tool_call" }>;
    expect(call.payload).toMatchObject({ name: "mail_search", isError: false });
    expect(call.payload.inputSummary.length).toBeLessThanOrEqual(200);
    expect(call.payload.resultSummary.length).toBeLessThanOrEqual(200);
    expect(call.untrusted).toBe(true);
    const detail = await env.service.get(task.id);
    expect(detail.task).toMatchObject({
      providerSessionId: "11111111-aaaa-4bbb-8ccc-000000000001",
      providerSessionKind: kind,
      status: "inbox",
    });
    expect(detail.runs[0]).toMatchObject({
      status: "completed",
      usage: { llmCalls: 1, toolCalls: 1, inputTokens: 120, outputTokens: 30 },
    });

    // Follow-up: the provider session is resumed with a short turn, not the history prompt.
    const next = await env.service.sendMessage(task.id, { text: "And from Bob?" });
    await waitFor(async () => (await env.service.get(task.id)).runs[0]?.status === "completed");
    expect(next.run.trigger).toMatchObject({ kind: "message" });
    const second = (await env.cli.calls())[1]!;
    const pair = resumeArgs(kind, "11111111-aaaa-4bbb-8ccc-000000000001");
    expect(second.args.join(" ")).toContain(pair.join(" "));
    expect(second.stdin).toMatch(/^Follow-up on the task/);
    expect(second.stdin).toContain("The person's request:\nAnd from Bob?");
    expect(second.stdin).not.toContain("Earlier in this task");
    expect(kinds_of(await env.items(task.id)).slice(-2)).toEqual([
      "user_message",
      "assistant_message",
    ]);
  });

  it("streams sanitised renders through native tool calls and charges the run budget", async () => {
    const env = await sessionBackend(
      kind,
      [
        {
          steps: [
            {
              tool: "render",
              args: {
                title: "Day",
                html: '<p onclick="bad()">Today</p><script>bad()</script>',
                height: 240,
              },
            },
            { tool: "render", args: { title: "Blocked", html: "<p>Over budget</p>" } },
          ],
        },
      ],
      { maxToolCalls: 1 },
    );
    const { task, done } = await env.service.create({ message: "Show my day" });
    await done;
    const timeline = await env.items(task.id);
    expect(timeline.filter((item) => item.kind === "render")).toEqual([
      expect.objectContaining({
        untrusted: true,
        payload: { title: "Day", html: "<p>Today</p>", height: 240 },
      }),
    ]);
    expect(timeline.filter((item) => item.kind === "tool_call")).toHaveLength(1);
    expect(timeline.at(-1)).toMatchObject({
      kind: "system_notice",
      payload: { code: "BUDGET_EXHAUSTED" },
    });
    expect((await env.service.get(task.id)).runs[0]?.usage?.toolCalls).toBe(1);
  });

  it("falls back to the history prompt when the provider no longer has the session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = await sessionBackend(kind, [
      { sessionId: "first-session", steps: [{ text: "Hello." }] },
      { resumeMissing: true },
      { sessionId: "fresh-session", steps: [{ text: "Back again." }] },
    ]);
    const { task, done } = await env.service.create({ message: "Say hello" });
    await done;
    await env.service.sendMessage(task.id, { text: "Again please" });
    await waitFor(async () => (await env.service.get(task.id)).runs[0]?.status === "completed");
    const calls = await env.cli.calls();
    expect(calls).toHaveLength(3);
    expect(calls[1]!.args.join(" ")).toContain(resumeArgs(kind, "first-session").join(" "));
    expect(calls[2]!.args).not.toContain("resume");
    expect(calls[2]!.args).not.toContain("--resume");
    expect(calls[2]!.stdin).toContain("Earlier in this task");
    expect(calls[2]!.stdin).toContain("Again please");
    expect((await env.service.get(task.id)).task.providerSessionId).toBe("fresh-session");
  });

  it("starts fresh with the history prompt when the task's session belongs to another agent", async () => {
    const env = await sessionBackend(kind, [
      { sessionId: "one", steps: [{ text: "Hi." }] },
      { sessionId: "two", steps: [{ text: "Hi again." }] },
    ]);
    const { task, done } = await env.service.create({ message: "Say hi" });
    await done;
    await env.backend.tasks!.service.tasks.update(task.id, {
      providerSessionKind: kind === "codex" ? "claude-code" : "codex",
    });
    await env.service.sendMessage(task.id, { text: "Once more" });
    await waitFor(async () => (await env.service.get(task.id)).runs[0]?.status === "completed");
    const calls = await env.cli.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args.join(" ")).not.toContain("resume");
    expect(calls[1]!.stdin).toContain("Earlier in this task");
  });

  it("interrupt stops the session at the next tool boundary", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = await sessionBackend(kind, [
      {
        steps: [search, { sleepMs: 30_000 }, { tool: "archive_emails", args: { emailIds: [] } }],
      },
    ]);
    const started = Date.now();
    const { task, done } = await env.service.create({ message: "Search, then archive" });
    await waitFor(async () => (await env.items(task.id)).some((item) => item.kind === "tool_call"));
    await env.service.interrupt(task.id);
    await expect(done).rejects.toMatchObject({ code: "RUN_CANCELLED" });
    expect(Date.now() - started).toBeLessThan(15_000);
    const detail = await waitFor(async () => {
      const d = await env.service.get(task.id);
      return d.runs[0]?.status === "cancelled" && d;
    });
    expect(detail.runs[0]?.error).toBe("RUN_CANCELLED");
    const timeline = await env.items(task.id);
    expect(timeline.filter((item) => item.kind === "tool_call")).toHaveLength(1);
    expect(timeline.at(-1)).toMatchObject({
      kind: "system_notice",
      payload: { code: "RUN_CANCELLED" },
    });
  });

  it("steer cancels the running session and resumes it with both messages", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = await sessionBackend(kind, [
      { sessionId: "steered-session", steps: [search, { sleepMs: 30_000 }] },
      { steps: [{ text: "Only the PDFs, then." }] },
    ]);
    const { task, done } = await env.service.create({ message: "Find invoices" });
    await waitFor(async () => (await env.items(task.id)).some((item) => item.kind === "tool_call"));
    const steer = await env.service.sendMessage(task.id, { text: "Only PDFs", mode: "steer" });
    await expect(done).rejects.toMatchObject({ code: "RUN_CANCELLED" });
    await waitFor(async () => (await env.service.get(task.id)).runs[0]?.status === "completed");
    const runs = (await env.service.get(task.id)).runs;
    expect(runs.map((run) => run.status)).toEqual(["completed", "cancelled"]);
    expect(runs[0]?.id).toBe(steer.run.id);
    const second = (await env.cli.calls())[1]!;
    expect(second.args.join(" ")).toContain(resumeArgs(kind, "steered-session").join(" "));
    expect(second.stdin).toContain("they added to it while you worked");
    expect(second.stdin).toContain("Find invoices");
    expect(second.stdin).toContain("Only PDFs");
  });

  it("ends the session with BUDGET_EXHAUSTED when the tool-call budget is spent", async () => {
    const env = await sessionBackend(kind, [{ steps: [search, search, { text: "never shown" }] }], {
      maxToolCalls: 1,
    });
    const { task, done } = await env.service.create({ message: "Search twice" });
    await done;
    // The refused call stops the session; the CLI is cancelled before it reports the refusal.
    const [call] = await env.cli.calls();
    expect(call?.results?.[0]).toContain("Invoice due Friday");
    expect(call?.results?.slice(1).every((text) => text.includes("BUDGET_EXHAUSTED"))).toBe(true);
    const timeline = await env.items(task.id);
    expect(timeline.filter((item) => item.kind === "tool_call")).toHaveLength(1);
    expect(timeline.at(-1)).toMatchObject({
      kind: "system_notice",
      payload: { code: "BUDGET_EXHAUSTED" },
    });
    expect(timeline.some((item) => item.kind === "assistant_message")).toBe(false);
    const detail = await env.service.get(task.id);
    expect(detail.runs[0]).toMatchObject({ status: "completed" });
    expect(detail.runs[0]?.summary).toContain("Run budget reached");
  });
});
