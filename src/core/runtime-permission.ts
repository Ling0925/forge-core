import type { AgentRuntimeDependencies, RunControl } from "../shared/contracts";
import { narrowestPermission } from "../shared/permissions";
import type { AgentEvent, Permission, RunInput } from "../shared/schemas";
import type { RunState } from "./runtime-state";

/**
 * A trusted background notification must never inherit a stale, wider grant.
 * Only a persisted actual run or explicit permission change can raise this cap;
 * without such evidence the notification is readonly.
 */
export const previousRunPermission = (
  events: readonly AgentEvent[],
): Permission => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "run_started" || event?.type === "permission_changed")
      return event.permission;
  }
  return "readonly";
};

/**
 * The run's permission right now: the requested (or dynamically granted)
 * level, clamped by the session ceiling, the agent profile and, for
 * background notifications, a cap pinned from persisted evidence.
 */
export const createEffectivePermission = (
  run: RunState,
  input: RunInput,
  deps: Pick<AgentRuntimeDependencies, "settings">,
  control: RunControl | undefined,
) => {
  const effectivePermission = () => {
    // A background notification is an internal continuation, not a new grant.
    // Pin its cap once from the last actual run/permission change so neither a
    // later dynamic grant nor this run's own events can widen it; without
    // persisted evidence it stays readonly.
    if (control?.inputOrigin === "background_task")
      run.notificationCap ??=
        run.snapshot &&
        [
          "running",
          "awaiting_approval",
          "failed",
          "cancelled",
          "interrupted",
        ].includes(run.snapshot.status)
          ? "readonly"
          : previousRunPermission(run.snapshot?.events ?? []);
    const requested =
      input.mode === "plan"
        ? "readonly"
        : (control?.getPermission?.() ??
          input.permission ??
          deps.settings.defaultPermission);
    return narrowestPermission(
      requested,
      run.snapshot?.permissionCeiling,
      run.snapshot?.agentProfile?.permission,
      run.notificationCap,
    );
  };
  return effectivePermission;
};
