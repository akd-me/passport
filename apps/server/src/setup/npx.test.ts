import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { NO_NPX_MESSAGE, npxAvailable } from "./browser.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("R3-7: setup detects a Mac without Node (Passport.app's binary has no npx beside it)", async () => {
  const app = await mkdtemp(join(tmpdir(), "passport-app-macos-"));
  const node = await mkdtemp(join(tmpdir(), "passport-node-bin-"));
  dirs.push(app, node);
  await writeFile(join(node, "npx"), "#!/bin/sh\n");
  await chmod(join(node, "npx"), 0o755);
  const electron = join(app, "Passport");
  expect(npxAvailable({ PATH: app }, "darwin", electron)).toBe(false);
  expect(npxAvailable({ PATH: `${app}:${node}` }, "darwin", electron)).toBe(true);
  expect(npxAvailable({ PATH: "" }, "darwin", join(node, "node"))).toBe(true);
  expect(NO_NPX_MESSAGE).toContain("nodejs.org");
});
