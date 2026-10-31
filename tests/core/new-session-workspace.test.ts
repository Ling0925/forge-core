import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({ fail: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    stat: async (...args: Parameters<typeof original.stat>) => {
      if (fs.fail)
        throw Object.assign(new Error(`${fs.fail}: injected`), {
          code: fs.fail,
        });
      return original.stat(...args);
    },
  };
});
import { resolveNewSession } from "../../src/core/harness-sessions";
import { defaultPublicSettings } from "../../src/shared/schemas";

const settings = { ...defaultPublicSettings, model: "m" };
const create = (workspace: string) =>
  resolveNewSession(settings, { workspace } as Parameters<
    typeof resolveNewSession
  >[1]);
afterEach(() => {
  fs.fail = undefined;
});

it("reports missing paths and files as not an existing directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-new-session-"));
  try {
    await writeFile(join(dir, "file"), "");
    for (const workspace of [join(dir, "missing"), join(dir, "file")])
      await expect(create(workspace)).rejects.toThrow(
        "Workspace must be an existing directory.",
      );
    await expect(create(dir)).resolves.toMatchObject({ workspace: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not report permission or I/O failures as a missing directory", async () => {
  for (const [code, message] of [
    ["ENOTDIR", "Workspace must be an existing directory."],
    ["EACCES", "Workspace is not accessible: permission denied."],
    ["EPERM", "Workspace is not accessible: permission denied."],
    ["EIO", "Workspace could not be inspected (EIO)."],
  ] as const) {
    fs.fail = code;
    await expect(create("/workspace-fixture")).rejects.toMatchObject({
      code: "invalid_input",
      message,
    });
  }
});
