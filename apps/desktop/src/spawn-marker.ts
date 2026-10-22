// Records the `passport serve` this app spawned, so a launch after a crash (or a force quit)
// recognises that server as its own orphan and replaces it instead of attaching to it.
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { OwnerLease } from "./discovery";

interface SpawnRecord {
  pid: number;
  dataDir: string;
  startedAt: string;
}

function read(path: string): SpawnRecord | null {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as SpawnRecord;
    return Number.isInteger(record.pid) && typeof record.dataDir === "string" ? record : null;
  } catch {
    // Missing or damaged: no record of a child.
    return null;
  }
}

export function recordSpawn(path: string, pid: number, dataDir: string): void {
  const record: SpawnRecord = { pid, dataDir, startedAt: new Date().toISOString() };
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** Forget the record (only if it still names `pid`, when given). */
export function forgetSpawn(path: string, pid?: number): void {
  if (pid === undefined || read(path)?.pid === pid) {
    rmSync(path, { force: true });
  }
}

/**
 * True when the live lease holder is the child an earlier launch of this app spawned for this
 * data directory: same pid, and a lease taken after that spawn (so a reused pid never matches).
 */
export function ownOrphan(path: string, owner: OwnerLease, dataDir: string): boolean {
  const record = read(path);
  return (
    !!record &&
    record.pid === owner.pid &&
    record.dataDir === dataDir &&
    Date.parse(owner.startedAt) >= Date.parse(record.startedAt) - 1000
  );
}
