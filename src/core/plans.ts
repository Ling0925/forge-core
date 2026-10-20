import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ForgeError } from "../shared/errors";
import { recordPlan, sessionPlans } from "../shared/plans";
import { taskPlanSchema, type SessionSnapshot, type TaskPlan } from "../shared/schemas";

const selectionSchema = z.object({
  action: z.enum(["create", "update"]).optional(),
  planId: z.string().trim().min(1).max(128).optional(),
}).strict();

const createArgs = z.object({
  name: z.string().trim().min(1).max(256),
  ...taskPlanSchema.innerType().omit({ id: true, title: true }).shape,
}).strict();

export const planArgumentSchemas = {
  create_plan: createArgs,
  update_plan: taskPlanSchema.innerType().omit({ id: true, title: true }).extend({
    planId: selectionSchema.shape.planId.describe("Existing plan ID returned by create_plan or update_plan. Never invent an ID."),
  }).strict(),
} as const;

export function createSessionPlan(
  snapshot: Pick<SessionSnapshot, "plan" | "plans">,
  args: Record<string, unknown>,
): { plan: TaskPlan; plans: readonly TaskPlan[] } {
  const { name, ...content } = createArgs.parse(args);
  return updateSessionPlan(snapshot, { ...content, title: name, action: "create" });
}

/** Missing selectors remain compatible with old models: continue unfinished work,
 * but start a separate plan after completion instead of rewriting its history. */
export function updateSessionPlan(
  snapshot: Pick<SessionSnapshot, "plan" | "plans">,
  args: Record<string, unknown>,
): { plan: TaskPlan; plans: readonly TaskPlan[] } {
  const { action: rawAction, planId: rawId, ...content } = args;
  const { action, planId } = selectionSchema.parse({ action: rawAction, planId: rawId });
  // Identity is assigned here, never accepted as arbitrary persisted content.
  if ("id" in content) throw new ForgeError("invalid_input", "Use planId to update an existing plan.");
  const input = taskPlanSchema.parse(content);
  const plans = sessionPlans(snapshot);
  if (action === "create" && planId)
    throw new ForgeError("invalid_input", "A new plan cannot specify planId.");
  const previous = planId
    ? plans.find(plan => plan.id === planId)
    : snapshot.plan ? plans.find(plan => plan.id === (snapshot.plan?.id ?? "legacy")) : plans.at(-1);
  if (planId && !previous)
    throw new ForgeError("invalid_input", "Unknown planId. Read session history for the existing plan IDs.");
  if (action === "update" && !previous)
    throw new ForgeError("invalid_input", "No existing plan to update. Use create_plan for a new task.");
  const create = action === "create" || (!previous) || (
    !action && !planId && previous.steps.every(step => step.status === "completed")
  );
  if (create && plans.length >= 10000)
    throw new ForgeError("budget", "Session plan limit reached; start a new session.");
  const plan: TaskPlan = {
    ...input,
    id: create ? randomUUID() : previous!.id,
    title: input.title ?? (create ? `计划 ${plans.length + 1}` : previous!.title),
  };
  return recordPlan(snapshot, plan);
}
