import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { detectHostAgents, runHostAgentSession } from "@passport/agent";
import { newId } from "@passport/store";
import type {
  Account,
  EventBus,
  HostAgentEvent,
  HostAgentKind,
  HostAgentMcpServer,
  HostAgentReasoning,
  HostAgentSessionRequest,
  HostAgentSessionResult,
  HostAgentStatus,
  SetupPromptKind,
  SetupProvider,
  SetupTask,
} from "@passport/types";
import { ApiError } from "../errors.js";
import { logger } from "../logger.js";
import {
  type BrowserMcpOptions,
  browserMcpServer,
  closeSetupBrowser,
  detectSetupBrowser,
  NO_BROWSER_MESSAGE,
  prepareBrowserMcp,
  type SetupBrowser,
} from "./browser.js";
import { SetupMcpListener, SetupTaskEnded, type SetupToolHost } from "./mcp.js";
import { setupPrompt, setupSteps } from "./prompt.js";
import { SetupTaskState } from "./task.js";

/** The model each host agent runs setup with: browser work across long pages needs the strongest. */
export const SETUP_AGENT_MODELS: Record<
  HostAgentKind,
  { model: string; reasoning: HostAgentReasoning }
> = {
  codex: { model: "gpt-6.1-sol", reasoning: "high" },
  "claude-code": { model: "claude-opus-5-5", reasoning: "high" },
};

/**
 * Browser tools the agent may use. Excluded: arbitrary code (`browser_run_code_unsafe`,
 * `browser_evaluate`), file access (`browser_file_upload`, `browser_drop`) and network
 * inspection, which could expose cookies or tokens of the signed-in console.
 */
export const SETUP_BROWSER_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_wait_for",
  "browser_tabs",
  "browser_handle_dialog",
  "browser_find",
  "browser_resize",
];

const AGENT_LABELS: Record<HostAgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
};
const MAX_TASKS = 20;

export interface SetupOAuth {
  start(
    input: Record<string, unknown>,
    origin: string,
  ): Promise<{ authUrl: string; attemptId: string; nonce: string; redirectUri: string }>;
  peek(state: string): { status: string; accountId?: string; error?: string } | undefined;
}

export interface SetupBrowserControl {
  detect(): SetupBrowser | null;
  prepare(signal: AbortSignal): Promise<void>;
  server(options: BrowserMcpOptions): HostAgentMcpServer;
  close(profileDir: string): Promise<void>;
}

export type RunSession = (
  request: HostAgentSessionRequest,
  onEvent: (event: HostAgentEvent) => void,
) => { done: Promise<HostAgentSessionResult>; cancel(): void };

export interface SetupRunnerOptions {
  mode: "demo" | "real";
  dataDir: string;
  bus: Pick<EventBus, "emit">;
  oauth: SetupOAuth;
  listAccounts(): Promise<Account[]>;
  detectAgents?: () => Promise<HostAgentStatus[]>;
  runSession?: RunSession;
  browser?: Partial<SetupBrowserControl>;
  /** Longest a single ask_user / wait_for_connection call blocks (default 10 minutes). */
  waitMs?: number;
  pollMs?: number;
  sessionTimeoutMs?: number;
  /** How long an agent may keep running after finish before it is stopped. */
  finishGraceMs?: number;
  models?: Partial<typeof SETUP_AGENT_MODELS>;
}

export interface StartSetupInput {
  provider: SetupProvider;
  calendar: boolean;
  agent?: HostAgentKind;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve,
  };
}

interface Run {
  state: SetupTaskState;
  input: StartSetupInput;
  origin: string;
  controller: AbortController;
  answers: Map<string, Deferred<string>>;
  attempts: Set<string>;
  session?: { cancel(): void };
}

interface Ticket {
  run: Run;
  state: string;
  nonce: string;
  authUrl: string;
  expiresAt: number;
}

