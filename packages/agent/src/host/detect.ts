import { accessSync, constants, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { HostAgentKind, HostAgentStatus } from "@passport/types";
import { extraBinDirs, hostAgentEnv, redact } from "./env.js";
import { runCli } from "./process.js";
import { record } from "./types.js";

export const HOST_AGENT_KINDS: readonly HostAgentKind[] = ["codex", "claude-code"];

const BINARY: Record<HostAgentKind, string> = { "claude-code": "claude", codex: "codex" };
const LABEL: Record<HostAgentKind, string> = { "claude-code": "Claude Code", codex: "Codex" };
/** Env overrides for a binary outside the usual locations. */
const OVERRIDE: Record<HostAgentKind, string> = {
  "claude-code": "PASSPORT_CLAUDE_PATH",
  codex: "PASSPORT_CODEX_PATH",
};

export const HOST_AGENT_FIXES = {
  "claude-code": {
    install:
      "Install Claude Code (https://docs.claude.com/en/docs/claude-code/setup), then run `claude auth login`.",
    login: "Run `claude auth login` and sign in with your Claude subscription.",
  },
  codex: {
    install:
      "Install Codex with `npm install -g @openai/codex` (https://developers.openai.com/codex/cli), then run `codex login`.",
    login: "Run `codex login` and sign in with your ChatGPT account.",
  },
} as const;

function executable(path: string, log?: (message: string) => void): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    // Host-agent executable probe failed.
    log?.("Host-agent executable probe failed");

    return false;
  }
}

/** Resolve a host CLI on PATH plus `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. */
export function resolveHostAgentBinary(
  kind: HostAgentKind,
  env: NodeJS.ProcessEnv = process.env,
  log?: (message: string) => void,
): string | null {
  const override = env[OVERRIDE[kind]];
  if (override) {
    return executable(override, log) ? override : null;
  }
  const names =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((ext) => BINARY[kind] + ext.toLowerCase())
      : [BINARY[kind]];
  const dirs = [
    // Only absolute entries: a relative one would be checked here and run from another cwd.
    ...(env.PATH ?? env.Path ?? "").split(delimiter).filter((dir) => isAbsolute(dir)),
    ...extraBinDirs(env),
  ];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (executable(candidate, log)) {
        return candidate;
      }
    }
  }
  return null;
}

