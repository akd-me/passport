import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { basename, isAbsolute, delimiter as platformDelimiter } from "node:path";

/**
 * A Finder- or launchd-started process gets roughly `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and no
 * locale, so `claude`/`codex` (and the `node` an npm-installed CLI needs) are missing. This reads
 * the variables the user's login shell would set, the way a terminal would see them.
 */
export type ShellEnvironmentSource = "login-shell" | "launchctl" | "fallback";

/** Variables read from the login shell by default. */
export const SHELL_ENV_NAMES = [
  "PATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "__MISE_DIFF",
  "VOLTA_HOME",
  "FNM_DIR",
  "FNM_MULTISHELL_PATH",
  "NVM_DIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const;
export type ShellEnvName = Exclude<(typeof SHELL_ENV_NAMES)[number], "PATH">;

export type ShellEnvironment = {
  source: ShellEnvironmentSource;
  /** The shell that answered (`zsh`), or null for launchctl/fallback. Never a full command. */
  shell: string | null;
  /** Shell (or launchctl) PATH first, then the inherited PATH, de-duplicated. */
  PATH: string;
} & Partial<Record<ShellEnvName, string>>;

export interface ProbeShellEnvironmentOptions {
  /** Absolute shell paths to try in order. Default: `$SHELL`, the account shell, `/bin/zsh`. */
  shells?: readonly string[];
  /** Per-shell budget before SIGTERM. */
  timeoutMs?: number;
  /** Variable names to read (letters, digits, underscore). Default {@link SHELL_ENV_NAMES}. */
  names?: readonly string[];
  /** The inherited environment. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Used on darwin when no shell answers. */
  launchctlPath?: string;
  log?: (message: string) => void;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Shells that understand `printf`, `printenv`, `;` and `||` (fish ≥ 3 does). */
const SUPPORTED_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish"]);
const KILL_GRACE_MS = 1000;
const LAUNCHCTL_TIMEOUT_MS = 2000;
const MAX_OUTPUT = 256 * 1024;
const LOCALE_NAMES = ["LANG", "LC_ALL", "LC_CTYPE"] as const;

function accountShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    // Some service accounts have no passwd entry; `$SHELL` and the default remain.
    return undefined;
  }
}

/** `$SHELL`, the account's login shell, then the platform default, de-duplicated. */
export function loginShellCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const fallback = platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  const seen = new Set<string>();
  for (const candidate of [env.SHELL, accountShell(), fallback]) {
    const shell = candidate?.trim();
    if (shell && isAbsolute(shell)) {
      seen.add(shell);
    }
  }
  return [...seen];
}

/** Join PATH values, keeping the first occurrence of each entry. */
export function mergePathValues(
  values: readonly (string | undefined)[],
  delimiter: string = platformDelimiter,
): string {
  const entries: string[] = [];
  for (const value of values) {
    for (const raw of value?.split(delimiter) ?? []) {
      const entry = raw.trim();
      if (entry && !entries.includes(entry)) {
        entries.push(entry);
      }
    }
  }
  return entries.join(delimiter);
}

function markers(nonce: string, name: string): [string, string] {
  return [`__PASSPORT_ENV_${nonce}_${name}_START__`, `__PASSPORT_ENV_${nonce}_${name}_END__`];
}

/**
 * The command handed to `shell -ilc`. Only validated variable names and fixed markers are
 * interpolated; nothing user-provided is evaluated.
 */
export function captureCommand(names: readonly string[], nonce: string): string {
  return names
    .map((name) => {
      if (!NAME.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }
      const [start, end] = markers(nonce, name);
      return `printf '%s\\n' '${start}'; printenv ${name} || true; printf '%s\\n' '${end}'`;
    })
    .join("; ");
}

function extract(output: string, nonce: string, name: string): string | undefined {
  const [start, end] = markers(nonce, name);
  const from = output.indexOf(start);
  if (from === -1) {
    return undefined;
  }
  const to = output.indexOf(end, from + start.length);
  if (to === -1) {
    return undefined;
  }
  const value = output
    .slice(from + start.length, to)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");
  return value || undefined;
}

