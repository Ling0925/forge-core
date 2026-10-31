import {
  type FileHandle,
  appendFile,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { signature } from "../../src/tools/local-common";
import { createLocalPolicy } from "../../src/tools/local-policy";
import { createWorkspacePathGuard } from "../../src/tools/path-guard";

const hooks = vi.hoisted(() => ({
  afterOpen: vi.fn<(handle: FileHandle) => Promise<void>>(async () => {}),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      await hooks.afterOpen(handle);
      return handle;
    },
  };
});

let root: string;
let path: string;
let policy: ReturnType<typeof createLocalPolicy>;
let signal: AbortSignal;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-local-policy-"));
  path = join(root, "file.txt");
  policy = createLocalPolicy({
    known: [],
    guard: await createWorkspacePathGuard(root),
    readReceipts: new Map(),
  });
  signal = new AbortController().signal;
});
afterEach(async () => {
  hooks.afterOpen.mockReset();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it.each(["first\nsecond\n", "中文 😀\n", ""])(
  "reads %j with a file-sized buffer and preserves cache results",
  async (text) => {
    await writeFile(path, text);
    const info = await lstat(path);
    const expected = await readFile(path, "utf8");
    const alloc = vi.spyOn(Buffer, "alloc");
    const first = await policy.readTarget(path, signal);
    const cached = await policy.readTarget(path, signal);
    const allocations = alloc.mock.calls.map(([size]) => size);
    alloc.mockRestore();
    expect(allocations).toEqual([info.size + 1]);
    expect(first).toEqual({
      text: expected,
      cacheHit: false,
      stamp: signature(info),
    });
    expect(cached).toEqual({
      ...first,
      cacheHit: true,
    });
    policy.clearCache();
    expect(await policy.readTarget(path, signal)).toEqual(first);

    await appendFile(path, "changed");
    const changed = await policy.readTarget(path, signal);
    expect(changed).toEqual({
      text: await readFile(path, "utf8"),
      cacheHit: false,
      stamp: signature(await lstat(path)),
    });
    expect(changed.stamp).not.toBe(first.stamp);
    policy.clearCache();
    expect(await policy.readTarget(path, signal)).toEqual(changed);
  },
);

it("rejects growth between lstat and the opening stamp check", async () => {
  await writeFile(path, "before");
  hooks.afterOpen.mockImplementationOnce(async () => {
    await appendFile(path, " after");
  });
  await expect(policy.readTarget(path, signal)).rejects.toMatchObject({
    code: "tool",
    message: "File changed while opening; retry.",
  });
});

it.each(["before", ""])(
  "rejects growth of %j after the opening stamp check without caching it",
  async (text) => {
    await writeFile(path, text);
    hooks.afterOpen.mockImplementationOnce(async (handle) => {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        const info = await stat();
        await appendFile(path, " after");
        return info;
      });
    });
    await expect(policy.readTarget(path, signal)).rejects.toMatchObject({
      code: "tool",
      message: "File changed while reading; retry.",
    });
    expect(await policy.readTarget(path, signal)).toMatchObject({
      text: `${text} after`,
      cacheHit: false,
    });
  },
);
