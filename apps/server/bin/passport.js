#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const shimPath = realpathSync(fileURLToPath(import.meta.url));

async function installMcp() {
  if (args.length !== 4 || args[2] !== "--client" || args[3] !== "claude-code")
    throw new Error("Usage: passport mcp install --client claude-code (writes .mcp.json in the current directory)");
  const path = resolve(".mcp.json");
  let config = {};
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Could not parse .mcp.json. Repair it before registering Passport.");
    if (error.code !== "ENOENT") throw error;
  }
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      (config.mcpServers && (typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))))
    throw new Error("Existing .mcp.json must contain an object with an optional mcpServers object");
  const entry = { command: process.execPath, args: [shimPath, "mcp"] };
  if (process.env.PASSPORT_DATA_DIR) entry.env = { PASSPORT_DATA_DIR: resolve(process.env.PASSPORT_DATA_DIR) };
  const existing = config.mcpServers?.passport;
  if (existing && JSON.stringify(existing) !== JSON.stringify(entry))
    throw new Error(".mcp.json already has a different passport entry. Edit it manually to replace it.");
  config.mcpServers = { ...config.mcpServers, passport: entry };
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  console.log(`Registered Passport in ${path}. Keep this CLI installation available. Use one backend writer per data directory.`);
}

async function run() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    const error = new Error("Passport requires Node >=22.16 with SQLite FTS5 (Node 24 recommended).");
    error.code = "PASSPORT_RUNTIME_REQUIRED";
    throw error;
  }
  if (args[0] === "mcp" && args.slice(1).some((arg) => ["--help", "-h", "help"].includes(arg))) {
    console.log("passport mcp — start the mailbox MCP server over stdio\npassport mcp install --client claude-code — register in .mcp.json in the current directory\nUse HTTP MCP at http://127.0.0.1:4318/mcp when passport serve already owns the data directory.");
    return;
  }
  if (args[0] === "mcp" && args[1] === "install") return installMcp();
  // Early Node 22 releases gate node:sqlite behind this flag. Re-exec before
  // importing the bundle, whose static imports include SQLite.
  if (major === 22 && minor < 13 && !process.execArgv.includes("--experimental-sqlite")) {
    const child = spawn(process.execPath, ["--experimental-sqlite", shimPath, ...args], { stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    child.on("error", () => { console.error("Could not start Passport with built-in SQLite."); process.exitCode = 1; });
    child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1); });
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
      const error = new Error("This Node build lacks SQLite FTS5, required for persistent workspaces. Upgrade to Node 24 (or Node >=22.16 with FTS5). Demo mode still works on Node >=22.5.");
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
  console.error(["INVALID_COMMAND", "PASSPORT_RUNTIME_REQUIRED"].includes(error?.code) || args[1] === "install" ? error.message : "Passport failed. Check your Node version, configuration and provider credentials.");
  process.exitCode = 1;
});
