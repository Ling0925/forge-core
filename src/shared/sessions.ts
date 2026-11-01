import type { SessionSnapshot, SessionSummary } from "./schemas/sessions";

export const sessionOriginWorkspace = (
  session: Pick<
    SessionSnapshot,
    "workspace" | "originWorkspace" | "agentWorktree"
  >,
): string =>
  session.originWorkspace ??
  session.agentWorktree?.repository ??
  session.workspace;

/** Keep child records available for task navigation, but out of ordinary session lists. */
export const isPrimarySession = (
  session: Pick<SessionSummary, "parentSessionId">,
): boolean => session.parentSessionId === undefined;
