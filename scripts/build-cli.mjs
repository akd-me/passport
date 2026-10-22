import { readFileSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import config, { WORKER_BUNDLED, workerConfig } from "../apps/server/esbuild.config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const serverDir = join(root, "apps/server");
const packageDir = join(serverDir, "dist/package");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const server = await readJson(join(serverDir, "package.json"));
// Reuse esbuild from the existing, lockfile-pinned tsx build toolchain. This
// avoids changing dependency manifests/lockfiles owned by the other tracks.
const require = createRequire(join(serverDir, "package.json"));
const { build } = createRequire(require.resolve("tsx/package.json"))("esbuild");
const workspaceEntries = new Map();
const dependencies = {};
const visited = new Set();

function installedVersion(name, manifestPath) {
  const ownerRequire = createRequire(manifestPath);
  // Some packages (notably the MCP SDK) expose only subpaths, not a root entry.
  // Node's search paths locate their manifest without relying on those exports.
  for (const directory of ownerRequire.resolve.paths(name) ?? []) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, name, "package.json"), "utf8"));
      if (manifest.name === name) {
        return manifest.version;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  let directory = dirname(ownerRequire.resolve(name));
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (manifest.name === name) {
        return manifest.version;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Cannot find installed ${name}`);
    }
    directory = parent;
  }
}

async function collect(manifestPath) {
  const manifest = await readJson(manifestPath);
  if (visited.has(manifest.name)) {
    return;
  }
  visited.add(manifest.name);
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (WORKER_BUNDLED.includes(name)) {
      continue; // Bundled into the attachment worker below.
    }
    if (name.startsWith("@passport/")) {
      const directory = join(root, "packages", name.slice("@passport/".length));
      workspaceEntries.set(name, join(directory, "src/index.ts"));
      await collect(join(directory, "package.json"));
    } else {
      const version = installedVersion(name, manifestPath);
      if (dependencies[name] && dependencies[name] !== version) {
        throw new Error(`Conflicting installed versions of ${name}; resolve before publishing`);
      }
      dependencies[name] = version;
    }
  }
}

await collect(join(serverDir, "package.json"));
await readFile(join(root, "apps/web/dist/index.html")); // Fail if the UI was not built.
await rm(packageDir, { recursive: true, force: true });
await mkdir(packageDir, { recursive: true });
// Keep two path segments beneath the package root: app.ts locates the UI via
// ../../web/dist relative to import.meta.url. No source rewrite is needed.
const result = await build(
  config({ serverDir, outdir: join(packageDir, "dist/server"), workspaceEntries }),
);
const worker = await build(workerConfig({ root, outdir: join(packageDir, "dist/server") }));
const builtins = new Set(builtinModules);
for (const output of Object.values(worker.metafile.outputs)) {
  for (const { path, external } of output.imports) {
    if (external && !path.startsWith("node:") && !builtins.has(path)) {
      throw new Error(`The attachment worker must be self-contained; external import: ${path}`);
    }
  }
}
for (const output of Object.values(result.metafile.outputs)) {
  for (const { path, external } of output.imports) {
    if (!external || path.startsWith("node:") || builtins.has(path)) {
      continue;
    }
    const name = path.startsWith("@") ? path.split("/").slice(0, 2).join("/") : path.split("/")[0];
    if (!dependencies[name]) {
      throw new Error(`External import missing from dependencies: ${path}`);
    }
  }
}
const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
const version = changelog.match(/^## \[(\d+\.\d+\.\d+(?:-[\w.-]+)?)\]/m)?.[1];
if (!version) {
  throw new Error("CHANGELOG.md must start with a versioned release heading");
}
await writeFile(
  join(packageDir, "package.json"),
  JSON.stringify(
    {
      name: "@akd-me/passport",
      version,
      description:
        "Local-first, agent-native mail and calendar with earned trust, undo and a delayed outbox.",
      license: "MIT",
      type: "module",
      engines: { node: ">=22.16" },
      bin: server.bin,
      files: server.files,
      repository: {
        type: "git",
        url: "git+https://github.com/akd-me/passport.git",
        directory: "apps/server",
      },
      homepage: "https://github.com/akd-me/passport#readme",
      bugs: { url: "https://github.com/akd-me/passport/issues" },
      publishConfig: { access: "public" },
      dependencies: Object.fromEntries(
        Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
    null,
    2,
  ) + "\n",
);
await cp(join(serverDir, "bin"), join(packageDir, "bin"), { recursive: true });
await chmod(join(packageDir, "bin/passport.js"), 0o755);
await cp(join(root, "apps/web/dist"), join(packageDir, "web/dist"), { recursive: true });
for (const name of ["README.md", "LICENSE"]) {
  await cp(join(root, name), join(packageDir, name));
}
console.log(`Built @akd-me/passport@${version} in ${packageDir}`);
