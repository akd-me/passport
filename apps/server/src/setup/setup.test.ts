import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createProviderRegistry } from "@passport/providers";
import type {
  DomainEvent,
  HostAgentEvent,
  HostAgentSessionRequest,
  HostAgentSessionResult,
  HostAgentStatus,
  ProviderRegistry,
  SetupTask,
} from "@passport/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../auth.test-client.js";
import { createRealBackend, type RealBackend } from "../compose.js";
import { defaultConfig } from "../config.js";
import { createDemoBackend } from "../demo/index.js";
import { browserMcpServer, detectSetupBrowser, PLAYWRIGHT_MCP_PACKAGE } from "./browser.js";
import { setupPrompt, setupSteps } from "./prompt.js";
import { setupTasks } from "./routes.js";
import { describeBrowserCall, type RunSession, SETUP_AGENT_MODELS } from "./runner.js";
import { SetupTaskState } from "./task.js";

const SECRET = "GOCSPX-client-secret-value-123";
const CLIENT_ID = "1234567890-abcdef.apps.googleusercontent.com";

function status(kind: HostAgentStatus["kind"], ready: boolean): HostAgentStatus {
  return {
    kind,
    label: kind,
    installed: ready,
    binaryPath: ready ? `/bin/${kind}` : null,
    version: "1",
    loggedIn: ready,
    account: null,
    ready,
    checkedAt: new Date().toISOString(),
    ...(ready ? {} : { fix: `Install ${kind}.` }),
  };
}

interface Tools {
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  request: HostAgentSessionRequest;
  emit(event: HostAgentEvent): void;
  signal: AbortSignal;
}
type Script = (tools: Tools) => Promise<void>;

/** A host-agent session double: talks to the setup MCP server over HTTP exactly as a CLI would. */
function fakeSessions() {
  const requests: HostAgentSessionRequest[] = [];
  const cancels = vi.fn();
  let script: Script = async () => {};
  const run: RunSession = (request, onEvent) => {
    requests.push(request);
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(request.signal ? [request.signal] : []),
    ]);
    const server = request.mcpServers!.passport as { url: string; headers: Record<string, string> };
    const done = (async (): Promise<HostAgentSessionResult> => {
      onEvent({ type: "started", sessionId: "s1" });
      const client = new Client({ name: "fake-agent", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: server.headers },
        }),
      );
      try {
        await script({
          request,
          signal,
          emit: onEvent,
          call: async (name, args = {}) => {
            const result = await client.callTool({ name, arguments: args }, undefined, {
              timeout: 30_000,
              signal,
            });
            const content = result.content as Array<{ type: string; text?: string }>;
            return {
              text: content.map((item) => item.text ?? "").join("\n"),
              isError: result.isError === true,
            };
          },
        });
      } catch (error) {
        if (signal.aborted) {
          return {
            kind: request.kind,
            ok: false,
            text: "",
            error: { code: "HOST_AGENT_CANCELLED", message: "Codex run was cancelled" },
          };
        }
        return {
          kind: request.kind,
          ok: false,
          text: "",
          error: {
            code: "HOST_AGENT_FAILED",
            message: `Codex run failed: ${(error as Error).message}`,
          },
        };
      } finally {
        await client.close().catch(() => undefined);
      }
      onEvent({ type: "completed", text: "done" });
      return { kind: request.kind, ok: true, text: "done" };
    })();
    return {
      done,
      cancel: () => {
        cancels();
        controller.abort();
      },
    };
  };
  return {
    run,
    requests,
    cancels,
    script: (next: Script) => {
      script = next;
    },
  };
}

