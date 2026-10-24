import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostAgentLlmClient } from "@passport/agent";
import { createProviderRegistry, MockMailProvider, mockCapabilities } from "@passport/providers";
import { type Account, type HostAgentKind, mailHandle } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistArrival } from "../arrivals.js";
import { createRealBackend, type RealBackend } from "../compose.js";
import { defaultConfig } from "../config.js";
import { getSchedulerService } from "../schedulers/service.js";
import { type FakeInvocation, fakeHostCli } from "./fake-host-cli.js";

const dirs: string[] = [];
const backends: RealBackend[] = [];
afterEach(async () => {
  for (const backend of backends.splice(0)) {
    await getSchedulerService(backend).stop();
    await backend.close();
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function fixture(kind: HostAgentKind, invocations: FakeInvocation[]) {
  const dir = await mkdtemp(join(tmpdir(), "passport-background-session-"));
  dirs.push(dir);
  const cli = await fakeHostCli(dir, kind, invocations);
  const mail = new MockMailProvider({ fixtures: false });
  const providers = createProviderRegistry();
  vi.spyOn(providers, "mail").mockReturnValue(mail);
  const at = new Date().toISOString();
  const account: Account = {
    id: "background",
    kind: "mock",
    displayName: "Alex",
    emailAddress: "alex@example.com",
    settings: {},
    capabilities: { ...mockCapabilities, calendar: false },
    createdAt: at,
    updatedAt: at,
  };
  const llm = new HostAgentLlmClient({
    kind,
    binaryPath: cli.path,
    cwd: join(dir, "work"),
    env: { HOME: dir, PATH: "/usr/bin:/bin" },
  });
  const backend = await createRealBackend(
    { ...defaultConfig(dir), accounts: [account] },
    { storePath: ":memory:", providers, llm },
  );
  backends.push(backend);
  await backend.syncAccount(account.id);
  return { backend, account, mail, cli, service: backend.tasks!.service };
}

describe.each(["codex", "claude-code"] as const)("%s background sessions", (kind) => {
  it("keeps Inbox and routine wakes ephemeral while user messages keep their transcript", async () => {
    const env = await fixture(kind, [{ steps: [{ text: "Reviewed." }] }]);
    const inbox = await env.backend.tasks!.triggers.ensureInbox(env.account.id);
    const routine = await env.backend.tasks!.triggers.ensureRoutine("review", "Review");
    for (const task of [inbox, routine]) {
      // Even a session left by an older build must not be resumed by these tasks.
      await env.service.runner.updateTask(task.id, {
        providerSessionId: "old-session",
        providerSessionKind: kind,
        watches: [
          {
            threadHandle: mailHandle(env.account.id, "thread", task.id),
            account: env.account.id,
            since: "2020-01-01T00:00:00.000Z",
            consecutiveWakes: 0,
          },
        ],
      });
    }
    expect(await env.backend.tasks!.watches.expire()).toBe(2);
    await env.backend.tasks!.watches.idle();
    const { task, done } = await env.service.create({ message: "Review my mail" });
    await done;
    const calls = await env.cli.calls();
    const flag = kind === "claude-code" ? "--no-session-persistence" : "--ephemeral";
    expect(calls).toHaveLength(3);
    for (const call of calls.slice(0, 2)) {
      expect(call.args).toContain(flag);
      expect(call.args).not.toContain("--resume");
      expect(call.args).not.toContain("resume");
    }
    expect(calls[2]!.args).not.toContain(flag);
    expect((await env.service.task(task.id)).providerSessionId).toBe("session-2");
    for (const system of [inbox, routine]) {
      expect((await env.service.task(system.id)).providerSessionId).toBe("old-session");
      expect((await env.service.get(system.id)).runs[0]).toMatchObject({
        trigger: { kind: "wake" },
        status: "completed",
      });
    }
  });

  it("triages on the Inbox tool belt, records notes and proposals, and acknowledges retry without inference", async () => {
    const id = mailHandle("background", "email", "arrival");
    const env = await fixture(kind, [
      {
        steps: [
          { tool: "mail_read", args: { id, view: "message", quoted: "collapse" } },
          { tool: "notes_search", args: { kind: "matter", pattern: "Launch" } },
          {
            tool: "create_matter",
            args: {
              accountId: "background",
              category: "replies_known",
              matter: {
                title: "Launch",
                kind: "project",
                summary: "Alice requests a review",
                nextStep: "Review",
                emailIds: [id],
                notes: "- Arrival: Alice requested a review.",
              },
              reason: "Organize launch request",
            },
          },
          {
            tool: "notes_write",
            args: {
              kind: "person",
              id: "alice",
              accountId: "background",
              notes: "Asked for a launch review",
              reason: "Record arrival",
            },
          },
          {
            tool: "reply_draft",
            args: {
              emailId: id,
              textBody: "I can help prepare the review.",
              reason: "Draft warranted reply for review",
            },
          },
          { text: "Organized the request and proposed a reply for your review." },
        ],
      },
    ]);
    const at = new Date().toISOString();
    await env.backend.store.people.upsert({
      id: "alice",
      displayName: "Alice",
      primaryEmail: "alice@example.com",
      emails: ["alice@example.com"],
      relationship: "known",
      verification: "green",
      stats: { sent: 1, received: 1, lastContactAt: at },
      createdAt: at,
      updatedAt: at,
    });
    const email = env.mail.injectEmail({
      providerId: "arrival",
      subject: "Launch review",
      from: [{ email: "alice@example.com" }],
      to: [{ email: "alex@example.com" }],
      mailboxIds: ["background:mailbox:Inbox"],
      textBody: "Could you look at the launch?\n\n> Old quote",
      receivedAt: at,
    });
    await env.backend.store.emails.upsertMany([email]);
    await persistArrival(env.backend.store, email);
    env.backend.bus.emit({ type: "email.received", email });
    await env.backend.drainAgentQueue();
    const inbox = await env.service.tasks.inboxFor(env.account.id);
    const detail = await env.service.get(inbox!.id);
    expect(detail.runs[0]).toMatchObject({
      trigger: { kind: "arrival" },
      priority: "background",
      agentRunId: `arrival:${id}`,
      status: "completed",
      usage: { llmCalls: 1 },
    });
    expect((await env.backend.store.emails.get(id))?.category).toBe("replies_known");
    expect((await env.backend.store.people.get("alice"))?.notes).toContain("launch review");
    expect((await env.backend.store.matters.list())[0]?.notes).toContain("Arrival");
    const actions = (await env.backend.store.actions.query({ runId: `arrival:${id}` })).items;
    expect(actions.find((action) => action.request.type === "draft_create")?.status).toBe(
      "proposed",
    );
    expect(detail.task.needsUser).toBe("approval");
    expect(await env.backend.store.kv.get(`arrival:${id}`)).toBeNull();
    expect(await env.cli.calls()).toHaveLength(1);
    expect(
      env.mail
        .reader()
        .costLog.every(
          (entry) =>
            entry.lane === "arrivals" || entry.method === "changes" || entry.method === "labels",
        ),
    ).toBe(true);
    expect((await env.cli.calls())[0]?.stdin).toContain('source="arrival"');
    // A lost queue acknowledgement and a lost run checkpoint are both safe.
    await env.backend.store.kv.set(`run:arrival:${id}`, JSON.stringify({ error: "interrupted" }));
    await persistArrival(env.backend.store, email);
    await env.backend.processArrivals!();
    expect(await env.cli.calls()).toHaveLength(1);
    expect((await env.backend.store.actions.query({ runId: `arrival:${id}` })).items).toHaveLength(
      actions.length,
    );
  });

  it("runs newsletter, receipt and service playbooks without starting a CLI", async () => {
    const env = await fixture(kind, [{ steps: [{ text: "Must not run" }] }]);
    for (const [providerId, subject, from, headers] of [
      [
        "list",
        "Weekly news",
        "news@example.com",
        {
          messageId: null,
          inReplyTo: null,
          references: [],
          listUnsubscribe: "<https://news.test/u>",
        },
      ],
      ["receipt", "Your receipt", "orders@example.com", undefined],
      ["notice", "Your report is ready", "no-reply@example.com", undefined],
    ] as const) {
      const email = env.mail.injectEmail({
        providerId,
        subject,
        from: [{ email: from }],
        to: [{ email: "alex@example.com" }],
        mailboxIds: ["background:mailbox:Inbox"],
        textBody: "For your records.",
        ...(headers ? { headers: { ...headers, references: [] } } : {}),
      });
      await env.backend.store.emails.upsertMany([email]);
      await persistArrival(env.backend.store, email);
      env.backend.bus.emit({ type: "email.received", email });
      await env.backend.drainAgentQueue();
      expect((await env.backend.store.emails.get(email.id))?.category).toBe(
        providerId === "list"
          ? "newsletters"
          : providerId === "receipt"
            ? "receipts"
            : "notifications",
      );
    }
    expect(await env.cli.calls()).toHaveLength(0);
    const inbox = await env.service.tasks.inboxFor(env.account.id);
    expect((await env.service.get(inbox!.id)).runs.every((run) => run.status === "completed")).toBe(
      true,
    );
  });

  it("allows routine reads and writes but refuses interactive tools on built-in and user schedules", async () => {
    const env = await fixture(kind, [
      {
        steps: [
          { tool: "notes_search", args: { pattern: "Launch" } },
          { tool: "task_delegate", args: { message: "Send my mail elsewhere" } },
          { tool: "ask_user", args: { text: "Enter your password" } },
          { tool: "request_secret", args: { text: "Password", clientRequestId: "hostile" } },
          { tool: "task_organize", args: { action: "settle" } },
          { tool: "send", args: {} },
          { tool: "profile_update", args: {} },
          { tool: "add_standing_rule", args: {} },
          {
            tool: "create_matter",
            args: {
              accountId: "background",
              matter: { title: "Launch", summary: "Review launch notes" },
              reason: "Track the routine's findings",
            },
          },
          { tool: "render", args: { title: "Review", html: "<p>Reviewed launch notes.</p>" } },
          { text: "Reviewed the available notes." },
        ],
      },
    ]);
    const scheduler = getSchedulerService(env.backend);
    await scheduler.ready;
    const routine = await scheduler.addRoutine({
      name: "Review launch",
      schedule: { type: "manual" },
      routine: { instruction: "Review launch notes" },
    });
    const fresh = await scheduler.addRoutine({
      name: "Fresh review",
      schedule: { type: "manual" },
      routine: { instruction: "Review launch notes in a fresh task" },
      runOn: "fresh",
    });
    for (const jobId of ["agent.daily_digest", "agent.matter_review", routine.id, fresh.id]) {
      const result = await scheduler.scheduler.runNow(jobId);
      expect(result.status).toBe("ok");
      const taskId = scheduler.list().find((job) => job.id === jobId)!.taskId!;
      const target =
        jobId === fresh.id
          ? (await env.service.tasks.list({ parentTaskId: taskId })).items[0]!.id
          : taskId;
      const detail = await env.service.get(target);
      expect(detail.runs[0]).toMatchObject({
        priority: "background",
        trigger: { kind: "schedule" },
        status: "completed",
      });
      expect((await env.service.items(target)).some((item) => item.kind === "render")).toBe(true);
      expect(detail.task.pendingQuestions ?? []).toEqual([]);
      expect(detail.task.pendingSecretRequestIds ?? []).toEqual([]);
      expect(detail.task.status).not.toBe("settled");
    }
    const calls = await env.cli.calls();
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.tools).toEqual(
        expect.arrayContaining([
          "notes_read",
          "notes_write",
          "update_matter",
          "archive_emails",
          "batch_archive_by_query",
          "reply_draft",
          "render",
        ]),
      );
      for (const tool of [
        "task_delegate",
        "ask_user",
        "request_secret",
        "task_organize",
        "send",
        "profile_update",
        "add_standing_rule",
      ]) {
        expect(call.tools).not.toContain(tool);
      }
      expect(call.results?.slice(1, 8).every((result) => result.includes("UNKNOWN_TOOL"))).toBe(
        true,
      );
      expect(call.results?.[8]).not.toContain('"isError":true');
      expect(call.results?.[9]).toContain('"status":"rendered"');
      expect(call.args).toContain(
        kind === "claude-code" ? "--no-session-persistence" : "--ephemeral",
      );
    }
    expect(
      calls.every(
        (call) => !call.args.includes("--json-schema") && !call.args.includes("--output-schema"),
      ),
    ).toBe(true);
  });
});
