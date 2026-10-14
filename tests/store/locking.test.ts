import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const openHooks = vi.hoisted(() => ({
  afterOpen: async (
    _path: string,
    _flags: string | number | undefined,
    _handle: FileHandle,
  ): Promise<void> => {},
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (
      ...args: Parameters<typeof original.open>
    ): Promise<FileHandle> => {
      const handle = await original.open(...args);
      await openHooks.afterOpen(String(args[0]), args[1], handle);
      return handle;
    },
  };
});
import { readJson } from "../../src/store/io";
import { fileLock } from "../../src/store/lock";
import { openSessionStore } from "../../src/store/sessions";
import { openSettingsStore } from "../../src/store/settings";
let directory = "";
let worker = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-lock-test-"));
  worker = join(directory, "worker.mjs");
  await build({
    entryPoints: [resolve("tests/store/process-worker.ts")],
    outfile: worker,
    bundle: true,
    platform: "node",
    format: "esm",
  });
});
afterEach(async () => {
  openHooks.afterOpen = async () => {};
  await rm(directory, { recursive: true, force: true });
});
function probe(path: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("flock", ["-n", "-E", "75", path, "true"], {
      cwd: directory,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", resolve);
  });
}
function start(mode: string, value: string) {
  return spawn(process.execPath, [worker, directory, mode, value], {
    cwd: directory,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
it("locks exact independent session inodes, ignores orphan gates and creates no cwd/3", async () => {
  const store = await openSessionStore(directory);
  const a = await store.create({
    workspace: directory,
    title: "a",
    model: "test",
  });
  const b = await store.create({
    workspace: directory,
    title: "b",
    model: "test",
  });
  const path = join(directory, "sessions", `${a.id}.json.lock`);
  await writeFile(`${path}.gate`, "", { mode: 0o600 });
  const first = await store.acquire(a.id);
  const second = await store.acquire(b.id);
  try {
    expect(await probe(path)).toBe(75);
    expect(await probe(join(directory, "sessions", `${b.id}.json.lock`))).toBe(
      75,
    );
    expect(await readdir(directory)).not.toContain("3");
    const contenders = await Promise.allSettled(
      Array.from({ length: 12 }, () => store.acquire(a.id)),
    );
    expect(contenders.every((value) => value.status === "rejected")).toBe(true);
  } finally {
    await first();
    await second();
  }
  expect(await probe(path)).toBe(0);
  await (await store.acquire(a.id))();
});
it("recovers after real owner SIGKILL, with independent OS exclusion before death", async () => {
  const store = await openSessionStore(directory);
  const snapshot = await store.create({
    workspace: directory,
    title: "crash",
    model: "test",
  });
  const child = start("session", snapshot.id);
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("exit", () => reject(new Error("Owner exited before ready")));
    });
    expect(
      await probe(join(directory, "sessions", `${snapshot.id}.json.lock`)),
    ).toBe(75);
    await expect(store.acquire(snapshot.id)).rejects.toMatchObject({
      code: "busy",
    });
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
  const release = await store.acquire(snapshot.id);
  await release();
});
it("closes failed and cancelled acquisition descriptors and rejects unsafe entries", async () => {
  const path = join(directory, "lock");
  const before = (await readdir("/proc/self/fd")).length;
  const saved = process.env.PATH;
  try {
    process.env.PATH = directory;
    await expect(fileLock(path)).rejects.toMatchObject({ code: "storage" });
  } finally {
    process.env.PATH = saved;
  }
  for (let i = 0; i < 12; i += 1) {
    const controller = new AbortController();
    let opened: FileHandle | undefined;
    openHooks.afterOpen = async (openedPath, flags, handle) => {
      if (
        openedPath === path &&
        flags === (constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW)
      ) {
        opened = handle;
        controller.abort(); // A real descriptor exists; acquisition cannot race the abort.
      }
    };
    await expect(fileLock(path, controller.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(opened).toBeDefined();
    expect(opened?.fd).toBe(-1);
    openHooks.afterOpen = async () => {};
  }
  expect((await readdir("/proc/self/fd")).length).toBeLessThanOrEqual(
    before + 1,
  );
  expect(await probe(path)).toBe(0);
  await chmod(path, 0o644);
  await expect(fileLock(path)).rejects.toMatchObject({ code: "storage" });
  await rm(path);
  await symlink(worker, path);
  await expect(fileLock(path)).rejects.toMatchObject({ code: "storage" });
});
it("closes both descriptors and releases the kernel lock when verification observes a late abort", async () => {
  const path = join(directory, "late-abort-lock");
  const before = (await readdir("/proc/self/fd")).length;
  // Cover abort just after verification open and during its final close await.
  for (const phase of ["open", "close"] as const) {
    const controller = new AbortController();
    const handles: FileHandle[] = [];
    let lockedAtVerification: number | null = null;
    openHooks.afterOpen = async (openedPath, flags, handle) => {
      if (openedPath !== path) return;
      handles.push(handle);
      if (flags !== (constants.O_RDONLY | constants.O_NOFOLLOW)) return;
      lockedAtVerification = await probe(path);
      if (phase === "open") controller.abort();
      else {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          controller.abort();
        };
      }
    };
    await expect(fileLock(path, controller.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(controller.signal.aborted).toBe(true);
    expect(lockedAtVerification).toBe(75);
    expect(handles).toHaveLength(2);
    expect(handles.map((handle) => handle.fd)).toEqual([-1, -1]);
    openHooks.afterOpen = async () => {};
    expect(await probe(path)).toBe(0);
  }
  expect((await readdir("/proc/self/fd")).length).toBeLessThanOrEqual(
    before + 1,
  );
  await (await fileLock(path))();
});
it("joins a real cancelled helper before closing the inherited descriptor", async () => {
  const path = join(directory, "cancel-lock");
  const ready = join(directory, "helper-ready");
  await writeFile(
    join(directory, "flock"),
    `#!${process.execPath}\n(async()=>{const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);})();`,
    { mode: 0o700 },
  );
  const saved = process.env.PATH;
  const controller = new AbortController();
  try {
    process.env.PATH = directory;
    const pending = fileLock(path, controller.signal);
    const checked = expect(pending).rejects.toMatchObject({
      code: "cancelled",
    });
    for (let i = 0; i < 100; i += 1) {
      try {
        await stat(ready);
        break;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    }
    const pid = Number(await readFile(ready, "utf8"));
    controller.abort();
    await checked;
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    process.env.PATH = saved;
  }
  expect(await probe(path)).toBe(0);
});
it("rejects lock inode replacement during helper acquisition without deleting replacement", async () => {
  const path = join(directory, "replace-lock");
  const helper = join(directory, "flock");
  await writeFile(
    helper,
    `#!${process.execPath}\n(async()=>{const fs=await import('node:fs');const cp=await import('node:child_process');cp.spawnSync('/usr/bin/flock',['-n','3'],{stdio:['ignore','ignore','ignore',3]});fs.unlinkSync(${JSON.stringify(path)});fs.writeFileSync(${JSON.stringify(path)},'replacement',{mode:0o600});})();`,
    { mode: 0o700 },
  );
  const saved = process.env.PATH;
  try {
    process.env.PATH = directory;
    await expect(fileLock(path)).rejects.toMatchObject({ code: "storage" });
    expect(await readFile(path, "utf8")).toBe("replacement");
  } finally {
    process.env.PATH = saved;
  }
});
it("bounds JSON reads and rejects symlinks without changing small-file allocation", async () => {
  const path = join(directory, "record.json");
  await writeFile(path, JSON.stringify({ value: "x".repeat(1000) }), {
    mode: 0o600,
  });
  await expect(readJson(path, 100)).rejects.toMatchObject({ code: "storage" });
  await rm(path);
  await symlink(worker, path);
  await expect(readJson(path)).rejects.toMatchObject({ code: "storage" });
});
it("merges settings across instances and real processes; commits provider pairs atomically", async () => {
  const a = await openSettingsStore(directory);
  const b = await openSettingsStore(directory);
  await Promise.all([
    a.update({ settings: { baseUrl: "https://example.invalid" } }),
    b.update({ settings: { maxTurns: 37 } }),
  ]);
  const children = [start("theme", "unused"), start("model", "child-model")];
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) =>
            code === 0 ? resolve() : reject(new Error("Settings child failed")),
          );
        }),
    ),
  );
  expect(await a.getPublic()).toMatchObject({
    baseUrl: "https://example.invalid",
    maxTurns: 37,
    theme: "dark",
    model: "child-model",
  });
  await a.update({
    settings: { baseUrl: "https://pair.invalid" },
    apiKey: "synthetic-test-key",
  });
  // Simulate interrupted legacy projections; authoritative transaction must win.
  await writeFile(
    join(directory, "settings", "credential.json"),
    JSON.stringify({ version: 1, apiKey: "old-test-key" }),
  );
  expect(await b.getProviderConfig()).toMatchObject({
    baseUrl: "https://pair.invalid",
    apiKey: "synthetic-test-key",
  });
  expect(
    (await stat(join(directory, "settings", "state.json"))).mode & 0o777,
  ).toBe(0o600);
  expect(
    await readFile(join(directory, "settings", "config.json"), "utf8"),
  ).not.toContain("synthetic-test-key");
});
