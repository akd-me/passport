// packages: external keeps real npm dependencies external. This is esbuild's
// equivalent of tsup's noExternal: [/^@passport\//]. Workspace roots resolve
// directly to source, so none of the private packages need publishing.
export default function config({ serverDir, outdir, workspaceEntries }) {
  const noExternal = [/^@passport\//];
  return {
    absWorkingDir: serverDir,
    entryPoints: ["src/cli.ts"],
    outdir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.5",
    packages: "external",
    sourcemap: true,
    sourcesContent: false,
    metafile: true,
    plugins: [
      {
        name: "bundle-passport-workspaces",
        setup(build) {
          build.onResolve({ filter: noExternal[0] }, ({ path }) => {
            const entry = workspaceEntries.get(path);
            if (!entry) {
              throw new Error(`Unknown workspace root: ${path}`);
            }
            return { path: entry };
          });
        },
      },
    ],
  };
}

/**
 * mail_attachment_read's extraction worker (packages/tools/src/attachments) is a second,
 * self-contained entry next to cli.js: its libraries are bundled in, so they are not runtime
 * dependencies of the published package (pdf.js's optional native canvas is never installed,
 * and SheetJS comes from its CDN tarball, not the stale npm release).
 */
export const WORKER_BUNDLED = ["pdfjs-dist", "mammoth", "xlsx", "fflate"];

export function workerConfig({ root, outdir }) {
  return {
    absWorkingDir: root,
    entryPoints: { "attachment-worker": "packages/tools/src/attachments/attachment-worker.ts" },
    outdir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.5",
    sourcemap: false,
    minify: true,
    keepNames: true,
    metafile: true,
    logLevel: "error",
    // CommonJS dependencies (mammoth) call require() for Node builtins.
    banner: {
      js: 'import { createRequire as __passportRequire } from "node:module"; const require = __passportRequire(import.meta.url);',
    },
  };
}