type ProbeExec = (
  binary: string,
  args: string[],
  env: Record<string, string>,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const defaultExec: ProbeExec = async (binary, args, env) => {
  const { done } = runCli({ binary, args, env, cwd: tmpdir(), timeoutMs: 15_000 });
  const result = await done;
  return {
    code: result.timedOut ? null : result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

function version(text: string): string | null {
  return /\d+\.\d+\.\d+[\w.+-]*/.exec(text)?.[0] ?? null;
}

async function probe(
  kind: HostAgentKind,
  env: NodeJS.ProcessEnv,
  exec: ProbeExec,
  now: () => number,
  log?: (message: string) => void,
): Promise<HostAgentStatus> {
  const base = { kind, label: LABEL[kind], checkedAt: new Date(now()).toISOString() };
  const binaryPath = resolveHostAgentBinary(kind, env, log);
  if (!binaryPath) {
    return {
      ...base,
      installed: false,
      binaryPath: null,
      version: null,
      loggedIn: false,
      account: null,
      ready: false,
      fix: HOST_AGENT_FIXES[kind].install,
    };
  }
  const childEnv = hostAgentEnv(env, binaryPath);
  const [ver, auth] = await Promise.all([
    exec(binaryPath, ["--version"], childEnv).catch(() => {
      // Host-agent version probe failed.
      log?.("Host-agent version probe failed");
      return null;
    }),
    exec(
      binaryPath,
      kind === "claude-code" ? ["auth", "status"] : ["login", "status"],
      childEnv,
    ).catch(() => {
      // Host-agent login probe failed.
      log?.("Host-agent login probe failed");
      return null;
    }),
  ]);
  let loggedIn = false,
    account: string | null = null;
  if (auth && kind === "claude-code") {
    try {
      const status = record(JSON.parse(auth.stdout));
      loggedIn = status?.loggedIn === true;
      if (loggedIn && status) {
        const method = typeof status.authMethod === "string" ? status.authMethod : "signed in";
        const plan =
          typeof status.subscriptionType === "string" ? ` (${status.subscriptionType})` : "";
        account = `${method}${plan}`;
      }
    } catch (error) {
      // Malformed JSON is expected here; retain the existing text or stream fallback.
      if (!(error instanceof SyntaxError)) {
        throw error;
      }

      /* unknown output: treat as signed out */
    }
  } else if (auth) {
    // `codex login status` prints to stdout or stderr depending on version.
    const text = `${auth.stdout}\n${auth.stderr}`;
    const match = /Logged in using (?:an? )?([^\n.]+)/i.exec(text);
    loggedIn = auth.code === 0 && !!match && !/not logged in/i.test(text);
    // API-key logins append a masked key ("API key - sk-proj-***"); keep only the method.
    if (loggedIn) {
      account = redact(match![1]!.split(/\s+-\s+/)[0]!.trim(), 40);
    }
  }
  const versionText = ver && ver.code === 0 ? version(ver.stdout) : null;
  return {
    ...base,
    installed: true,
    binaryPath,
    version: versionText,
    loggedIn,
    account,
    ready: loggedIn,
    ...(loggedIn ? {} : { fix: HOST_AGENT_FIXES[kind].login }),
  };
}

export interface DetectHostAgentsOptions {
  log?: (message: string) => void;
  /** Ignore the 60-second cache. */
  refresh?: boolean;
  env?: NodeJS.ProcessEnv;
  exec?: ProbeExec;
  now?: () => number;
}

const CACHE_MS = 60_000;
let cache: { at: number; result: Promise<HostAgentStatus[]> } | undefined;

/**
 * Detect the Codex and Claude Code CLIs and their login state, Codex first. Results are
 * cached for 60 seconds. Only version and status subcommands run; no tokens are read.
 */
export function detectHostAgents(
  options: DetectHostAgentsOptions = {},
): Promise<HostAgentStatus[]> {
  const now = options.now ?? Date.now;
  const custom = !!(options.env || options.exec);
  if (!custom && !options.refresh && cache && now() - cache.at < CACHE_MS) {
    return cache.result;
  }
  const env = options.env ?? process.env;
  const result = Promise.allSettled(
    HOST_AGENT_KINDS.map((kind) => probe(kind, env, options.exec ?? defaultExec, now, options.log)),
  ).then((results) =>
    results.map((result, index): HostAgentStatus => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      // One broken CLI must not hide another ready agent; never log the raw probe error.
      options.log?.("Host-agent probe failed; treating that agent as unavailable");
      const kind = HOST_AGENT_KINDS[index]!;
      const binaryPath = resolveHostAgentBinary(kind, env, options.log);
      return {
        kind,
        label: LABEL[kind],
        installed: !!binaryPath,
        binaryPath,
        version: null,
        loggedIn: false,
        account: null,
        ready: false,
        checkedAt: new Date(now()).toISOString(),
        fix: binaryPath ? HOST_AGENT_FIXES[kind].login : HOST_AGENT_FIXES[kind].install,
      };
    }),
  );
  if (!custom) {
    const entry = { at: now(), result };
    cache = entry;
    result.catch(() => {
      // Host-agent discovery failed; clearing the cached probe.
      options.log?.("Host-agent discovery failed; clearing the cached probe");

      if (cache === entry) {
        cache = undefined;
      }
    });
  }
  return result;
}

/** Pick the preferred ready host agent: Codex, then Claude Code. */
export function preferredHostAgent(
  statuses: readonly HostAgentStatus[],
): HostAgentStatus | undefined {
  return HOST_AGENT_KINDS.map((kind) => statuses.find((status) => status.kind === kind)).find(
    (status) => status?.ready,
  );
}
