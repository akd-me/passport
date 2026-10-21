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
