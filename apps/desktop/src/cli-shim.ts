// Writes ~/.local/bin/passport so the terminal runs the app's bundled CLI without npm
// (the T3 Code DesktopCliShim pattern: the Electron binary in Node mode plus the server entry).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { serverEntry } from "./paths";

const MARKER = "Written by Passport.app: runs the app's bundled passport CLI.";

const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export const shimPath = () => join(homedir(), ".local", "bin", "passport");

export function renderShim(executable: string, entry: string, dataDir: string): string {
  return [
    "#!/bin/sh",
    `# ${MARKER}`,
    `data=${shellWord(dataDir)}`,
    'if [ -z "$PASSPORT_DATA_DIR" ]; then export PASSPORT_DATA_DIR="$data"; fi',
    "export ELECTRON_RUN_AS_NODE=1",
    `app=${shellWord(executable)}`,
    `entry=${shellWord(entry)}`,
    'if [ ! -x "$app" ] || [ ! -f "$entry" ]; then',
    '  echo "Passport.app has moved or been removed. Open it and choose Install passport Command again." >&2',
    "  exit 127",
    "fi",
    'exec "$app" "$entry" "$@"',
    "",
  ].join("\n");
}

export type ShimResult = { ok: true; path: string } | { ok: false; path: string; reason: string };

/** Refuses to replace a `passport` it did not write (for example the npm package's bin link). */
export function installShim(dataDir: string): ShimResult {
  const path = shimPath();
  if (existsSync(path)) {
    let ours = false;
    try {
      ours = readFileSync(path, "utf8").includes(MARKER);
    } catch {
      // Unreadable (or a dangling link): treat it as someone else's file.
    }
    if (!ours) {
      return {
        ok: false,
        path,
        reason: `${path} already exists and was not written by Passport.app (perhaps the npm package). Remove it first to use the app's CLI.`,
      };
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, renderShim(process.execPath, serverEntry(), dataDir), { mode: 0o755 });
  chmodSync(temp, 0o755);
  renameSync(temp, path);
  return { ok: true, path };
}
