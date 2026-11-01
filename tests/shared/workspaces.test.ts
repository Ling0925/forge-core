import { expect, it } from "vitest";
import {
  isAbsoluteWorkspacePath,
  workspaceBrowseRequestSchema,
} from "../../src/shared/workspaces";

it.each(["C:/workspace", "C:\\workspace", "\\\\server\\share"])(
  "rejects %s as a workspace browse root",
  (path) => {
    expect(isAbsoluteWorkspacePath(path)).toBe(false);
    expect(workspaceBrowseRequestSchema.safeParse({ path }).success).toBe(
      false,
    );
  },
);

it.each(["/", "/workspace", "/workspace/a:b", "/workspace/a\\b"])(
  "accepts the absolute POSIX workspace path %s",
  (path) => {
    expect(workspaceBrowseRequestSchema.parse({ path })).toEqual({ path });
  },
);
