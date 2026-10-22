// Owns the `passport serve` child (or attaches to one the CLI already runs) and restarts it with
// backoff. The child is Electron's own binary in Node mode, so no second runtime ships.
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { activeOwner, type Health, health, readToken, serverAddress } from "./discovery";
import { log, rotatedLog, serverEntry } from "./paths";
import { forgetSpawn, ownOrphan, recordSpawn } from "./spawn-marker";

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

export interface SupervisorOptions {
  /** The key for the child's bootstrap pipe (null: the server keeps its master.key behaviour). */
  masterKey: () => string | null;
  /** Where the app records the child it spawned, so a later launch can stop an orphan. */
  spawnMarker: string;
}

const STARTUP_TIMEOUT_MS = 60_000;
const ATTACH_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const MONITOR_MS = 5_000;
const STABLE_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

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

/** A filesystem or spawn failure, with its errno, for the window and menu bar. */
const describeError = (error: unknown) =>
  `Passport could not start its server (${(error as NodeJS.ErrnoException).code ?? (error as Error).name}: ${(error as Error).message}).`;

/** Children without the app's secrets: the key goes over the bootstrap pipe instead. */
function childEnvironment(dataDir: string, key: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PASSPORT_MASTER_KEY;
  delete env.PASSPORT_BOOTSTRAP_FD;
  return {
    ...env,
    PASSPORT_DATA_DIR: dataDir,
    ELECTRON_RUN_AS_NODE: "1",
    PASSPORT_PARENT: "desktop",
    ...(key ? { PASSPORT_BOOTSTRAP_FD: "3" } : {}),
  };
}

export class ServerSupervisor extends EventEmitter<{ state: [ServerState] }> {
  state: ServerState = { status: "starting", detail: "Starting Passport…" };
  /** Every child this app started and has not seen exit; Quit stops all of them. */
  private readonly children = new Set<ChildProcess>();
  private stopping = false;
  /** Bumped by start/restart/stop and each retry; an older connect() gives up at its next step. */
  private attemptId = 0;
  private attempt = 0;
  private generation = 0;
  private readyAt = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private monitor: NodeJS.Timeout | undefined;

  constructor(
    private readonly dataDir: string,
    private readonly options: SupervisorOptions,
  ) {
    super();
  }

  start(): void {
    void this.connect(++this.attemptId);
  }

  /** Drop the current server and connect again now (tray "Restart server"). */
  async restart(): Promise<void> {
    const id = ++this.attemptId;
    clearTimeout(this.retryTimer);
    clearInterval(this.monitor);
    this.set({ status: "starting", detail: "Restarting…" });
    await this.stopChildren();
    if (id !== this.attemptId || this.stopping) {
      return;
    }
    clearTimeout(this.retryTimer);
    this.attempt = 0;
    void this.connect(id);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.attemptId += 1;
    clearTimeout(this.retryTimer);
    clearInterval(this.monitor);
    await this.stopChildren();
  }

  /** The server answered 401 to the window: the token file may have been rotated. */
  refreshToken(): void {
    const state = this.state;
    if (state.status !== "ready") {
      return;
    }
    let token: string | null = null;
    try {
      token = readToken(this.dataDir);
    } catch (error) {
      log("warn", `Could not re-read api-token (${(error as NodeJS.ErrnoException).code})`);
    }
    if (token && token !== state.token) {
      log("info", "api-token changed; signing the window in again");
      this.generation += 1;
      this.set({ ...state, token, generation: this.generation });
    }
  }

  private set(state: ServerState): void {
    this.state = state;
    this.emit("state", state);
  }

  private current(id: number): boolean {
    return id === this.attemptId && !this.stopping;
  }

  private async connect(id: number): Promise<void> {
    try {
      await this.connectOnce(id);
    } catch (error) {
      // EACCES/ENOSPC/EISDIR on the token, lease, config or log: report it and keep retrying.
      log("error", describeError(error));
      this.fail(id, describeError(error));
    }
  }

