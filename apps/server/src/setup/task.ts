import { randomBytes } from "node:crypto";
import { redact } from "@passport/agent";
import type {
  Id,
  SetupLogEntry,
  SetupPrompt,
  SetupPromptKind,
  SetupProvider,
  SetupStepStatus,
  SetupTask,
  SetupTaskStatus,
} from "@passport/types";
import { ApiError } from "../errors.js";
import type { SetupStepDefinition } from "./prompt.js";

const MAX_LOG = 300;
/**
 * OAuth client secrets the agent may read off a console page before Passport knows them:
 * Google (`GOCSPX-…`), Microsoft (`xxx8Q~…`), and anything labelled a secret.
 */
const CLIENT_SECRETS: Array<[RegExp, string]> = [
  [/\bGOCSPX-[A-Za-z0-9_-]{4,}/g, "[redacted]"],
  [/[A-Za-z0-9_.-]{2,}~[A-Za-z0-9_.~-]{20,}/g, "[redacted]"],
  [
    /\b(secret)(\s*(?:is|was|value)?\s*[:=]?\s*["'`]?)(?!\[redacted\])[^\s"'`,;]{6,}/gi,
    "$1$2[redacted]",
  ],
];
const TERMINAL: readonly SetupTaskStatus[] = ["completed", "failed", "cancelled"];

/**
 * One setup task's observable state. Every mutation publishes a full snapshot; text that
 * reaches the log, steps, prompt or error is scrubbed of registered secrets and redacted.
 * Once terminal, the task ignores further changes.
 */
export class SetupTaskState {
  private task: SetupTask;
  private readonly secrets = new Set<string>();

  constructor(
    id: Id,
    provider: SetupProvider,
    steps: SetupStepDefinition[],
    private readonly publish: (task: SetupTask) => void,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.task = {
      id,
      provider,
      status: "running",
      steps: steps.map((step) => ({ ...step, status: "pending" })),
      log: [],
    };
  }

  get id(): Id {
    return this.task.id;
  }
  get provider(): SetupProvider {
    return this.task.provider;
  }
  get status(): SetupTaskStatus {
    return this.task.status;
  }
  get prompt(): SetupPrompt | undefined {
    return this.task.prompt;
  }
  get terminal(): boolean {
    return TERMINAL.includes(this.task.status);
  }
  get connected(): boolean {
    return !!this.task.result?.accountIds.length;
  }
  stepIds(): string[] {
    return this.task.steps.map((step) => step.id);
  }

  snapshot(): SetupTask {
    return structuredClone(this.task);
  }

  /** Values that must never appear in anything the task publishes. */
  addSecret(value: string | undefined): void {
    if (value && value.length >= 4) this.secrets.add(value);
  }

  scrub(text: string, max = 400): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join("[redacted]");
    for (const [pattern, replacement] of CLIENT_SECRETS) out = out.replace(pattern, replacement);
    return redact(out, max);
  }

  private change(mutate: () => void): void {
    if (this.terminal) return;
    mutate();
    this.publish(this.snapshot());
  }

  log(level: SetupLogEntry["level"], text: string): void {
    const clean = this.scrub(text);
    if (!clean) return;
    this.change(() => {
      this.task.log.push({ at: this.now().toISOString(), level, text: clean });
      if (this.task.log.length > MAX_LOG) this.task.log.splice(0, this.task.log.length - MAX_LOG);
    });
  }

  /** Unknown ids are rejected so the checklist stays the one the user was shown. */
  step(id: string, status: SetupStepStatus | "skipped", detail?: string): void {
    const step = this.task.steps.find((candidate) => candidate.id === id);
    if (!step)
      throw new ApiError(
        "UNKNOWN_STEP",
        `Unknown step ${id}; use one of ${this.stepIds().join(", ")}`,
      );
    this.change(() => {
      step.status = status === "skipped" ? "done" : status;
      const text = status === "skipped" ? `Already set up${detail ? `: ${detail}` : ""}` : detail;
      if (text) step.detail = this.scrub(text, 200);
      else delete step.detail;
    });
  }

  /** The running step, if any, becomes failed: the user sees where it stopped. */
  private failRunningSteps(): void {
    for (const step of this.task.steps) if (step.status === "running") step.status = "failed";
  }

  /**
   * Show a prompt. Asking the same question again (after a bounded wait expired) keeps the
   * same prompt, so the user's view does not flicker.
   */
  ask(kind: SetupPromptKind, message: string): SetupPrompt {
    const clean = this.scrub(message, 500);
    const current = this.task.prompt;
    if (current && current.kind === kind && current.message === clean) return current;
    const prompt: SetupPrompt = { id: randomBytes(8).toString("hex"), kind, message: clean };
    this.change(() => {
      this.task.prompt = prompt;
      this.task.status = "waiting_for_user";
    });
    return prompt;
  }

  /** Accept the user's answer to the current prompt. */
  answer(promptId: string): SetupPrompt {
    if (this.terminal)
      throw new ApiError("TASK_FINISHED", "This setup task has already finished", 409);
    const prompt = this.task.prompt;
    if (!prompt || prompt.id !== promptId)
      throw new ApiError("PROMPT_STALE", "That question is no longer being asked", 409);
    this.change(() => {
      delete this.task.prompt;
      this.task.status = "running";
    });
    return prompt;
  }

  connect(accountIds: Id[]): void {
    this.change(() => {
      this.task.result = { accountIds };
    });
  }

  complete(): void {
    this.change(() => {
      delete this.task.prompt;
      for (const step of this.task.steps) if (step.status !== "failed") step.status = "done";
      this.task.status = "completed";
    });
  }

  fail(error: string): void {
    this.change(() => {
      delete this.task.prompt;
      this.failRunningSteps();
      this.task.error = this.scrub(error, 300);
      this.task.log.push({ at: this.now().toISOString(), level: "error", text: this.task.error });
      this.task.status = "failed";
    });
  }

  cancel(): void {
    this.change(() => {
      delete this.task.prompt;
      // Cancelling is the user's choice, not a failure of the step in progress.
      for (const step of this.task.steps) if (step.status === "running") step.status = "pending";
      this.task.log.push({ at: this.now().toISOString(), level: "warn", text: "Cancelled." });
      this.task.status = "cancelled";
    });
  }
}
