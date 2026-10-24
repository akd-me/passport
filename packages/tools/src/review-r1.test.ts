/**
 * Review R1: classification scope (R1-2), task account scope (R1-10), secret requests and
 * task stamping (R1-18, R1-19), and failed renders (R1-25).
 */
import { type StoreTasks, stampTask, type Task, type TaskItem } from "@passport/types";
import { beforeEach, describe, expect, it } from "vitest";
import { createToolRegistry } from "./index.js";
import { secretAsked, secretResolved } from "./secrets.js";
import { MemoryBus, MemoryExecutor, MemoryPolicy, MemoryStore } from "./testing/fakes.js";
import * as f from "./testing/fixtures.js";
import type { Tool, ToolContext } from "./types.js";

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Follow up",
    accountIds: ["account-1"],
    status: "working",
    pinned: false,
    permissionMode: "supervised",
    interactionMode: "default",
    createdBy: "user",
    kind: "task",
    needsUser: null,
    lastActivityAt: f.at,
    createdAt: f.at,
    watches: [],
    ...patch,
  };
}

let store: MemoryStore & { tasks?: StoreTasks };
let executor: MemoryExecutor;
const build = () =>
  createToolRegistry({
    store,
    executor,
    policy: new MemoryPolicy(),
    bus: new MemoryBus(),
    actor: { kind: "agent", id: "run-1" },
    selfAddresses: ["me@example.com"],
    now: () => f.at,
  });
const call = (tools: Tool[], name: string, input: unknown, context?: ToolContext) =>
  tools.find((tool) => tool.name === name)!.handler(input, context);

beforeEach(async () => {
  store = new MemoryStore();
  executor = new MemoryExecutor(store, new MemoryPolicy());
  await store.accounts.upsert(f.account());
  await store.accounts.upsert(f.account({ id: "account-2", emailAddress: "work@example.com" }));
  await store.emails.upsertMany([
    f.email(),
    f.email({ id: "email-2", providerId: "message-2", subject: "Contract" }),
    f.email({ id: "email-b", accountId: "account-2", providerId: "message-b" }),
  ]);
});

describe("triage classification scope (R1-2)", () => {
  it("overrides the inferred category only for the emails it describes", async () => {
    const tools = build();
    const triage = { classification: "newsletters" as const, classificationEmailIds: ["email-1"] };
    await call(tools, "archive_emails", { emailIds: ["email-1"], reason: "r" }, triage);
    await call(tools, "archive_emails", { emailIds: ["email-2"], reason: "r" }, triage);
    await call(
      tools,
      "archive_emails",
      { emailIds: ["email-1"], reason: "r" },
      { classification: "newsletters" },
    );
    expect(executor.submitted.map((request) => request.category)).toEqual([
      "newsletters",
      executor.submitted[1]!.category,
      executor.submitted[2]!.category,
    ]);
    expect(executor.submitted[1]!.category).not.toBe("newsletters");
    expect(executor.submitted[2]!.category).not.toBe("newsletters");
  });
});

describe("task account scope (R1-10)", () => {
  const scope = { accountIds: ["account-1"] };

  it("refuses reads and writes on other accounts", async () => {
    const tools = build();
    expect(await call(tools, "get_email", { emailId: "email-b" }, scope)).toMatchObject({
      isError: true,
      error: "ACCOUNT_FORBIDDEN",
    });
    expect(
      await call(tools, "archive_emails", { emailIds: ["email-b"], reason: "r" }, scope),
    ).toMatchObject({ isError: true, error: "ACCOUNT_FORBIDDEN" });
    expect(
      await call(tools, "mail_list", { account: "account-2", container: "Inbox" }, scope),
    ).toMatchObject({ isError: true, error: "ACCOUNT_FORBIDDEN" });
    expect(executor.submitted).toEqual([]);
  });

  it("resolves and lists only the task's accounts", async () => {
    const tools = build();
    const accounts = (await call(tools, "mail_accounts", {}, scope)) as {
      items: Array<{ id: string }>;
    };
    expect(accounts.items.map((item) => item.id)).toEqual(["account-1"]);
    const found = (await call(tools, "search_emails", {}, scope)) as {
      items: Array<{ accountId: string }>;
    };
    expect(found.items.length).toBeGreaterThan(0);
    expect(found.items.every((item) => item.accountId === "account-1")).toBe(true);
    // With one account in scope, account-less writes resolve to it.
    expect(
      await call(tools, "archive_emails", { emailIds: ["email-1"], reason: "r" }, scope),
    ).not.toHaveProperty("isError");
    expect(executor.submitted.map((request) => request.accountId)).toEqual(["account-1"]);
  });

  it("leaves unscoped calls unchanged", async () => {
    const tools = build();
    expect(await call(tools, "get_email", { emailId: "email-b" })).not.toHaveProperty("isError");
  });
});

