// pnpm dist:desktop: build and pack the npm artifact, stage it with production dependencies
// outside app.asar, then run electron-builder for macOS arm64 (an unsigned .app by default).
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appIcon } from "./icon.mjs";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const root = join(desktop, "../..");
const serverDist = join(root, "apps/server/dist");
const build = join(desktop, "build");

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(" ")}`);
  // pnpm exports its own npm_config_* settings, which npm rejects as unknown; keep them to pnpm.
  const env =
    command === "npm"
      ? Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)))
      : process.env;
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed (exit ${result.status ?? result.signal})`);
  }
}

// 1. The same artifact npm users install (and Docker builds from): pnpm build + pnpm pack.
for (const name of readdirSync(serverDist).filter((file) => file.endsWith(".tgz"))) {
  rmSync(join(serverDist, name));
}
run("pnpm", ["run", "pack"], root);
const { version } = JSON.parse(readFileSync(join(serverDist, "package/package.json"), "utf8"));
const tarball = readdirSync(serverDist).find((file) => file.endsWith(".tgz"));
if (!tarball) {
  throw new Error("pnpm pack produced no tarball in apps/server/dist");
}

// 2. Unpack it to build/server and install its production dependencies there.
rmSync(build, { recursive: true, force: true });
mkdirSync(join(build, "stage"), { recursive: true });
run("tar", ["-xzf", join(serverDist, tarball), "-C", join(build, "stage")], desktop);
renameSync(join(build, "stage/package"), join(build, "server"));
rmSync(join(build, "stage"), { recursive: true });
run(
  "npm",
  ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"],
  join(build, "server"),
);

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
console.log(`Passport ${version}: ${join(desktop, "dist/mac-arm64/Passport.app")}`);