  private async connectOnce(id: number): Promise<void> {
    if (!this.current(id)) {
      return;
    }
    let owner = activeOwner(this.dataDir);
    if (owner && ownOrphan(this.options.spawnMarker, owner, this.dataDir)) {
      // Our own child from a launch that crashed: stop it and start fresh, never attach.
      log("warn", `Stopping passport serve (pid ${owner.pid}) left by an earlier app launch`);
      this.set({ status: "starting", detail: "Stopping the previous Passport server…" });
      await this.stopPid(owner.pid);
      forgetSpawn(this.options.spawnMarker);
      if (!this.current(id)) {
        return;
      }
      owner = activeOwner(this.dataDir);
    }
    const { origin, port } = serverAddress(this.dataDir, process.env, owner);
    if (owner) {
      if (owner.mode === "demo") {
        this.fail(
          id,
          `passport demo (pid ${owner.pid}) is using this data directory. Stop it to use Passport.`,
        );
        return;
      }
      this.set({ status: "starting", detail: `Connecting to passport serve (pid ${owner.pid})…` });
      const result = await this.waitHealthy(origin, ATTACH_TIMEOUT_MS, () => this.current(id));
      if (!this.current(id)) {
        return;
      }
      if (result === "ok") {
        this.ready(id, origin, true, owner.pid);
        this.watchAttached(id, origin);
      } else {
        this.fail(id, describe(result, port));
      }
      return;
    }
    const occupied = await health(origin, readToken(this.dataDir));
    if (!this.current(id)) {
      return;
    }
    if (occupied !== "down") {
      this.fail(
        id,
        occupied === "wrong-server"
          ? describe(occupied, port)
          : `Port ${port} already runs a Passport server for a different data directory. Stop it, or set PASSPORT_PORT.`,
      );
      return;
    }
    this.set({ status: "starting", detail: "Starting the Passport server…" });
    const child = this.spawnChild();
    const result = await this.waitHealthy(
      origin,
      STARTUP_TIMEOUT_MS,
      () => running(child) && this.current(id),
    );
    if (!this.current(id)) {
      // A restart or quit took over; it stops every child, including this one.
      return;
    }
    if (result === "ok" && running(child)) {
      this.ready(id, origin, false, child.pid ?? null);
      return;
    }
    await this.stopChild(child);
    this.fail(id, describe(running(child) ? result : "exited", port));
  }

  private spawnChild(): ChildProcess {
    const key = this.options.masterKey();
    const logPath = rotatedLog("server.log");
    const fd = openSync(logPath, "a", 0o600);
    let child: ChildProcess;
    try {
      writeSync(fd, `\n--- ${new Date().toISOString()} Passport.app starting passport serve\n`);
      // stdin stays open for the child's lifetime: EOF tells it the app is gone. fd 3 carries
      // the key once and is closed, so it is never in argv or in the environment `ps` shows.
      child = spawn(process.execPath, [serverEntry(), "serve"], {
        cwd: homedir(),
        env: childEnvironment(this.dataDir, !!key),
        stdio: ["pipe", fd, fd, "pipe"],
      });
    } finally {
      closeSync(fd);
    }
    const bootstrap = child.stdio[3] as NodeJS.WritableStream | null;
    // A child that dies at once closes its pipes; the exit handler reports that instead.
    child.stdin?.on("error", () => {});
    bootstrap?.on("error", () => {});
    bootstrap?.end(key ? JSON.stringify({ masterKey: key }) : "");
    this.children.add(child);
    if (child.pid) {
      recordSpawn(this.options.spawnMarker, child.pid, this.dataDir);
    }
    log("info", `Spawned passport serve (pid ${child.pid ?? "?"}); output in ${logPath}`);
    child.once("error", () => {
      log("error", "Could not spawn the Passport server process");
    });
    child.once("exit", (code, signal) => {
      this.children.delete(child);
      if (child.pid) {
        forgetSpawn(this.options.spawnMarker, child.pid);
      }
      log("warn", `passport serve exited (code ${code ?? "none"}, signal ${signal ?? "none"})`);
      const wasServing =
        this.state.status === "ready" && !this.state.attached && this.state.pid === child.pid;
      if (wasServing && !this.stopping) {
        this.fail(this.attemptId, "The Passport server stopped unexpectedly. Restarting…");
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

  private ready(id: number, origin: string, attached: boolean, pid: number | null): void {
    if (!this.current(id)) {
      return;
    }
    const token = readToken(this.dataDir);
    if (!token) {
      this.fail(id, "The server is running but its api-token is unreadable.");
      return;
    }
    this.generation += 1;
    this.readyAt = Date.now();
    log("info", `Server ready at ${origin} (${attached ? "attached" : "spawned"})`);
    this.set({ status: "ready", origin, token, attached, pid, generation: this.generation });
  }

  /** An attached server can stop at any time; when it does, take over the data directory. */
  private watchAttached(id: number, origin: string): void {
    let misses = 0;
    clearInterval(this.monitor);
    this.monitor = setInterval(async () => {
      let result: Health = "down";
      try {
        result = await health(origin, readToken(this.dataDir));
      } catch (error) {
        log("warn", `Could not check the attached server (${(error as Error).name})`);
      }
      if (!this.current(id)) {
        return;
      }
      misses = result === "ok" ? 0 : misses + 1;
      if (misses >= 2) {
        clearInterval(this.monitor);
        log("warn", "Lost the attached passport serve; reconnecting");
        this.set({ status: "starting", detail: "Reconnecting…" });
        void this.connect(++this.attemptId);
      }
    }, MONITOR_MS);
  }

  private fail(id: number, detail: string): void {
    if (!this.current(id)) {
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
    this.retryTimer = setTimeout(() => void this.connect(++this.attemptId), delay);
  }

  private async stopChildren(): Promise<void> {
    await Promise.all([...this.children].map((child) => this.stopChild(child)));
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    if (!running(child)) {
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

  /** Stops a process this app spawned in an earlier launch (not our child any more). */
  private async stopPid(pid: number): Promise<void> {
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        // ESRCH: it has exited.
        return false;
      }
    };
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
      return;
    }
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (alive() && Date.now() < deadline) {
      await sleep(200);
    }
    if (alive()) {
      process.kill(pid, "SIGKILL");
    }
  }
}
