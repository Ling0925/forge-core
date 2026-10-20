import { defineTool } from "../shared/tool-definition";
import { z } from "zod";
import { invalidToolInput } from "../shared/tool-input";
import type { ToolDefinition, ToolResult } from "../shared/schemas";
import type { TaskPlan } from "../shared/schemas";
import { createSessionPlan, updateSessionPlan, planArgumentSchemas } from "./plans";
import { ForgeError, formatValidationError } from "../shared/errors";
import { executeHistory, historyDefinitions } from "./history";
import { executeAgentOperation, agentArgumentSchemas, type AgentEnvironment } from "./agent-operations";
export { agentSummary } from "./agent-operations";
const modelListArgs = z
  .object({
    query: z.string().max(256).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
const MODEL_CATALOG_BYTES = 32768;


export const nativeDefinitions: readonly ToolDefinition[] = [
  ...historyDefinitions,
  { name: "list_models", description: "Readonly discovery of exact IDs from the configured provider catalog. Optional substring query and pagination. Catalog presence does not prove live quota or availability; no capability, pricing, or quota guarantees. Discover IDs before choosing distinct delegation models; preserve IDs explicitly supplied by the user. If discovery fails, report it and use explicitly supplied IDs, not invented alternatives. Never automatically replay or fallback an effectful task.", input: modelListArgs },
  { name: "create_plan", description: "Create an independent plan for a new multi-step task, preserving prior plans. Supply a concise name and full steps (at most one in_progress); the result supplies the generated id. No ID or action input. Use update_plan with the returned id for milestones in this task. Simple questions need no plan.", input: planArgumentSchemas.create_plan },
  { name: "update_plan", description: "Revise an existing task plan using its returned id as planId and its full steps (at most one in_progress). Omit planId to continue the current unfinished plan. For a new task use create_plan, not an invented planId. Prior plans remain intact. Legacy selector-free calls can still create a plan when none is unfinished.", input: planArgumentSchemas.update_plan },
  { name: "spawn_agent", description: "Start an independent child with inherited permission. Depth one, four active slots (released after cleanup), separate total limit 32 per run. Declare disjoint literal writePaths to reject overlapping active assignments; ownership is coordination, NOT a filesystem sandbox. Optional maxToolCalls may only lower the child budget. No automatic retry or model fallback.", input: agentArgumentSchemas.spawn_agent },
  { name: "list_agents", description: "Page persisted children of this parent session. currentRun/active/controllable distinguish historical records from locally owned work; historical running status may be stale. No tasks are resumed.", input: agentArgumentSchemas.list_agents },
  { name: "wait_agents", description: "Wait for all/any selected children (default all current-run children). Judge timeout_ms based on expected task complexity; defaults to 10 minutes (600000ms) if omitted so long tasks can finish without frequent timeout polling. Set 0 to poll immediately. Returns completed summaries AND active statuses; timeout never cancels tasks. Historical child results are readable but not joined. Returned settled results are delivered once, avoiding automatic duplicate reconciliation. Use get_agent_result for truncated text; resolve_agent explicitly records handled failures.", input: agentArgumentSchemas.wait_agents },
  { name: "cancel_agent", description: "Cancel and join a child owned by this run. Does not cancel siblings or erase failure; use resolve_agent with evidence after inspecting effects. Historical children cannot be cancelled here.", input: agentArgumentSchemas.cancel_agent },
  { name: "get_agent_result", description: "Read a bounded page of a current or historical child's latest assistant result. Only direct children of this parent are accessible. Offsets count UTF-16 string units. Returns truncation, nextOffset, errors and reported usage; no task is resumed. This partial read does not mark a result fully delivered.", input: agentArgumentSchemas.get_agent_result },
  { name: "send_agent_message", description: "Queue bounded guidance for an active child owned by this run. Consumed at the next model boundary, not an interrupt; queued does not mean executed. Cannot increase permissions, reopen settled tasks or replay effects. Queue limit eight messages.", input: agentArgumentSchemas.send_agent_message },
  { name: "resolve_agent", description: "After inspecting a settled child's outcome/effects, persist why its failure or cancellation is handled (e.g. independently completed and verified, or deliberately abandoned). Allows parent success without rewriting child status or replaying work. Never use to hide unresolved failures. Active tasks cannot be resolved.", input: agentArgumentSchemas.resolve_agent },
].map(d => defineTool(d.name, d.description, d.input));
export async function executeNative(
  ...parameters: Parameters<typeof executeNativeUnchecked>
): Promise<ToolResult> {
  try {
    return await executeNativeUnchecked(...parameters);
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new ForgeError("invalid_input", formatValidationError(error));
    throw error;
  }
}

async function executeNativeUnchecked(
  name: string,
  args: Record<string, unknown>,
  env: AgentEnvironment & {
    savePlan: (plan: TaskPlan) => Promise<void>;
  },
): Promise<ToolResult> {
  const output = (value: unknown): ToolResult => ({
    content: JSON.stringify(value).slice(0, 131072),
    isError: false,
  });
  const { deps } = env;
  switch (name) {
    case "history_search":
    case "history_read":
      return executeHistory(name, args, env.snapshot);
    case "list_models": {
      const parsed = modelListArgs.safeParse(args);
      if (!parsed.success) return invalidToolInput(parsed.error);
      if (env.signal.aborted)
        return {
          content: JSON.stringify({ error: "Model discovery cancelled" }),
          isError: true,
        };
      const { query, offset, limit } = parsed.data;
      let onAbort = () => {};
      try {
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error("cancelled"));
          env.signal.addEventListener("abort", onAbort, { once: true });
          if (env.signal.aborted) onAbort();
        });
        const catalog = await Promise.race([
          deps.provider.listModels(env.signal),
          aborted,
        ]);
        if (env.signal.aborted) throw new Error("cancelled");
        if (
          !Array.isArray(catalog) ||
          catalog.some((id) => typeof id !== "string")
        )
          throw new Error("invalid catalog");
        const matches =
          query === undefined
            ? catalog
            : catalog.filter((id) =>
                id.toLowerCase().includes(query.toLowerCase()),
              );
        const ids: string[] = [];
        const encode = () =>
          JSON.stringify({
            ids,
            total: matches.length,
            offset,
            returned: ids.length,
            nextOffset:
              offset + ids.length < matches.length ? offset + ids.length : null,
            truncated: offset + ids.length < matches.length,
          });
        for (const id of matches.slice(offset, offset + limit)) {
          ids.push(id);
          if (Buffer.byteLength(encode(), "utf8") > MODEL_CATALOG_BYTES) {
            ids.pop();
            break;
          }
        }
        if (!ids.length && offset < matches.length)
          return {
            content: JSON.stringify({
              error:
                "Catalog ID exceeds output byte limit; refine query or advance offset",
              total: matches.length,
              offset,
              returned: 0,
              nextOffset: offset + 1,
              truncated: true,
            }),
            isError: true,
          };
        return { content: encode(), isError: false };
      } catch {
        return {
          content: JSON.stringify({
            error: env.signal.aborted
              ? "Model discovery cancelled"
              : "Configured provider model catalog unavailable. Use explicitly supplied model IDs; do not guess availability.",
          }),
          isError: true,
        };
      } finally {
        env.signal.removeEventListener("abort", onAbort);
      }
    }
    case "create_plan":
    case "update_plan": {
      const { plan } = name === "create_plan"
        ? createSessionPlan(env.snapshot, args)
        : updateSessionPlan(env.snapshot, args);
      await env.savePlan(plan);
      return output(plan);
    }
    case "spawn_agent":
    case "list_agents":
    case "wait_agents":
    case "cancel_agent":
    case "get_agent_result":
    case "send_agent_message":
    case "resolve_agent":
      return executeAgentOperation(name, args, env);
    default:
      return { content: "Unknown native tool", isError: true };
  }
}
