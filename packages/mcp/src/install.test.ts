import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const installer = pathToFileURL(join(root, "apps/server/dist/cli/mcp-install.js")).href;
const tokenLoader = pathToFileURL(join(root, "apps/server/dist/mcp-token.js")).href;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "passport-install-"));
  dirs.push(dir);
  return dir;
}
async function install(dir: string, client: string, flags: string[] = [], token?: string) {
  const source = `const { installMcp } = await import(${JSON.stringify(installer)}); await installMcp(${JSON.stringify(["--client", client, ...flags])}, ${JSON.stringify({ home: dir, cwd: dir, platform: "darwin", dataDir: join(dir, "data"), nodePath: process.execPath, entryPath: join(root, "apps/server/dist/cli.js") })});`;
  return run(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env: { ...process.env, PASSPORT_MCP_TOKEN: token ?? "fixture-token-for-install" },
  });
}
function configPath(dir: string, client: string) {
  return client === "claude-code"
    ? join(dir, ".mcp.json")
    : client === "codex"
      ? join(dir, ".codex/config.toml")
      : client === "cursor"
        ? join(dir, ".cursor/mcp.json")
        : join(dir, "Library/Application Support/Claude/claude_desktop_config.json");
}

describe("mcp install client formats", () => {
  it.each(["claude-code", "codex", "cursor", "claude-desktop"])(
    "dry-runs %s stdio config without writing anything",
    async (client) => {
      const dir = await setup();
      const { stdout } = await install(dir, client, ["--dry-run"]);
      const plan = JSON.parse(stdout) as { path: string; content: string; dryRun: boolean };
      expect(plan.path).toBe(configPath(dir, client));
      expect(plan.dryRun).toBe(true);
      if (client === "codex") {
        expect(plan.content).toContain("[mcp_servers.passport]");
        expect(plan.content).toContain(`command = ${JSON.stringify(process.execPath)}`);
      } else {
        const config = JSON.parse(plan.content);
        expect(config.mcpServers.passport.command).toBe(process.execPath);
        expect(config.mcpServers.passport.args).toEqual([
          join(root, "apps/server/dist/cli.js"),
          "mcp",
        ]);
      }
      expect(await readdir(dir)).toEqual([]);
    },
  );
  it.each(["claude-code", "codex", "cursor", "claude-desktop"])(
    "dry-runs %s HTTP config with redacted auth",
    async (client) => {
      const dir = await setup(),
        { stdout } = await install(dir, client, ["--http", "--dry-run"]);
      const plan = JSON.parse(stdout) as { content: string };
      expect(plan.content).toContain("http://127.0.0.1:4318/mcp");
      expect(plan.content).toContain("<redacted>");
      expect(stdout).not.toContain("fixture-token-for-install");
      if (client === "claude-desktop")
        expect(JSON.parse(plan.content).mcpServers.passport.args).toContain("proxy");
      else if (client === "codex") expect(plan.content).toContain("http_headers = { Authorization");
      else
        expect(JSON.parse(plan.content).mcpServers.passport.headers.Authorization).toBe(
          "Bearer <redacted>",
        );
      expect(await readdir(dir)).toEqual([]);
    },
  );
  it.each(["claude-code", "cursor", "claude-desktop"])(
    "merges %s JSON and makes an exact backup",
    async (client) => {
      const dir = await setup(),
        path = configPath(dir, client);
      await mkdir(dirname(path), { recursive: true });
      const before = JSON.stringify({
        theme: "dark",
        mcpServers: {
          other: { command: "other" },
          passport: { custom: true, command: "old", env: { KEEP: "yes" } },
        },
      });
      await writeFile(path, before);
      const { stdout } = await install(dir, client);
      const plan = JSON.parse(stdout) as { backup: string };
      expect(await readFile(plan.backup, "utf8")).toBe(before);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        theme: "dark",
        mcpServers: {
          other: { command: "other" },
          passport: { custom: true, command: process.execPath, env: { KEEP: "yes" } },
        },
      });
    },
  );
  it("preserves TOML values, comments, multiline strings and unrelated tables while switching transports", async () => {
    const dir = await setup(),
      path = configPath(dir, "codex");
    await mkdir(dirname(path), { recursive: true });
    const before =
      '# retain\nmodel = "example"\nnotes = """\n[mcp_servers.passport]\nfake\n"""\n[mcp_servers.other]\ncommand = "other"\n[mcp_servers."passport"]\ncommand = "old"\nargs = [\n "old-entry"\n]\ntool_timeout_sec = 60\n[mcp_servers.passport.http_headers]\nAuthorization = "Bearer old"\n[mcp_servers.passport.tools.search_emails]\napproval_mode = "prompt"\n[features]\nexample = true\n';
    await writeFile(path, before);
    const { stdout } = await install(dir, "codex", ["--http"]);
    const result = await readFile(path, "utf8");
    expect(result).toContain('url = "http://127.0.0.1:4318/mcp"');
    expect(result).toContain('Authorization = "Bearer fixture-token-for-install"');
    for (const expected of [
      '# retain\nmodel = "example"',
      'notes = """\n[mcp_servers.passport]\nfake\n"""',
      "tool_timeout_sec = 60",
      '[mcp_servers.other]\ncommand = "other"',
      '[mcp_servers.passport.tools.search_emails]\napproval_mode = "prompt"',
      "[features]\nexample = true",
    ])
      expect(result).toContain(expected);
    expect(result).not.toContain('command = "old"');
    expect(result).not.toContain("Bearer old");
    expect(await readFile(JSON.parse(stdout).backup, "utf8")).toBe(before);
    await install(dir, "codex");
    const stdio = await readFile(path, "utf8");
    expect(stdio).not.toContain("http_headers");
    expect(stdio).toContain("tool_timeout_sec = 60");
  });
  it("supports Claude Code user scope", async () => {
    const dir = await setup(),
      { stdout } = await install(dir, "claude-code", ["--user", "--dry-run"]);
    expect(JSON.parse(stdout).path).toBe(join(dir, ".claude.json"));
  });
  it("refuses malformed or unsupported configs without changing them", async () => {
    const dir = await setup(),
      path = configPath(dir, "claude-code");
    await writeFile(path, '{"mcpServers": []}');
    await expect(install(dir, "claude-code")).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe('{"mcpServers": []}');
    const codex = configPath(dir, "codex");
    await mkdir(dirname(codex), { recursive: true });
    await writeFile(codex, 'mcp_servers = { passport = { command = "old" } }');
    await expect(install(dir, "codex")).rejects.toThrow();
    expect(await readFile(codex, "utf8")).toContain('command = "old"');
  });
  it("uses the same token file for listener and HTTP installer, and creates it privately once", async () => {
    const dir = await setup(),
      dataDir = join(dir, "data");
    const env = { ...process.env };
    delete env.PASSPORT_MCP_TOKEN;
    const source = `const { loadMcpToken } = await import(${JSON.stringify(tokenLoader)}); const { installMcp } = await import(${JSON.stringify(installer)}); const token = await loadMcpToken(${JSON.stringify(dataDir)}); const again = await loadMcpToken(${JSON.stringify(dataDir)}); if (token !== again) throw Error("Token changed"); await installMcp(["--client", "cursor", "--http"], ${JSON.stringify({ home: dir, dataDir })});`;
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", source], {
      cwd: root,
      env,
    });
    const token = (await readFile(join(dataDir, "mcp-token"), "utf8")).trim();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(join(dataDir, "mcp-token"))).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(await readFile(configPath(dir, "cursor"), "utf8")).mcpServers.passport.headers
        .Authorization,
    ).toBe(`Bearer ${token}`);
    expect(stdout).not.toContain(token);
  });
});