/** Validated `POST /api/setup/tasks` body. */
export function parseSetupInput(body: Record<string, unknown>): StartSetupInput {
  if (body.provider !== "gmail" && body.provider !== "microsoft") {
    throw new ApiError("INVALID_PROVIDER", "Choose gmail or microsoft");
  }
  if (body.calendar !== undefined && typeof body.calendar !== "boolean") {
    throw new ApiError("INVALID_FIELD", "calendar must be true or false");
  }
  if (body.agent !== undefined && body.agent !== "codex" && body.agent !== "claude-code") {
    throw new ApiError("INVALID_FIELD", "agent must be codex or claude-code");
  }
  return {
    provider: body.provider,
    calendar: body.calendar !== false,
    ...(body.agent ? { agent: body.agent } : {}),
  };
}

/** True for an `http://` loopback origin with a port; OAuth redirects must land on this computer. */
function loopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}

/**
 * Runs agent-driven account setup: a host-agent session with a visible browser and the
 * Passport setup tools. One task runs at a time; the last {@link MAX_TASKS} stay in memory.
 */
export class SetupTaskRunner {
  private readonly runs = new Map<string, Run>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly listener = new SetupMcpListener();
  private readonly browser: SetupBrowserControl;
  private readonly waitMs: number;
  private readonly pollMs: number;

  constructor(private readonly options: SetupRunnerOptions) {
    this.browser = {
      detect: () => detectSetupBrowser(),
      prepare: (signal) => prepareBrowserMcp({ signal }),
      server: browserMcpServer,
      close: closeSetupBrowser,
      ...options.browser,
    };
    this.waitMs = options.waitMs ?? 10 * 60_000;
    this.pollMs = options.pollMs ?? 500;
  }

  get profileDir(): string {
    return join(this.options.dataDir, "setup-browser-profile");
  }
  private get workDir(): string {
    return join(this.options.dataDir, "setup-agent");
  }

  list(): SetupTask[] {
    return [...this.runs.values()].reverse().map((run) => run.state.snapshot());
  }

  get(id: string): SetupTask {
    const run = this.runs.get(id);
    if (!run) {
      throw new ApiError("NOT_FOUND", "Setup task not found", 404);
    }
    return run.state.snapshot();
  }

  start(input: StartSetupInput, origin: string): SetupTask {
    if (this.options.mode === "demo") {
      throw new ApiError("DEMO_ONLY", "Start passport serve to connect real accounts");
    }
    if (!loopbackOrigin(origin)) {
      throw new ApiError(
        "INVALID_REDIRECT",
        "Run Passport on an HTTP loopback address to connect accounts",
      );
    }
    if ([...this.runs.values()].some((run) => !run.state.terminal)) {
      throw new ApiError(
        "SETUP_BUSY",
        "A setup task is already running; finish or cancel it first",
        409,
      );
    }
    const id = newId();
    const state = new SetupTaskState(
      id,
      input.provider,
      setupSteps(input.provider, input.calendar),
      (task) => this.options.bus.emit({ type: "setup.task.updated", task }),
    );
    const run: Run = {
      state,
      input,
      origin,
      controller: new AbortController(),
      answers: new Map(),
      attempts: new Set(),
    };
    this.runs.set(id, run);
    for (const [key, old] of this.runs) {
      if (this.runs.size <= MAX_TASKS) {
        break;
      }
      if (old.state.terminal) {
        this.runs.delete(key);
      }
    }
    state.log(
      "info",
      `Setting up ${input.provider === "gmail" ? "Gmail" : "Microsoft"}${input.calendar ? " with calendar" : ""}.`,
    );
    void this.execute(run).catch(() => {
      run.state.fail("Setup stopped unexpectedly. Try again, or set up manually.");
      logger.error("Setup task failed unexpectedly");
    });
    return state.snapshot();
  }

  respond(id: string, promptId: unknown, answer: unknown): SetupTask {
    const run = this.runs.get(id);
    if (!run) {
      throw new ApiError("NOT_FOUND", "Setup task not found", 404);
    }
    if (typeof promptId !== "string") {
      throw new ApiError("INVALID_FIELD", "promptId is required");
    }
    if (typeof answer !== "string" || answer.length > 2000) {
      throw new ApiError("INVALID_FIELD", "answer must be text up to 2000 characters");
    }
    const prompt = run.state.answer(promptId);
    if (prompt.kind === "question" && !answer.trim()) {
      throw new ApiError("INVALID_FIELD", "Type an answer");
    }
    run.state.log(
      "info",
      prompt.kind === "question" ? "You answered the agent's question." : "You clicked Continue.",
    );
    const waiting = run.answers.get(promptId) ?? deferred<string>();
    run.answers.set(promptId, waiting);
    waiting.resolve(prompt.kind === "question" ? answer.trim() : "done");
    return run.state.snapshot();
  }

