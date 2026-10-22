import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { ToolError } from "./presentation.js";

/**
 * Filesystem helpers for `mail_export`. The scratch directory is shared with a host that may
 * run a sandboxed shell able to write into it, so nothing here follows a symlink: directories
 * are checked with `lstat` (real directory, owned by this user, inside the scratch root) and
 * files are created with `O_CREAT|O_EXCL` (`wx`) after unlinking whatever was there (R4-2).
 */

/** Scratch sessions older than this are removed by `sweepScratchDir`. */
export const SCRATCH_MAX_AGE_MS = 24 * 3600_000;

const refuse = () =>
  new ToolError(
    "INVALID_PATH",
    "The export directory is not a private directory inside the scratch root (symlink or foreign owner).",
  );

/** A 16-hex-character name for a provider id: distinct for ids that differ anywhere (R4-37). */
export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Creates (0700) or validates `name` under `parent`, which must already be safe: a real
 * directory, not a symlink, owned by this process's user, whose real path stays inside
 * `realRoot`. Returns its path.
 */
export async function privateDir(parent: string, name: string, realRoot: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") {
      throw error;
    }
  });
  const info = await lstat(path);
  const uid = process.getuid?.();
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) {
    throw refuse();
  }
  const inside = relative(realRoot, await realpath(path));
  if (!inside || inside.startsWith("..") || inside.includes(`..${sep}`)) {
    throw refuse();
  }
  await chmod(path, 0o700);
  return path;
}

/** The real path of the scratch root, created (0700) when missing. */
export async function scratchRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return realpath(root);
}

/** Writes a new file (0600) without ever following a symlink planted at `path`. */
export async function writeNew(path: string, data: string | Uint8Array): Promise<void> {
  await rm(path, { force: true });
  await writeFile(path, data, { mode: 0o600, flag: "wx" });
}

/**
 * Removes session directories under `scratchDir` whose own mtime is older than `maxAgeMs`;
 * returns their names. Uses `lstat` semantics throughout: symlinks and files at the top level
 * are left alone, and `rm` never follows links inside a session. Never throws.
 */
export async function sweepScratchDir(
  scratchDir: string,
  { now = Date.now(), maxAgeMs = SCRATCH_MAX_AGE_MS } = {},
): Promise<string[]> {
  const removed: string[] = [];
  const entries = await readdir(scratchDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(scratchDir, entry.name);
    try {
      const info = await lstat(path);
      if (info.isDirectory() && now - info.mtimeMs > maxAgeMs) {
        await rm(path, { recursive: true, force: true });
        removed.push(entry.name);
      }
    } catch {
      // Removed concurrently or unreadable; the next sweep retries.
    }
  }
  return removed;
}
