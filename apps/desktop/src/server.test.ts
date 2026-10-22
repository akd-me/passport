import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const userData = mkdtempSync(join(tmpdir(), "passport-desktop-app-"));
vi.mock("electron", () => ({
  app: { getPath: () => userData, isPackaged: false },
}));
const { ServerSupervisor } = await import("./server");
type State = InstanceType<typeof ServerSupervisor>["state"];

const fake = fileURLToPath(new URL("./fixtures/fake-serve.mjs", import.meta.url));
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe("ServerSupervisor", () => {
  let dataDir: string;
  let marker: string;
  let supervisor: InstanceType<typeof ServerSupervisor>;
  let states: State[];
  const outside: ChildProcess[] = [];
  const spawned = (): number[] => {
    try {
      return readFileSync(join(dataDir, "spawned.log"), "utf8").trim().split("\n").map(Number);
    } catch {
      return [];
    }
  };
  const report = (pid: number) =>
    JSON.parse(readFileSync(join(dataDir, `report-${pid}.json`), "utf8"));
  /** A `passport serve` the app did not start (a terminal, or an earlier crashed launch). */
  const serveOutside = (env: Record<string, string> = {}) => {
    const child = spawn(process.execPath, [fake, "serve"], {
      env: { ...process.env, PASSPORT_DATA_DIR: dataDir, ...env },
      stdio: "ignore",
    });
    outside.push(child);
    return child;
  };
  const make = (key: string | null = "app-key") => {
    supervisor = new ServerSupervisor(dataDir, { masterKey: () => key, spawnMarker: marker });
    supervisor.on("state", (state) => states.push(state));
    return supervisor;
  };
  const ready = () => states.filter((state) => state.status === "ready");

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "passport-desktop-data-"));
    marker = join(dataDir, "..", `${dataDir.split("/").at(-1)}-server-child.json`);
    states = [];
    vi.stubEnv("PASSPORT_DESKTOP_SERVER_ENTRY", fake);
    vi.stubEnv("PASSPORT_PORT", String(await freePort()));
    vi.stubEnv("PASSPORT_API_TOKEN", "");
    vi.stubEnv("PASSPORT_HOST", "");
  });
  afterEach(async () => {
    await supervisor?.stop();
    for (const child of outside.splice(0)) {
      child.kill("SIGKILL");
    }
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(marker, { force: true });
  });

  it("R3-3: Restart Server during startup leaves exactly one server, and Quit stops it", async () => {
    vi.stubEnv("FAKE_DELAY_MS", "1500");
    make().start();
    await until(() => spawned().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await supervisor.restart(); // the review's race: an in-flight connect() and a restart
    await until(() => ready().length > 0);
    await new Promise((resolve) => setTimeout(resolve, 2500)); // a stale loop would spawn again
    const live = spawned().filter(alive);
    expect(live).toHaveLength(1);
    expect(ready()).toHaveLength(1);
    expect(supervisor.state).toMatchObject({ status: "ready", pid: live[0] });
    await supervisor.stop();
    await until(() => !spawned().some(alive));
  }, 30_000);

  it("R3-4: the key reaches the child on its bootstrap pipe, never in its environment", async () => {
    vi.stubEnv("PASSPORT_MASTER_KEY", "inherited-by-the-app");
    make("sealed-key").start();
    await until(() => ready().length > 0);
    const child = report(spawned()[0] as number);
    expect(child.envKey).toBeNull();
    expect(child.bootstrap).toEqual({ masterKey: "sealed-key" });
    expect(child.parent).toBe("desktop");
  }, 30_000);

  it("R3-5: a server left by a crashed launch is stopped and replaced, not attached", async () => {
    // A user's own `passport serve` is attached to, as before.
    const theirs = serveOutside({ PASSPORT_PORT: process.env.PASSPORT_PORT as string });
    await until(() => {
      try {
        return JSON.parse(readFileSync(join(dataDir, "owner.lock"), "utf8")).pid === theirs.pid;
      } catch {
        return false;
      }
    });
    make().start();
    await until(() => ready().length > 0);
    expect(supervisor.state).toMatchObject({ attached: true, pid: theirs.pid });
    await supervisor.stop();
    expect(alive(theirs.pid as number)).toBe(true);
    theirs.kill("SIGTERM");
    await until(() => !alive(theirs.pid as number));

    // The app's own child, orphaned when its main process was killed (marker left behind).
    states = [];
    make().start();
    await until(() => ready().length > 0);
    const orphan = (supervisor.state as { pid: number }).pid;
    expect(JSON.parse(readFileSync(marker, "utf8")).pid).toBe(orphan);
    const app = supervisor;
    supervisor = make(); // the relaunch; the first supervisor is "dead" and never stops its child
    (app as unknown as { stopping: boolean }).stopping = true;
    supervisor.start();
    await until(() => ready().length > 1);
    expect(alive(orphan)).toBe(false);
    expect(supervisor.state).toMatchObject({ status: "ready", attached: false });
    expect((supervisor.state as { pid: number }).pid).not.toBe(orphan);
  }, 45_000);

  it("R3-9: an unreadable api-token fails with its errno and keeps retrying", async () => {
    writeFileSync(join(dataDir, "api-token"), "x".repeat(64), { mode: 0o600 });
    chmodSync(join(dataDir, "api-token"), 0o000);
    make().start();
    await until(() => states.some((state) => state.status === "failed"));
    expect(states.find((state) => state.status === "failed")).toMatchObject({
      detail: expect.stringContaining("EACCES"),
    });
    chmodSync(join(dataDir, "api-token"), 0o600);
    rmSync(join(dataDir, "api-token"));
    await until(() => ready().length > 0, 20_000); // the retry recovers on its own
  }, 30_000);

  it("R3-10: attaches to the port the owner recorded, and names a demo owner plainly", async () => {
    const port = await freePort();
    const theirs = serveOutside({ PASSPORT_PORT: String(port) });
    await until(() => {
      try {
        return JSON.parse(readFileSync(join(dataDir, "owner.lock"), "utf8")).port === port;
      } catch {
        return false;
      }
    });
    make().start(); // PASSPORT_PORT (the app's) differs from the owner's
    await until(() => ready().length > 0);
    expect(supervisor.state).toMatchObject({ origin: `http://127.0.0.1:${port}`, attached: true });
    await supervisor.stop();
    theirs.kill("SIGTERM");
    await until(() => !alive(theirs.pid as number));

    const demo = serveOutside({ PASSPORT_PORT: String(port), FAKE_MODE: "demo" });
    await until(() => {
      try {
        return JSON.parse(readFileSync(join(dataDir, "owner.lock"), "utf8")).pid === demo.pid;
      } catch {
        return false;
      }
    });
    states = [];
    make().start();
    await until(() => states.some((state) => state.status === "failed"));
    expect(supervisor.state).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("passport demo"),
    });
  }, 30_000);

  it("R3-6: a rotated api-token yields a new generation so the window signs in again", async () => {
    make().start();
    await until(() => ready().length > 0);
    const before = supervisor.state as Extract<State, { status: "ready" }>;
    supervisor.refreshToken();
    expect(ready()).toHaveLength(1); // unchanged token: nothing to do
    const token = "b".repeat(64);
    writeFileSync(join(dataDir, "api-token"), token);
    supervisor.refreshToken();
    expect(supervisor.state).toMatchObject({ token, generation: before.generation + 1 });
  }, 30_000);
});
