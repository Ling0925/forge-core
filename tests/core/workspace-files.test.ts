import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listWorkspaceDirectory,
  readWorkspaceFilePreview,
} from "../../src/core/workspace-files";

describe("workspace file content safety", () => {
  let workspace = "";
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "forge-file-preview-"));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("omits sensitive files from browsing and refuses direct preview", async () => {
    await writeFile(join(workspace, "credentials.json"), "{}");
    await writeFile(join(workspace, "notes.txt"), "ordinary notes");
    const listing = await listWorkspaceDirectory(workspace);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["notes.txt"]);
    await expect(
      readWorkspaceFilePreview(workspace, "credentials.json"),
    ).rejects.toMatchObject({ code: "tool" });
  });

  it("withholds secret-shaped content while retaining ordinary file metadata", async () => {
    const content = "  -----BEGIN PRIVATE KEY-----\nfixture";
    await writeFile(join(workspace, "notes.txt"), content);
    const preview = await readWorkspaceFilePreview(workspace, "notes.txt");
    expect(preview).toMatchObject({
      content: "[敏感内容已隐藏]",
      path: "notes.txt",
      binary: false,
      sizeBytes: Buffer.byteLength(content),
    });
  });

  it("redacts configured values without hiding otherwise ordinary text", async () => {
    await writeFile(join(workspace, "notes.txt"), "value: fixture-secret");
    const preview = await readWorkspaceFilePreview(workspace, "notes.txt", {
      redactValues: ["fixture-secret"],
    });
    expect(preview.content).toBe("value: [REDACTED]");
  });
});
