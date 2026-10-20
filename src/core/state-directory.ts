import { homedir } from "node:os";
import { join, resolve } from "node:path";
/** Shared by the runtime and local device-management CLI; never creates credentials. */
export const resolveStateDirectory = (directory?: string): string =>
  resolve(
    directory ??
      process.env.FORGE_HOME ??
      join(homedir(), ".local", "share", "forge"),
  );
