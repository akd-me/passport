// Runs Electron's bundled Node (ELECTRON_RUN_AS_NODE) and checks what the server needs from it:
// node:sqlite with FTS5 and JSON1. An Electron bump that drops either fails here, not at runtime.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// The app ships for macOS only; elsewhere (Linux CI) the Electron binary may lack GUI libraries.
if (process.platform !== "darwin" && process.env.PASSPORT_DESKTOP_SMOKE !== "1") {
  console.log(
    "skipped: the desktop smoke test runs on macOS (set PASSPORT_DESKTOP_SMOKE=1 to force)",
  );
  process.exit(0);
}
const electron = createRequire(import.meta.url)("electron");
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
const result = spawnSync(electron, ["-e", probe], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
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
console.log(
  `ok: electron ${versions.electron}, node ${versions.node}, sqlite ${versions.sqlite} (FTS5 + JSON1)`,
);
