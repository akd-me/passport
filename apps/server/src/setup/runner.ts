import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { detectHostAgents, runHostAgentSession } from "@passport/agent";
import { newId } from "@passport/store";
import type { HostAgentEvent, HostAgentKind, SetupPromptKind, SetupTask } from "@passport/types";
import { ApiError } from "../errors.js";
import { logger } from "../logger.js";
import {
  browserMcpServer,
  closeSetupBrowser,
  detectSetupBrowser,
  NO_BROWSER_MESSAGE,
  prepareBrowserMcp,
} from "./browser.js";
import { DECLINED, SetupMcpListener, type SetupToolHost } from "./mcp.js";
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
import { SetupTaskState, scrubAgentText } from "./task.js";

export { describeBrowserCall } from "./runner-events.js";
export type {
  RunSession,
  SetupBrowserControl,
  SetupRunnerOptions,
  StartSetupInput,
} from "./runner-state.js";
export { parseSetupInput, SETUP_AGENT_MODELS } from "./runner-state.js";

/** Confirmations accept yes (or done) and no; sign-ins accept done; questions need text. */
function parseAnswer(kind: SetupPromptKind, answer: string): { value: string; log: string } {
  if (kind === "question") {
    if (!answer.trim()) {
      throw new ApiError("INVALID_FIELD", "Type an answer");
    }
    return { value: answer.trim(), log: "You answered the agent's question." };
  }
  if (answer === "done" || (kind === "confirm" && answer === "yes")) {
    return { value: "done", log: "You clicked Continue." };
  }
  if (kind === "confirm" && answer === "no") {
    return { value: DECLINED, log: "You declined." };
  }
  throw new ApiError(
    "INVALID_FIELD",
    kind === "confirm" ? 'answer must be "yes" or "no"' : 'answer must be "done"',
  );
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
    const runs = [...this.runs.values()];
    if (runs.some((run) => !run.state.terminal)) {
      throw new ApiError(
        "SETUP_BUSY",
        "A setup task is already running; finish or cancel it first",
        409,
      );
    }
    // The next task reuses the browser profile and output directory.
    if (runs.some((run) => !run.settled)) {
      throw new ApiError(
        "SETUP_BUSY",
        "The previous setup task is finishing up (closing its agent and browser); try again in a moment",
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
      asking: new Map(),
      attempts: new Set(),
      settled: false,
    };
    this.runs.set(id, run);
    for (const [key, old] of this.runs) {
      if (this.runs.size <= MAX_TASKS) {
        break;
      }
      if (old.state.terminal && old.settled) {
        this.runs.delete(key);
      }
    }
    state.log(
      "info",
      `Setting up ${input.provider === "gmail" ? "Gmail" : "Microsoft"}${input.calendar ? " with calendar" : ""}.`,
    );
    run.execution = this.execute(run)
      .catch(() => {
        // Keep the existing operational log and fallback; never include the caught payload.

        run.state.fail("Setup stopped unexpectedly. Try again, or set up manually.");
        logger.error("Setup task failed unexpectedly");
      })
      .finally(() => {
        run.settled = true;
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
    // Validate before clearing the prompt, so a rejected answer leaves it answerable.
    const reply = parseAnswer(run.state.pending(promptId).kind, answer);
    run.state.answer(promptId);
    run.state.log("info", reply.log);
    const waiting = run.answers.get(promptId) ?? deferred<string>();
    run.answers.set(promptId, waiting);
    waiting.resolve(reply.value);
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

  /** Resolves once every task's session and cleanup have ended. */
  async idle(): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => run.execution));
  }

  /** Stops every task, including finished ones whose session is still winding down. */
  async close(): Promise<void> {
    for (const run of this.runs.values()) {
      if (!run.state.terminal) {
        run.state.cancel();
      }
      if (!run.settled) {
        this.stop(run);
      }
    }
    await this.idle();
    await this.listener.close();
  }

  private stop(run: Run): void {
    run.controller.abort();
    run.session?.cancel();
    this.revoke(run);
  }

  /** Unused setup links and unanswered OAuth attempts die with their task. */
  private revoke(run: Run): void {
    for (const [ticket, entry] of this.tickets) {
      if (entry.run === run) {
        this.tickets.delete(ticket);
      }
    }
    for (const attempt of run.attempts) {
      this.options.oauth.revoke(attempt);
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
      this.revoke(run);
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
      state.log("info", `Agent: ${scrubAgentText(event.text)}`);
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