async function until<T>(read: () => T, accept: (value: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (accept(value)) {
      return value;
    }
    if (Date.now() > end) {
      throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("agent-driven account setup", () => {
  let backend: RealBackend,
    dataDir: string,
    events: DomainEvent[],
    sessions: ReturnType<typeof fakeSessions>;
  let agents: HostAgentStatus[];
  const browser = {
    detect: vi.fn(() => "chrome" as const),
    prepare: vi.fn(async () => {}),
    server: vi.fn(() => ({ command: "browser-stub" })),
    close: vi.fn(async () => {}),
  };
  let app: ReturnType<typeof createApp>;
  const base = "http://127.0.0.1:3000";
  const json = (path: string, body?: unknown, init: RequestInit = {}) =>
    app.request(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...init.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const task = (id: string) => setupTasks(backend).get(id);

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "passport-setup-test-"));
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/token")
        ? Response.json({
            access_token: "access-secret",
            refresh_token: "refresh-secret",
            expires_in: 3600,
            scope:
              "openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events",
          })
        : Response.json({ email: "alex@example.com", email_verified: true }),
    );
    const registry = createProviderRegistry({ fetch: fetcher });
    const offline: ProviderRegistry = {
      ...registry,
      mail: (kind) => registry.mail(kind === "gmail" || kind === "graph" ? "mock" : kind),
      calendar: () => registry.calendar("mock"),
    };
    vi.stubGlobal("fetch", ((input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith("https://")
        ? fetcher(input, init)
        : realFetch(input, init)) as typeof fetch);
    backend = await createRealBackend(
      { ...defaultConfig(dataDir), port: 3000 },
      { storePath: ":memory:", providers: offline },
    );
    vi.spyOn(backend, "syncAccount").mockResolvedValue();
    events = [];
    backend.bus.onAny((event) => events.push(event));
    sessions = fakeSessions();
    agents = [status("codex", true), status("claude-code", true)];
    for (const mock of Object.values(browser)) {
      mock.mockClear();
    }
    setupTasks(backend, {
      detectAgents: async () => agents,
      runSession: sessions.run,
      browser,
      pollMs: 5,
      finishGraceMs: 10,
    });
    app = createApp(backend);
  });
  afterEach(async () => {
    await backend.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });
  const realFetch = globalThis.fetch;

  it("signs in, registers the client, opens consent in the agent's browser and connects", async () => {
    let authorizationUrl = "",
      attempt = "";
    sessions.script(async (tools) => {
      tools.emit({ type: "text", text: `Found the client secret ${SECRET} on the page` });
      tools.emit({
        type: "tool_call",
        name: "mcp__browser__browser_navigate",
        input: { url: "https://console.cloud.google.com/apis?project=x" },
      });
      expect(
        (await tools.call("report_progress", { step: "sign_in", status: "running" })).text,
      ).toBe("Recorded.");
      const signIn = await tools.call("ask_user", {
        kind: "sign_in",
        message: "Sign in to Google in the browser window I opened, then click Continue.",
      });
      expect(signIn.text).toContain("clicked Continue");
      await tools.call("report_progress", { step: "sign_in", status: "done" });
      await tools.call("report_progress", {
        step: "project",
        status: "skipped",
        detail: "Project Passport exists",
      });
      const which = await tools.call("ask_user", {
        kind: "question",
        message: "Which address will you connect?",
      });
      expect(which.text).toBe("The user answered: alex@example.com");
      const registered = await tools.call("register_oauth_client", {
        provider: "gmail",
        clientId: CLIENT_ID,
        clientSecret: SECRET,
      });
      expect(registered.isError).toBe(false);
      ({ authorizationUrl, state: attempt } = JSON.parse(registered.text) as {
        authorizationUrl: string;
        state: string;
      });
      tools.emit({
        type: "tool_call",
        name: "mcp__browser__browser_navigate",
        input: { url: authorizationUrl },
      });
      // The agent's browser opens the Passport link, then the provider redirects back.
      const launch = await app.request(authorizationUrl);
      expect(launch.status).toBe(302);
      expect(launch.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
      expect(new URL(launch.headers.get("location")!).searchParams.get("redirect_uri")).toBe(
        `${base}/oauth/callback`,
      );
      expect((await app.request(authorizationUrl)).status).toBe(404); // single use
      const cookie = launch.headers.get("set-cookie")!.split(";")[0]!;
      expect(
        (
          await app.request(`${base}/oauth/callback?state=${attempt}&code=once`, {
            headers: { cookie },
          })
        ).status,
      ).toBe(303);
      expect((await tools.call("wait_for_connection", { state: attempt })).text).toBe(
        "Connected alex@example.com. Call finish now.",
      );
      expect(
        (
          await tools.call("finish", {
            summary: "Created project Passport and connected alex@example.com.",
            success: true,
          })
        ).text,
      ).toBe("Done. Stop now.");
    });
    const started = await json("/api/setup/tasks", { provider: "gmail", calendar: true });
    expect(started.status).toBe(201);
    const { id } = (await started.json()) as { id: string };
    const waiting = await until(
      () => task(id),
      (t) => t.status === "waiting_for_user",
    );
    expect(waiting.prompt).toMatchObject({
      kind: "sign_in",
      message: "Sign in to Google in the browser window I opened, then click Continue.",
    });
    expect(waiting.steps.find((step) => step.id === "sign_in")?.status).toBe("running");
    expect(
      (await json(`/api/setup/tasks/${id}/respond`, { promptId: "stale", answer: "done" })).status,
    ).toBe(409);
    expect(
      (
        await json(`/api/setup/tasks/${id}/respond`, {
          promptId: waiting.prompt!.id,
          answer: "done",
        })
      ).status,
    ).toBe(200);
    const question = await until(
      () => task(id),
      (t) => t.prompt?.kind === "question",
    );
    await json(`/api/setup/tasks/${id}/respond`, {
      promptId: question.prompt!.id,
      answer: " alex@example.com ",
    });
    const done = await until(
      () => task(id),
      (t) => t.status === "completed",
    );

    const accounts = await backend.store.accounts.list();
    expect(done.result?.accountIds.sort()).toEqual(accounts.map((account) => account.id).sort());
    expect(accounts.map((account) => account.kind).sort()).toEqual(["gmail", "google-calendar"]);
    expect(
      (await backend.store.accounts.getCredentials(done.result!.accountIds[0]!))?.clientSecret,
    ).toBe(SECRET);
    expect(done.steps.every((step) => step.status === "done")).toBe(true);
    expect(done.steps.find((step) => step.id === "project")?.detail).toBe(
      "Already set up: Project Passport exists",
    );
    expect(done.log.map((line) => line.text)).toEqual(
      expect.arrayContaining([
        "Using Codex (gpt-6.1-sol, high reasoning).",
        "Agent: Found the client secret [redacted] on the page",
        "Browser: opened https://console.cloud.google.com/apis",
        "Browser: opened http://127.0.0.1:3000/oauth/setup/…",
        "Connected alex@example.com; the first sync is running.",
      ]),
    );
    // Secrets never reach the task, the event stream, or the agent's instructions.
    const published = JSON.stringify([
      done,
      events,
      sessions.requests[0]!.prompt,
      sessions.requests[0]!.systemPrompt,
    ]);
    expect(published).not.toContain(SECRET);
    expect(published).not.toContain(authorizationUrl.split("/").at(-1));
    expect(published).not.toContain("access-secret");
    expect(events.filter((event) => event.type === "setup.task.updated").at(-1)).toEqual({
      type: "setup.task.updated",
      task: done,
    });
    // The session got the setup and browser servers, the pinned model, and a restricted browser tool list.
    const request = sessions.requests[0]!;
    expect(request).toMatchObject({
      kind: "codex",
      model: SETUP_AGENT_MODELS.codex.model,
      reasoning: "high",
      cwd: join(dataDir, "setup-agent"),
    });
    expect(Object.keys(request.mcpServers!)).toEqual(["passport", "browser"]);
    expect(request.allowedTools).toContain("mcp__browser__browser_navigate");
    expect(request.allowedTools).not.toContain("mcp__browser__browser_run_code_unsafe");
    expect(request.allowedTools).not.toContain("mcp__browser__browser_evaluate");
    expect(JSON.stringify(request.mcpServers!.passport)).toContain('"toolSec":720');
    expect(browser.server).toHaveBeenCalledWith(
      expect.objectContaining({
        browser: "chrome",
        profileDir: join(dataDir, "setup-browser-profile"),
      }),
    );
    expect(browser.close).toHaveBeenCalledWith(join(dataDir, "setup-browser-profile"));
    // The bearer token died with the task.
    const { url, headers } = request.mcpServers!.passport as {
      url: string;
      headers: Record<string, string>;
    };
    expect(await rejected(url, headers.Authorization!)).toBe(true);
  });

  it("binds the MCP bearer token to the running task and rejects other callers", async () => {
    sessions.script(async (tools) => {
      await tools.call("ask_user", { kind: "confirm", message: "Approve in the browser." });
    });
    const { id } = (await (
      await json("/api/setup/tasks", { provider: "microsoft", calendar: false })
    ).json()) as { id: string };
    await until(
      () => task(id),
      (t) => t.status === "waiting_for_user",
    );
    const { url, headers } = sessions.requests[0]!.mcpServers!.passport as {
      url: string;
      headers: Record<string, string>;
    };
    expect(new URL(url).hostname).toBe("127.0.0.1");
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "x", version: "1" },
      },
    };
    const post = (extra: Record<string, string>) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...extra,
        },
        body: JSON.stringify(initialize),
      });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer not-the-token" })).status).toBe(401);
    expect(
      (await post({ authorization: headers.Authorization!, origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect((await post({ authorization: headers.Authorization! })).status).toBe(200);
    // The token never travels in argv-visible request fields.
    expect(JSON.stringify(sessions.requests[0]!.mcpServers!.browser)).not.toContain(
      headers.Authorization!.slice(7),
    );
    await json(`/api/setup/tasks/${id}/cancel`, {});
    expect(await rejected(url, headers.Authorization!)).toBe(true);
  });

  it("cancels: stops the session and browser, ends pending tool calls, refuses late answers", async () => {
    let pending: Promise<{ text: string; isError: boolean }> | undefined;
    sessions.script(async (tools) => {
      await tools.call("report_progress", { step: "sign_in", status: "running" });
      pending = tools.call("ask_user", {
        kind: "sign_in",
        message: "Sign in, then click Continue.",
      });
      await pending;
      await new Promise((_, reject) =>
        tools.signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    });
    const { id } = (await (await json("/api/setup/tasks", { provider: "gmail" })).json()) as {
      id: string;
    };
    const waiting = await until(
      () => task(id),
      (t) => t.status === "waiting_for_user",
    );
    expect((await json("/api/setup/tasks", { provider: "gmail" })).status).toBe(409);
    const cancelled = (await (await json(`/api/setup/tasks/${id}/cancel`, {})).json()) as SetupTask;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.prompt).toBeUndefined();
    expect(cancelled.steps.map((step) => step.status)).toEqual([
      "done",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(sessions.cancels).toHaveBeenCalled();
    expect(
      (
        await json(`/api/setup/tasks/${id}/respond`, {
          promptId: waiting.prompt!.id,
          answer: "done",
        })
      ).status,
    ).toBe(409);
    await until(
      () => browser.close.mock.calls.length,
      (calls) => calls >= 2,
    );
    expect(task(id).status).toBe("cancelled");
    expect((await json("/api/setup/tasks")).status).toBe(200);
    // A new task can start once the previous one ended and cleaned up.
    await setupTasks(backend).idle();
    sessions.script(async () => {});
    expect((await json("/api/setup/tasks", { provider: "gmail" })).status).toBe(201);
  });

  it("keeps a prompt across bounded waits and rejects unknown steps and states", async () => {
    const runner = setupTasks(backend);
    Object.assign(runner, { waitMs: 30 });
    const ids: string[] = [];
    sessions.script(async (tools) => {
      expect(
        (await tools.call("ask_user", { kind: "confirm", message: "Approve access." })).text,
      ).toContain("has not answered yet");
      ids.push(runner.list()[0]!.prompt!.id);
      expect(
        (await tools.call("ask_user", { kind: "confirm", message: "Approve access." })).text,
      ).toContain("has not answered yet");
      ids.push(runner.list()[0]!.prompt!.id);
      const bad = await tools.call("report_progress", { step: "launch_rockets", status: "done" });
      expect(bad.isError).toBe(true);
      const unknown = await tools.call("wait_for_connection", { state: "made-up" });
      expect(unknown).toEqual({
        isError: true,
        text: "Use the state that register_oauth_client returned",
      });
      const wrong = await tools.call("register_oauth_client", {
        provider: "microsoft",
        clientId: "00000000-0000-0000-0000-000000000000",
      });
      expect(wrong.text).toBe("This task sets up gmail");
    });
    const { id } = (await (await json("/api/setup/tasks", { provider: "gmail" })).json()) as {
      id: string;
    };
    const failed = await until(
      () => task(id),
      (t) => t.status === "failed",
    );
    expect(ids[0]).toBe(ids[1]);
    expect(failed.error).toBe("The agent stopped before the mailbox was connected.");
  });

  it("chooses Codex, then Claude Code; fails clearly without a ready agent or browser", async () => {
    agents = [status("codex", false), status("claude-code", true)];
    // Each task holds the slot until its cleanup ends.
    const idle = () => setupTasks(backend).idle();
    const first = (await (await json("/api/setup/tasks", { provider: "gmail" })).json()) as {
      id: string;
    };
    await until(
      () => task(first.id),
      (t) => t.status === "failed",
    );
    await idle();
    expect(sessions.requests[0]).toMatchObject({
      kind: "claude-code",
      model: SETUP_AGENT_MODELS["claude-code"].model,
    });

    const explicit = (await (
      await json("/api/setup/tasks", { provider: "gmail", agent: "codex" })
    ).json()) as { id: string };
    expect(
      (
        await until(
          () => task(explicit.id),
          (t) => t.status === "failed",
        )
      ).error,
    ).toBe("Codex is not ready. Install codex.");
    await idle();

    agents = [status("codex", false), status("claude-code", false)];
    const none = (await (await json("/api/setup/tasks", { provider: "microsoft" })).json()) as {
      id: string;
    };
    const failed = await until(
      () => task(none.id),
      (t) => t.status === "failed",
    );
    expect(failed.error).toContain("No signed-in agent found");
    expect(failed.steps[0]).toMatchObject({ id: "prepare", status: "failed" });
    await idle();

    agents = [status("codex", true)];
    browser.detect.mockReturnValueOnce(null as never);
    const noBrowser = (await (await json("/api/setup/tasks", { provider: "gmail" })).json()) as {
      id: string;
    };
    expect(
      (
        await until(
          () => task(noBrowser.id),
          (t) => t.status === "failed",
        )
      ).error,
    ).toContain("install-browser chrome-for-testing");
    expect(sessions.requests).toHaveLength(1);
    expect((await json("/api/setup/tasks")).status).toBe(200);
    expect(
      ((await (await json("/api/setup/tasks")).json()) as SetupTask[]).map((t) => t.id),
    ).toEqual([noBrowser.id, none.id, explicit.id, first.id]);
  });

  it("validates input and requires API authentication", async () => {
    expect((await json("/api/setup/tasks", { provider: "imap" })).status).toBe(400);
    expect((await json("/api/setup/tasks", { provider: "gmail", calendar: "yes" })).status).toBe(
      400,
    );
    expect((await json("/api/setup/tasks", { provider: "gmail", agent: "gpt" })).status).toBe(400);
    expect((await json("/api/setup/tasks/nope")).status).toBe(404);
    expect(
      (
        await json(
          "/api/setup/tasks",
          { provider: "gmail" },
          { headers: { authorization: "Bearer wrong" } },
        )
      ).status,
    ).toBe(401);
    expect(
      (await json("/api/setup/tasks", undefined, { headers: { authorization: "Bearer wrong" } }))
        .status,
    ).toBe(401);
    expect((await app.request(`${base}/oauth/setup/unknown-ticket`)).status).toBe(404);
  });

  it("refuses to run in the demo workspace", async () => {
    const demo = await createDemoBackend(defaultConfig(dataDir));
    try {
      const response = await createApp(demo).request(`${base}/api/setup/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "gmail" }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("DEMO_ONLY");
    } finally {
      await demo.close();
    }
  });
});

async function rejected(url: string, authorization: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{}",
    });
    return response.status === 401;
  } catch {
    return true;
  }
}

describe("setup task state", () => {
  const steps = setupSteps("gmail", true);
  const make = () => {
    const published: SetupTask[] = [];
    return {
      state: new SetupTaskState("t1", "gmail", steps, (task) => published.push(task)),
      published,
    };
  };

  it("publishes snapshots, reuses an identical prompt and rejects stale answers", () => {
    const { state, published } = make();
    const prompt = state.ask("sign_in", "Sign in");
    expect(state.status).toBe("waiting_for_user");
    expect(state.ask("sign_in", "Sign in").id).toBe(prompt.id);
    expect(published).toHaveLength(1);
    const next = state.ask("question", "Which address?");
    expect(next.id).not.toBe(prompt.id);
    expect(() => state.answer(prompt.id)).toThrow(
      expect.objectContaining({ code: "PROMPT_STALE" }),
    );
    state.answer(next.id);
    expect(state.snapshot()).toMatchObject({ status: "running" });
    expect(state.snapshot().prompt).toBeUndefined();
    published[0]!.status = "failed";
    expect(state.status).toBe("running");
  });

  it("scrubs registered secrets and token-shaped text from logs, steps and errors", () => {
    const { state } = make();
    state.addSecret("hunter2-secret");
    state.log("info", "Typed hunter2-secret and Bearer abcdefghijklmnopqrstuvwxyz");
    state.step("client", "running", "secret is hunter2-secret");
    expect(state.snapshot().log[0]!.text).toBe("Typed [redacted] and [redacted]");
    expect(state.snapshot().steps.find((step) => step.id === "client")!.detail).toBe(
      "secret is [redacted]",
    );
    state.log(
      "info",
      "Client secret: abcdef123456, secret=xyz-987654 and 8Q~abcdefghijklmnopqrstuvwxyz, GOCSPX-abc_DEF",
    );
    expect(state.snapshot().log[1]!.text).toBe(
      "Client secret: [redacted], secret=[redacted] and [redacted], [redacted]",
    );
    expect(() => state.step("nope", "done")).toThrow(
      expect.objectContaining({ code: "UNKNOWN_STEP" }),
    );
    state.fail("Failed with hunter2-secret");
    expect(state.snapshot()).toMatchObject({ status: "failed", error: "Failed with [redacted]" });
    expect(state.snapshot().steps.find((step) => step.id === "client")!.status).toBe("failed");
  });

  it("ignores changes after it ends and bounds the log", () => {
    const { state, published } = make();
    for (let index = 0; index < 400; index++) {
      state.log("info", `line ${index}`);
    }
    expect(state.snapshot().log).toHaveLength(300);
    expect(state.snapshot().log[0]!.text).toBe("line 100");
    state.cancel();
    const count = published.length;
    state.log("info", "late");
    state.complete();
    state.connect(["a"]);
    expect(published).toHaveLength(count);
    expect(state.status).toBe("cancelled");
    expect(() => state.answer("x")).toThrow(expect.objectContaining({ code: "TASK_FINISHED" }));
  });
});

describe("setup browser and prompt", () => {
  it("prefers Chrome, then Edge, then Playwright's Chromium", () => {
    const options = (paths: string[], cache: string[] = []) => ({
      platform: "darwin" as const,
      env: { HOME: "/Users/u" },
      exists: (path: string) => paths.includes(path),
      list: () => cache,
    });
    expect(
      detectSetupBrowser(
        options([
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]),
      ),
    ).toBe("chrome");
    expect(
      detectSetupBrowser(
        options(["/Users/u/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]),
      ),
    ).toBe("msedge");
    expect(detectSetupBrowser(options([], ["ffmpeg-1011", "chromium-1247"]))).toBe("chromium");
    expect(detectSetupBrowser(options([], ["ffmpeg-1011"]))).toBeNull();
    expect(
      detectSetupBrowser({
        platform: "linux",
        env: { HOME: "/home/u" },
        exists: (path) => path === "/opt/google/chrome/chrome",
        list: () => [],
      }),
    ).toBe("chrome");
  });

  it("launches the pinned Playwright MCP headed on the persistent profile", () => {
    const server = browserMcpServer({
      browser: "msedge",
      profileDir: "/data/setup-browser-profile",
      outputDir: "/data/out",
    });
    expect("command" in server && server.args).toEqual(
      expect.arrayContaining([
        "-y",
        PLAYWRIGHT_MCP_PACKAGE,
        "--browser",
        "msedge",
        "--user-data-dir",
        "/data/setup-browser-profile",
        "--output-dir",
        "/data/out",
      ]),
    );
    expect(JSON.stringify(server)).not.toMatch(/headless|isolated/);
    expect(server.timeouts?.startupSec).toBeGreaterThanOrEqual(120);
  });

  it("describes browser actions without typed text or setup links", () => {
    expect(
      describeBrowserCall("mcp__browser__browser_type", {
        element: "Project name",
        text: "secret",
      }),
    ).toBe("Browser: filled in Project name");
    expect(
      describeBrowserCall("mcp__browser__browser_navigate", {
        url: "http://127.0.0.1:3000/oauth/setup/abc?x=1",
      }),
    ).toBe("Browser: opened http://127.0.0.1:3000/oauth/setup/…");
    expect(describeBrowserCall("mcp__browser__browser_snapshot", {})).toBeUndefined();
    expect(describeBrowserCall("mcp__passport__ask_user", {})).toBeUndefined();
  });

  it("tells the agent the redirect URI, scopes and permissions it must configure", () => {
    const gmail = setupPrompt({
      provider: "gmail",
      calendar: true,
      redirectUri: "http://127.0.0.1:3100/oauth/callback",
    });
    expect(gmail.systemPrompt).toContain("https://www.googleapis.com/auth/gmail.modify");
    expect(gmail.systemPrompt).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(gmail.systemPrompt).toContain("Desktop app");
    const outlook = setupPrompt({
      provider: "microsoft",
      calendar: false,
      redirectUri: "http://127.0.0.1:3100/oauth/callback",
    });
    expect(outlook.systemPrompt).toContain("http://127.0.0.1:3100/oauth/callback");
    expect(outlook.systemPrompt).toContain("offline_access, User.Read, Mail.ReadWrite, Mail.Send");
    expect(outlook.systemPrompt).not.toContain("Calendars.ReadWrite");
    expect(setupSteps("microsoft", true).map((step) => step.id)).toEqual([
      "prepare",
      "sign_in",
      "register",
      "redirect",
      "permissions",
      "authorize",
    ]);
  });
});
