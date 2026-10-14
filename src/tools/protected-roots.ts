import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function containsPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

// Missing roots are resolved through their nearest existing ancestor. Other
// I/O failures must not silently weaken the protected boundary.
export async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (
      !(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonicalPath(parent), relative(parent, absolute));
  }
}

export async function createProtectedRootMatcher(
  extra: readonly string[] = [],
) {
  const declared = [
    join(homedir(), ".local", "share", "forge"),
    ...(process.env.FORGE_HOME ? [process.env.FORGE_HOME] : []),
    ...extra,
  ].map((path) => resolve(path));
  const roots = [
    ...declared,
    ...(await Promise.all(declared.map(canonicalPath))),
  ];
  return (path: string): boolean =>
    roots.some((root) => containsPath(root, resolve(path)));
}