describe("secret requests on the task row (R1-18)", () => {
  it("keeps a question's Input state while a secret request ends, and the reverse", () => {
    const waiting = task({
      status: "inbox",
      needsUser: "question",
      pendingQuestions: [
        { itemId: "q-1", text: "Which?", options: [], blocking: false, askedAt: f.at },
      ] as unknown as Task["pendingQuestions"],
    });
    const asked = { ...waiting, ...secretAsked(waiting, "s-1", f.at) };
    expect(asked.pendingSecretRequestIds).toEqual(["s-1"]);
    expect(asked.needsUser).toBe("question");
    // The secret ends; the question still waits on the person.
    const ended = { ...asked, ...secretResolved(asked, "s-1") };
    expect(ended).toMatchObject({ pendingSecretRequestIds: [], needsUser: "question" });
    // The question ends first; the open secret request still waits on the person.
    const secretOnly = { ...asked, pendingQuestions: [] };
    expect(secretOnly.needsUser).toBe("question");
    const done = { ...secretOnly, ...secretResolved(secretOnly, "s-1") };
    expect(done.needsUser).toBeNull();
  });

  it("surfaces like a question: approvals first, a settled task only records it", () => {
    const working = task({ snoozedUntil: null });
    expect(secretAsked(working, "s-1", "2026-10-21T00:00:00.000Z")).toEqual({
      pendingSecretRequestIds: ["s-1"],
      status: "inbox",
      needsUser: "question",
      snoozedUntil: null,
      lastActivityAt: "2026-10-21T00:00:00.000Z",
    });
    expect(secretAsked(task({ pendingActionIds: ["a-1"] }), "s-1", f.at)).toMatchObject({
      needsUser: "approval",
    });
    expect(secretAsked(task({ status: "settled" }), "s-1", f.at)).toEqual({
      pendingSecretRequestIds: ["s-1"],
      needsUser: "question",
    });
    expect(
      secretResolved(task({ needsUser: "failure", pendingSecretRequestIds: ["s-1"] }), "s-1"),
    ).toEqual({ pendingSecretRequestIds: [] });
  });
});

describe("task stamping (R1-19)", () => {
  it("stamps returnedAt with lastActivityAt and clears titleGenerated on a rename", () => {
    const current = task({ titleGenerated: true });
    expect(stampTask(current, { lastActivityAt: "x" })).toEqual({
      lastActivityAt: "x",
      returnedAt: "x",
    });
    expect(stampTask(current, () => ({ title: "Renamed" }))).toEqual({
      title: "Renamed",
      titleGenerated: false,
    });
  });

  it("watch tools are agent actions: they move neither lastActivityAt nor returnedAt", async () => {
    let row = task({ returnedAt: f.at });
    store.tasks = {
      get: async () => structuredClone(row),
      update: async (_id, patch) => {
        row = { ...row, ...(typeof patch === "function" ? patch(row) : patch) };
        return structuredClone(row);
      },
    } as StoreTasks;
    const tools = build();
    const later = createToolRegistry({
      store,
      executor,
      policy: new MemoryPolicy(),
      bus: new MemoryBus(),
      actor: { kind: "agent", id: "run-1" },
      selfAddresses: [],
      now: () => "2026-10-22T00:00:00.000Z",
    });
    await call(
      later,
      "watch_conversation",
      { threadHandle: "account-1:thread:t-1" },
      {
        taskId: "task-1",
      },
    );
    await call(tools, "unwatch_conversation", {}, { taskId: "task-1" });
    expect(row).toMatchObject({ lastActivityAt: f.at, returnedAt: f.at, watches: [] });
  });
});

describe("render limit counts failures (R1-25)", () => {
  it("refuses an eleventh attempt even when every earlier one failed", async () => {
    const items: TaskItem[] = [];
    store.tasks = {
      runs: {
        byAgentRunId: async () => ({ id: "run-1", taskId: "task-1", status: "running" }),
      },
      items: {
        list: async () => items,
        append: async (item: TaskItem) => {
          const saved = { ...item, id: `item-${items.length}`, seq: items.length + 1 };
          items.push(saved);
          return saved;
        },
      },
    } as unknown as StoreTasks;
    const tools = build();
    const context = { taskId: "task-1", runId: "run-1" };
    const tooBig = "&".repeat(60_000);
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(await call(tools, "render", { title: "T", html: tooBig }, context)).toMatchObject({
        error: "RENDER_TOO_LARGE",
      });
    }
    expect(await call(tools, "render", { title: "T", html: "<p>ok</p>" }, context)).toMatchObject({
      error: "RENDER_LIMIT",
    });
    expect(items).toEqual([]);
  });
});
