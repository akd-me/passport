// Bundles the Electron main and preload processes into CommonJS, and renders the tray template
// images beside them. Electron is the only external: the app has no runtime npm dependencies.
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { trayTemplate } from "./icon.mjs";

const root = new URL("..", import.meta.url).pathname;
const shared = {
  absWorkingDir: root,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
  sourcesContent: false,
  logLevel: "warning",
};
await build({ ...shared, entryPoints: ["src/main.ts"], outfile: "dist/main.cjs" });
await build({ ...shared, entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs" });
await mkdir(`${root}dist`, { recursive: true });
await writeFile(`${root}dist/trayTemplate.png`, trayTemplate(18));
await writeFile(`${root}dist/trayTemplate@2x.png`, trayTemplate(36));
console.log("Built dist/main.cjs, dist/preload.cjs and the tray template images");
