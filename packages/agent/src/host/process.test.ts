import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { runCli } from "./process.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
    return false;
  }
}

function cleanupGroup(pid: number): void {
  if (!pid) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

describe.skipIf(process.platform === "win32")("POSIX host process groups", () => {
  it("V2-3: bounds stdio drain when a descendant escapes the process group", async () => {
    let descendant = 0;
    const run = runCli({
      binary: process.execPath,
      args: [
        "-e",
        `
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
        console.log(child.pid);
        process.exit(0);
      `,
      ],
      cwd: tmpdir(),
      env: {},
      timeoutMs: 5000,
      onLine: (line) => {
        descendant = Number(line);
      },
    });
    try {
      const result = await Promise.race([
        run.done,
        delay(1500, undefined, { ref: false }).then(() => {
          throw new Error("escaped descendant kept stdio open");
        }),
      ]);
      expect(result).toMatchObject({ code: 0, timedOut: false, aborted: false });
      expect(descendant).toBeGreaterThan(0);
      // A new session deliberately escapes group signalling; only stdio settlement is guaranteed.
      expect(alive(descendant)).toBe(true);
    } finally {
      cleanupGroup(descendant);
      await run.done;
    }
  });

  it("V2-3: exit cleanup retains groups after the leader closes its stdio", async () => {
    let leader = 0;
    let descendant = 0;
    const moduleUrl = new URL("./process.ts", import.meta.url).href;
    const leaderScript = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log(process.pid); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.once("data", data => console.log(JSON.stringify({ leader: process.pid, descendant: Number(String(data).trim()) })));
      setInterval(() => {}, 1000);
    `;
    const wrapper = runCli({
      binary: process.execPath,
      args: [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `
        import { runCli } from ${JSON.stringify(moduleUrl)};
        const run = runCli({ binary: process.execPath, args: ["-e", ${JSON.stringify(leaderScript)}], cwd: ${JSON.stringify(tmpdir())}, env: {}, timeoutMs: 400, onLine: line => console.log(line) });
        await run.done;
        process.exit(0);
      `,
      ],
      cwd: tmpdir(),
      env: {},
      timeoutMs: 5000,
      onLine: (line) => {
        ({ leader, descendant } = JSON.parse(line));
      },
    });
    try {
      expect((await wrapper.done).code).toBe(0);
      expect(descendant).toBeGreaterThan(0);
      await expect.poll(() => alive(descendant), { timeout: 1000 }).toBe(false);
    } finally {
      wrapper.kill();
      cleanupGroup(leader);
    }
  });

  it.each(["pipe", "inherit"])(
    "V2-3: kills SIGTERM-resistant grandchildren after the leader exits (%s stdio)",
    async (stdio) => {
      let leader = 0;
      let descendant = 0;
      const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log(process.pid); setInterval(() => {}, 1000);'], { stdio: ["ignore", ${JSON.stringify(stdio)}, "ignore"] });
      ${stdio === "pipe" ? 'child.stdout.once("data", data => console.log(JSON.stringify({ leader: process.pid, descendant: Number(String(data).trim()) })));' : "console.log(JSON.stringify({ leader: process.pid, descendant: child.pid }));"}
      setInterval(() => {}, 1000);
    `;
      const run = runCli({
        binary: process.execPath,
        args: ["-e", script],
        cwd: tmpdir(),
        env: {},
        timeoutMs: 800,
        onLine: (line) => {
          if (line.startsWith("{")) {
            ({ leader, descendant } = JSON.parse(line));
          }
        },
      });
      try {
        const result = await Promise.race([
          run.done,
          delay(4000, undefined, { ref: false }).then(() => {
            throw new Error("stdio kept done pending");
          }),
        ]);
        expect(result.timedOut).toBe(true);
        expect(descendant).toBeGreaterThan(0);
        await expect.poll(() => alive(descendant), { timeout: 3000 }).toBe(false);
      } finally {
        run.kill();
        cleanupGroup(leader);
        await run.done;
      }
    },
    8000,
  );
});
