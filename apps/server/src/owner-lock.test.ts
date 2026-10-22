import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireOwner, activeOwner } from "./owner-lock.js";

const directories: string[] = [];
const owners: ReturnType<typeof acquireOwner>[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    owner.release();
  }
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
it("R9: owner leases exclude a second owner, heartbeat every ten seconds and expire at sixty", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "passport-owner-"));
  directories.push(dataDir);
  vi.useFakeTimers();
  const owner = acquireOwner(dataDir);
  owners.push(owner);
  const initial = activeOwner(dataDir)!;
  expect(initial.pid).toBe(process.pid);
  expect(() => acquireOwner(dataDir)).toThrow("already owns");
  await vi.advanceTimersByTimeAsync(10000);
  const renewed = activeOwner(dataDir)!;
  expect(Date.parse(renewed.heartbeatAt) - Date.parse(initial.heartbeatAt)).toBe(10000);
  expect(renewed.startedAt).toBe(initial.startedAt);
  vi.setSystemTime(Date.parse(renewed.heartbeatAt) + 60000);
  expect(activeOwner(dataDir)).toBeNull();
  const replacement = acquireOwner(dataDir);
  owners.push(replacement);
  owner.release();
  expect(activeOwner(dataDir)?.id).not.toBe(initial.id);
  replacement.release();
  expect(activeOwner(dataDir)).toBeNull();
});
it("R9: a replaced owner stops work and cannot overwrite or unlink its successor", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "passport-owner-"));
  directories.push(dataDir);
  vi.useFakeTimers();
  const lost = vi.fn(),
    owner = acquireOwner(dataDir, lost);
  owners.push(owner);
  const path = join(dataDir, "owner.lock");
  const replacement = { ...JSON.parse(await readFile(path, "utf8")), id: "successor" };
  await writeFile(path, JSON.stringify(replacement));
  await vi.advanceTimersByTimeAsync(10000);
  expect(lost).toHaveBeenCalledOnce();
  owner.release();
  expect(activeOwner(dataDir)?.id).toBe("successor");
});
it("R3-10: the lease records where its owner listens, so Passport.app attaches to that port", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "passport-owner-"));
  directories.push(dataDir);
  owners.push(acquireOwner(dataDir, () => {}, { host: "127.0.0.1", port: 4000, mode: "demo" }));
  const lease = JSON.parse(await readFile(join(dataDir, "owner.lock"), "utf8"));
  expect(lease).toMatchObject({ pid: process.pid, host: "127.0.0.1", port: 4000, mode: "demo" });
});
