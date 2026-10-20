export interface AgentWorktreeCreateInput {
  /** Existing parent workspace, optionally a subdirectory of the repository. */
  readonly workspace: string;
  /** Validated UUID of the child session that will own this worktree. */
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

export interface AgentWorktree {
  /** Workspace to give the child: the same subdirectory under the worktree. */
  readonly workspace: string;
  /** Canonical repository root shared with the parent. */
  readonly repository: string;
  /** Full committed revision the detached worktree was created from. */
  readonly baseRevision: string;
  /** Absolute worktree destination retained for recovery and manual cleanup. */
  readonly worktree: string;
}

export interface AgentWorktreeService {
  create(input: AgentWorktreeCreateInput): Promise<AgentWorktree>;
}
