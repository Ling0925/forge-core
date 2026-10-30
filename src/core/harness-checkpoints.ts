import { createHash } from "node:crypto";
import { join } from "node:path";
import { ForgeError } from "../shared/errors";
import type { SessionId } from "../shared/schemas";
import { createCheckpointStore } from "../store/checkpoints";
import type { openSessionStore } from "../store/sessions";

/**
 * Session-scoped checkpoint access. Checkpoints live per workspace, so every
 * read filters to the requesting session's own checkpoints.
 */
export const createHarnessCheckpoints = (
  store: Awaited<ReturnType<typeof openSessionStore>>,
  directory: string,
) => {
  const checkpointFor = async (id: SessionId) => {
    const s = await store.get(id);
    return createCheckpointStore(
      s.workspace,
      join(
        directory,
        "checkpoints",
        createHash("sha256").update(s.workspace).digest("hex"),
      ),
      { protectedStateRoot: directory },
    );
  };
  return {
    async list(id: SessionId) {
      return (await (await checkpointFor(id)).list()).filter(
        (c) => c.sessionId === id,
      );
    },
    async diff(id: SessionId, checkpointId: string) {
      const cp = await checkpointFor(id);
      if (
        !(await cp.list()).some(
          (c) => c.id === checkpointId && c.sessionId === id,
        )
      )
        throw new ForgeError("not_found", "Checkpoint not found");
      return cp.getDiff(checkpointId);
    },
    async restore(
      id: SessionId,
      checkpointId: string,
      isSessionActive: (session: string) => Promise<boolean>,
    ) {
      const cp = await checkpointFor(id);
      if (
        !(await cp.list()).some(
          (c) => c.id === checkpointId && c.sessionId === id,
        )
      )
        throw new ForgeError("not_found", "Checkpoint not found");
      await cp.restore(checkpointId, { isSessionActive });
    },
  };
};
