// Owns the `passport serve` child (or attaches to one the CLI already runs) and restarts it with
// backoff. The child is Electron's own binary in Node mode, so no second runtime ships.
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { activeOwner, type Health, health, readToken, serverAddress } from "./discovery";
import { log, rotatedLog, serverEntry } from "./paths";

export type ServerState =
  | { status: "starting"; detail: string }
  | {
      status: "ready";
      origin: string;
      token: string;
      /** True when an external `passport serve` owns the data directory. */
      attached: boolean;
      pid: number | null;
      /** Changes whenever a different server instance (and so a new session table) is in use. */
      generation: number;
    }
  | { status: "failed"; detail: string };

const STARTUP_TIMEOUT_MS = 60_000;
const ATTACH_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const MONITOR_MS = 5_000;
const STABLE_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function describe(result: Health | "exited" | "timeout", port: number): string {
  switch (result) {
    case "unauthorized":
      return "The running server rejected this data directory's API token. If it uses PASSPORT_API_TOKEN, start the app with the same value.";
    case "wrong-server":
      return `Port ${port} answers, but not as a persistent Passport server. Set PASSPORT_PORT or "port" in passport.config.json.`;
    case "exited":
      return "The server exited during startup. See server.log for the reason.";
    default:
      return "The server did not become ready in time. See server.log.";
  }
}

export class ServerSupervisor extends EventEmitter<{ state: [ServerState] }> {
  state: ServerState = { status: "starting", detail: "Starting Passport…" };
  private child: ChildProcess | null = null;
  private stopping = false;
  private attempt = 0;
  private generation = 0;
  private readyAt = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private monitor: NodeJS.Timeout | undefined;

  constructor(
    private readonly dataDir: string,
    /** Extra child environment (PASSPORT_MASTER_KEY); resolved once per spawn. */
    private readonly childEnv: () => NodeJS.ProcessEnv,
  ) {
    super();
  }

  start(): void {
    void this.connect();
  }

  /** Drop the current server and connect again now (tray "Restart server"). */
  async restart(): Promise<void> {
    clearTimeout(this.retryTimer);
    clearInterval(this.monitor);
    // Leave "ready" first so the child's exit handler does not schedule a second retry.
    this.set({ status: "starting", detail: "Restarting…" });
    await this.stopChild();
    this.attempt = 0;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.monitor);
    await this.stopChild();
  }

  private set(state: ServerState): void {
    this.state = state;
    this.emit("state", state);
  }

  private async connect(): Promise<void> {
    if (this.stopping) {
      return;
    }
    const { origin, port } = serverAddress(this.dataDir);
    const owner = activeOwner(this.dataDir);
    if (owner) {
      this.set({ status: "starting", detail: `Connecting to passport serve (pid ${owner.pid})…` });
      const result = await this.waitHealthy(origin, ATTACH_TIMEOUT_MS, () => true);
      if (result === "ok") {
        this.ready(origin, true, owner.pid);
        this.watchAttached(origin);
      } else {
        this.fail(describe(result, port));
      }
      return;
    }
    const occupied = await health(origin, readToken(this.dataDir));
    if (occupied !== "down") {
      this.fail(
        occupied === "wrong-server"
          ? describe(occupied, port)
          : `Port ${port} already runs a Passport server for a different data directory. Stop it, or set PASSPORT_PORT.`,
      );
      return;
    }
    this.set({ status: "starting", detail: "Starting the Passport server…" });
    const child = this.spawnChild();
    const alive = () => child.exitCode === null && child.signalCode === null;
    const result = await this.waitHealthy(origin, STARTUP_TIMEOUT_MS, alive);
    if (this.stopping) {
      return;
    }
    if (result === "ok") {
      this.ready(origin, false, child.pid ?? null);
      return;
    }
    if (alive()) {
      await this.stopChild();
    }
    this.fail(describe(result, port));
  }

  private spawnChild(): ChildProcess {
    const logPath = rotatedLog("server.log");
    const fd = openSync(logPath, "a", 0o600);
    writeSync(fd, `\n--- ${new Date().toISOString()} Passport.app starting passport serve\n`);
    const child = spawn(process.execPath, [serverEntry(), "serve"], {
      cwd: homedir(),
      env: { ...process.env, ...this.childEnv(), ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    this.child = child;
    log("info", `Spawned passport serve (pid ${child.pid ?? "?"}); output in ${logPath}`);
    child.once("error", () => {
      log("error", "Could not spawn the Passport server process");
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      log("warn", `passport serve exited (code ${code ?? "none"}, signal ${signal ?? "none"})`);
      const wasServing =
        this.state.status === "ready" && !this.state.attached && this.state.pid === child.pid;
      if (wasServing && !this.stopping) {
        this.fail("The Passport server stopped unexpectedly. Restarting…");
      }
    });
    return child;
  }

  private async waitHealthy(
    origin: string,
    timeoutMs: number,
    alive: () => boolean,
  ): Promise<Health | "exited" | "timeout"> {
    const deadline = Date.now() + timeoutMs;
    let last: Health = "down";
    while (Date.now() < deadline && !this.stopping) {
      if (!alive()) {
        return "exited";
      }
      last = await health(origin, readToken(this.dataDir));
      if (last === "ok") {
        return last;
      }
      await sleep(300);
    }
    return last === "down" ? "timeout" : last;
  }

  private ready(origin: string, attached: boolean, pid: number | null): void {
    const token = readToken(this.dataDir);
    if (!token) {
      this.fail("The server is running but its api-token is unreadable.");
      return;
    }
    this.generation += 1;
    this.readyAt = Date.now();
    log("info", `Server ready at ${origin} (${attached ? "attached" : "spawned"})`);
    this.set({ status: "ready", origin, token, attached, pid, generation: this.generation });
  }

  /** An attached server can stop at any time; when it does, take over the data directory. */
  private watchAttached(origin: string): void {
    let misses = 0;
    clearInterval(this.monitor);
    this.monitor = setInterval(async () => {
      const result = await health(origin, readToken(this.dataDir));
      misses = result === "ok" ? 0 : misses + 1;
      if (misses >= 2) {
        clearInterval(this.monitor);
        log("warn", "Lost the attached passport serve; reconnecting");
        this.set({ status: "starting", detail: "Reconnecting…" });
        void this.connect();
      }
    }, MONITOR_MS);
  }

  private fail(detail: string): void {
    if (this.stopping) {
      return;
    }
    if (this.readyAt && Date.now() - this.readyAt > STABLE_MS) {
      this.attempt = 0;
    }
    const delay = Math.min(1000 * 2 ** this.attempt, MAX_BACKOFF_MS);
    this.attempt += 1;
    log("warn", `${detail} Retrying in ${Math.round(delay / 1000)} s.`);
    this.set({ status: "failed", detail });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const graceful = await Promise.race([exited.then(() => true), sleep(STOP_TIMEOUT_MS)]);
    if (!graceful) {
      log("warn", "passport serve ignored SIGTERM for 10 s; killing it");
      child.kill("SIGKILL");
      await Promise.race([exited, sleep(2000)]);
    }
  }
}
