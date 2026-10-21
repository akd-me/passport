import { spawn } from "node:child_process";

export interface CliRunOptions {
  binary: string;
  args: string[];
  /** Written to stdin, which is then closed. */
  input?: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called for each complete stdout line. */
  onLine?: (line: string) => void;
}

export interface CliRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  /** Bounded tail of stderr. Never surface it verbatim; it may contain secrets. */
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

const MAX_CAPTURE = 64 * 1024;
const live = new Set<number>();
let exitHook = false;

/** Detached groups do not receive the parent's Ctrl-C; stop them when Passport exits. */
function track(pid: number | undefined): void {
  if (!pid || process.platform === "win32") {
    return;
  }
  live.add(pid);
  if (exitHook) {
    return;
  }
  exitHook = true;
  process.once("exit", () => {
    for (const group of live) {
      try {
        process.kill(-group, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  });
}

/**
 * Run a CLI to completion. The child gets its own process group on POSIX so a timeout or
 * abort also stops grandchildren (MCP servers the CLI launched).
 */
export function runCli(options: CliRunOptions): { done: Promise<CliRunResult>; kill: () => void } {
  let killed = false,
    timedOut = false,
    aborted = false;
  const child = spawn(options.binary, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  track(child.pid);
  const kill = () => {
    if (killed || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    killed = true;
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, sig);
        } else {
          child.kill(sig);
        }
      } catch {
        /* already gone */
      }
    };
    signal("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        signal("SIGKILL");
      }
    }, 2000).unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, options.timeoutMs);
  timer.unref();
  const onAbort = () => {
    aborted = true;
    kill();
  };
  if (options.signal?.aborted) {
    onAbort();
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }

  let stdout = "",
    stderr = "",
    pending = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length < MAX_CAPTURE * 16) {
      stdout += chunk;
    }
    pending += chunk;
    let index = pending.indexOf("\n");
    while (index >= 0) {
      const line = pending.slice(0, index).trim();
      pending = pending.slice(index + 1);
      if (line) {
        options.onLine?.(line);
      }
      index = pending.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_CAPTURE);
  });
  child.stdin.on("error", () => {
    /* child exited before reading stdin */
  });
  child.stdin.end(options.input ?? "");

  const done = new Promise<CliRunResult>((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (child.pid) {
        live.delete(child.pid);
      }
      options.signal?.removeEventListener("abort", onAbort);
      const rest = pending.trim();
      pending = "";
      if (rest) {
        options.onLine?.(rest);
      }
      resolve({ code, signal, stdout, stderr, timedOut, aborted });
    });
  });
  return {
    done,
    kill: () => {
      aborted = true;
      kill();
    },
  };
}
