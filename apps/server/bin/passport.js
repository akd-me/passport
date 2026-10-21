#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const shimPath = realpathSync(fileURLToPath(import.meta.url));

async function run() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    const error = new Error(
      "Passport requires Node >=22.16 with SQLite FTS5 (Node 24 recommended).",
    );
    error.code = "PASSPORT_RUNTIME_REQUIRED";
    throw error;
  }
  // Early Node 22 releases gate node:sqlite behind this flag. Re-exec before
  // importing the bundle, whose static imports include SQLite.
  if (major === 22 && minor < 13 && !process.execArgv.includes("--experimental-sqlite")) {
    const child = spawn(process.execPath, ["--experimental-sqlite", shimPath, ...args], {
      stdio: "inherit",
    });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    child.on("error", () => {
      console.error("Could not start Passport with built-in SQLite.");
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
    });
    return;
  }
  const command = args[0] ?? "serve";
  const demo = command === "demo" || (command !== "mcp" && args.includes("--demo"));
  if (!["--help", "-h", "help"].includes(command) && !demo) {
    const { DatabaseSync } = await import("node:sqlite");
    const probe = new DatabaseSync(":memory:");
    try {
      probe.exec("CREATE VIRTUAL TABLE passport_runtime_probe USING fts5(content)");
    } catch {
      const error = new Error(
        "This Node build lacks SQLite FTS5, required for persistent workspaces. Upgrade to Node 24 (or Node >=22.16 with FTS5). Demo mode still works on Node >=22.5.",
      );
      error.code = "PASSPORT_RUNTIME_REQUIRED";
      throw error;
    } finally {
      probe.close();
    }
  }
  // Installed package layout; when linked from the workspace use tsc's output.
  const bundled = new URL("../dist/server/cli.js", import.meta.url);
  let entry;
  try {
    await readFile(bundled);
    entry = bundled;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    entry = new URL("../dist/cli.js", import.meta.url);
  }
  const { main } = await import(entry.href);
  await main(args);
}

run().catch((error) => {
  console.error(
    [
      "INVALID_COMMAND",
      "PASSPORT_RUNTIME_REQUIRED",
      "API_UNAUTHORIZED",
      "SERVER_UNAVAILABLE",
      "WRONG_SERVER",
      "OWNER_RUNNING",
      "OWNER_BUSY",
    ].includes(error?.code) || args[1] === "install"
      ? error.message
      : "Passport failed. Check your Node version, configuration and provider credentials.",
  );
  process.exitCode = 1;
});
