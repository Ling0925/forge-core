import type { SessionSnapshot, TaskPlan } from "./schemas";

type PlanState = Pick<SessionSnapshot, "plan" | "plans">;
const identified = (plan: TaskPlan): TaskPlan => ({
  ...plan,
  id: plan.id ?? "legacy",
  title: plan.title ?? "原有计划",
});

/** Read old single-plan snapshots without changing their persisted history. */
export function sessionPlans(snapshot: PlanState): readonly TaskPlan[] {
  const plans = (snapshot.plans ?? []).map(identified);
  if (snapshot.plan) {
    const current = identified(snapshot.plan);
    const index = plans.findIndex(plan => plan.id === current.id);
    if (index < 0) plans.push(current);
    else plans[index] = current;
  }
  return plans;
}

/** The same immutable upsert is used by the runtime and live-event clients. */
export function recordPlan(snapshot: PlanState, plan: TaskPlan): {
  plan: TaskPlan; plans: readonly TaskPlan[];
} {
  const current = identified(plan);
  const plans = [...sessionPlans(snapshot)];
  const index = plans.findIndex(item => item.id === current.id);
  if (index < 0) plans.push(current);
  else plans[index] = current;
  // Preserve the old event payload in the compatibility projection; only the
  // collection needs the synthetic legacy identity.
  return { plan, plans };
}
