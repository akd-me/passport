import { MockMailProvider } from "@passport/providers";
import type {
  AgentRunOptions,
  HostAgentEvent,
  HostAgentKind,
  HostAgentSessionResult,
} from "@passport/types";
import { DEFAULT_AGENT_RUN_BUDGET } from "@passport/types";
import { describe, expect, it, vi } from "vitest";
import type { HostAgentSessionInput, SessionLlmClient } from "./host/client.js";
import { orchestrationPrompt } from "./prompts/orchestration.js";
import { createAgentRuntime } from "./runtime.js";
import type { ToolBelt, ToolBeltHost } from "./session-run.js";
import { FakeExecutor, FakePolicy, MemoryBus } from "./testing/collaborators.js";
import { FakeLlm } from "./testing/fake-llm.js";
import { accountFixture, TEST_NOW } from "./testing/fixtures.js";
import { MemoryStore } from "./testing/memory-store.js";

type Turn = (
  belt: ToolBelt,
  emit: (event: HostAgentEvent) => void,
  input: HostAgentSessionInput,
) => Promise<Partial<HostAgentSessionResult>>;

/** A session client whose "CLI" is a scripted function calling the belt directly. */
class FakeSessionLlm extends FakeLlm implements SessionLlmClient {
  readonly inputs: HostAgentSessionInput[] = [];
  belt?: ToolBelt;
  constructor(
    readonly hostKind: HostAgentKind,
    readonly turns: Turn[],
  ) {
    super([]);
  }
  session(input: HostAgentSessionInput, onEvent: (event: HostAgentEvent) => void) {
    this.inputs.push(input);
    const turn = this.turns.shift();
    const done = (async (): Promise<HostAgentSessionResult> => {
      const result = turn ? await turn(this.belt!, onEvent, input) : {};
      return { kind: this.hostKind, ok: true, text: "", ...result };
    })();
    return { done, cancel: () => {} };
  }
}

async function setup(turns: Turn[], kind: HostAgentKind = "claude-code") {
  const mock = new MockMailProvider({ fixtures: false });
  await mock.connect(accountFixture());
  mock.setNow(TEST_NOW);
  mock.injectEmail({
    providerId: "invoice",
    from: [{ name: "Alice", email: "alice@example.com" }],
    to: [{ email: "me@example.com" }],
    cc: [],
    mailboxIds: ["account-1:mailbox:Inbox"],
    subject: "Invoice due Friday",
    textBody: "Please pay by Friday.",
    receivedAt: TEST_NOW,
  });
  const store = new MemoryStore(),
    policy = new FakePolicy(),
    bus = new MemoryBus();
  await store.accounts.upsert(accountFixture());
  const executor = new FakeExecutor(store, policy);
  const llm = new FakeSessionLlm(kind, turns);
  const released = vi.fn();
  const toolBelt: ToolBeltHost = {
    bind: async (belt) => {
      llm.belt = belt;
      return { server: { url: "http://127.0.0.1:1/mcp" }, release: async () => released() };
    },
  };
  const readers = vi.fn(async () => mock.reader());
  const runtime = createAgentRuntime({
    store,
    executor,
    policy,
    bus,
    llm,
    selfAddresses: ["me@example.com"],
    now: () => TEST_NOW,
    readers,
    toolBelt,
  });
  const events = { texts: [] as string[], sessions: [] as unknown[], notices: [] as unknown[] };
  const options = (extra: AgentRunOptions = {}): AgentRunOptions => ({
    taskId: "task-1",
    session: {},
    observer: {
      assistantMessage: (text) => events.texts.push(text),
      providerSession: (session) => events.sessions.push(session),
      notice: (notice) => events.notices.push(notice),
    },
    ...extra,
  });
  return { mock, store, executor, llm, runtime, readers, released, events, options };
}

const instruction = { kind: "manual" as const, instruction: "Anything due this week?" };

