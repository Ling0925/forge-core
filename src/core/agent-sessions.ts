import {
  type AgentProfile,
  type AgentWorktreeService,
  ForgeError,
  type Permission,
  type RootRunBudget,
  type SessionSnapshot,
  type SessionStore,
} from "../shared";

export async function createAgentSession(
  deps: {
    store: SessionStore;
    agentWorktrees?: AgentWorktreeService;
    rootBudget?: RootRunBudget;
  },
  input: Parameters<SessionStore["create"]>[0] & {
    profile?: AgentProfile;
    permission: Permission;
    isolation: "shared" | "worktree";
    parentSessionId?: SessionSnapshot["parentSessionId"];
    agentTask?: string;
    ownership?: string;
    writePaths?: readonly string[];
  },
  signal: AbortSignal,
): Promise<SessionSnapshot> {
  const {
    profile,
    permission,
    isolation,
    parentSessionId,
    agentTask,
    ownership,
    writePaths,
    ...creation
  } = input;
  if (isolation === "worktree" && permission === "readonly")
    throw new ForgeError("tool", "Readonly mode cannot create a worktree.");
  if (isolation === "worktree" && !deps.agentWorktrees)
    throw new ForgeError("tool", "This host does not provide agent worktrees.");
  const session = await deps.store.create(creation);
  let snapshot: SessionSnapshot = {
    ...session,
    ...(profile
      ? {
          agentProfile: profile,
          agentProfileId: profile.id,
          agentProfileName: profile.name,
        }
      : {}),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(agentTask === undefined ? {} : { agentTask }),
    ...(ownership === undefined ? {} : { ownership }),
    ...(writePaths === undefined ? {} : { writePaths }),
    permissionCeiling: permission,
  };
  await deps.store.save(snapshot);
  if (isolation === "worktree" && deps.agentWorktrees) {
    try {
      deps.rootBudget?.checkAdmission();
      if (signal.aborted) throw new ForgeError("cancelled", "Run cancelled.");
      const { workspace, ...agentWorktree } = await deps.agentWorktrees.create({
        workspace: session.workspace,
        sessionId: session.id,
        signal,
      });
      snapshot = { ...snapshot, workspace, agentWorktree };
      await deps.store.save(snapshot);
    } catch (error) {
      await deps.store.save({
        ...(await deps.store.get(session.id)),
        status: signal.aborted ? "cancelled" : "failed",
      });
      throw error;
    }
  }
  return snapshot;
}
