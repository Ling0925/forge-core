/**
 * Identity of the Core build that is actually running.
 *
 * `scripts/build.mjs` replaces the two `__FORGE_CORE_*__` identifiers with
 * string literals through esbuild `define`, once per build, and writes the same
 * identity to `dist/build-info.json`. Code that runs from source (Vitest, tsx,
 * an unbuilt dev server) has no substitution, so both reads are `typeof`
 * guarded: the export is then `null`, and callers must say "unknown" instead of
 * inventing an identity. This module is browser-safe on purpose (no Node
 * imports) so the Web UI can import the expected build through
 * `@forge/core/shared/build-info`.
 */
export interface CoreBuildInfo {
  readonly id: string;
  readonly builtAt: string;
}

declare const __FORGE_CORE_BUILD_ID__: string | undefined;
declare const __FORGE_CORE_BUILT_AT__: string | undefined;

const BUILD_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Validates an untrusted build identity (for example the on-disk manifest).
 * Extra keys are ignored so an older reader still understands a newer file;
 * a missing, oversized or malformed value yields `undefined`, never a guess.
 */
export function parseCoreBuildInfo(value: unknown): CoreBuildInfo | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as { readonly id?: unknown; readonly builtAt?: unknown };
  const { id, builtAt } = record;
  if (typeof id !== "string" || !BUILD_ID.test(id)) return undefined;
  if (
    typeof builtAt !== "string" ||
    !ISO_TIME.test(builtAt) ||
    !Number.isFinite(Date.parse(builtAt))
  )
    return undefined;
  return { id, builtAt };
}

const embedded: unknown =
  typeof __FORGE_CORE_BUILD_ID__ === "undefined" ||
  typeof __FORGE_CORE_BUILT_AT__ === "undefined"
    ? undefined
    : { id: __FORGE_CORE_BUILD_ID__, builtAt: __FORGE_CORE_BUILT_AT__ };

/** The build stamped into this bundle, or `null` when running from source. */
export const coreBuildInfo: CoreBuildInfo | null =
  parseCoreBuildInfo(embedded) ?? null;
