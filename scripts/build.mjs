import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
// One identity per build, stamped into every module through `define` and
// written to dist/build-info.json for the running process to compare against.
// The id is unique even for builds made in the same millisecond.
const buildInfo = {
  id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
  builtAt: new Date().toISOString(),
};
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
  define: {
    __FORGE_CORE_BUILD_ID__: JSON.stringify(buildInfo.id),
    __FORGE_CORE_BUILT_AT__: JSON.stringify(buildInfo.builtAt),
  },
  logLevel: "info",
});
if (process.platform === "darwin") {
  await mkdir("dist/native", { recursive: true });
  execFileSync("/usr/bin/cc", ["-O2", "-Wall", "-Wextra", "-Werror", "native/flock.c", "-o", "dist/native/forge-flock"], { stdio: "inherit" });
  await chmod("dist/native/forge-flock", 0o755);
}
await chmod("dist/web/serve.js", 0o755);
await writeFile("dist/build-meta.json", JSON.stringify(result.metafile, null, 2) + "\n");
// Written only after a successful build, atomically, so a reader never sees a
// half-written manifest and a crashed build cannot advertise a new identity.
await writeFile(
  "dist/build-info.json.tmp",
  `${JSON.stringify(buildInfo, null, 2)}\n`,
);
await rename("dist/build-info.json.tmp", "dist/build-info.json");
