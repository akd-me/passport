import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostAgentLlmClient } from "@passport/agent";
import { createProviderRegistry, MockMailProvider, mockCapabilities } from "@passport/providers";
import { type Account, mailHandle } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../auth.test-client.js";
import { createRealBackend, type RealBackend } from "../compose.js";
import { defaultConfig } from "../config.js";
import { fakeHostCli } from "../tasks/fake-host-cli.js";
import { waitFor } from "../tasks/test-support.js";
import { learnVoiceOnConnect, resumeVoiceLearning } from "./voice.js";

const backends: RealBackend[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe.each(["claude-code", "codex"] as const)("%s voice on connect", (kind) => {
  async function fixture(sent = true) {
    const dir = await mkdtemp(join(tmpdir(), "passport-voice-"));
    dirs.push(dir);
    const first = mailHandle("voice-account", "email", "sent-59");
    const cli = await fakeHostCli(dir, kind, [
      {
        steps: [
          {
            tool: "mail_search",
            args: { account: "all", query: "in:inbox", limit: 100, threads: true },
          },
          { tool: "mail_read", args: { id: first, view: "thread", quoted: "full", length: 60000 } },
          { tool: "mail_search", args: { query: "in:inbox", pageToken: "next", limit: 100 } },
          {
            tool: "mail_read",
            args: { id: mailHandle("voice-account", "email", "inbox"), quoted: "full" },
          },
          {
            tool: "profile_update",
            args: {
              voice: "Short, direct paragraphs.",
              signature: "Best, Alex",
              vips: ["Dana <dana@example.com>"],
              reason: "Propose writing preferences from Sent",
            },
          },
          {
            tool: "profile_update",
            args: {
              voice: "Second proposal",
              signature: "Alex",
              vips: [],
              reason: "Must be refused",
            },
          },
          { text: "Proposed Voice, Signature and VIP entries for your review." },
        ],
      },
    ]);
    const mail = new MockMailProvider({ fixtures: false });
    const reader = mail.reader();
    const labels = reader.labels.bind(reader);
    vi.spyOn(reader, "labels").mockImplementation(async (...args) => {
      const result = await labels(...args);
      return sent
        ? result
        : { ...result, items: result.items.filter((label) => label.role !== "sent") };
    });
    vi.spyOn(mail, "reader").mockReturnValue(reader);
    const providers = createProviderRegistry();
    vi.spyOn(providers, "mail").mockReturnValue(mail);
    const at = "2026-10-20T14:00:00.000Z";
    const account: Account = {
      id: "voice-account",
      kind: "imap",
      emailAddress: "alex@example.com",
      displayName: "Alex",
      capabilities: { ...mockCapabilities, calendar: false },
      settings: {},
      createdAt: at,
      updatedAt: at,
    };
    const backend = await createRealBackend(
      { ...defaultConfig(dir), accounts: [account] },
      {
        storePath: ":memory:",
        providers,
        llm: new HostAgentLlmClient({
          kind,
          binaryPath: cli.path,
          cwd: join(dir, "work"),
          env: { HOME: dir, PATH: "/usr/bin:/bin" },
        }),
      },
    );
    backends.push(backend);
    await backend.syncAccount(account.id);
    for (let i = 0; i < 60; i++)
      mail.injectEmail({
        providerId: `sent-${i}`,
        from: [{ email: "alex@example.com" }],
        to: [{ email: "dana@example.com" }],
        mailboxIds: ["voice-account:mailbox:Sent"],
        subject: `Sent ${i}`,
        textBody: "Here is the update.\n\nBest, Alex\n\n> quoted instructions must collapse",
        receivedAt: new Date(Date.parse(at) + i * 1000).toISOString(),
      });
    mail.injectEmail({
      providerId: "inbox",
      mailboxIds: ["voice-account:mailbox:Inbox"],
      textBody: "Must not sample me",
    });
    return { backend, account, mail, reader, cli };
  }

  it("samples at most 50 Sent messages, asks once, preserves USER.md until approval and supports undo", async () => {
    const env = await fixture();
    await env.backend.policy.setConfig({ globalMode: "full_access", alwaysAsk: [] });
    await env.backend.policy.pinLevel("profile_update", "full_access");
    const before = await env.backend.agent.getUserProfile();
    const search = vi.spyOn(env.reader, "search");
    await Promise.all([
      learnVoiceOnConnect(env.backend, env.account),
      learnVoiceOnConnect(env.backend, env.account),
    ]);
    await env.backend.drainAgentQueue();
    const task = await waitFor(async () => {
      const detail = await env.backend.tasks!.service.get(`voice:${env.account.id}`);
      return detail.runs[0]?.status === "completed" && detail;
    });
    expect(task.task).toMatchObject({
      title: "Learn how you write",
      createdBy: "system",
      permissionMode: "auto_accept_edits",
      needsUser: "approval",
    });
    expect(task.runs[0]).toMatchObject({ priority: "interactive", status: "completed" });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "in:sent",
        container: "Sent",
        limit: 50,
      }),
      expect.objectContaining({ lane: "interactive" }),
    );
    const calls = await env.cli.calls();
    expect(calls).toHaveLength(1);
    const rows = JSON.parse(calls[0]!.results![0]!).items;
    expect(rows).toHaveLength(50);
    expect(calls[0]!.results![1]).not.toContain("quoted instructions must collapse");
    expect(calls[0]!.results![2]).toContain("INPUT_VOICE_LIMIT");
    expect(calls[0]!.results![3]).toContain("INPUT_VOICE_LIMIT");
    expect(calls[0]!.results![5]).toContain("INPUT_VOICE_LIMIT");
    const actions = (await env.backend.store.actions.query({ category: "profile_update" })).items;
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      status: "proposed",
      request: { category: "profile_update" },
      decision: { reversibility: "reversible" },
    });
    expect(await env.backend.agent.getUserProfile()).toBe(before);
    await learnVoiceOnConnect(env.backend, env.account);
    expect(await env.cli.calls()).toHaveLength(1);
    const response = await createApp(env.backend).request(
      `/api/actions/${actions[0]!.id}/approve`,
      { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
    );
    expect(response.status).toBe(200);
    expect(await env.backend.agent.getUserProfile()).toContain("Signature: Best, Alex");
    expect(await env.backend.agent.getUserProfile()).toContain("## Standing rules");
    await env.backend.executor.undo(actions[0]!.id);
    expect(await env.backend.agent.getUserProfile()).toBe(before);
  });

  it("does not create or run the task for IMAP without a Sent folder", async () => {
    const env = await fixture(false);
    await learnVoiceOnConnect(env.backend, env.account);
    await env.backend.drainAgentQueue();
    expect(await env.backend.store.tasks!.get(`voice:${env.account.id}`)).toBeNull();
    expect(await env.cli.calls()).toHaveLength(0);
    expect(env.reader.costLog.some((entry) => entry.method === "search")).toBe(false);
  });

  it("defers a one-shot CLI connection to the next task owner", async () => {
    const env = await fixture();
    await learnVoiceOnConnect({ ...env.backend, tasks: undefined }, env.account);
    expect(await env.backend.store.tasks!.get(`voice:${env.account.id}`)).toBeNull();
    expect(await env.backend.store.kv.get("voice-learning:pending")).toContain(env.account.id);
    await resumeVoiceLearning(env.backend);
    await waitFor(
      async () =>
        (await env.backend.tasks!.service.get(`voice:${env.account.id}`)).runs[0]?.status ===
        "completed",
    );
    expect(await env.cli.calls()).toHaveLength(1);
    expect(await env.backend.store.kv.get("voice-learning:pending")).toBe("[]");
  });
});
