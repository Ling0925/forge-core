import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CoreBuildInfo,
  coreBuildInfo,
  parseCoreBuildInfo,
} from "../shared/build-info";

export type { CoreBuildInfo } from "../shared/build-info";

/** `unknown` is a real answer: neither side proved the other is current. */
export type RestartRequired = "true" | "false" | "unknown";

export interface BuildSnapshot {
  /** Stamped into this bundle at compile time; `null` for source/dev runs. */
  readonly running: CoreBuildInfo | null;
  /** The manifest in the fixed build directory, when it is valid right now. */
  readonly disk: CoreBuildInfo | null;
  readonly restartRequired: RestartRequired;
}

export const BUILD_HEADERS = Object.freeze({
  running: "X-Forge-Core-Build",
  disk: "X-Forge-Core-Disk-Build",
  restart: "X-Forge-Core-Restart-Required",
});

const MANIFEST = "build-info.json";
const MAX_MANIFEST_BYTES = 4096;
const DEFAULT_CACHE_MS = 5000;

/**
 * Compares the identity this process actually loaded with the one the build
 * directory currently advertises. Only two valid, different ids mean a restart
 * is required; a missing side stays `unknown` rather than claiming agreement.
 */
export function buildStatus(
  running: CoreBuildInfo | null,
  disk: CoreBuildInfo | null,
): BuildSnapshot {
  if (!running || !disk) return { running, disk, restartRequired: "unknown" };
  return {
    running,
    disk,
    restartRequired: running.id === disk.id ? "false" : "true",
  };
}

/**
 * Reads exactly `<buildDirectory>/build-info.json`. The path is fixed: no
 * fallback to a parent or the working directory. The file must be a regular
 * file (never a symlink), and reading stops at 4097 bytes, so a file that grows
 * after `stat` is still bounded. Every failure is `null`, never a guess.
 */
export async function readDiskBuildInfo(
  buildDirectory: string,
): Promise<CoreBuildInfo | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      join(buildDirectory, MANIFEST),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    if (!(await handle.stat()).isFile()) return null;
    // Read one byte past the limit: a longer file is rejected, not truncated
    // into something that might still parse.
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let read = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        read,
        buffer.length - read,
        read,
      );
      if (bytesRead === 0) break;
      read += bytesRead;
      if (read > MAX_MANIFEST_BYTES) return null;
    }
    return (
      parseCoreBuildInfo(JSON.parse(buffer.toString("utf8", 0, read))) ?? null
    );
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The one fixed build directory for this module, derived from its own compiled
 * URL and never from `process.cwd()`: `dist/web/*.js` and `dist/chunks/*.js`
 * both sit one level below `dist`, where the build writes `build-info.json`.
 * A source run resolves to `src/`, which has no manifest, so it reports
 * `unknown` instead of inventing an identity.
 */
function defaultBuildDirectory(): string | undefined {
  try {
    return fileURLToPath(new URL("../", import.meta.url));
  } catch {
    return undefined;
  }
}

export interface BuildDiagnostics {
  /** Bounded, cached read; `force` bypasses the cache. */
  snapshot(force?: boolean): Promise<BuildSnapshot>;
}

export interface BuildDiagnosticsOptions {
  /** Exact directory holding `build-info.json`. Defaults to this module's build root. */
  directory?: string;
  /** How long an on-disk answer stays fresh. Negative disables caching. */
  cacheMs?: number;
  now?: () => number;
}

export function createBuildDiagnostics(
  options: BuildDiagnosticsOptions = {},
): BuildDiagnostics {
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const now = options.now ?? Date.now;
  const directory =
    options.directory === undefined
      ? defaultBuildDirectory()
      : options.directory;
  let cached: { at: number; value: BuildSnapshot } | undefined;
  let reading: Promise<CoreBuildInfo | null> | undefined;
  return {
    async snapshot(force = false) {
      if (cacheMs >= 0 && !force && cached && now() - cached.at < cacheMs)
        return cached.value;
      // One read at a time: a burst of reconnects shares the same disk probe.
      reading ??= (
        directory === undefined
          ? Promise.resolve(null)
          : readDiskBuildInfo(directory)
      ).finally(() => {
        reading = undefined;
      });
      const value = buildStatus(coreBuildInfo, await reading);
      cached = { at: now(), value };
      return value;
    },
  };
}

/** Process-wide instance for the Web host; reads are bounded and cached. */
export const coreBuildDiagnostics: BuildDiagnostics = createBuildDiagnostics();

/** Writes only static, pathless build facts; safe on connect and reconnect. */
export function applyBuildHeaders(
  response: { setHeader(name: string, value: string): unknown },
  snapshot: BuildSnapshot,
): void {
  response.setHeader(BUILD_HEADERS.running, snapshot.running?.id ?? "unknown");
  response.setHeader(BUILD_HEADERS.disk, snapshot.disk?.id ?? "unknown");
  response.setHeader(BUILD_HEADERS.restart, snapshot.restartRequired);
}
