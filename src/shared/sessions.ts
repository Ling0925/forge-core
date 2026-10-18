import type { SessionSummary } from "./schemas";

/** Keep child records available for task navigation, but out of ordinary session lists. */
export const isPrimarySession = (session: Pick<SessionSummary, "parentSessionId">): boolean =>
  session.parentSessionId === undefined;
