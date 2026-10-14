import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { ForgeError } from "../shared/errors";
import { checkEntry, storageError } from "./io";

const cancelled = () =>
  new ForgeError("cancelled", "Lock acquisition was cancelled.");
const busy = () =>
  new ForgeError("busy", "This record is already locked.", true);

export async function fileLock(
  path: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  if (signal?.aborted) throw cancelled();
  if (process.platform !== "linux") throw storageError();
  await checkEntry(path);
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw storageError();
  }
  let retained = false;
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw storageError();
    if (signal?.aborted) throw cancelled();
    const child = spawn("flock", ["-n", "-E", "75", "3"], {
      stdio: ["ignore", "ignore", "ignore", handle.fd],
    });
    const result = await new Promise<"ok" | "busy" | "error" | "cancelled">(
      (resolve) => {
        let settled = false;
        let aborted = false;
        let failed = false;
        const timer = setTimeout(() => {
          failed = true;
          child.kill("SIGKILL");
        }, 5000);
        const finish = (value: "ok" | "busy" | "error" | "cancelled") => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve(value);
        };
        const abort = () => {
          aborted = true;
          child.kill("SIGKILL");
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        child.once("error", () => {
          failed = true;
        });
        child.once("close", (code) =>
          finish(
            aborted
              ? "cancelled"
              : failed
                ? "error"
                : code === 0
                  ? "ok"
                  : code === 75
                    ? "busy"
                    : "error",
          ),
        );
      },
    );
    if (result !== "ok" || signal?.aborted) {
      if (result === "cancelled" || signal?.aborted) throw cancelled();
      if (result === "busy") throw busy();
      throw storageError();
    }
    const verify = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await verify.stat();
      if (
        current.dev !== info.dev ||
        current.ino !== info.ino ||
        (current.mode & 0o777) !== 0o600
      )
        throw storageError();
    } finally {
      await verify.close();
    }
    // Verification awaits can observe an abort after the helper has exited.
    // Transfer ownership only after the final await and cancellation check.
    if (signal?.aborted) throw cancelled();
    retained = true;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await handle.close();
    };
  } finally {
    if (!retained) await handle.close();
  }
}
