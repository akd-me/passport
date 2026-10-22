// pnpm dist:desktop: build and pack the npm artifact, stage it with production dependencies
// outside app.asar, then run electron-builder for macOS arm64 (an unsigned .app by default).
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appIcon } from "./icon.mjs";
import { smokePackaged } from "./smoke.mjs";
import { stageDependencies } from "./stage-deps.mjs";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const root = join(desktop, "../..");
const serverDist = join(root, "apps/server/dist");
const build = join(desktop, "build");

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed (exit ${result.status ?? result.signal})`);
  }
}

// 1. The same artifact npm users install (and Docker builds from): pnpm build + pnpm pack.
// A clean checkout has no apps/server/dist until this step builds it.
if (existsSync(serverDist)) {
  for (const name of readdirSync(serverDist).filter((file) => file.endsWith(".tgz"))) {
    rmSync(join(serverDist, name));
  }
}
run("pnpm", ["run", "pack"], root);
const { version } = JSON.parse(readFileSync(join(serverDist, "package/package.json"), "utf8"));
const tarball = readdirSync(serverDist).find((file) => file.endsWith(".tgz"));
if (!tarball) {
  throw new Error("pnpm pack produced no tarball in apps/server/dist");
}

// 2. Unpack it to build/server and copy in its production dependencies from the workspace's
// pnpm install, so the app ships the lockfile's versions rather than whatever npm resolves today.
rmSync(build, { recursive: true, force: true });
mkdirSync(join(build, "stage"), { recursive: true });
run("tar", ["-xzf", join(serverDist, tarball), "-C", join(build, "stage")], desktop);
renameSync(join(build, "stage/package"), join(build, "server"));
rmSync(join(build, "stage"), { recursive: true });
const packages = join(root, "packages");
const workspaceDirs = [
  join(root, "apps/server"),
  ...readdirSync(packages).map((name) => join(packages, name)),
];
console.log(`Staged ${stageDependencies(join(build, "server"), workspaceDirs)} packages`);

// 3. App icon, main process, then the bundle.
writeFileSync(join(build, "icon.png"), appIcon(1024));
run("node", ["scripts/build-main.mjs"], desktop);
const dmg = process.env.PASSPORT_DESKTOP_DMG === "1";
const sign = process.env.PASSPORT_DESKTOP_SIGN === "1";
run(
  join(desktop, "node_modules/.bin/electron-builder"),
  [
    "--mac",
    ...(dmg ? ["dmg", "zip"] : ["dir"]),
    "--arm64",
    "--publish",
    "never",
    `-c.extraMetadata.version=${version}`,
    ...(sign ? [] : ["-c.mac.identity=null"]),
  ],
  desktop,
);
const app = join(desktop, "dist/mac-arm64/Passport.app");
// 4. Start the packaged server the way the app does, so a broken bundle fails the build.
if (!dmg || existsSync(app)) {
  await smokePackaged(app);
}
console.log(`Passport ${version}: ${app}`);
