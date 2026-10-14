import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkspacePathError,
  createWorkspacePathGuard,
} from "../src/tools/path-guard";
import type { WorkspacePathGuard } from "../src/tools/path-guard";

interface Fixture {
  readonly temporary: string;
  readonly workspace: string;
  readonly sibling: string;
  readonly guard: WorkspacePathGuard;
}

let fixture: Fixture | undefined;

function givenWorkspace(): Fixture {
  if (fixture === undefined)
    throw new Error("Fixture has not been initialized");
  return fixture;
}

beforeEach(async () => {
  const temporary = await mkdtemp(join(tmpdir(), "forge-path-guard-"));
  const workspace = join(temporary, "workspace");
  const sibling = join(temporary, "workspace-extra");
  try {
    await mkdir(join(workspace, "nested"), { recursive: true });
    await mkdir(sibling);
    await writeFile(join(workspace, "nested", "note.txt"), "hello");
    await writeFile(join(sibling, "outside.txt"), "outside");
    fixture = {
      temporary,
      workspace,
      sibling,
      guard: await createWorkspacePathGuard(workspace),
    };
  } catch (error: unknown) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  if (current !== undefined) {
    await rm(current.temporary, { recursive: true, force: true });
  }
});

describe("workspace path guard: Given / When / Then", () => {
  it("given a nested file, when reading or replacing it, then returns its canonical workspace path", async () => {
    const { guard } = givenWorkspace();
    const expected = join(guard.root, "nested", "note.txt");
    expect(await guard.resolveRead("nested/note.txt")).toBe(expected);
    expect(await guard.resolveWrite("nested/note.txt")).toBe(expected);
    expect(await guard.resolveRead("nested")).toBe(join(guard.root, "nested"));
  });

  it("given an existing parent, when writing a new basename, then permits the missing file", async () => {
    const { guard } = givenWorkspace();
    expect(await guard.resolveWrite("nested/new.txt")).toBe(
      join(guard.root, "nested", "new.txt"),
    );
    expect(await guard.resolveWrite("new.txt")).toBe(
      join(guard.root, "new.txt"),
    );
  });

  it("given the root, when listing dot, then accepts it but never as a write-file target", async () => {
    const { guard } = givenWorkspace();
    expect(await guard.resolveRead(".")).toBe(guard.root);
    await expect(guard.resolveWrite(".")).rejects.toMatchObject({
      code: "NOT_DIRECTORY",
      relativePath: ".",
    });
  });

  it("given traversal input, when it escapes even temporarily, then rejects it", async () => {
    const { guard } = givenWorkspace();
    for (const input of [
      "../outside.txt",
      "nested/../../outside.txt",
      "../workspace/nested/note.txt",
    ]) {
      await expect(guard.resolveRead(input)).rejects.toMatchObject({
        code: "OUTSIDE_WORKSPACE",
        relativePath: null,
      });
      await expect(guard.resolveWrite(input)).rejects.toMatchObject({
        code: "OUTSIDE_WORKSPACE",
      });
    }
  });

  it("given a prefix-sharing sibling, when targeted relatively or absolutely, then rejects it", async () => {
    const { guard, sibling } = givenWorkspace();
    await expect(
      guard.resolveRead("../workspace-extra/outside.txt"),
    ).rejects.toMatchObject({
      code: "OUTSIDE_WORKSPACE",
    });
    await expect(
      guard.resolveWrite(join(sibling, "new.txt")),
    ).rejects.toMatchObject({
      code: "OUTSIDE_WORKSPACE",
    });
  });

  it("given absolute input even inside the workspace, when resolving, then rejects it", async () => {
    const { guard, workspace } = givenWorkspace();
    for (const input of [
      join(workspace, "nested", "note.txt"),
      "/absolute",
      "C:\\absolute",
    ]) {
      await expect(guard.resolveRead(input)).rejects.toMatchObject({
        code: "OUTSIDE_WORKSPACE",
      });
    }
  });

  it("given invalid input, when resolving, then exposes neither raw input nor filesystem details", async () => {
    const { guard } = givenWorkspace();
    for (const input of ["", "nested/\0secret", "C:relative"]) {
      await expect(guard.resolveRead(input)).rejects.toMatchObject({
        name: "WorkspacePathError",
        code: "INVALID_PATH",
        relativePath: null,
        message: "Workspace path rejected: INVALID_PATH",
      });
    }
  });

  it("given missing files and parents, when resolving, then distinguishes permitted creation from absence", async () => {
    const { guard } = givenWorkspace();
    await expect(guard.resolveRead("nested/absent.txt")).rejects.toMatchObject({
      code: "MISSING",
      relativePath: join("nested", "absent.txt"),
    });
    await expect(guard.resolveWrite("absent/new.txt")).rejects.toMatchObject({
      code: "MISSING",
    });
  });

  it("given a file as parent, when reading or writing its child, then rejects the non-directory", async () => {
    const { guard } = givenWorkspace();
    await expect(
      guard.resolveRead("nested/note.txt/child"),
    ).rejects.toMatchObject({
      code: "NOT_DIRECTORY",
    });
    await expect(
      guard.resolveWrite("nested/note.txt/child"),
    ).rejects.toMatchObject({
      code: "NOT_DIRECTORY",
    });
  });

  it("given an existing directory, when used as a write-file target, then rejects it", async () => {
    const { guard } = givenWorkspace();
    await expect(guard.resolveWrite("nested")).rejects.toMatchObject({
      code: "NOT_DIRECTORY",
    });
  });

  it("given Unicode and spaces, when reading and creating filenames, then preserves them", async () => {
    const { guard, workspace } = givenWorkspace();
    const name = "日本語 café 🌱.txt";
    await writeFile(join(workspace, "nested", name), "unicode");
    expect(await guard.resolveRead(`nested/${name}`)).toBe(
      join(guard.root, "nested", name),
    );
    expect(await guard.resolveWrite("nested/新しい file.txt")).toBe(
      join(guard.root, "nested", "新しい file.txt"),
    );
  });

  it("given final symlinks to internal, external, and missing files, when resolving, then rejects all of them", async () => {
    const { guard, workspace, sibling } = givenWorkspace();
    const targets = [
      join(workspace, "nested", "note.txt"),
      join(sibling, "outside.txt"),
      join(sibling, "missing.txt"),
    ];
    for (const [index, target] of targets.entries()) {
      const name = `link-${index}`;
      await symlink(target, join(workspace, name), "file");
      await expect(guard.resolveRead(name)).rejects.toMatchObject({
        code: "SYMLINK",
      });
      await expect(guard.resolveWrite(name)).rejects.toMatchObject({
        code: "SYMLINK",
      });
    }
  });

  it("given symlink parents, when reading or writing a missing child, then rejects internal and external traversal", async () => {
    const { guard, workspace, sibling } = givenWorkspace();
    await symlink(
      join(workspace, "nested"),
      join(workspace, "internal"),
      "dir",
    );
    await symlink(sibling, join(workspace, "external"), "dir");
    await expect(guard.resolveRead("internal/note.txt")).rejects.toMatchObject({
      code: "SYMLINK",
    });
    await expect(
      guard.resolveRead("external/outside.txt"),
    ).rejects.toMatchObject({ code: "SYMLINK" });
    for (const name of ["internal", "external"]) {
      await expect(
        guard.resolveWrite(`${name}/missing.txt`),
      ).rejects.toMatchObject({ code: "SYMLINK" });
    }
  });

  it("given a canceled path component, when traversing it, then still requires a real directory", async () => {
    const { guard, workspace } = givenWorkspace();
    await symlink(join(workspace, "nested"), join(workspace, "alias"), "dir");
    await expect(
      guard.resolveRead("alias/../nested/note.txt"),
    ).rejects.toMatchObject({ code: "SYMLINK" });
    await expect(
      guard.resolveRead("missing/../nested/note.txt"),
    ).rejects.toMatchObject({ code: "MISSING" });
    expect(await guard.resolveRead("nested/../nested/note.txt")).toBe(
      join(guard.root, "nested", "note.txt"),
    );
  });

  it("given a workspace alias, when constructing the guard, then canonicalizes the root", async () => {
    const { temporary, workspace } = givenWorkspace();
    const alias = join(temporary, "alias");
    await symlink(workspace, alias, "dir");
    const guard = await createWorkspacePathGuard(alias);
    expect(guard.root).toBe(await realpath(workspace));
    expect(await guard.resolveRead(".")).toBe(guard.root);
  });

  it("given an absent or file workspace, when constructing the guard, then returns typed safe errors", async () => {
    const { temporary, workspace } = givenWorkspace();
    await expect(
      createWorkspacePathGuard(join(temporary, "absent")),
    ).rejects.toBeInstanceOf(WorkspacePathError);
    await expect(
      createWorkspacePathGuard(join(temporary, "absent")),
    ).rejects.toMatchObject({ code: "MISSING", relativePath: null });
    await expect(
      createWorkspacePathGuard(join(workspace, "nested", "note.txt")),
    ).rejects.toMatchObject({ code: "NOT_DIRECTORY", relativePath: "." });
  });
});
