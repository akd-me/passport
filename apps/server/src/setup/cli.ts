import type { Server } from "node:http";
import { createInterface } from "node:readline/promises";
import { serve } from "@hono/node-server";
import type { SetupPrompt, SetupTask } from "@passport/types";
import { createApp } from "../app.js";
import { serverClient } from "../cli/server-client.js";
import { createRealBackend } from "../compose.js";
import { loadConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { resolveLlmSelection } from "../llm-selection.js";
import { setupTasks } from "./routes.js";
import { parseSetupInput } from "./runner.js";

/** The setup-task operations, against a running server or in this process. */
export interface SetupClient {
  start(body: Record<string, unknown>): Promise<string>;
  get(id: string): Promise<SetupTask>;
  respond(id: string, promptId: string, answer: string): Promise<void>;
  cancel(id: string): Promise<void>;
}

export function parseConnectArgs(args: string[]): Record<string, unknown> {
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const provider = value("--provider");
  if (!provider) {
    throw new ApiError(
      "INVALID_COMMAND",
      "Use passport accounts connect --provider gmail|microsoft [--no-calendar] [--agent codex|claude-code]",
    );
  }
  const agent = value("--agent");
  return { provider, calendar: !args.includes("--no-calendar"), ...(agent ? { agent } : {}) };
}

const TERMINAL = ["completed", "failed", "cancelled"];
const MARK = { pending: " ", running: "…", done: "✓", failed: "✗" } as const;

/**
 * Print a task's steps, log and result as they change, and answer its prompts with `ask`.
 * Resolves with the final task.
 */
export async function followSetupTask(
  client: SetupClient,
  id: string,
  ask: (prompt: SetupPrompt) => Promise<string>,
  print: (line: string) => void,
  options: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<SetupTask> {
  const steps = new Map<string, string>(),
    printed = new Set<string>();
  let answered: string | undefined;
  for (;;) {
    const task = await client.get(id);
    for (const step of task.steps) {
      const key = `${step.status}|${step.detail ?? ""}`;
      if (steps.get(step.id) === key || step.status === "pending") {
        continue;
      }
      steps.set(step.id, key);
      print(`[${MARK[step.status]}] ${step.title}${step.detail ? ` — ${step.detail}` : ""}`);
    }
    for (const line of task.log) {
      const key = `${line.at}|${line.text}`;
      if (printed.has(key)) {
        continue;
      }
      printed.add(key);
      print(`    ${line.level === "info" ? "" : `${line.level}: `}${line.text}`);
    }
    if (TERMINAL.includes(task.status)) {
      return task;
    }
    if (task.prompt && task.prompt.id !== answered) {
      answered = task.prompt.id;
      const answer = await ask(task.prompt);
      try {
        await client.respond(id, task.prompt.id, answer);
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          !["PROMPT_STALE", "TASK_FINISHED"].includes(error.code)
        ) {
          throw error;
        }
      }
      continue;
    }
    if (options.signal?.aborted) {
      return client.get(id);
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1000));
  }
}

/** `passport accounts connect --provider gmail|microsoft [--no-calendar] [--agent codex|claude-code]` */
export async function connectCommand(args: string[]): Promise<void> {
  const body = parseConnectArgs(args);
  parseSetupInput(body);
  const config = await loadConfig();
  const request = await serverClient(config);
  let close = async () => {};
  let client: SetupClient;
  if (request) {
    client = {
      start: async (input) =>
        ((await request("/api/setup/tasks", "POST", input)) as { id: string }).id,
      get: async (id) => (await request(`/api/setup/tasks/${encodeURIComponent(id)}`)) as SetupTask,
      respond: async (id, promptId, answer) => {
        await request(`/api/setup/tasks/${encodeURIComponent(id)}/respond`, "POST", {
          promptId,
          answer,
        });
      },
      cancel: async (id) => {
        await request(`/api/setup/tasks/${encodeURIComponent(id)}/cancel`, "POST", {});
      },
    };
  } else {
    // No server: run the task here, with a temporary listener for the OAuth callback.
    await resolveLlmSelection(config, { log: false });
    const backend = await createRealBackend(config, { clientMode: true });
    const app = createApp(backend);
    let listener: ReturnType<typeof serve>;
    try {
      listener = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
        const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.port }, () =>
          resolve(server),
        );
        server.once("error", reject);
      });
    } catch {
      await backend.close();
      throw new ApiError(
        "PORT_IN_USE",
        `Port ${config.port} is in use. Stop what is using it, start passport serve, or set PASSPORT_PORT.`,
      );
    }
    const address = listener.address();
    const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : config.port}`;
    const runner = setupTasks(backend);
    client = {
      start: async (input) => runner.start(parseSetupInput(input), origin).id,
      get: async (id) => runner.get(id),
      respond: async (id, promptId, answer) => {
        runner.respond(id, promptId, answer);
      },
      cancel: async (id) => {
        runner.cancel(id);
      },
    };
    close = async () => {
      await backend.close();
      (listener as Server).closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    };
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdout.isTTY,
  });
  let id: string | undefined;
  const interrupted = new AbortController();
  const interrupt = () => {
    console.log("\nCancelling…");
    interrupted.abort();
    if (id) {
      void client.cancel(id).catch(() => undefined);
    }
  };
  process.once("SIGINT", interrupt);
  rl.on("SIGINT", interrupt);
  try {
    id = await client.start(body);
    console.log(
      "A browser window will open. Passport's agent does the console work; you sign in and approve.",
    );
    const task = await followSetupTask(
      client,
      id,
      async (prompt) => {
        console.log(`\n>> ${prompt.message}`);
        // An interrupted question resolves; the next poll then sees the cancelled task.
        try {
          if (prompt.kind === "question") {
            return await rl.question("Your answer: ", { signal: interrupted.signal });
          }
          await rl.question("Press Enter when done… ", { signal: interrupted.signal });
        } catch {
          /* interrupted */
        }
        return "done";
      },
      (line) => console.log(line),
      { signal: interrupted.signal },
    );
    if (task.status === "completed") {
      console.log(`\nConnected. Accounts: ${task.result?.accountIds.join(", ") ?? "none"}.`);
    } else {
      console.log(
        `\nSetup ${task.status}.${task.error ? ` ${task.error}` : ""} See docs/accounts.md to set up manually.`,
      );
      process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", interrupt);
    rl.close();
    await close();
  }
}