/**
 * Run a command detached (its own process group, no controlling terminal, stdin ignored) and
 * resolve its stdout, or null on failure. On timeout the whole group gets SIGTERM, then SIGKILL
 * after a grace period, and the result is null even if rc-file helpers keep the pipe open.
 */
function capture(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let timedOut = false;
    let grace: NodeJS.Timeout | undefined;
    const child = spawn(file, args, {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const signal = (name: NodeJS.Signals) => {
      try {
        if (child.pid) {
          process.kill(-child.pid, name);
        }
      } catch {
        // ESRCH (already exited) or EPERM: nothing more to signal; the grace timer still bounds
        // the wait, so the probe resolves either way.
      }
    };
    const finish = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.stdout?.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signal("SIGTERM");
      grace = setTimeout(() => {
        signal("SIGKILL");
        finish(null);
      }, KILL_GRACE_MS);
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += chunk;
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(!timedOut && code === 0 ? stdout : null));
  });
}

/** The inherited environment minus Passport's own settings and secrets. */
function shellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("PASSPORT_")));
}

/**
 * Read PATH (and certificate, Homebrew, version-manager and locale variables) from the user's
 * login shell; on macOS fall back to `launchctl getenv PATH`; otherwise keep the inherited PATH.
 * Never throws for a missing, slow or unsupported shell. Nushell, xonsh and other non-POSIX
 * shells are skipped in favour of the next candidate.
 */
export async function probeShellEnvironment(
  options: ProbeShellEnvironmentOptions = {},
): Promise<ShellEnvironment> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const names = options.names ?? SHELL_ENV_NAMES;
  const delimiter = platform === "win32" ? ";" : ":";
  const inherited = env.PATH ?? env.Path ?? "";
  const fallback: ShellEnvironment = {
    source: "fallback",
    shell: null,
    PATH: mergePathValues([inherited], delimiter),
  };
  if (platform === "win32") {
    return fallback;
  }
  const nonce = randomBytes(8).toString("hex").toUpperCase();
  const command = captureCommand(names.includes("PATH") ? names : ["PATH", ...names], nonce);
  const childEnv = shellEnv(env);
  for (const shell of options.shells ?? loginShellCandidates(env, platform)) {
    const name = basename(shell).toLowerCase();
    if (!isAbsolute(shell) || !SUPPORTED_SHELLS.has(name)) {
      options.log?.(`Skipping unsupported login shell ${name}`);
      continue;
    }
    const output = await capture(shell, ["-ilc", command], childEnv, options.timeoutMs ?? 5000);
    const path = output === null ? undefined : extract(output, nonce, "PATH");
    if (output === null || !path) {
      options.log?.(`Login shell ${name} did not report PATH`);
      continue;
    }
    const result: ShellEnvironment = {
      source: "login-shell",
      shell: name,
      PATH: mergePathValues([path, inherited], delimiter),
    };
    for (const variable of names) {
      const value = variable === "PATH" ? undefined : extract(output, nonce, variable);
      if (value !== undefined) {
        (result as Record<string, string | null>)[variable] = value;
      }
    }
    return result;
  }
  if (platform === "darwin") {
    const output = await capture(
      options.launchctlPath ?? "/bin/launchctl",
      ["getenv", "PATH"],
      childEnv,
      LAUNCHCTL_TIMEOUT_MS,
    );
    const path = output?.trim();
    if (path) {
      return {
        source: "launchctl",
        shell: null,
        PATH: mergePathValues([path, inherited], delimiter),
      };
    }
    options.log?.("launchctl did not report PATH; keeping the inherited PATH");
  }
  return fallback;
}

/**
 * Write a probe result into `env` (default `process.env`). Without any locale on macOS,
 * sets `LC_CTYPE=en_US.UTF-8` so CLIs do not fall back to ASCII.
 */
export function applyShellEnvironment(
  result: ShellEnvironment,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  for (const [key, value] of Object.entries(result)) {
    if (key === "source" || key === "shell" || typeof value !== "string" || !value) {
      continue;
    }
    env[key] = value;
  }
  if (platform === "darwin" && LOCALE_NAMES.every((name) => !env[name])) {
    env.LC_CTYPE = "en_US.UTF-8";
  }
}
