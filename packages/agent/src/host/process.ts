import { spawn } from "node:child_process";

export interface CliRunOptions {
  log?: (message: string) => void;
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
const KILL_GRACE_MS = 2000;
const STDIO_GRACE_MS = 250;
interface ProcessGroup {
  pid: number;
  log?: (message: string) => void;
  escalation?: NodeJS.Timeout;
  poll?: NodeJS.Timeout;
}
const live = new Map<number, ProcessGroup>();
let exitHook = false;

function forget(group: ProcessGroup): void {
  clearTimeout(group.escalation);
  clearInterval(group.poll);
  live.delete(group.pid);
}

/** Only ESRCH confirms the group is gone; the leader's exit/close is insufficient. */
function signalGroup(group: ProcessGroup, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-group.pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      forget(group);
      return false;
    }
    // Retain the group for exit cleanup if signalling or checking it failed.
    group.log?.("Host-agent process group signal failed");
    return true;
  }
}

/** Detached groups do not receive the parent's Ctrl-C; stop them when Passport exits. */
function track(pid: number | undefined, log?: (message: string) => void): ProcessGroup | undefined {
  if (!pid || process.platform === "win32") {
    return;
  }
  const group = { pid, log };
  live.set(pid, group);
  if (!exitHook) {
    exitHook = true;
    process.once("exit", () => {
      for (const group of live.values()) {
        // Exit hooks cannot wait for a grace period: kill even SIGTERM-resistant helpers.
        signalGroup(group, "SIGKILL");
      }
    });
  }
  return group;
}

/**
 * Run a CLI to completion. The child gets its own process group on POSIX so a timeout or
 * abort also stops grandchildren (MCP servers the CLI launched). A descendant that creates
 * its own group/session escapes this cleanup. Windows retains direct-child termination.
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
  const group = track(child.pid, options.log);
  const kill = () => {
    if (killed) {
      return;
    }
    killed = true;
    if (group) {
      if (!signalGroup(group, "SIGTERM")) {
        return;
      }
      // The leader may exit before its helpers; escalation belongs to the group.
      group.escalation = setTimeout(() => signalGroup(group, "SIGKILL"), KILL_GRACE_MS);
      group.escalation.unref();
      group.poll = setInterval(() => signalGroup(group, 0), 100);
      group.poll.unref();
      return;
    }
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, KILL_GRACE_MS).unref();
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
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      // Descendants holding inherited pipes must not keep `done` pending indefinitely.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      const rest = pending.trim();
      pending = "";
      if (rest) {
        options.onLine?.(rest);
      }
      resolve({ code, signal, stdout, stderr, timedOut, aborted });
    };
    child.once("error", (error) => {
      settled = true;
      cleanup();
      if (group) {
        kill();
      }
      reject(error);
    });
    child.once("exit", (code, signal) => {
      // Normal leader exit also ends the invocation and any helpers left in its group.
      kill();
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      drainTimer = setTimeout(() => finish(code, signal), STDIO_GRACE_MS);
    });
    child.once("close", (code, signal) => {
      if (group) {
        signalGroup(group, 0);
      }
      finish(code, signal);
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