describe("agentic session runs", () => {
  it("serves a session's tool call through the runtime's readers (v0.3.1 regression)", async () => {
    let reply: unknown;
    const env = await setup([
      async (belt, emit) => {
        emit({ type: "started", sessionId: "s-1" });
        reply = await belt.call("mail_search", { query: "from:alice@example.com", limit: 5 });
        emit({ type: "text", text: "Alice's invoice is due Friday." });
        return {
          sessionId: "s-1",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            costUsd: null,
          },
        };
      },
    ]);
    const run = await env.runtime.run(instruction, env.options());
    expect(JSON.stringify(reply)).toContain("Invoice due Friday");
    expect(JSON.stringify(reply)).not.toContain("ON_DEMAND_UNSUPPORTED");
    expect(env.mock.reader().costLog.map((entry) => entry.method)).toContain("search");
    expect(env.readers).toHaveBeenCalled();
    expect(env.events.texts).toEqual(["Alice's invoice is due Friday."]);
    expect(env.events.sessions).toEqual([{ kind: "claude-code", id: "s-1" }]);
    expect(run.toolBudget).toMatchObject({ callsMade: 1, llmCalls: 1, inputTokens: 100 });
    expect(run.summary).toContain("Session completed with 1 tool calls");
    expect(env.released).toHaveBeenCalledTimes(1);
    // Native tools: the session sees the belt, not a JSON protocol, plus the orchestration notes.
    const input = env.llm.inputs[0]!;
    expect(input.allowedTools).toEqual(["mcp__passport"]);
    expect(Object.keys(input.mcpServers)).toEqual(["passport"]);
    expect(input.systemPrompt).toContain("## How Passport runs you");
    expect(input.systemPrompt).not.toContain("argumentsJson");
    expect(input.prompt).toContain("Anything due this week?");
    expect(env.llm.calls).toEqual([]);
  });

  it("runs the completion loop instead when no session is requested or no belt exists", async () => {
    const env = await setup([]);
    env.llm.script.push("Nothing due.");
    await env.runtime.run(instruction, { ...env.options(), session: undefined });
    expect(env.llm.inputs).toEqual([]);
    expect(env.llm.calls).toHaveLength(1);
    expect(env.llm.calls[0]?.system).not.toContain("How Passport runs you");
  });

  it("resumes the requested session with the short turn", async () => {
    const env = await setup([async () => ({ sessionId: "s-1" })]);
    await env.runtime.run(
      instruction,
      env.options({
        session: { resume: { kind: "claude-code", id: "s-1", instruction: "Follow-up turn" } },
      }),
    );
    expect(env.llm.inputs[0]).toMatchObject({ resumeSessionId: "s-1", prompt: "Follow-up turn" });
  });

  it("resolves the session lazily and ignores a session of another host agent", async () => {
    const env = await setup([async () => ({})], "codex");
    const resolveResume = vi.fn(async () => ({
      kind: "claude-code" as const,
      id: "s-1",
      instruction: "Follow-up turn",
    }));
    await env.runtime.run(instruction, env.options({ session: { resolveResume } }));
    expect(resolveResume).toHaveBeenCalledTimes(1);
    expect(env.llm.inputs[0]?.resumeSessionId).toBeUndefined();
    expect(env.llm.inputs[0]?.prompt).toContain("Anything due this week?");
  });

  it("falls back to a fresh session when the resume fails before doing anything", async () => {
    const env = await setup([
      async () => ({ ok: false, error: { code: "HOST_AGENT_FAILED", message: "No session" } }),
      async (_belt, emit) => {
        emit({ type: "started", sessionId: "s-2" });
        return {};
      },
    ]);
    const run = await env.runtime.run(
      instruction,
      env.options({
        session: { resume: { kind: "claude-code", id: "gone", instruction: "Turn" } },
      }),
    );
    expect(env.llm.inputs.map((input) => input.resumeSessionId)).toEqual(["gone", undefined]);
    expect(env.llm.inputs[1]?.prompt).toContain("Anything due this week?");
    expect(env.events.sessions).toEqual([{ kind: "claude-code", id: "s-2" }]);
    expect(run.summary).toContain("could not be resumed");
  });

  it("does not retry a resumed session that already did work", async () => {
    const env = await setup([
      async (belt) => {
        await belt.call("mail_labels", {});
        return { ok: false, error: { code: "HOST_AGENT_RATE_LIMIT", message: "Limited" } };
      },
    ]);
    await expect(
      env.runtime.run(
        instruction,
        env.options({ session: { resume: { kind: "claude-code", id: "s", instruction: "T" } } }),
      ),
    ).rejects.toMatchObject({ code: "HOST_AGENT_RATE_LIMIT" });
    expect(env.llm.inputs).toHaveLength(1);
  });

  it("returns schema and unknown-tool errors to the session and keeps going", async () => {
    const replies: unknown[] = [];
    const env = await setup([
      async (belt) => {
        replies.push(await belt.call("mail_search", { query: 42 }));
        replies.push(await belt.call("no_such_tool", {}));
        return {};
      },
    ]);
    const run = await env.runtime.run(instruction, env.options());
    expect(replies).toEqual([
      expect.objectContaining({ isError: true, error: "INVALID_INPUT" }),
      expect.objectContaining({ isError: true, error: "UNKNOWN_TOOL" }),
    ]);
    expect(run.error).toBeUndefined();
  });

  it("refuses calls past the budget and ends the run with BUDGET_EXHAUSTED", async () => {
    const replies: unknown[] = [];
    const env = await setup([
      async (belt) => {
        for (let i = 0; i < 3; i++) {
          replies.push(await belt.call("mail_labels", {}));
        }
        return { ok: false, error: { code: "HOST_AGENT_CANCELLED", message: "Cancelled" } };
      },
    ]);
    const runtime = createAgentRuntime({
      store: env.store,
      executor: env.executor,
      policy: new FakePolicy(),
      bus: new MemoryBus(),
      llm: env.llm,
      selfAddresses: [],
      now: () => TEST_NOW,
      toolBelt: {
        bind: async (belt) => {
          env.llm.belt = belt;
          return { server: { url: "http://127.0.0.1:1/mcp" }, release: async () => {} };
        },
      },
      budget: { maxToolCalls: 1 },
    });
    const run = await runtime.run(instruction, env.options());
    expect(replies[1]).toMatchObject({ isError: true, error: "BUDGET_EXHAUSTED" });
    expect(replies[2]).toMatchObject({ isError: true, error: "RUN_STOPPED" });
    expect(env.events.notices).toEqual([expect.objectContaining({ code: "BUDGET_EXHAUSTED" })]);
    expect(run.error).toBeUndefined();
    expect(run.toolBudget.callsMade).toBe(1);
  });

  it("cancels on the run signal and refuses later tool calls", async () => {
    const controller = new AbortController();
    const replies: unknown[] = [];
    const env = await setup([
      async (belt) => {
        replies.push(await belt.call("mail_labels", {}));
        controller.abort();
        replies.push(await belt.call("mail_labels", {}));
        return { ok: false, error: { code: "HOST_AGENT_CANCELLED", message: "Cancelled" } };
      },
    ]);
    await expect(
      env.runtime.run(instruction, env.options({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: "RUN_CANCELLED" });
    expect(replies[1]).toMatchObject({ isError: true, error: "RUN_STOPPED" });
  });
});

describe("orchestration prompt", () => {
  it("stays under 4 KB and names the budget", () => {
    for (const session of [true, false]) {
      const text = orchestrationPrompt(DEFAULT_AGENT_RUN_BUDGET, session);
      expect(Buffer.byteLength(text)).toBeLessThan(4096);
      expect(text).toContain("at most 200 tool calls and 30 minutes");
      expect(text).toContain('"proposed"');
      // W2A: questions, subtasks and organising.
      for (const tool of ["ask_user", "task_delegate", "task_status", "task_organize"]) {
        expect(text).toContain(tool);
      }
    }
  });
});
