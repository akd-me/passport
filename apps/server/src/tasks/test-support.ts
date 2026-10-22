/** Test helpers for task tests: a scripted LLM and a real in-memory backend on the mock provider. */
import type { CompleteOptions, LlmClient, LlmCompletion } from "@passport/agent";
import {
  createProviderRegistry,
  MockCalendarProvider,
  MockMailProvider,
} from "@passport/providers";
import { vi } from "vitest";
import { addAccount } from "../accounts.js";
import { createApp } from "../auth.test-client.js";
import { createRealBackend, type RealBackend } from "../compose.js";
import { defaultConfig } from "../config.js";

type Step = string | LlmCompletion | ((opts: CompleteOptions) => Promise<string | LlmCompletion>);

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

export function toolCall(name: string, args: unknown, text = ""): LlmCompletion {
  return {
    text,
    toolCalls: [{ id: `call-${name}`, name, arguments: args }],
    model: "script",
    usage,
  };
}

/** Structured triage steps get fixed answers; free-text (manual) calls follow `script`. */
export class ScriptLlm implements LlmClient {
  readonly script: Step[] = [];
  readonly prompts: string[] = [];

  async complete(options: CompleteOptions): Promise<LlmCompletion> {
    const properties = options.json?.properties;
    if (properties) {
      const json = properties.category
        ? { category: "other" }
        : properties.matterId
          ? {
              matterId: null,
              title: "Fixture",
              kind: "project",
              summary: "Review.",
              nextStep: "Review",
            }
          : properties.slots
            ? { status: "tentative", textBody: "Some times.", slots: [] }
            : properties.textBody
              ? { textBody: "Thanks." }
              : { summary: "Waiting", nextStep: "Review", status: "waiting" };
      return { text: JSON.stringify(json), json, toolCalls: [], model: "script", usage };
    }
    const first = options.messages[0]?.content;
    if (typeof first === "string" && options.messages.length === 1) {
      this.prompts.push(first);
    }
    const step = this.script.shift() ?? "Done.";
    const value = typeof step === "function" ? await step(options) : step;
    return typeof value === "string"
      ? { text: value, toolCalls: [], model: "script", usage }
      : value;
  }
}

export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

export async function waitFor<T>(check: () => Promise<T | null | undefined | false>, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function taskBackend(backends: RealBackend[]) {
  const mail = new MockMailProvider({ fixtures: false });
  const calendar = new MockCalendarProvider();
  const providers = createProviderRegistry();
  vi.spyOn(providers, "mail").mockReturnValue(mail);
  vi.spyOn(providers, "calendar").mockReturnValue(calendar);
  const llm = new ScriptLlm();
  const backend = await createRealBackend(defaultConfig(), {
    storePath: ":memory:",
    providers,
    llm,
  });
  backends.push(backend);
  const account = await addAccount(backend, {
    kind: "mock",
    emailAddress: "alex@example.com",
    displayName: "Alex",
    fields: {},
  });
  // First tick: cursor at "now", no backfill.
  await backend.syncAccount(account.id);
  const tasks = backend.tasks!;
  return { backend, account, mail, llm, tasks, service: tasks.service, app: createApp(backend) };
}

/** A message delivered to the mock Inbox, then picked up by one watcher tick. */
export async function deliver(
  env: Awaited<ReturnType<typeof taskBackend>>,
  input: Parameters<MockMailProvider["injectEmail"]>[0],
) {
  const inbox = `${env.account.id}:mailbox:Inbox`;
  const injected = env.mail.injectEmail({
    mailboxIds: [inbox],
    receivedAt: new Date().toISOString(),
    ...input,
  });
  await env.backend.syncAccount(env.account.id);
  return (await env.backend.store.emails.getByProviderId(env.account.id, injected.providerId))!;
}
