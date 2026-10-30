import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, it } from "vitest";
import { workspaceCheckpointDirectory } from "../../src/store/checkpoints";

// Existing checkpoints must stay readable: keep the on-disk layout stable.
it("keeps checkpoints at <state>/checkpoints/<sha256(workspace)>", () => {
  const workspace = "/tmp/some workspace";
  expect(workspaceCheckpointDirectory("/state", workspace)).toBe(
    join(
      "/state",
      "checkpoints",
      createHash("sha256").update(workspace).digest("hex"),
    ),
  );
});
