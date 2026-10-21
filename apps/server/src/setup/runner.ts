import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { detectHostAgents, runHostAgentSession } from "@passport/agent";
import { newId } from "@passport/store";
import type { HostAgentEvent, HostAgentKind, SetupTask } from "@passport/types";
import { ApiError } from "../errors.js";
import { logger } from "../logger.js";
import {
  browserMcpServer,
  closeSetupBrowser,
  detectSetupBrowser,
  NO_BROWSER_MESSAGE,
  prepareBrowserMcp,
} from "./browser.js";
import { SetupMcpListener, type SetupToolHost } from "./mcp.js";
import { setupPrompt, setupSteps } from "./prompt.js";
import { describeBrowserCall } from "./runner-events.js";
import {
  AGENT_LABELS,
  deferred,
  loopbackOrigin,
  MAX_TASKS,
  type Run,
  SETUP_AGENT_MODELS,
  SETUP_BROWSER_TOOLS,
  type SetupBrowserControl,
  type SetupRunnerOptions,
  type StartSetupInput,
  type Ticket,
} from "./runner-state.js";
import { createSetupToolHost } from "./runner-tools.js";
import { SetupTaskState } from "./task.js";

export { describeBrowserCall } from "./runner-events.js";
export type {
  RunSession,
  SetupBrowserControl,
  SetupRunnerOptions,
  StartSetupInput,
} from "./runner-state.js";
export { parseSetupInput, SETUP_AGENT_MODELS } from "./runner-state.js";

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
      // Keep the existing operational log and fallback; never include the caught payload.

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
        // Browser helper preparation failed.
        logger.warn("Browser helper preparation failed");

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
      await release?.().catch(() => {
        // Browser helper release failed during cleanup.
        logger.warn("Browser helper release failed during cleanup");
        return undefined;
      });
      if (browserStarted) {
        await this.browser.close(this.profileDir).catch(() => {
          // Setup browser close failed during cleanup.
          logger.warn("Setup browser close failed during cleanup");
          return undefined;
        });
        // Screenshots can show the client secret; they are not kept.
        await rm(join(this.workDir, "browser-output"), { recursive: true, force: true }).catch(
          () => {
            // Setup browser output cleanup failed.
            logger.warn("Setup browser output cleanup failed");
            return undefined;
          },
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
    return createSetupToolHost(run, {
      options: this.options,
      waitMs: this.waitMs,
      pollMs: this.pollMs,
      tickets: this.tickets,
    });
  }
}
