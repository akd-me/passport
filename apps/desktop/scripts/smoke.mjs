// Runs Electron's bundled Node (ELECTRON_RUN_AS_NODE) and checks what the server needs from it:
// node:sqlite with FTS5 and JSON1. An Electron bump that drops either fails here, not at runtime.
// `smokePackaged` (run by dist.mjs) also starts a packaged Passport.app's server the way the app
// does and checks that it serves, signs in and stops cleanly.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const probe = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(":memory:");
db.exec("CREATE VIRTUAL TABLE probe USING fts5(subject, body)");
db.prepare("INSERT INTO probe (subject, body) VALUES (?, ?)").run("Quarterly invoice", "due friday");
const hits = db.prepare("SELECT subject FROM probe WHERE probe MATCH ?").all("invoice");
const json = db.prepare("SELECT json_extract(?, '$.a') AS a").get('{"a":7}');
const sqlite = db.prepare("SELECT sqlite_version() AS v").get().v;
db.close();
if (hits.length !== 1 || json.a !== 7) {
  throw new Error("FTS5 or JSON1 returned unexpected results");
}
console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, sqlite }));
`;

/** The parent environment without Passport or Electron settings that would change the run. */
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(PASSPORT_|ELECTRON_)/.test(key)),
  );

export function probeSqlite(executable) {
  const result = spawnSync(executable, ["-e", probe], {
    env: { ...cleanEnv(), ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    console.error(result.stderr);
    throw new Error(`Electron's Node failed the node:sqlite FTS5 probe (exit ${result.status})`);
  }
  const versions = JSON.parse(result.stdout.trim().split("\n").at(-1));
  if (!versions.electron) {
    throw new Error("The probe did not run under Electron");
  }
  return versions;
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

/**
 * Starts `<app>/Contents/Resources/server/bin/passport.js serve` exactly as the app's supervisor
 * does, then stops it the way the app's Quit does (SIGTERM, pipe still open) or the way a crashed
 * app does (the pipe closes).
 */
async function serveOnce(app, executable, stop) {
  const dataDir = mkdtempSync(join(tmpdir(), "passport-smoke-"));
  const [port, mcpPort] = [await freePort(), await freePort()];
  const child = spawn(
    executable,
    [join(app, "Contents/Resources/server/bin/passport.js"), "serve"],
    {
      cwd: dataDir,
      env: {
        ...cleanEnv(),
        ELECTRON_RUN_AS_NODE: "1",
        PASSPORT_DATA_DIR: dataDir,
        PASSPORT_PORT: String(port),
        PASSPORT_MCP_PORT: String(mcpPort),
        PASSPORT_BOOTSTRAP_FD: "3",
        PASSPORT_PARENT: "desktop",
      },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  child.stdio[3].end(JSON.stringify({ masterKey: randomBytes(32).toString("base64url") }));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  try {
    const deadline = Date.now() + 60_000;
    let ok = false;
    while (!ok && Date.now() < deadline && child.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const tokenPath = join(dataDir, "api-token");
      const token = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "";
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
      ok = !!response?.ok && (await response.json()).mode === "real";
      if (ok) {
        const login = await fetch(`http://127.0.0.1:${port}/?token=${token}`, {
          redirect: "manual",
        });
        if (login.status !== 303 || !login.headers.get("set-cookie")) {
          throw new Error(`The packaged server did not accept its login URL (${login.status})`);
        }
      }
    }
    if (!ok) {
      throw new Error(`The packaged server did not become healthy:\n${output}`);
    }
    if (existsSync(join(dataDir, "master.key"))) {
      throw new Error("The packaged server wrote master.key despite a bootstrap key");
    }
    if (stop === "quit") {
      child.kill("SIGTERM"); // the supervisor gives it 10 s before SIGKILL
    } else {
      child.stdin.end(); // the app's liveness pipe closing: a crashed main process
    }
    const code = await Promise.race([exited, new Promise((r) => setTimeout(r, 9_000, "hung"))]);
    if (code !== 0 || existsSync(join(dataDir, "owner.lock"))) {
      throw new Error(`The packaged server did not stop cleanly (${stop}: ${code}):\n${output}`);
    }
  } finally {
    child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  }
}

export async function smokePackaged(app) {
  const executable = join(app, "Contents/MacOS/Passport");
  const versions = probeSqlite(executable);
  for (const stop of ["quit", "crash"]) {
    await serveOnce(app, executable, stop);
  }
  console.log(
    `ok: packaged ${app}: electron ${versions.electron}, node ${versions.node}, sqlite ${versions.sqlite}; server started, signed in, and stopped on quit and on app exit`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The app ships for macOS only; elsewhere (Linux CI) the Electron binary may lack GUI libraries.
  if (process.platform !== "darwin" && process.env.PASSPORT_DESKTOP_SMOKE !== "1") {
    console.log(
      "skipped: the desktop smoke test runs on macOS (set PASSPORT_DESKTOP_SMOKE=1 to force)",
    );
  } else if (process.argv[2] === "--packaged") {
    await smokePackaged(process.argv[3] ?? "dist/mac-arm64/Passport.app");
  } else {
    const versions = probeSqlite(createRequire(import.meta.url)("electron"));
    console.log(
      `ok: electron ${versions.electron}, node ${versions.node}, sqlite ${versions.sqlite} (FTS5 + JSON1)`,
    );
  }
}
