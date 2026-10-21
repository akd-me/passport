import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { installMcp } from "./mcp-install.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passport-install-"));
  directories.push(root);
  return {
    cwd: root,
    home: root,
    dataDir: join(root, "workspace"),
    entryPath: "/absolute/passport/cli.js",
    nodePath: process.execPath,
    platform: "darwin",
  };
}
it.each(
  [false, true].flatMap((dryRun) => ["claude-code", "codex"].map((client) => ({ dryRun, client }))),
)(
  "B3: redacts argv, URL values and opaque secrets in install previews ($client, dry-run=$dryRun)",
  async ({ dryRun, client }) => {
    const options = await fixture();
    const secrets = [
      "argument-credential",
      "query-credential",
      "fragment-credential",
      "environment-credential",
      "0123456789abcdef0123456789abcdef",
      "/aBC9dE1fG2hJ3kL4mN5pQ6rS7tU8vW9x",
    ];
    const other = {
      args: [
        `--token=${secrets[0]}`,
        `--api-key=${secrets[0]}`,
        `Bearer ${secrets[0]}`,
        `opaque:${secrets[5]}`,
      ],
      url: `https://x/mcp?token=${secrets[1]}&arbitrary=${secrets[1]}#${secrets[2]}`,
      env: {
        FLAGS: `secret=${secrets[3]} key=${secrets[3]} token=${secrets[3]}`,
        VALUE: secrets[4],
      },
    };
    const path =
      client === "codex"
        ? join(options.home, ".codex", "config.toml")
        : join(options.cwd, ".mcp.json");
    await mkdir(dirname(path), { recursive: true });
    const before =
      client === "codex"
        ? `[mcp_servers.other]\nargs = ${JSON.stringify(other.args)}\nurl = ${JSON.stringify(other.url)}\nenv = { FLAGS = ${JSON.stringify(other.env.FLAGS)}, VALUE = ${JSON.stringify(other.env.VALUE)} }\n`
        : JSON.stringify({ mcpServers: { other } });
    await writeFile(path, before);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await installMcp(
      ["--client", client, ...(dryRun ? ["--dry-run"] : [])],
      options,
    );
    for (const secret of secrets) {
      expect(result.content).not.toContain(secret);
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    }
    const saved = await readFile(result.path, "utf8");
    if (client === "codex") {
      expect(saved).toContain(before.trim());
    } else {
      expect(JSON.parse(saved).mcpServers.other).toEqual(other);
    }
    if (result.backup) {
      expect(await readFile(result.backup, "utf8")).toBe(before);
    }
  },
);
it("B3: redacts opaque credentials in printed config and backup paths", async () => {
  const options = await fixture();
  const secret = "e5a298c70145b2f67d903e8ac61f4b90";
  options.cwd = join(options.cwd, secret);
  await mkdir(options.cwd);
  await writeFile(join(options.cwd, ".mcp.json"), "{}");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const result = await installMcp(["--client", "claude-code"], options);
  expect(result.backup).toContain(secret);
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  expect(await readFile(result.backup!, "utf8")).toBe("{}");
});
it("B3: keeps hyphenated install paths intact in previews", async () => {
  const options = await fixture();
  options.entryPath = "/Users/me/my-projects/passport/apps/server/dist/cli.js";
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const result = await installMcp(["--client", "claude-code", "--dry-run"], options);
  expect(JSON.parse(result.content).mcpServers.passport.args).toEqual([options.entryPath, "mcp"]);
  expect(JSON.stringify(log.mock.calls)).not.toContain("<redacted>");
});
it("R15: redacts nested existing JSON secrets while preserving them on disk and in the backup", async () => {
  const options = await fixture();
  const before = JSON.stringify({
    mcpServers: {
      other: {
        env: {
          apiKey: "old-key",
          PASSWORD: "old-password",
          nested: [
            { Authorization: "old-bearer", refresh_token: "old-token", clientSecret: "old-secret" },
          ],
        },
      },
      passport: { env: { keep: "yes" } },
    },
  });
  await writeFile(join(options.cwd, ".mcp.json"), before);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const result = await installMcp(["--client", "claude-code"], options);
  for (const secret of ["old-key", "old-password", "old-bearer", "old-token", "old-secret"]) {
    expect(result.content).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  }
  const saved = JSON.parse(await readFile(result.path, "utf8"));
  expect(saved.mcpServers.other.env.apiKey).toBe("old-key");
  expect(saved.mcpServers.passport.env).toEqual({
    keep: "yes",
    PASSPORT_DATA_DIR: options.dataDir,
  });
  expect(await readFile(result.backup!, "utf8")).toBe(before);
});
it("R15: redacts TOML secrets in multiline values, nested tables and inline tables", async () => {
  const options = await fixture();
  const path = join(options.home, ".codex", "config.toml");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `[mcp_servers.other]\napi_key = """top\nsecret-value"""\nheaders = { Authorization = "bearer-secret", nested = { password = "password-secret" } }\n[mcp_servers.other.secret]\nvalue = "table-secret"\n[mcp_servers.passport]\ncommand = "old"\n[mcp_servers.passport.env]\nKEEP = "yes"\nPASSPORT_DATA_DIR = "/old"\n`,
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  const result = await installMcp(["--client", "codex", "--dry-run"], options);
  for (const secret of ["secret-value", "bearer-secret", "password-secret", "table-secret"]) {
    expect(result.content).not.toContain(secret);
  }
  expect(result.content).toContain(`PASSPORT_DATA_DIR = ${JSON.stringify(options.dataDir)}`);
  expect(result.content.match(/PASSPORT_DATA_DIR\s*=/g)).toHaveLength(1);
  expect(await readdir(dirname(path))).toEqual(["config.toml"]);
});
it.each(["claude-code", "codex", "cursor", "claude-desktop"])(
  "R15: stdio %s keeps a nondefault data directory on repeat installation",
  async (client) => {
    const options = await fixture();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await installMcp(["--client", client], options);
    const result = await installMcp(["--client", client], options);
    const content = await readFile(result.path, "utf8");
    if (client === "codex") {
      expect(content.match(/env.PASSPORT_DATA_DIR\s*=/g)).toHaveLength(1);
    } else {
      expect(JSON.parse(content).mcpServers.passport.env.PASSPORT_DATA_DIR).toBe(options.dataDir);
    }
  },
);
it("MCP_INSTALL: packaged shim delegates Codex HTTP dry-run and user installs to the bundled CLI", async () => {
  const options = await fixture();
  const built = fileURLToPath(new URL("../../dist/package/", import.meta.url));
  const installed = await mkdtemp(join(tmpdir(), "passport-installed-"));
  directories.push(installed);
  await cp(join(built, "bin"), join(installed, "bin"), { recursive: true });
  await cp(join(built, "dist"), join(installed, "dist"), { recursive: true });
  await cp(join(built, "package.json"), join(installed, "package.json"));
  // An offline installation: reuse the exact locked dependencies already
  // installed in workspace packages, without consulting npm during tests.
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const owners = [
    join(root, "apps/server"),
    ...(await readdir(join(root, "packages"))).map((name) => join(root, "packages", name)),
  ];
  const manifest = JSON.parse(await readFile(join(built, "package.json"), "utf8"));
  for (const name of Object.keys(manifest.dependencies)) {
    let target: string | undefined;
    for (const owner of owners) {
      try {
        target = await realpath(join(owner, "node_modules", name));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    if (!target) {
      throw new Error(`Missing locked dependency ${name}`);
    }
    const link = join(installed, "node_modules", name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link, "dir");
  }
  const shim = join(installed, "bin/passport.js");
  const invoke = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [shim, "mcp", "install", ...args], {
        cwd: options.cwd,
        env: {
          ...process.env,
          HOME: options.home,
          PASSPORT_DATA_DIR: options.dataDir,
          PASSPORT_MCP_TOKEN: "fixture-mcp-token",
        },
      });
      let output = "",
        error = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        error += String(chunk);
      });
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(error))));
    });
  const dry = JSON.parse(await invoke(["--client", "codex", "--http", "--dry-run"]));
  expect(dry.dryRun).toBe(true);
  expect(dry.content).toContain("http://127.0.0.1:4318/mcp");
  expect(dry.content).not.toContain("fixture-mcp-token");
  expect(await readdir(options.home)).toEqual([]);
  for (const client of ["claude-code", "cursor", "claude-desktop"]) {
    const args = ["--client", client, ...(client === "claude-code" ? ["--user"] : [])];
    // Desktop is macOS-only; this repository's packaged smoke runs on other OSes too.
    if (client === "claude-desktop" && process.platform !== "darwin") {
      continue;
    }
    const first = JSON.parse(await invoke(args));
    expect(first.dryRun).toBe(false);
    const second = JSON.parse(await invoke(args));
    expect(second.backup).toContain(".bak-");
    const registration = JSON.parse(await readFile(first.path, "utf8")).mcpServers.passport;
    expect(registration.env.PASSPORT_DATA_DIR).toBe(options.dataDir);
    expect((await stat(registration.args[0])).isFile()).toBe(true);
  }
});