  cancel(id: string): SetupTask {
    const run = this.runs.get(id);
    if (!run) {
      throw new ApiError("NOT_FOUND", "Setup task not found", 404);
    }
    if (!run.state.terminal) {
      run.state.cancel();
      this.stop(run);
    }
    return run.state.snapshot();
  }

  /** Single use: the browser that opens the link receives the attempt's cookie. */
  launch(ticket: string): { state: string; nonce: string; authUrl: string } | undefined {
    const entry = this.tickets.get(ticket);
    if (!entry) {
      return;
    }
    this.tickets.delete(ticket);
    if (entry.expiresAt <= Date.now() || entry.run.state.terminal) {
      return;
    }
    return { state: entry.state, nonce: entry.nonce, authUrl: entry.authUrl };
  }

  async close(): Promise<void> {
    for (const run of this.runs.values()) {
      if (!run.state.terminal) {
        run.state.cancel();
        this.stop(run);
      }
    }
    await this.listener.close();
  }

  private stop(run: Run): void {
    run.controller.abort();
    run.session?.cancel();
    for (const [ticket, entry] of this.tickets) {
      if (entry.run === run) {
        this.tickets.delete(ticket);
      }
    }
  }

  private async execute(run: Run): Promise<void> {
    const { state, input, controller } = run;
    const signal = controller.signal;
    let release: (() => Promise<void>) | undefined;
    let browserStarted = false;
    try {
      state.step("prepare", "running", "Looking for a signed-in agent");
      const statuses = await (this.options.detectAgents ?? (() => detectHostAgents()))();
      if (signal.aborted) {
        return;
      }
      const ready = (kind: HostAgentKind) =>
        statuses.find((status) => status.kind === kind && status.ready);
      const kind =
        input.agent ??
        (ready("codex") ? "codex" : ready("claude-code") ? "claude-code" : undefined);
      if (!kind) {
        return state.fail(
          "No signed-in agent found. Sign in to Codex (`codex login`) or Claude Code (`claude`), or set up manually.",
        );
      }
      if (!ready(kind)) {
        const status = statuses.find((candidate) => candidate.kind === kind);
        return state.fail(
          `${AGENT_LABELS[kind]} is not ready.${status?.fix ? ` ${status.fix}` : ""}`,
        );
      }
      const model = { ...SETUP_AGENT_MODELS, ...this.options.models }[kind];
      state.log(
        "info",
        `Using ${AGENT_LABELS[kind]} (${model.model}, ${model.reasoning} reasoning).`,
      );

      const browser = this.browser.detect();
      if (!browser) {
        return state.fail(NO_BROWSER_MESSAGE);
      }
      state.step("prepare", "running", "Preparing the browser");
      try {
        await this.browser.prepare(signal);
      } catch {
        if (signal.aborted) {
          return;
        }
        return state.fail(
          "Could not download the browser helper (Playwright MCP via npx). Check your network connection and try again.",
        );
      }
      if (signal.aborted) {
        return;
      }
      await mkdir(this.profileDir, { recursive: true, mode: 0o700 });
      await mkdir(this.workDir, { recursive: true, mode: 0o700 });
      // A browser left over from an earlier task would hold the profile lock.
      await this.browser.close(this.profileDir);
      if (signal.aborted) {
        return;
      }

      const binding = await this.listener.bind(this.toolHost(run));
      release = binding.release;
      if (signal.aborted) {
        return;
      }
      const { systemPrompt, prompt } = setupPrompt({
        provider: input.provider,
        calendar: input.calendar,
        redirectUri: `${run.origin}/oauth/callback`,
      });
      state.step(
        "prepare",
        "done",
        `${AGENT_LABELS[kind]} with ${browser === "chrome" ? "Google Chrome" : browser === "msedge" ? "Microsoft Edge" : "Chromium"}`,
      );
      browserStarted = true;
      const session = (this.options.runSession ?? runHostAgentSession)(
        {
          kind,
          model: model.model,
          reasoning: model.reasoning,
          prompt,
          systemPrompt,
          cwd: this.workDir,
          mcpServers: {
            passport: {
              url: binding.url,
              headers: { Authorization: `Bearer ${binding.token}` },
              timeouts: { toolSec: Math.ceil(this.waitMs / 1000) + 120 },
            },
            browser: this.browser.server({
              browser,
              profileDir: this.profileDir,
              outputDir: join(this.workDir, "browser-output"),
            }),
          },
          allowedTools: [
            "mcp__passport",
            ...SETUP_BROWSER_TOOLS.map((tool) => `mcp__browser__${tool}`),
          ],
          timeoutMs: this.options.sessionTimeoutMs ?? 60 * 60_000,
          signal,
        },
        (event) => this.onEvent(run, event),
      );
      run.session = session;
      const result = await session.done;
      if (state.terminal) {
        return;
      }
      if (state.connected) {
        state.log("info", "Agent finished.");
        state.complete();
      } else {
        state.fail(
          result.error?.code === "HOST_AGENT_TIMEOUT"
            ? "The agent ran out of time. Start setup again; finished steps are reused."
            : result.error
              ? result.error.message
              : "The agent stopped before the mailbox was connected.",
        );
      }
    } finally {
      run.controller.abort();
      for (const [ticket, entry] of this.tickets) {
        if (entry.run === run) {
          this.tickets.delete(ticket);
        }
      }
      await release?.().catch(() => undefined);
      if (browserStarted) {
        await this.browser.close(this.profileDir).catch(() => undefined);
        // Screenshots can show the client secret; they are not kept.
        await rm(join(this.workDir, "browser-output"), { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  }

  private onEvent(run: Run, event: HostAgentEvent): void {
    const { state } = run;
    if (event.type === "started") {
      state.log("info", "Agent started.");
    } else if (event.type === "text") {
      state.log("info", `Agent: ${event.text}`);
    } else if (event.type === "tool_call") {
      const line = describeBrowserCall(event.name, event.input);
      if (line) {
        state.log("info", line);
      }
    } else if (event.type === "tool_result" && !event.ok) {
      state.log("warn", `${event.name.replace(/^mcp__[^_]+__/, "")} failed: ${event.summary}`);
    }
  }

  private toolHost(run: Run): SetupToolHost {
    const { state } = run;
    const ended = () => {
      if (state.terminal || run.controller.signal.aborted) {
        throw new SetupTaskEnded();
      }
    };
    const sleep = (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    return {
      provider: run.input.provider,
      stepIds: () => state.stepIds().filter((id) => id !== "prepare"),
      askUser: async (kind: SetupPromptKind, message: string, signal: AbortSignal) => {
        ended();
        const prompt = state.ask(kind, message);
        if (prompt.kind === "sign_in") {
          state.log("info", "Waiting for you to sign in in the browser window.");
        }
        let waiting = run.answers.get(prompt.id);
        if (!waiting) {
          waiting = deferred<string>();
          run.answers.set(prompt.id, waiting);
        }
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), this.waitMs);
        try {
          const stop = AbortSignal.any([signal, timeout.signal]);
          const answer = await Promise.race([
            waiting.promise,
            new Promise<null>((resolve) => {
              if (stop.aborted) {
                resolve(null);
              }
              stop.addEventListener("abort", () => resolve(null), { once: true });
            }),
          ]);
          if (answer !== null) {
            run.answers.delete(prompt.id);
          }
          ended();
          return answer;
        } finally {
          clearTimeout(timer);
        }
      },
      reportProgress: (step, status, detail) => {
        ended();
        state.step(step, status, detail);
      },
      registerOAuthClient: async (input) => {
        ended();
        if (input.provider !== run.input.provider) {
          throw new ApiError("INVALID_PROVIDER", `This task sets up ${run.input.provider}`);
        }
        state.addSecret(input.clientSecret);
        const attempt = await this.options.oauth.start(
          {
            kind: input.provider === "gmail" ? "gmail" : "graph",
            clientId: input.clientId,
            ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
            calendar: run.input.calendar,
          },
          run.origin,
        );
        ended();
        const ticket = randomBytes(24).toString("base64url");
        state.addSecret(ticket);
        state.addSecret(attempt.attemptId);
        this.tickets.set(ticket, {
          run,
          state: attempt.attemptId,
          nonce: attempt.nonce,
          authUrl: attempt.authUrl,
          expiresAt: Date.now() + 10 * 60_000,
        });
        run.attempts.add(attempt.attemptId);
        state.step("authorize", "running", "Waiting for you to approve access");
        state.log(
          "info",
          "Passport stored the new OAuth client. Approve access in the browser window.",
        );
        return {
          authorizationUrl: `${run.origin}/oauth/setup/${ticket}`,
          state: attempt.attemptId,
          redirectUri: attempt.redirectUri,
        };
      },
      waitForConnection: async (attemptId, signal) => {
        ended();
        if (!run.attempts.has(attemptId)) {
          throw new ApiError("UNKNOWN_STATE", "Use the state that register_oauth_client returned");
        }
        const deadline = Date.now() + this.waitMs;
        while (!signal.aborted && Date.now() < deadline) {
          const status = this.options.oauth.peek(attemptId);
          if (!status) {
            return {
              status: "failed",
              error: "Authorization expired. Call register_oauth_client again to get a new link.",
            };
          }
          if (status.status === "connected" && status.accountId) {
            const accounts = await this.options.listAccounts();
            const linked = accounts.filter(
              (account) =>
                account.id === status.accountId || account.settings.oauthGroup === status.accountId,
            );
            const address = linked.find((account) => account.id === status.accountId)?.emailAddress;
            state.connect(linked.map((account) => account.id));
            state.step("authorize", "done", address ? `Connected ${address}` : "Connected");
            state.log("info", `Connected ${address ?? "the mailbox"}; the first sync is running.`);
            return {
              status: "connected",
              accountIds: linked.map((account) => account.id),
              ...(address ? { address } : {}),
            };
          }
          if (status.status === "failed") {
            const error = status.error ?? "Authorization failed";
            state.step("authorize", "failed", error);
            return { status: "failed", error };
          }
          await sleep(this.pollMs, signal);
        }
        ended();
        return { status: "waiting" };
      },
      finish: (summary, success) => {
        ended();
        state.log(success ? "info" : "warn", `Agent: ${summary}`);
        if (success && state.connected) {
          state.complete();
        } else {
          state.fail(
            state.connected
              ? summary
              : success
                ? `The agent finished, but no mailbox was connected. ${summary}`
                : summary,
          );
        }
        // The agent was told to stop; do not let a lingering session hold the browser.
        const session = run.session;
        setTimeout(() => session?.cancel(), this.options.finishGraceMs ?? 20_000).unref();
      },
    };
  }
}

/** One readable log line per meaningful browser action; reads are omitted, typed text never logged. */
export function describeBrowserCall(name: string, input: unknown): string | undefined {
  const match = /^mcp__browser__(?:browser_)?(.+)$/.exec(name);
  if (!match) {
    return;
  }
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const element = typeof args.element === "string" ? args.element.slice(0, 80) : undefined;
  const tool = match[1]!;
  switch (tool) {
    case "navigate": {
      try {
        const url = new URL(String(args.url));
        return `Browser: opened ${url.origin}${url.pathname.startsWith("/oauth/setup/") ? "/oauth/setup/…" : url.pathname}`;
      } catch {
        return "Browser: opened a page";
      }
    }
    case "click":
      return `Browser: clicked ${element ?? "an element"}`;
    case "type":
    case "fill_form":
      return `Browser: filled in ${element ?? "a form"}`;
    case "select_option":
      return `Browser: chose an option${element ? ` in ${element}` : ""}`;
    case "snapshot":
    case "take_screenshot":
    case "wait_for":
    case "find":
    case "hover":
    case "resize":
      return;
    default:
      return `Browser: ${tool.replace(/_/g, " ")}`;
  }
}
