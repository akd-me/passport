import { delimiter } from "node:path";
import {
  applyShellEnvironment,
  probeShellEnvironment,
  type ShellEnvironment,
  type ShellEnvironmentSource,
} from "@passport/agent";
import type { HostAgentKind } from "@passport/types";
import type { PassportConfig } from "./config.js";
import { logger } from "./logger.js";

/**
 * Host-CLI environment for a server started outside a terminal (Finder, launchd, the Mac app).
 * `serve`/`demo` read PATH from the login shell unless the launcher already did
 * (`PASSPORT_SHELL_ENV_PREPARED=1`, optionally `PASSPORT_SHELL_ENV_SOURCE`) or stdin is a TTY.
 * Configured binary paths (`hostAgents.*Path`) are exposed to host-agent discovery through the
 * `PASSPORT_CLAUDE_PATH` / `PASSPORT_CODEX_PATH` variables, which win when set by the environment.
 */
export type PathSource = ShellEnvironmentSource | "inherited" | "desktop";
export interface PathState {
  source: PathSource;
  /** Human-readable form for logs, doctor and settings. Never contains PATH itself. */
  label: string;
  entries: number;
}

const SHELL_SOURCES: readonly ShellEnvironmentSource[] = ["login-shell", "launchctl", "fallback"];
const PROBE_COMMANDS = new Set(["serve", "demo"]);

export type ShellProbe = () => Promise<ShellEnvironment>;
let probe: ShellProbe = () => probeShellEnvironment();
let state: PathState | undefined;

/** Tests replace the login-shell probe; returns the previous probe. */
export function setShellProbe(next: ShellProbe): ShellProbe {
  const previous = probe;
  probe = next;
  return previous;
}

function count(env: NodeJS.ProcessEnv): number {
  return (env.PATH ?? "").split(delimiter).filter(Boolean).length;
}

function describeSource(source: ShellEnvironmentSource, shell: string | null): string {
  if (source === "login-shell") {
    return shell ? `login shell (${shell})` : "login shell";
  }
  return source === "launchctl" ? "launchctl" : "fallback (inherited PATH only)";
}

/** Where this process's PATH came from. */
export function pathState(env: NodeJS.ProcessEnv = process.env): PathState {
  if (state) {
    return { ...state, entries: count(env) };
  }
  if (env.PASSPORT_SHELL_ENV_PREPARED) {
    const source = env.PASSPORT_SHELL_ENV_SOURCE as ShellEnvironmentSource | undefined;
    const known = source && SHELL_SOURCES.includes(source);
    return {
      source: "desktop",
      label: known ? `${describeSource(source, null)}, prepared by the app` : "prepared by the app",
      entries: count(env),
    };
  }
  return { source: "inherited", label: "inherited", entries: count(env) };
}

/** Run the login-shell probe and write its result into `env`. Never throws. */
export async function hydrateShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PathState> {
  try {
    const result = await probe();
    applyShellEnvironment(result, env);
    state = {
      source: result.source,
      label: describeSource(result.source, result.shell),
      entries: count(env),
    };
  } catch {
    // The probe does not throw for a missing or slow shell; anything else keeps the inherited PATH.
    logger.warn("Login-shell PATH probe failed; keeping the inherited PATH");
    state = { source: "fallback", label: describeSource("fallback", null), entries: count(env) };
  }
  return state;
}

const PATH_KEYS = { "claude-code": "claudePath", codex: "codexPath" } as const;
export const HOST_AGENT_PATH_ENV = {
  "claude-code": "PASSPORT_CLAUDE_PATH",
  codex: "PASSPORT_CODEX_PATH",
} as const satisfies Record<HostAgentKind, string>;
/** Values the environment set before Passport applied any configured path. */
const pinned = new WeakMap<NodeJS.ProcessEnv, Partial<Record<HostAgentKind, string>>>();

function environmentPaths(env: NodeJS.ProcessEnv): Partial<Record<HostAgentKind, string>> {
  let values = pinned.get(env);
  if (!values) {
    values = {};
    for (const kind of Object.keys(HOST_AGENT_PATH_ENV) as HostAgentKind[]) {
      const value = env[HOST_AGENT_PATH_ENV[kind]];
      if (value) {
        values[kind] = value;
      }
    }
    pinned.set(env, values);
  }
  return values;
}

/** Expose configured binary paths to discovery; environment-set paths take precedence. */
export function applyHostAgentPaths(
  config: Pick<PassportConfig, "hostAgents">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const fromEnvironment = environmentPaths(env);
  for (const kind of Object.keys(HOST_AGENT_PATH_ENV) as HostAgentKind[]) {
    if (fromEnvironment[kind]) {
      continue;
    }
    const configured = config.hostAgents?.[PATH_KEYS[kind]];
    if (configured) {
      env[HOST_AGENT_PATH_ENV[kind]] = configured;
    } else {
      delete env[HOST_AGENT_PATH_ENV[kind]];
    }
  }
}

export interface HostAgentPathSetting {
  /** Saved in `passport.config.json`. */
  configured: string | null;
  /** Set by `PASSPORT_CLAUDE_PATH` / `PASSPORT_CODEX_PATH`; overrides `configured`. */
  environment: string | null;
}

export function hostAgentPathSettings(
  config: Pick<PassportConfig, "hostAgents">,
  env: NodeJS.ProcessEnv = process.env,
): Record<HostAgentKind, HostAgentPathSetting> {
  const fromEnvironment = environmentPaths(env);
  const setting = (kind: HostAgentKind): HostAgentPathSetting => ({
    configured: config.hostAgents?.[PATH_KEYS[kind]] ?? null,
    environment: fromEnvironment[kind] ?? null,
  });
  return { "claude-code": setting("claude-code"), codex: setting("codex") };
}

/**
 * CLI startup hook, run before host-agent detection. Applies configured binary paths for every
 * command and, for `serve`/`demo` launched without a terminal, reads PATH from the login shell.
 */
export async function prepareHostEnvironment(
  config: Pick<PassportConfig, "hostAgents">,
  command: string,
  options: { env?: NodeJS.ProcessEnv; isTTY?: boolean } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  applyHostAgentPaths(config, env);
  const isTTY = options.isTTY ?? process.stdin.isTTY === true;
  if (!PROBE_COMMANDS.has(command) || env.PASSPORT_SHELL_ENV_PREPARED || isTTY) {
    return;
  }
  const result = await hydrateShellEnvironment(env);
  logger.info(`Host CLI PATH from ${result.label}: ${result.entries} entries.`);
}
