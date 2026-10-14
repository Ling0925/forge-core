import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ToolContext } from "../../src/shared/contracts";
import { parseSessionId } from "../../src/shared/schemas";
import { createCheckpointStore } from "../../src/store/checkpoints";
import { createLocalToolRegistry } from "../../src/tools/local";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-checkpoint-effects-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const directory = join(root, "private");
  const store = await createCheckpointStore(workspace, directory);
  const tools = await createLocalToolRegistry(workspace, {
    checkpointStore: store,
  });
  const controller = new AbortController();
  const context: ToolContext = {
    sessionId: parseSessionId(randomUUID()),
    toolCallId: "call",
    workspace,
    permission: "unrestricted",
    signal: controller.signal,
    onEvent: () => {},
    approve: async () => true,
  };
  const execute = (name: string, args: object) =>
    tools.execute(
      {
        id: "call",
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
      context,
    );
  return { root, workspace, directory, store, tools, controller, execute };
}
async function sole(store: Awaited<ReturnType<typeof createCheckpointStore>>) {
  const entries = await store.list();
  expect(entries).toHaveLength(1);
  const item = entries[0];
  if (!item) throw new Error("expected persisted checkpoint");
  return item;
}
const inactive = { isSessionActive: async () => false };

it("preserves executable mode on edit and restore, including persisted reload", async () => {
  const t = await fixture();
  const file = join(t.workspace, "script.sh");
  await writeFile(file, "#!/bin/sh\necho before\n", { mode: 0o755 });
  await chmod(file, 0o755);
  expect(
    (
      await t.execute("edit_file", {
        path: "script.sh",
        old_text: "before",
        new_text: "after",
      })
    ).isError,
  ).toBe(false);
  expect((await lstat(file)).mode & 0o777).toBe(0o755);
  const reloaded = await createCheckpointStore(t.workspace, t.directory);
  const item = await sole(reloaded);
  expect(item.beforeMode).toBe(0o755);
  await reloaded.restore(item.id, inactive);
  expect(await readFile(file, "utf8")).toBe("#!/bin/sh\necho before\n");
  expect((await lstat(file)).mode & 0o777).toBe(0o755);
  await t.tools.dispose();
});

it("will not certify a transaction without an actual matching result, leaving pending evidence", async () => {
  const t = await fixture();
  const transaction = await t.store.begin({
    path: "absent.txt",
    sessionId: "session",
    toolCallId: "call",
    before: null,
    after: Buffer.from("expected"),
  });
  try {
    await expect(transaction.complete()).rejects.toThrow("does not match");
    await writeFile(join(t.workspace, "absent.txt"), "wrong");
    await expect(transaction.complete()).rejects.toThrow("does not match");
  } finally {
    await transaction.release();
  }
  const item = await sole(t.store);
  expect(item.state).toBe("pending");
  await expect(t.store.restore(item.id, inactive)).rejects.toThrow();
  await t.tools.dispose();
});

it("fails closed when backup storage is unavailable and never writes target", async () => {
  const t = await fixture();
  await rm(t.directory, { recursive: true });
  const output = await t.execute("write_file", {
    path: "untouched.txt",
    content: "new content",
  });
  expect(output.isError).toBe(true);
  await expect(
    readFile(join(t.workspace, "untouched.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await t.tools.dispose();
});

it("failed guarded write leaves no invented checkpoint and does not follow symlinks", async () => {
  const t = await fixture();
  // A symlink target is refused before a backup or write.
  await symlink(join(t.root, "outside"), join(t.workspace, "alias"));
  const result = await t.execute("write_file", {
    path: "alias",
    content: "new",
  });
  expect(result.isError).toBe(true);
  expect(await t.store.list()).toHaveLength(0);
  await t.tools.dispose();
});

it("refuses overwrite of an externally changed creation and symlink replacement", async () => {
  const t = await fixture();
  const file = join(t.workspace, "created.txt");
  expect(
    (await t.execute("write_file", { path: "created.txt", content: "initial" }))
      .isError,
  ).toBe(false);
  const item = await sole(t.store);
  await writeFile(file, "user work");
  await expect(t.store.restore(item.id, inactive)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("user work");
  await rm(file);
  await symlink(join(t.root, "outside"), file);
  await expect(t.store.restore(item.id, inactive)).rejects.toThrow();
  expect((await lstat(file)).isSymbolicLink()).toBe(true);
  await t.tools.dispose();
});

it("cancelled transaction acquisition does not mutate or leak a held lock", async () => {
  const t = await fixture();
  t.controller.abort();
  await expect(
    t.execute("write_file", { path: "cancelled.txt", content: "value" }),
  ).rejects.toThrow();
  await expect(
    readFile(join(t.workspace, "cancelled.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await t.store.list()).toHaveLength(0);
  const abort = new AbortController();
  abort.abort();
  await expect(
    t.store.begin({
      path: "cancelled.txt",
      sessionId: "s",
      toolCallId: "c",
      before: null,
      after: Buffer.from("x"),
      signal: abort.signal,
    }),
  ).rejects.toThrow();
  const pending = await t.store.begin({
    path: "cancelled.txt",
    sessionId: "s",
    toolCallId: "c",
    before: null,
    after: Buffer.from("x"),
  });
  await pending.release();
  await t.tools.dispose();
});

it("limits Unicode diffs by real UTF-8 bytes and labels truncation", async () => {
  const t = await fixture();
  const before = Buffer.from("界".repeat(60000));
  const after = Buffer.from("界".repeat(60001));
  const file = join(t.workspace, "unicode.txt");
  await writeFile(file, before);
  const tx = await t.store.begin({
    path: "unicode.txt",
    sessionId: "s",
    toolCallId: "c",
    before,
    after,
  });
  try {
    await writeFile(file, after);
    await tx.complete();
  } finally {
    await tx.release();
  }
  const diff = await t.store.getDiff((await sole(t.store)).id);
  expect(diff).toContain("[diff truncated]");
  expect(Buffer.byteLength(diff, "utf8")).toBeLessThanOrEqual(128 * 1024);
  await t.tools.dispose();
});

it("refuses backup failure for an existing file without changing bytes or creating completed metadata", async () => {
  const t = await fixture();
  const file = join(t.workspace, "existing.txt");
  await writeFile(file, "original");
  await rm(t.directory, { recursive: true });
  const output = await t.execute("edit_file", {
    path: "existing.txt",
    old_text: "original",
    new_text: "changed",
  });
  expect(output.isError).toBe(true);
  expect(await readFile(file, "utf8")).toBe("original");
  await t.tools.dispose();
});

it("rejects secret-bearing local edits before persisting private artifacts", async () => {
  const t = await fixture();
  const output = await t.execute("write_file", {
    path: "safe.txt",
    content: "password=supersecret123456",
  });
  expect(output.isError).toBe(true);
  expect(await t.store.list()).toHaveLength(0);
  await expect(readFile(join(t.workspace, "safe.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await t.tools.dispose();
});
