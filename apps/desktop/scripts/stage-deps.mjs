// Stages the bundled server's production dependencies from the workspace's own pnpm install,
// so the .app ships exactly the versions pnpm-lock.yaml pinned (and CI tested). No registry
// access: each package is copied from pnpm's store and laid out npm-style, hoisting where
// Node's resolution allows and nesting where two versions of a package conflict.
import { cpSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** The directories Node searches for a package's own declared dependencies. */
function searchDirs(realDir) {
  const dirs = [join(realDir, "node_modules")];
  // In pnpm's virtual store a package's dependencies are its siblings:
  // node_modules/.pnpm/<entry>/node_modules/{<name>,<its deps>}.
  const store = realDir.match(
    /^(.*[\\/]node_modules[\\/]\.pnpm[\\/][^\\/]+[\\/]node_modules)[\\/]/,
  );
  if (store) {
    dirs.push(store[1]);
  }
  return dirs;
}

function find(name, realDir) {
  for (const dir of searchDirs(realDir)) {
    if (existsSync(join(dir, name, "package.json"))) {
      return realpathSync(join(dir, name));
    }
  }
  return null;
}

/** node_modules directories a package installed at `installDir` resolves through, nearest first. */
function chain(installDir, top) {
  const dirs = [join(installDir, "node_modules")];
  for (let dir = dirname(installDir); dir.startsWith(top); dir = dirname(dir)) {
    if (basename(dir) === "node_modules") {
      dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * Copies the dependency closure of `<packageDir>/package.json` into `<packageDir>/node_modules`.
 * Direct dependencies are looked up in `workspaceDirs` (apps/server, packages/*) and must match
 * the exact versions the packed manifest records.
 */
export function stageDependencies(packageDir, workspaceDirs) {
  const top = join(packageDir, "node_modules");
  /** install path → real directory it was copied from */
  const installed = new Map();
  const queue = [];
  const install = (name, realDir, nodeModules) => {
    const target = join(nodeModules, name);
    const nested = join(realDir, "node_modules");
    cpSync(realDir, target, {
      recursive: true,
      dereference: true,
      filter: (src) => src !== nested && !src.startsWith(nested + sep),
    });
    installed.set(target, realDir);
    queue.push({ realDir, installDir: target });
  };
  for (const [name, version] of Object.entries(
    readJson(join(packageDir, "package.json")).dependencies ?? {},
  )) {
    const realDir = workspaceDirs
      .map((dir) => find(name, dir))
      .find((dir) => dir && readJson(join(dir, "package.json")).version === version);
    if (!realDir) {
      throw new Error(`${name}@${version} is not installed; run pnpm install --frozen-lockfile`);
    }
    install(name, realDir, top);
  }
  while (queue.length) {
    const { realDir, installDir } = queue.shift();
    const manifest = readJson(join(realDir, "package.json"));
    const optional = new Set([
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    const names = new Set([...Object.keys(manifest.dependencies ?? {}), ...optional]);
    for (const name of names) {
      const dep = find(name, realDir);
      if (!dep) {
        if (optional.has(name)) {
          continue; // An optional or peer dependency pnpm did not install.
        }
        throw new Error(`${manifest.name} needs ${name}, which is not installed`);
      }
      const dirs = chain(installDir, top);
      const resolved = dirs.map((dir) => installed.get(join(dir, name))).find(Boolean);
      if (resolved === dep) {
        continue;
      }
      // Nothing on the path yet: hoist. A different version on the path: nest under the dependent.
      install(name, dep, resolved ? dirs[0] : top);
    }
  }
  return installed.size;
}
