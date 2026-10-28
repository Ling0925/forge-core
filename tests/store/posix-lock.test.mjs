import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fileLock } from "../../dist/store/lock.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = resolve(process.env.FORGE_TEST_TMP_DIR ?? join(root, "../../.forge/tmp/posix-lock"));

test("POSIX lock owns the inode until release and recovers after owner death", { skip: !["darwin", "linux"].includes(process.platform) }, async t => {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "run-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "record.lock");
  const release = await fileLock(path);
  try {
    await assert.rejects(fileLock(path), { code: "busy" });
    const releaseOther = await fileLock(join(directory, "other.lock"));
    await releaseOther();
  } finally { await release(); }
  await release(); // idempotent
  await (await fileLock(path))();
  const child = spawn(process.execPath, [join(root, "tests/store/lock-owner.mjs"), path], {
    env: { PATH: process.env.PATH, HOME: directory, FORGE_HOME: join(directory, "state") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(([code]) => { throw new Error(`Lock owner exited before ready: ${code}`); }),
    ]);
    await assert.rejects(fileLock(path), { code: "busy" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
    }
  }
  await (await fileLock(path))();
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(fileLock(path, cancelled.signal), { code: "cancelled" });
  await chmod(path, 0o644);
  await assert.rejects(fileLock(path), { code: "storage" });
  await rm(path);
  const target = join(directory, "target");
  await writeFile(target, "", { mode: 0o600 });
  await symlink(target, path);
  await assert.rejects(fileLock(path), { code: "storage" });
});
