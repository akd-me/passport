import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

it("R3-5/R3-18: a server started by Passport.app stops when the app's pipe closes and logs no token", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "passport-parent-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("PASSPORT_")),
  );
  const child = spawn(process.execPath, ["--import", "tsx", cli, "serve"], {
    env: {
      ...env,
      PASSPORT_DATA_DIR: dataDir,
      PASSPORT_PORT: "0",
      PASSPORT_MCP_PORT: "0",
      PASSPORT_SHELL_ENV_PREPARED: "1",
      PASSPORT_PARENT: "desktop",
      PASSPORT_BOOTSTRAP_FD: "3",
    },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  (child.stdio[3] as NodeJS.WritableStream).end(JSON.stringify({ masterKey: "app-key" }));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    const deadline = Date.now() + 30_000;
    while (!output.includes("workspace →") && Date.now() < deadline && child.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(output).toContain("real workspace → http://127.0.0.1:");
    expect(output).not.toContain("token=");
    expect(existsSync(join(dataDir, "owner.lock"))).toBe(true);
    expect(existsSync(join(dataDir, "master.key"))).toBe(false);
    // What a crashed (SIGKILLed) main process looks like to its child: EOF on the pipe.
    child.stdin?.end();
    expect(await exited).toBe(0);
    expect(existsSync(join(dataDir, "owner.lock"))).toBe(false);
  } finally {
    child.kill("SIGKILL");
    await rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);
