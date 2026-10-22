import { chmod, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path)
      : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  }))).flat();
}

// Each source module remains an explicit package subpath. Code splitting keeps
// shared schemas and stateful modules singletons instead of bundling duplicates.
await rm("dist", { recursive: true, force: true });
const result = await build({
  entryPoints: await sources("src"),
  outbase: "src",
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  chunkNames: "chunks/[name]-[hash]",
  sourcemap: false,
  legalComments: "eof",
  metafile: true,
  logLevel: "info",
});
await chmod("dist/web/serve.js", 0o755);
await writeFile("dist/build-meta.json", JSON.stringify(result.metafile, null, 2) + "\n");
