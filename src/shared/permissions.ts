import type { Permission } from "./schemas";

/** Permission levels from narrowest to widest. */
export const PERMISSION_LEVELS = [
  "readonly",
  "workspace",
  "unrestricted",
] as const satisfies readonly Permission[];

/** Position in PERMISSION_LEVELS; -1 for a value that is not a permission. */
export const permissionRank = (permission: Permission): number =>
  PERMISSION_LEVELS.indexOf(permission);

/**
 * The narrowest of the given permissions. An omitted limit does not narrow;
 * an unrecognised value fails closed to readonly.
 */
export const narrowestPermission = (
  requested: Permission,
  ...limits: (Permission | undefined)[]
): Permission =>
  PERMISSION_LEVELS[
    Math.min(
      permissionRank(requested),
      ...limits.map((limit) =>
        limit === undefined
          ? PERMISSION_LEVELS.length - 1
          : permissionRank(limit),
      ),
    )
  ] ?? "readonly";
