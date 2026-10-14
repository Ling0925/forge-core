import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "checkpoint-test-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  const store = await createCheckpointStore(workspace, join(root, "private"));
  const tools = await createLocalToolRegistry(workspace, {
    checkpointStore: store,
  });
  const sessionId = parseSessionId(randomUUID());
  const context: ToolContext = {
    sessionId,
    toolCallId: "call",
    workspace,
    permission: "unrestricted",
    signal: new AbortController().signal,
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
  return { root, workspace, store, tools, execute };
}
it("restores full original beyond previews after reload and refuses changed files or active sessions", async () => {
  const t = await setup();
  const original = `${"a".repeat(9000)}\nTAIL_MARKER\n`;
  await writeFile(join(t.workspace, "large.txt"), original);
  const outcome = await t.execute("edit_file", {
    path: "large.txt",
    old_text: "TAIL_MARKER",
    new_text: "REPLACED",
  });
  expect(outcome.isError).toBe(false);
  expect(outcome.changes?.[0]?.truncated).toBe(true);
  const reloaded = await createCheckpointStore(
    t.workspace,
    join(t.root, "private"),
  );
  const [item] = await reloaded.list();
  if (!item) throw new Error("expected checkpoint");
  expect(item.beforeHash).toMatch(/^[a-f0-9]{64}$/);
  expect(await reloaded.getDiff(item.id)).toContain("REPLACED");
  await expect(
    reloaded.restore(item.id, { isSessionActive: async () => true }),
  ).rejects.toThrow();
  await writeFile(join(t.workspace, "large.txt"), "user change");
  await expect(
    reloaded.restore(item.id, { isSessionActive: async () => false }),
  ).rejects.toThrow();
  await writeFile(
    join(t.workspace, "large.txt"),
    original.replace("TAIL_MARKER", "REPLACED"),
  );
  await reloaded.restore(item.id, { isSessionActive: async () => false });
  expect(await readFile(join(t.workspace, "large.txt"), "utf8")).toBe(original);
  await t.tools.dispose();
});
it("removes created file and prevents symlink, path escape, cancellation and unsafe backup", async () => {
  const t = await setup();
  expect(
    (await t.execute("write_file", { path: "new.txt", content: "created" }))
      .isError,
  ).toBe(false);
  const [item] = await t.store.list();
  if (!item) throw new Error("expected checkpoint");
  await t.store.restore(item.id, { isSessionActive: async () => false });
  await expect(readFile(join(t.workspace, "new.txt"))).rejects.toThrow();
  await symlink(t.root, join(t.workspace, "link"));
  await expect(
    t.store.begin({
      path: "link/escape",
      sessionId: "s",
      toolCallId: "c",
      before: null,
      after: Buffer.from("x"),
    }),
  ).rejects.toThrow();
  await expect(
    t.store.begin({
      path: "../escape",
      sessionId: "s",
      toolCallId: "c",
      before: null,
      after: Buffer.from("x"),
    }),
  ).rejects.toThrow();
  const controller = new AbortController();
  controller.abort();
  await expect(t.store.list(controller.signal)).rejects.toThrow();
  const failure = await t.execute("write_file", {
    path: ".env",
    content: "secret",
  });
  expect(failure.isError).toBe(true);
  expect((await t.store.list()).length).toBe(1);
  await t.tools.dispose();
});
