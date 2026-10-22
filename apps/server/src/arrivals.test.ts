import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderRegistry, MockMailProvider, mockCapabilities } from "@passport/providers";
import type { Account, ActionRecord, AgentRun, Email } from "@passport/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Arrival, ArrivalQueue, persistArrival } from "./arrivals.js";
import { createApp } from "./auth.test-client.js";
import { createRealBackend, type RealBackend } from "./compose.js";
import { defaultConfig } from "./config.js";
import { getSchedulerService } from "./schedulers/service.js";

const at = "2026-10-20T12:00:00.000Z";
const account: Account = {
  id: "account",
  kind: "mock",
  displayName: "Test",
  emailAddress: "alex@example.com",
  capabilities: { ...mockCapabilities, calendar: false, push: false },
  settings: {},
  createdAt: at,
  updatedAt: at,
};
const successfulRun: AgentRun = {
  id: "run",
  trigger: { kind: "manual", instruction: "fixture" },
  startedAt: at,
  actionIds: [],
  summary: "Triaged",
};

describe("durable email arrivals", () => {
  const backends: RealBackend[] = [];
  const directories: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const backend of backends.splice(0)) {
      await getSchedulerService(backend).stop();
      await backend.close();
    }
    for (const path of directories.splice(0)) {
      await rm(path, { recursive: true, force: true });
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  async function fixture(dataDir?: string, enabled = true) {
    const providers = createProviderRegistry();
    const mail = new MockMailProvider({
      fixtures: false,
      now: () => new Date(),
    });
    vi.spyOn(providers, "mail").mockReturnValue(mail);
    const config = {
      ...defaultConfig(dataDir),
      accounts: [account],
      syncIntervalSeconds: 86400,
    };
    const backend = await createRealBackend(config, {
      storePath: dataDir ? join(dataDir, "passport.sqlite") : ":memory:",
      providers,
      ...(enabled
        ? {
            llm: {
              complete: vi.fn().mockRejectedValue(new Error("Use the fake agent")),
            },
          }
        : {}),
    });
    backends.push(backend);
    await mail.connect(account, {});
    const run = vi.spyOn(backend.agent, "run").mockResolvedValue(successfulRun);
    const scheduler = getSchedulerService(backend);
    await scheduler.ready;
    // The watcher's first tick takes its cursor at "now"; later injected mail arrives.
    await backend.syncAccount(account.id);
    return { backend, mail, run, scheduler };
  }
  async function arrival(backend: RealBackend, providerId = "new"): Promise<Email> {
    return (await backend.store.emails.getByProviderId(account.id, providerId))!;
  }
  async function entry(backend: RealBackend, email: Email): Promise<Arrival | null> {
    const saved = await backend.store.kv.get(`arrival:${email.id}`);
    return saved ? JSON.parse(saved) : null;
  }

  it("persists before immediate inference, retries on the 30-second scheduler and acknowledges success", async () => {
    const { backend, mail, run, scheduler } = await fixture();
    run.mockImplementationOnce(async (trigger) => {
      expect(trigger.kind).toBe("email.received");
      if (trigger.kind === "email.received") {
        expect(await backend.store.kv.get(`arrival:${trigger.emailId}`)).not.toBeNull();
        expect(JSON.parse((await backend.store.kv.get("arrival:pending"))!)[trigger.emailId]).toBe(
          account.id,
        );
      }
      throw Object.assign(new Error("private provider detail"), {
        code: "MODEL_UNAVAILABLE",
      });
    });
    mail.injectEmail({ providerId: "new" });
    await backend.syncAccount(account.id);
    await backend.drainAgentQueue();
    const email = await arrival(backend);
    expect(await entry(backend, email)).toMatchObject({
      attempts: 1,
      nextAttemptAt: "2026-10-20T12:01:00.000Z",
      lastError: "MODEL_UNAVAILABLE",
    });
    expect(scheduler.list().find((job) => job.id === "agent.arrivals")!.definition).toMatchObject({
      schedule: { type: "interval", everyMs: 30000 },
      concurrency: "single",
    });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(59999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(await entry(backend, email)).toBeNull();
    expect(JSON.parse((await backend.store.kv.get("arrival:pending"))!)).toEqual({});
  });

  it("treats an AgentRun.error result as a failed attempt", async () => {
    const { backend, mail, run, scheduler } = await fixture();
    run.mockResolvedValueOnce({ ...successfulRun, error: "Model timeout" });
    mail.injectEmail({ providerId: "new" });
    await backend.syncAccount(account.id);
    await backend.drainAgentQueue();
    const email = await arrival(backend);
    expect(await entry(backend, email)).toMatchObject({
      attempts: 1,
      lastError: "TRIAGE_FAILED",
    });
    await vi.advanceTimersByTimeAsync(60000);
    await scheduler.scheduler.runNow("agent.arrivals");
    expect(run).toHaveBeenCalledTimes(2);
    expect(await entry(backend, email)).toBeNull();
  });

  it("R2/B1: retries an unfinished action-bearing run after a journal failure without delivering twice", async () => {
    const { backend, mail, run, scheduler } = await fixture();
    await backend.policy.setConfig({ globalMode: "full_access" });
    await backend.policy.pinLevel("scheduling", "full_access");
    await backend.store.accounts.upsert({
      ...account,
      id: "calendar",
      capabilities: { ...account.capabilities, mail: false, calendar: true },
      lastSyncAt: at,
    });
    await backend.store.syncState.set({ accountId: "calendar", cursor: "complete", updatedAt: at });
    run.mockImplementationOnce(async (trigger) => {
      const runId = (trigger as { runId?: string }).runId;
      expect(runId).toBe(`arrival:${trigger.kind === "email.received" ? trigger.emailId : ""}`);
      await backend.executor.submit({
        type: "calendar_propose",
        accountId: account.id,
        category: "scheduling",
        runId,
        actor: { kind: "agent", id: "fixture" },
        reason: "Schedule a meeting",
        params: {
          slots: [],
          draft: {
            accountId: account.id,
            to: [{ email: "sam@example.com" }],
            subject: "Meeting",
            textBody: "Can we meet?",
          },
        },
      });
      throw new Error("Journal write failed after proposal creation");
    });
    mail.injectEmail({ providerId: "new" });
    await backend.syncAccount(account.id);
    await backend.drainAgentQueue();
    await vi.advanceTimersByTimeAsync(60000);
    await scheduler.scheduler.runNow("agent.arrivals");
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      (await backend.store.actions.query({ runId: `arrival:${(await arrival(backend)).id}` }))
        .items,
    ).toHaveLength(1);
    await backend.executor.releaseDue("2099-01-01T00:00:00Z");
    expect(mail.sentMail).toHaveLength(1);
  });

  it("R2: a crash before acknowledgement does not re-run a completed action-free arrival", async () => {
    const { backend, mail, run } = await fixture(undefined, false);
    mail.injectEmail({ providerId: "new" });
    await backend.syncAccount(account.id);
    const email = await arrival(backend);
    const remove = vi
      .spyOn(backend.store.kv, "delete")
      .mockRejectedValueOnce(new Error("Disk failure"));
    const queue = new ArrivalQueue(backend.store, backend.bus, backend.agent, () => true);
    await queue.enqueue(email.id, account.id);
    expect(await entry(backend, email)).toMatchObject({ completedAt: at });
    remove.mockRestore();
    // Simulate recovery of the discovery index too (e.g. crash before its write).
    await backend.store.kv.set("arrival:pending", JSON.stringify({ [email.id]: account.id }));
    await queue.drainDue();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("R9: two independent SQLite connections claim an arrival only once and renew a long run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "passport-claims-"));
    directories.push(directory);
    const first = await fixture(directory, false);
    first.mail.injectEmail({ providerId: "new" });
    await first.backend.syncAccount(account.id);
    const second = await fixture(directory, false);
    let finish!: (run: AgentRun) => void;
    first.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const one = new ArrivalQueue(
      first.backend.store,
      first.backend.bus,
      first.backend.agent,
      () => true,
    );
    const two = new ArrivalQueue(
      second.backend.store,
      second.backend.bus,
      second.backend.agent,
      () => true,
    );
    const work = one.drainDue();
    await vi.advanceTimersByTimeAsync(0);
    await two.drainDue();
    await vi.advanceTimersByTimeAsync(120000);
    await two.drainDue();
    expect(first.run).toHaveBeenCalledTimes(1);
    expect(second.run).not.toHaveBeenCalled();
    finish(successfulRun);
    await work;
  });

  it("R5: defers unsynced companion calendars without consuming retries, then marks availability unverified after one minute", async () => {
    const { backend, mail, run } = await fixture();
    await backend.store.accounts.upsert({
      ...account,
      id: "calendar",
      capabilities: { ...account.capabilities, mail: false, calendar: true },
      settings: { mailAccountId: account.id },
    });
    mail.injectEmail({ providerId: "new" });
    await backend.syncAccount(account.id);
    await backend.drainAgentQueue();
    expect(run).not.toHaveBeenCalled();
    const email = await arrival(backend);
    expect(await entry(backend, email)).toMatchObject({ attempts: 0, calendarWaitStartedAt: at });
    await vi.advanceTimersByTimeAsync(59999);
    await backend.processArrivals!();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await backend.processArrivals!();
    expect(run).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "email.received",
        emailId: email.id,
        runId: `arrival:${email.id}`,
        availabilityUnverified: true,
      },
      { priority: "background" },
    );
  });

  it("R5: resumes deferred arrivals once the companion calendar has a completed sync", async () => {
    const { backend, mail, run } = await fixture();
    await backend.store.accounts.upsert({
      ...account,
      id: "calendar",
      capabilities: { ...account.capabilities, mail: false, calendar: true },
    });
    mail.injectEmail({ providerId: "new" });
    await backend.syncAccount(account.id);
    await backend.drainAgentQueue();
    expect(run).not.toHaveBeenCalled();
    await backend.store.syncState.set({ accountId: "calendar", cursor: "complete", updatedAt: at });
    await backend.store.accounts.upsert({
      ...(await backend.store.accounts.get("calendar"))!,
      lastSyncAt: at,
    });
    await vi.advanceTimersByTimeAsync(30000);
    await backend.processArrivals!();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "backs off for 1m, 5m, 15m, 1h and exposes one failure decision (existing matter: %s)",
    async (existingMatter) => {
      const { backend, mail, run, scheduler } = await fixture();
      run.mockRejectedValue(new Error("private model failure"));
      mail.injectEmail({ providerId: "new" });
      await backend.syncAccount(account.id);
      await backend.drainAgentQueue();
      const email = await arrival(backend);
      if (existingMatter) {
        await backend.store.matters.upsert({
          id: "matter",
          title: "Existing history",
          summary: "Keep",
          status: "waiting",
          personIds: [],
          emailIds: [email.id],
          eventIds: [],
          createdAt: at,
          updatedAt: at,
        });
      }
      for (const [index, delay] of [60000, 300000, 900000, 3600000].entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        await scheduler.scheduler.runNow("agent.arrivals");
        expect(run).toHaveBeenCalledTimes(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        await scheduler.scheduler.runNow("agent.arrivals");
        expect(run).toHaveBeenCalledTimes(index + 2);
      }
      expect(await entry(backend, email)).toMatchObject({
        attempts: 5,
        nextAttemptAt: null,
        lastError: "TRIAGE_FAILED",
      });
      const app = createApp(backend);
      for (const suffix of ["", `?accountId=${account.id}`]) {
        const response = await app.request(`/api/decisions${suffix}`);
        expect(response.status).toBe(200);
        const { items } = (await response.json()) as { items: ActionRecord[] };
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          status: "proposed",
          request: {
            reason: "Needs your attention: triage incomplete at people",
            type: existingMatter ? "matter_update" : "matter_create",
          },
        });
        expect(JSON.stringify(items)).not.toContain("private model failure");
      }
      await vi.advanceTimersByTimeAsync(86400000);
      await scheduler.scheduler.runNow("agent.arrivals");
      expect(run).toHaveBeenCalledTimes(5);
      const decisions = await backend.store.actions.query({
        status: ["proposed"],
      });
      expect(decisions.items).toHaveLength(1);
      const action = await backend.executor.approve(decisions.items[0]!.id);
      expect(action.status).toBe("executed");
      const updated = (await backend.store.emails.get(email.id))!;
      expect(updated.matterId).toBeTruthy();
      if (existingMatter) {
        expect(updated.matterId).toBe("matter");
      }
      expect((await backend.store.matters.get(updated.matterId!))!.nextStep).toContain("Review");
    },
  );

  it("recovers persisted entries from a closed and reopened SQLite store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "passport-arrivals-"));
    directories.push(directory);
    const first = await fixture(directory);
    first.run.mockRejectedValueOnce(new Error("Temporary failure"));
    first.mail.injectEmail({ providerId: "new" });
    await first.backend.syncAccount(account.id);
    await first.backend.drainAgentQueue();
    const email = await arrival(first.backend);
    await first.scheduler.stop();
    await first.backend.close();
    backends.splice(backends.indexOf(first.backend), 1);
    await vi.advanceTimersByTimeAsync(60000);
    const second = await fixture(directory);
    // The provider still holds the message; read-through revalidation would tombstone it otherwise.
    second.mail.injectEmail({ providerId: "new" });
    expect(await entry(second.backend, email)).toMatchObject({ attempts: 1 });
    await second.scheduler.scheduler.runNow("agent.arrivals");
    expect(second.run).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "email.received",
        emailId: email.id,
        runId: `arrival:${email.id}`,
      },
      { priority: "background" },
    );
    expect(await entry(second.backend, email)).toBeNull();
  });

  it("serializes the fast path and scheduler retries per account without overlapping the same arrival", async () => {
    const { backend, mail, run, scheduler } = await fixture();
    let finish!: (run: AgentRun) => void;
    run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mail.injectEmail({ providerId: "new" });
    mail.injectEmail({ providerId: "second" });
    await backend.syncAccount(account.id);
    expect(run).toHaveBeenCalledTimes(1);
    const draining = scheduler.scheduler.runNow("agent.arrivals");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(run).toHaveBeenCalledTimes(1);
    finish(successfulRun);
    await draining;
    await backend.drainAgentQueue();
    expect(run).toHaveBeenCalledTimes(2);
    expect(JSON.parse((await backend.store.kv.get("arrival:pending"))!)).toEqual({});
  });

  it("retains arrivals without a configured model and recovers a claim interrupted on the fifth attempt", async () => {
    const { backend, mail, run, scheduler } = await fixture(undefined, false);
    mail.injectEmail({ providerId: "new" });
    await backend.syncAccount(account.id);
    await scheduler.scheduler.runNow("agent.arrivals");
    const email = await arrival(backend);
    expect(await entry(backend, email)).toMatchObject({ attempts: 0 });
    expect(run).not.toHaveBeenCalled();
    await backend.store.kv.set(
      `arrival:${email.id}`,
      JSON.stringify({
        accountId: account.id,
        attempts: 5,
        nextAttemptAt: at,
        lastError: null,
      }),
    );
    const queue = new ArrivalQueue(backend.store, backend.bus, backend.agent, () => true);
    await queue.drainDue();
    await queue.drainDue();
    expect(run).not.toHaveBeenCalled();
    expect((await backend.store.actions.query({ status: ["proposed"] })).items).toHaveLength(1);
  });

  it("preserves discovery when concurrent account arrivals register and skips deleted mail", async () => {
    const { backend, mail, run, scheduler } = await fixture(undefined, false);
    mail.injectEmail({ providerId: "new" });
    mail.injectEmail({ providerId: "second" });
    await backend.syncAccount(account.id);
    const first = await arrival(backend),
      second = await arrival(backend, "second");
    await Promise.all([
      persistArrival(backend.store, first),
      persistArrival(backend.store, second),
    ]);
    expect(Object.keys(JSON.parse((await backend.store.kv.get("arrival:pending"))!))).toHaveLength(
      2,
    );
    await backend.store.emails.patchMany([first.id, second.id], {
      keywords: { $deleted: true },
    });
    const queue = new ArrivalQueue(backend.store, backend.bus, backend.agent, () => true);
    await queue.drainDue();
    expect(run).not.toHaveBeenCalled();
    expect(await entry(backend, first)).toBeNull();
    expect(await entry(backend, second)).toBeNull();
    await scheduler.scheduler.runNow("agent.arrivals");
  });
});
