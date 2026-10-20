// Installs the tarball outside the workspace: missing runtime dependencies,
// leaked workspace references, broken bin shims and missing UI assets fail here.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";

if (process.argv.length !== 3) throw new Error("Usage: node scripts/smoke-package.mjs <tarball>");
const tarball = resolve(process.argv[2]);
const directory = await mkdtemp(join(tmpdir(), "passport-package-"));
const env = { ...process.env, PASSPORT_DATA_DIR: join(directory, "data") };
// The smoke check never uses developer credentials or a real mailbox.
for (const key of ["PASSPORT_MASTER_KEY", "PASSPORT_LLM_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NODE_PATH"])
  delete env[key];
env.PASSPORT_HOST = "127.0.0.1";
env.PASSPORT_LLM_PROVIDER = "anthropic";
env.PASSPORT_LLM_MODEL = "smoke-no-model-calls";
env.PASSPORT_LLM_BASE_URL = "";
env.PASSPORT_MCP_PORT = "0";

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: directory, env, encoding: "utf8", timeout: 120_000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${program} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function smokeServer(cli, mode) {
  const port = await freePort();
  const child = spawn(process.execPath, [cli, mode], { cwd: directory, env: { ...env, PASSPORT_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise((resolve) => child.once("close", resolve));
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  try {
    const base = `http://127.0.0.1:${port}`;
    let healthy = false;
    let token = env.PASSPORT_API_TOKEN;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`${mode} exited early:\n${logs}`);
      if (!token) {
        for (const raw of logs.match(/https?:\/\/[^\s]+/g) ?? []) {
          const url = new URL(raw);
          if (url.origin === base) token = url.searchParams.get("token") ?? undefined;
        }
      }
      if (!token) { await setTimeout(100); continue; }
      try {
        const response = await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
        if (response.ok) { healthy = true; break; }
      } catch { /* Wait for the listener. */ }
      await setTimeout(100);
    }
    assert(healthy, `${mode} did not become healthy:\n${logs}`);
    assert.equal((await fetch(`${base}/api/health`)).status, 401, "Health must require authentication");
    const curl = ["--fail", "--silent", "--show-error", "--max-time", "5", "--header", `Authorization: Bearer ${token}`];
    const health = JSON.parse(command("curl", [...curl, `${base}/api/health`]));
    assert.equal(health.ok, true);
    assert.equal(health.mode, mode === "serve" ? "real" : "demo");
    const decisions = JSON.parse(command("curl", [...curl, `${base}/api/decisions`]));
    assert(Array.isArray(decisions.items));
    if (mode === "demo") assert(decisions.items.length > 0, "Demo must contain decisions");
    const response = await fetch(base, { signal: AbortSignal.timeout(5000) });
    const html = await response.text();
    assert(response.ok && html.includes('<div id="root">'), "Built React UI must be served");
    const asset = html.match(/src="([^"]+\.js)"/)?.[1];
    assert(asset, "UI must reference built JavaScript");
    const javascript = await fetch(new URL(asset, base), { signal: AbortSignal.timeout(5000) });
    assert(javascript.ok && javascript.headers.get("content-type")?.includes("javascript"), "Built UI asset must be served");
    console.log(`Installed passport ${mode}: health, decisions and built UI OK`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), 10_000);
    await closed;
    clearTimeout(timer);
    assert.equal(child.exitCode, 0, `${mode} must shut down cleanly:\n${logs}`);
  }
}

await test("B4: packed CLI help, MCP dry-run and authenticated demo/persistent APIs", async () => {
  try {
    await writeFile(join(directory, "package.json"), '{"private":true}\n');
    command("npm", ["install", "--no-audit", "--no-fund", tarball]);
    const manifest = JSON.parse(await readFile(join(directory, "node_modules/@akd-me/passport/package.json"), "utf8"));
    assert.equal(manifest.name, "@akd-me/passport");
    assert.equal(manifest.bin.passport, "bin/passport.js");
    assert(!Object.keys(manifest.dependencies).some((name) => name.startsWith("@passport/")));
    const cli = join(directory, "node_modules/.bin/passport");
    assert.match(command(cli, ["--help"], { timeout: 10_000 }), /\bserve\b/);
    assert.match(command(cli, ["mcp", "--help"], { timeout: 10_000 }), /stdio/);
    const before = JSON.stringify({ mcpServers: { example: { command: "example" } } });
    await writeFile(join(directory, ".mcp.json"), before);
    const dry = JSON.parse(command(cli, ["mcp", "install", "--client", "claude-code", "--dry-run"]));
    assert.equal(dry.dryRun, true);
    assert.equal(JSON.parse(dry.content).mcpServers.passport.args[1], "mcp");
    assert.equal(await readFile(join(directory, ".mcp.json"), "utf8"), before, "Dry run must preserve config");
    command(cli, ["mcp", "install", "--client", "claude-code"]);
    command(cli, ["mcp", "install", "--client", "claude-code"]);
    const config = JSON.parse(await readFile(join(directory, ".mcp.json"), "utf8"));
    assert.equal(config.mcpServers.example.command, "example");
    assert.equal(config.mcpServers.passport.args[1], "mcp");
    await smokeServer(cli, "demo");
    await smokeServer(cli, "serve");
    console.log(`Tarball smoke passed on Node ${process.versions.node}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
