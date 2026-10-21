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
  SetupProvider,
} from "@passport/types";
import { ApiError } from "../errors.js";
import { logger } from "../logger.js";
import type { BrowserMcpOptions, SetupBrowser } from "./browser.js";
import type { SetupTaskState } from "./task.js";
export const SETUP_AGENT_MODELS: Record<
  HostAgentKind,
  { model: string; reasoning: HostAgentReasoning }
> = {
  codex: { model: "gpt-6.1-sol", reasoning: "high" },
  "claude-code": { model: "claude-opus-5-5", reasoning: "high" },
};
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
export const AGENT_LABELS: Record<HostAgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
};
export const MAX_TASKS = 20;
interface SetupOAuth {
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
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve,
  };
}
export interface Run {
  state: SetupTaskState;
  input: StartSetupInput;
  origin: string;
  controller: AbortController;
  answers: Map<string, Deferred<string>>;
  attempts: Set<string>;
  session?: { cancel(): void };
}
export interface Ticket {
  run: Run;
  state: string;
  nonce: string;
  authUrl: string;
  expiresAt: number;
}
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
export function loopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.origin === origin
    );
  } catch {
    // Setup owner process probe failed.
    logger.warn("Setup owner process probe failed");

    return false;
  }
}
