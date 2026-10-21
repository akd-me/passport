import type { CompleteOptions, LlmCompletion } from "@passport/agent";
import {
  createProviderRegistry,
  MockCalendarProvider,
  MockMailProvider,
  mockCapabilities,
} from "@passport/providers";
import type { Account } from "@passport/types";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRealBackend, type RealBackend } from "./compose.js";
import { defaultConfig } from "./config.js";

const at = "2026-10-20T12:00:00.000Z";
const account: Account = {
  id: "release",
  kind: "mock",
  displayName: "Release",
  emailAddress: "alex@example.com",
  capabilities: { ...mockCapabilities, push: false },
  settings: {},
  createdAt: at,
  updatedAt: at,
};
const slot = { start: "2026-10-21T10:00:00.000Z", end: "2026-10-21T11:00:00.000Z" };
const backends: RealBackend[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  for (const backend of backends.splice(0)) {
    await backend.close();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function fixture(llm?: { complete: (options: CompleteOptions) => Promise<LlmCompletion> }) {
  const mail = new MockMailProvider({ fixtures: false });
  const calendar = new MockCalendarProvider();
  const providers = createProviderRegistry();
  vi.spyOn(providers, "mail").mockReturnValue(mail);
  vi.spyOn(providers, "calendar").mockReturnValue(calendar);
  const backend = await createRealBackend(
    { ...defaultConfig(), accounts: [account] },
    { storePath: ":memory:", providers, llm },
  );
  backends.push(backend);
  await mail.connect(account, {});
  await backend.policy.setConfig({ globalMode: "full_access" });
  await backend.policy.pinLevel("scheduling", "full_access");
  return { backend, mail, calendar };
}
function completion(json: Record<string, unknown>): LlmCompletion {
  return {
    json,
    text: JSON.stringify(json),
    toolCalls: [],
    model: "release-fixture",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    },
  };
}

it("B1: retries failed scheduling after matter creation exactly once", async () => {
  let scheduleCalls = 0;
  const complete = vi.fn(async (options: CompleteOptions) => {
    if (options.json?.properties?.category) {
      return completion({ category: "scheduling" });
    }
    if (options.json?.properties?.matterId) {
      return completion({
        matterId: null,
        title: "Meeting",
        kind: "project",
        summary: "Arrange a meeting",
        nextStep: "Offer times",
      });
    }
    if (++scheduleCalls === 1) {
      throw new Error("Scheduling model unavailable");
    }
    return completion({ status: "tentative", textBody: "Can we meet?", slots: [slot] });
  });
  const { backend, mail } = await fixture({ complete });
  mail.injectEmail({
    providerId: "meeting",
    subject: "Meeting request",
    preview: "Let's meet",
    textBody: "Let's meet",
    from: [{ email: "sam@example.com" }],
    headers: {
      messageId: "<meeting@example.com>",
      inReplyTo: null,
      references: [],
      listUnsubscribe: null,
    },
  });
  await backend.syncAccount(account.id);
  await backend.drainAgentQueue();
  const email = (await backend.store.emails.getByProviderId(account.id, "meeting"))!;
  expect(email.matterId).toBeTruthy();
  expect(await backend.store.matters.list()).toHaveLength(1);
  const retry = JSON.parse((await backend.store.kv.get(`arrival:${email.id}`))!);
  expect(retry.attempts).toBe(1);
  expect(retry).toMatchObject({
    step: "scheduling",
    checkpoints: {
      people: {},
      classify: { value: "scheduling" },
      matter: { value: { id: email.matterId } },
    },
  });
  vi.setSystemTime(new Date(retry.nextAttemptAt));
  await backend.processArrivals!();
  await backend.processArrivals!();
  expect(scheduleCalls).toBe(2);
  expect(complete).toHaveBeenCalledTimes(4);
  expect(await backend.store.matters.list()).toHaveLength(1);
  const actions = (await backend.store.actions.query({ runId: `arrival:${email.id}`, limit: 100 }))
    .items;
  expect(actions.filter((action) => action.request.type === "matter_create")).toHaveLength(1);
  expect(actions.filter((action) => action.request.type === "calendar_propose")).toHaveLength(1);
  expect(await backend.store.kv.get(`arrival:${email.id}`)).toBeNull();
});

it.each(["people", "matter", "scheduling", "done"])(
  "B1: recovers a committed action when the %s checkpoint write fails",
  async (failedStep) => {
    const complete = vi.fn(async (options: CompleteOptions) =>
      completion(
        options.json?.properties?.category
          ? { category: "scheduling" }
          : options.json?.properties?.matterId
            ? {
                matterId: null,
                title: "Meeting",
                kind: "project",
                summary: "Arrange meeting",
                nextStep: "Offer times",
              }
            : { status: "tentative", textBody: "Can we meet?", slots: [slot] },
      ),
    );
    const { backend, mail } = await fixture({ complete });
    const set = backend.store.kv.set.bind(backend.store.kv);
    let interrupted = false;
    vi.spyOn(backend.store.kv, "set").mockImplementation(async (key, value) => {
      if (
        key.startsWith("arrival:") &&
        key !== "arrival:pending" &&
        JSON.parse(value).checkpoints?.[failedStep] &&
        !interrupted
      ) {
        interrupted = true;
        throw new Error("Checkpoint unavailable");
      }
      await set(key, value);
    });
    mail.injectEmail({
      providerId: "checkpoint",
      subject: "Meeting request",
      from: [{ email: "sam@example.com" }],
    });
    await backend.syncAccount(account.id);
    await backend.drainAgentQueue();
    const email = (await backend.store.emails.getByProviderId(account.id, "checkpoint"))!;
    expect(interrupted).toBe(true);
    const retry = JSON.parse((await backend.store.kv.get(`arrival:${email.id}`))!);
    vi.setSystemTime(new Date(retry.nextAttemptAt));
    await backend.processArrivals!();
    expect(complete).toHaveBeenCalledTimes(3);
    const actions = (
      await backend.store.actions.query({ runId: `arrival:${email.id}`, limit: 100 })
    ).items;
    expect(actions.filter((action) => action.request.type === "matter_create")).toHaveLength(1);
    expect(actions.filter((action) => action.request.type === "calendar_propose")).toHaveLength(1);
    expect(await backend.store.matters.list()).toHaveLength(1);
    expect(await backend.store.kv.get(`arrival:${email.id}`)).toBeNull();
  },
);

it("B1: exhausted scheduling retries surface one attention item naming the incomplete step", async () => {
  const complete = vi.fn(async (options: CompleteOptions) => {
    if (options.json?.properties?.category) {
      return completion({ category: "scheduling" });
    }
    if (options.json?.properties?.matterId) {
      return completion({
        matterId: null,
        title: "Meeting",
        kind: "project",
        summary: "Arrange meeting",
        nextStep: "Offer times",
      });
    }
    throw new Error("Private model error");
  });
  const { backend, mail } = await fixture({ complete });
  mail.injectEmail({
    providerId: "exhausted",
    subject: "Meeting request",
    from: [{ email: "sam@example.com" }],
  });
  await backend.syncAccount(account.id);
  await backend.drainAgentQueue();
  const email = (await backend.store.emails.getByProviderId(account.id, "exhausted"))!;
  for (let attempt = 1; attempt < 5; attempt++) {
    const retry = JSON.parse((await backend.store.kv.get(`arrival:${email.id}`))!);
    vi.setSystemTime(new Date(retry.nextAttemptAt));
    await backend.processArrivals!();
  }
  await backend.processArrivals!();
  expect(complete).toHaveBeenCalledTimes(7);
  expect(await backend.store.matters.list()).toHaveLength(1);
  const proposed = (await backend.store.actions.query({ status: ["proposed"] })).items.filter(
    (action) => action.request.actor.id === "agent.arrivals",
  );
  expect(proposed).toHaveLength(1);
  expect(proposed[0]).toMatchObject({
    request: {
      type: "matter_update",
      reason: "Needs your attention: triage incomplete at scheduling",
    },
  });
  expect(JSON.stringify(proposed)).not.toContain("Private model error");
});

it("B1: resumes a multi-action playbook after its label committed without archiving twice", async () => {
  const complete = vi.fn(async (options: CompleteOptions) =>
    completion(
      options.json?.properties?.category
        ? { category: "newsletters" }
        : {
            matterId: null,
            title: "Newsletter",
            kind: "reading",
            summary: "Read later",
            nextStep: "Archive",
          },
    ),
  );
  const { backend, mail } = await fixture({ complete });
  await backend.policy.pinLevel("newsletters", "full_access");
  const set = backend.store.kv.set.bind(backend.store.kv);
  let interrupted = false;
  vi.spyOn(backend.store.kv, "set").mockImplementation(async (key, value) => {
    if (key.startsWith("run:arrival:") && !interrupted) {
      const lastId = JSON.parse(value).actionIds.at(-1);
      if (lastId && (await backend.store.actions.get(lastId))?.request.type === "label") {
        interrupted = true;
        throw new Error("Action journal unavailable");
      }
    }
    await set(key, value);
  });
  mail.injectEmail({
    providerId: "newsletter",
    subject: "Weekly news",
    from: [{ email: "news@example.com" }],
  });
  await backend.syncAccount(account.id);
  await backend.drainAgentQueue();
  const email = (await backend.store.emails.getByProviderId(account.id, "newsletter"))!;
  expect(interrupted).toBe(true);
  const retry = JSON.parse((await backend.store.kv.get(`arrival:${email.id}`))!);
  vi.setSystemTime(new Date(retry.nextAttemptAt));
  await backend.processArrivals!();
  await backend.processArrivals!();
  const actions = (await backend.store.actions.query({ runId: `arrival:${email.id}`, limit: 100 }))
    .items;
  expect(actions.filter((action) => action.request.type === "label")).toHaveLength(1);
  expect(actions.filter((action) => action.request.type === "archive")).toHaveLength(1);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(await backend.store.kv.get(`arrival:${email.id}`)).toBeNull();
});

it("B1: retries an attention-only playbook without duplicating the surfaced decision", async () => {
  const complete = vi.fn(async (options: CompleteOptions) =>
    completion(
      options.json?.properties?.category
        ? { category: "other" }
        : {
            matterId: null,
            title: "Review",
            kind: "project",
            summary: "Needs review",
            nextStep: "Review",
          },
    ),
  );
  const { backend, mail } = await fixture({ complete });
  const set = backend.store.kv.set.bind(backend.store.kv);
  let interrupted = false;
  vi.spyOn(backend.store.kv, "set").mockImplementation(async (key, value) => {
    if (
      key.startsWith("arrival:") &&
      key !== "arrival:pending" &&
      JSON.parse(value).checkpoints?.playbook &&
      !interrupted
    ) {
      interrupted = true;
      throw new Error("Playbook checkpoint unavailable");
    }
    await set(key, value);
  });
  mail.injectEmail({
    providerId: "attention",
    subject: "Question",
    from: [{ email: "sam@example.com" }],
  });
  await backend.syncAccount(account.id);
  await backend.drainAgentQueue();
  const email = (await backend.store.emails.getByProviderId(account.id, "attention"))!;
  expect(interrupted).toBe(true);
  const retry = JSON.parse((await backend.store.kv.get(`arrival:${email.id}`))!);
  vi.setSystemTime(new Date(retry.nextAttemptAt));
  await backend.processArrivals!();
  expect(JSON.parse((await backend.store.kv.get("agent:pending_decisions"))!)).toEqual([
    `decision:arrival:${email.id}:${email.id}`,
  ]);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(await backend.store.kv.get(`arrival:${email.id}`)).toBeNull();
});

it.each([false, true])(
  "B2: holds a proposal during a mock calendar sync (reconcile=%s)",
  async (reconcile) => {
    const { backend, mail, calendar } = await fixture();
    await backend.syncAccount(account.id);
    const held = await backend.executor.submit({
      type: "calendar_propose",
      accountId: account.id,
      category: "scheduling",
      actor: { kind: "agent", id: "release" },
      reason: "Offer meeting",
      params: {
        slots: [slot],
        draft: {
          accountId: account.id,
          to: [{ email: "sam@example.com" }],
          subject: "Meeting",
          textBody: "Can we meet?",
        },
      },
    });
    expect(held.status).toBe("held");
    let finish!: () => void, entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const sync = vi.spyOn(calendar, "sync");
    if (reconcile) {
      sync.mockImplementationOnce(async function* () {
        throw Object.assign(new Error("Expired"), { code: "CURSOR_EXPIRED" });
      });
    }
    sync.mockImplementationOnce(async function* () {
      entered();
      await paused;
      yield { kind: "cursor", cursor: "complete" };
    });
    const syncing = backend.syncAccount(account.id);
    await started;
    try {
      vi.setSystemTime(new Date(held.holdUntil!));
      expect(await backend.executor.releaseDue()).toEqual([]);
      expect(await backend.store.actions.get(held.id)).toMatchObject({ status: "held" });
      expect(mail.sentMail).toHaveLength(0);
    } finally {
      finish();
      await syncing;
    }
    const deferred = (await backend.store.actions.get(held.id))!;
    vi.setSystemTime(new Date(deferred.holdUntil!));
    expect(await backend.executor.releaseDue()).toHaveLength(1);
    expect(mail.sentMail).toHaveLength(1);
  },
);

it("B2: holds a proposal until a combined account's entire sync pass finishes", async () => {
  const { backend, mail } = await fixture();
  await backend.syncAccount(account.id);
  const held = await backend.executor.submit({
    type: "calendar_propose",
    accountId: account.id,
    category: "scheduling",
    actor: { kind: "agent", id: "release" },
    reason: "Offer meeting",
    params: {
      slots: [slot],
      draft: {
        accountId: account.id,
        to: [{ email: "sam@example.com" }],
        subject: "Meeting",
        textBody: "Can we meet?",
      },
    },
  });
  let finish!: () => void, entered!: () => void;
  const paused = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(mail, "sync").mockImplementationOnce(async function* () {
    entered();
    await paused;
    yield { kind: "cursor", cursor: "complete" };
  });
  const syncing = backend.syncAccount(account.id);
  await started;
  try {
    expect(await backend.store.kv.get(`sync-in-progress:${account.id}`)).toBe("1");
    vi.setSystemTime(new Date(held.holdUntil!));
    expect(await backend.executor.releaseDue()).toEqual([]);
    expect((await backend.store.actions.get(held.id))!.status).toBe("held");
    expect(mail.sentMail).toHaveLength(0);
  } finally {
    finish();
    await syncing;
  }
  expect(await backend.store.kv.get(`sync-in-progress:${account.id}`)).toBeNull();
});

it.each(["stale", "missing", "reconcile", "failed-pass"])(
  "B2: defers %s calendar data three times, then requests review",
  async (state) => {
    const { backend, mail } = await fixture();
    await backend.syncAccount(account.id);
    const held = await backend.executor.submit({
      type: "calendar_propose",
      accountId: account.id,
      category: "scheduling",
      actor: { kind: "agent", id: "release" },
      reason: "Offer meeting",
      params: {
        slots: [slot],
        draft: {
          accountId: account.id,
          to: [{ email: "sam@example.com" }],
          subject: "Meeting",
          textBody: "Can we meet?",
        },
      },
    });
    if (state === "missing") {
      await backend.store.kv.delete(`calendar-sync:${account.id}`);
      await backend.store.syncState.set({ accountId: account.id, cursor: null, updatedAt: at });
    } else if (state === "reconcile") {
      await backend.store.kv.set(`sync-reconcile:${account.id}:calendar`, "1");
    } else if (state === "failed-pass") {
      await backend.store.kv.set(`calendar-sync-in-progress:${account.id}`, "1");
    }
    vi.setSystemTime(new Date(state === "stale" ? Date.parse(at) + 11 * 60000 : held.holdUntil!));
    const proposed = vi.fn();
    backend.bus.on("action.proposed", proposed);
    for (let extension = 0; extension < 3; extension++) {
      expect(await backend.executor.releaseDue()).toEqual([]);
      const deferred = (await backend.store.actions.get(held.id))!;
      expect(deferred.status).toBe("held");
      expect(Date.parse(deferred.holdUntil!)).toBe(Date.now() + 30000);
      vi.setSystemTime(new Date(deferred.holdUntil!));
    }
    expect(await backend.executor.releaseDue()).toEqual([]);
    expect(await backend.store.actions.get(held.id)).toMatchObject({
      status: "proposed",
      error: "AVAILABILITY_UNVERIFIED",
      holdUntil: null,
    });
    expect(proposed).toHaveBeenCalledTimes(1);
    expect(mail.sentMail).toHaveLength(0);
  },
);

it("B2: honors the configured calendar freshness window", async () => {
  const { backend, mail } = await fixture();
  backend.config.calendarMaxSyncAgeMinutes = 20;
  await backend.syncAccount(account.id);
  const held = await backend.executor.submit({
    type: "calendar_propose",
    accountId: account.id,
    category: "scheduling",
    actor: { kind: "agent", id: "release" },
    reason: "Offer meeting",
    params: {
      slots: [slot],
      draft: {
        accountId: account.id,
        to: [{ email: "sam@example.com" }],
        subject: "Meeting",
        textBody: "Can we meet?",
      },
    },
  });
  expect(held.status).toBe("held");
  vi.setSystemTime(new Date(Date.parse(at) + 11 * 60000));
  expect(await backend.executor.releaseDue()).toHaveLength(1);
  expect(mail.sentMail).toHaveLength(1);
});
