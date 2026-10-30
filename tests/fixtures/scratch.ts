import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);

/**
 * Test scratch space that never falls back to the OS temp directory.
 *
 * Order: `FORGE_TEST_TMP_DIR`, then the Forge assembly workspace's `.forge/tmp`
 * when this checkout lives at `repos/forge-core`, then a git-ignored directory
 * inside a standalone checkout (CI or an independent clone).
 */
export function testScratchRoot(): string {
  const configured = process.env.FORGE_TEST_TMP_DIR;
  if (configured) return resolve(configured);
  const assembly = resolve(repositoryRoot, "../../.forge");
  if (existsSync(assembly)) return join(assembly, "tmp");
  return join(repositoryRoot, ".forge-test-tmp");
}

export function testScratch(...segments: string[]): string {
  return join(testScratchRoot(), ...segments);
}
