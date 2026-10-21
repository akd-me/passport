import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  ProviderRegistry,
} from "@passport/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../auth.test-client.js";
import { createRealBackend, type RealBackend } from "../compose.js";
import { defaultConfig } from "../config.js";
import { prepareBrowserMcp } from "./browser.js";
import { setupSteps } from "./prompt.js";
import { setupTasks } from "./routes.js";
import type { RunSession, SetupTaskRunner } from "./runner.js";
import { SetupTaskState } from "./task.js";

const CLIENT_ID = "1234567890-abcdef.apps.googleusercontent.com";
const base = "http://127.0.0.1:3000";

/** A session the test drives itself: tool calls come from the test body, not a script. */
interface Session {
  request: HostAgentSessionRequest;
  emit(event: HostAgentEvent): void;
  end(): void;
  cancels: number;
  /** When set, cancel() does not end the session (a CLI still shutting down). */
  holdCancel: boolean;
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

function manualSessions() {
  const list: Session[] = [];
  const clients: Client[] = [];
  const run: RunSession = (request, onEvent) => {
    let resolve!: (result: HostAgentSessionResult) => void;
    const done = new Promise<HostAgentSessionResult>((r) => {
      resolve = r;
    });
    const server = request.mcpServers!.passport as { url: string; headers: Record<string, string> };
    let client: Promise<Client> | undefined;
    const session: Session = {
      request,
      emit: onEvent,
      end: () => resolve({ kind: request.kind, ok: false, text: "" }),
      cancels: 0,
      holdCancel: false,
      call: async (name, args = {}) => {
        client ??= (async () => {
          const next = new Client({ name: "test-agent", version: "1" });
          await next.connect(
            new StreamableHTTPClientTransport(new URL(server.url), {
              requestInit: { headers: server.headers },
            }),
          );
          clients.push(next);
          return next;
        })();
        const result = await (await client).callTool({ name, arguments: args }, undefined, {
          timeout: 30_000,
        });
        const content = result.content as Array<{ text?: string }>;
        return {
          text: content.map((item) => item.text ?? "").join("\n"),
          isError: result.isError === true,
        };
      },
    };
    list.push(session);
    return {
      done,
      cancel: () => {
        session.cancels++;
        if (!session.holdCancel) {
          session.end();
        }
      },
    };
  };
  return {
    run,
    list,
    close: () => Promise.all(clients.map((client) => client.close().catch(() => undefined))),
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

describe("setup task hardening", () => {
  let backend: RealBackend, dataDir: string, events: DomainEvent[];
  let sessions: ReturnType<typeof manualSessions>;
  let runner: SetupTaskRunner;
  let app: ReturnType<typeof createApp>;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  const browser = {
    detect: vi.fn(() => "chrome" as const),
    prepare: vi.fn(async () => {}),
    server: vi.fn(() => ({ command: "browser-stub" })),
    close: vi.fn(async () => {}),
  };
  const realFetch = globalThis.fetch;
  const json = (path: string, body?: unknown) =>
    app.request(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const start = async () => {
    const response = await json("/api/setup/tasks", { provider: "gmail", calendar: false });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const index = sessions.list.length;
    await until(
      () => sessions.list.length,
      (count) => count > index,
    );
    return { id, session: sessions.list[index]! };
  };
  const promptOf = async (id: string) =>
    (await until(
      () => runner.get(id).prompt,
      (prompt) => !!prompt,
    ))!;
  const respond = (id: string, promptId: string, answer: string) =>
    json(`/api/setup/tasks/${id}/respond`, { promptId, answer });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "passport-setup-hardening-"));
    fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/token")
        ? Response.json({
            access_token: "access-secret",
            refresh_token: "refresh-secret",
            expires_in: 3600,
            scope: "openid email https://www.googleapis.com/auth/gmail.modify",
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
    sessions = manualSessions();
    for (const mock of Object.values(browser)) {
      mock.mockClear();
    }
    runner = setupTasks(backend, {
      detectAgents: async () => [
        {
          kind: "codex",
          label: "Codex",
          installed: true,
          binaryPath: "/bin/codex",
          version: "1",
          loggedIn: true,
          account: null,
          ready: true,
          checkedAt: new Date().toISOString(),
        },
      ],
      runSession: sessions.run,
      browser,
      pollMs: 5,
      finishGraceMs: 60_000,
    });
    app = createApp(backend);
  });
  afterEach(async () => {
    for (const session of sessions.list) {
      session.holdCancel = false;
      session.end();
    }
    await backend.close();
    await sessions.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("V2-1: a rejected confirmation reaches the agent as declined; answers are validated per kind", async () => {
    const { id, session } = await start();
    const confirm = session.call("ask_user", { kind: "confirm", message: "Accept the terms?" });
    const asked = await promptOf(id);
    expect((await respond(id, asked.id, "maybe")).status).toBe(400);
    expect((await respond(id, asked.id, "no")).status).toBe(200);
    const declined = await confirm;
    expect(declined.isError).toBe(false);
    expect(declined.text).toContain('{"answer":"declined"}');
    expect(declined.text).toContain("The user said no");
    expect(declined.text).not.toContain("clicked Continue");
    expect(runner.get(id).log.at(-1)?.text).toBe("You declined.");

    const accepted = session.call("ask_user", { kind: "confirm", message: "Approve access?" });
    expect((await respond(id, (await promptOf(id)).id, "yes")).status).toBe(200);
    expect((await accepted).text).toContain("The user clicked Continue");

    const signIn = session.call("ask_user", {
      kind: "sign_in",
      message: "Sign in, then continue.",
    });
    const shown = await promptOf(id);
    for (const wrong of ["yes", "no", ""]) {
      expect((await respond(id, shown.id, wrong)).status).toBe(400);
    }
    expect(runner.get(id).prompt?.id).toBe(shown.id);
    expect((await respond(id, shown.id, "done")).status).toBe(200);
    expect((await signIn).text).toContain("The user clicked Continue");
  });

  it("V2-10: a blank answer is rejected without clearing the prompt, and a corrected answer reaches the agent", async () => {
    const { id, session } = await start();
    const question = session.call("ask_user", { kind: "question", message: "Which project?" });
    const asked = await promptOf(id);
    const blank = await respond(id, asked.id, "   ");
    expect(blank.status).toBe(400);
    expect(runner.get(id)).toMatchObject({ status: "waiting_for_user", prompt: { id: asked.id } });
    expect((await respond(id, asked.id, " passport-123 ")).status).toBe(200);
    expect((await question).text).toBe("The user answered: passport-123");
    expect(runner.get(id).prompt).toBeUndefined();
  });

  it("V2-11: a second, different ask_user waits its turn; identical retries share the prompt", async () => {
    const { id, session } = await start();
    const first = session.call("ask_user", { kind: "question", message: "First question?" });
    const asked = await promptOf(id);
    const second = await session.call("ask_user", {
      kind: "question",
      message: "Second question?",
    });
    expect(second.isError).toBe(true);
    expect(second.text).toContain("Wait for that ask_user call to return");
    expect(runner.get(id).prompt).toEqual(asked);
    const retry = session.call("ask_user", { kind: "question", message: "First question?" });
    await until(
      () => (runner as unknown as { runs: Map<string, { asking: Map<string, number> }> }).runs,
      (runs) => runs.get(id)?.asking.get(asked.id) === 2,
    );
    expect((await respond(id, asked.id, "one")).status).toBe(200);
    expect((await first).text).toBe("The user answered: one");
    expect((await retry).text).toBe("The user answered: one");
    // With nothing outstanding, the next question shows.
    const next = session.call("ask_user", { kind: "question", message: "Second question?" });
    const shown = await promptOf(id);
    expect(shown.message).toBe("Second question?");
    expect((await respond(id, shown.id, "two")).status).toBe(200);
    expect((await next).text).toBe("The user answered: two");
  });

  /** Register a client and open the setup link as the agent's browser would. */
  const consentLink = async (session: Session) => {
    const registered = await session.call("register_oauth_client", {
      provider: "gmail",
      clientId: CLIENT_ID,
      clientSecret: "GOCSPX-hardening-secret",
    });
    const { authorizationUrl, state } = JSON.parse(registered.text) as {
      authorizationUrl: string;
      state: string;
    };
    const launch = await app.request(authorizationUrl);
    expect(launch.status).toBe(302);
    const cookie = launch.headers.get("set-cookie")!.split(";")[0]!;
    return {
      state,
      callback: () =>
        app.request(`${base}/oauth/callback?state=${encodeURIComponent(state)}&code=once`, {
          headers: { cookie },
        }),
    };
  };

  it("V2-2: cancelling a task revokes its OAuth attempt; a later consent connects nothing", async () => {
    const { id, session } = await start();
    const consent = await consentLink(session);
    expect((await json(`/api/setup/tasks/${id}/cancel`, {})).status).toBe(200);
    const landed = await consent.callback();
    expect(landed.status).toBe(409);
    expect(await landed.text()).toContain("setup task has ended");
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/token"))).toBe(false);
    expect(await backend.store.accounts.list()).toEqual([]);
  });

  it("V2-2: a consent callback already exchanging the code when the task is cancelled persists nothing", async () => {
    const { id, session } = await start();
    const consent = await consentLink(session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tokens = fetcher.getMockImplementation()!;
    fetcher.mockImplementationOnce(async (url, init) => {
      await gate;
      return tokens(url, init);
    });
    const landing = consent.callback();
    await until(
      () => fetcher.mock.calls.length,
      (calls) => calls > 0,
    );
    expect((await json(`/api/setup/tasks/${id}/cancel`, {})).status).toBe(200);
    release();
    const landed = await landing;
    expect(landed.status).toBe(409);
    expect(await landed.text()).toContain("setup task has ended");
    expect(await backend.store.accounts.list()).toEqual([]);
    // The manual Accounts flow still connects with no task involved.
    const manual = await json("/api/accounts/oauth/start", { kind: "gmail", clientId: CLIENT_ID });
    const { attemptId } = (await manual.json()) as { attemptId: string };
    const connected = await app.request(`${base}/oauth/callback?state=${attemptId}&code=manual`, {
      headers: { cookie: manual.headers.get("set-cookie")!.split(";")[0]! },
    });
    expect(connected.status).toBe(303);
    expect((await backend.store.accounts.list()).map((account) => account.kind)).toEqual(["gmail"]);
  });

  it("V2-5: agent text cannot leak a client secret into the log before it is registered", async () => {
    const credential = "lQmMfkrd1JP5emxSR0pGK79Q";
    const { id, session } = await start();
    session.emit({ type: "text", text: `The OAuth credentials: ${credential}` });
    await until(
      () => runner.get(id).log.at(-1)?.text,
      (text) => !!text?.startsWith("Agent:"),
    );
    await session.call("register_oauth_client", {
      provider: "gmail",
      clientId: CLIENT_ID,
      clientSecret: credential,
    });
    expect(runner.get(id).log.map((line) => line.text)).toContain(
      "Agent: The OAuth credentials: [redacted]",
    );
    expect(JSON.stringify([runner.get(id), events])).not.toContain(credential);
  });

  it("V2-6: a cancelled task holds the slot until its session and cleanup end", async () => {
    const first = await start();
    first.session.holdCancel = true;
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect((await json(`/api/setup/tasks/${first.id}/cancel`, {})).status).toBe(200);
    expect(first.session.cancels).toBe(1);
    const busy = await json("/api/setup/tasks", { provider: "gmail" });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: { code: string; message: string } }).error).toEqual({
      code: "SETUP_BUSY",
      message: expect.stringContaining("finishing up"),
    });
    first.session.end();
    await runner.idle();
    expect(browser.close).toHaveBeenCalledTimes(2);
    const second = await start();
    expect(runner.get(second.id).status).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Only the new task's own start-up close ran; the old cleanup is long done.
    expect(browser.close).toHaveBeenCalledTimes(3);
    expect(runner.get(second.id).status).toBe("running");
  });

  it("V2-6: shutdown stops and awaits a finished task whose session is still running", async () => {
    const { id, session } = await start();
    expect(
      (await session.call("finish", { summary: "Could not continue", success: false })).text,
    ).toBe("Done. Stop now.");
    expect(runner.get(id).status).toBe("failed");
    expect(session.cancels).toBe(0);
    await runner.close();
    expect(session.cancels).toBe(1);
    expect(browser.close).toHaveBeenCalledTimes(2);
  });
});

describe("setup task state redaction", () => {
  it("V2-5: registering a secret rescrubs the retained log, steps, prompt and error", () => {
    const published: string[] = [];
    const state = new SetupTaskState("t1", "gmail", setupSteps("gmail", false), (task) =>
      published.push(JSON.stringify(task)),
    );
    const secret = "pa55-word";
    state.log("info", `Typed ${secret} into the form`);
    state.step("client", "running", `Read ${secret}`);
    state.ask("question", `Is ${secret} right?`);
    expect(JSON.stringify(state.snapshot())).toContain(secret);
    const frames = published.length;
    state.addSecret(secret);
    const snapshot = state.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(snapshot.log[0]!.text).toBe("Typed [redacted] into the form");
    expect(snapshot.steps.find((step) => step.id === "client")!.detail).toBe("Read [redacted]");
    expect(snapshot.prompt!.message).toBe("Is [redacted] right?");
    // The corrected snapshot is published; earlier frames cannot be retracted.
    expect(published).toHaveLength(frames + 1);
    expect(published.at(-1)).not.toContain(secret);
    expect(state.showing("question", `Is ${secret} right?`)).toBe(true);
    state.fail(`Stopped at ${secret}`);
    expect(state.snapshot().error).toBe("Stopped at [redacted]");
  });
});

describe.skipIf(process.platform === "win32")("browser helper preparation", () => {
  it("V2-4: npx gets an allowlisted environment without PASSPORT_* or provider API keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "passport-npx-env-"));
    const bin = join(dir, "bin");
    const capture = join(dir, "env.json");
    await mkdir(bin);
    await writeFile(
      join(bin, "npx"),
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.env));\n`,
    );
    await chmod(join(bin, "npx"), 0o700);
    const execPath = process.execPath;
    vi.stubEnv("PASSPORT_API_TOKEN", "synthetic-passport-token");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-openai-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-key");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
    vi.stubEnv("npm_config_cache", join(dir, "npm-cache"));
    try {
      process.execPath = join(bin, "node");
      await prepareBrowserMcp();
    } finally {
      process.execPath = execPath;
      vi.unstubAllEnvs();
    }
    try {
      const env = JSON.parse(await readFile(capture, "utf8")) as Record<string, string>;
      expect(Object.keys(env).filter((key) => /^PASSPORT_|_API_KEY$/.test(key))).toEqual([]);
      expect(env).toMatchObject({
        HTTPS_PROXY: "http://proxy.example:8080",
        npm_config_cache: join(dir, "npm-cache"),
        HOME: process.env.HOME,
      });
      expect(env.PATH!.split(":")[0]).toBe(bin);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
