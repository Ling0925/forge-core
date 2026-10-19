import { z } from "zod";
import type { ToolDefinition, ToolResult } from "../shared/schemas";
import type { TaskPlan } from "../shared/schemas";
import { updateSessionPlan } from "./plans";
import { executeHistory, historyDefinitions } from "./history";
import { executeAgentOperation, type AgentEnvironment } from "./agent-operations";
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
  {
    name: "list_models",
    description:
      "Readonly discovery of exact IDs from the configured provider catalog. Optional substring query and pagination. Catalog presence does not prove live quota or availability; no capability, pricing, or quota guarantees. Discover IDs before choosing distinct delegation models; preserve IDs explicitly supplied by the user. If discovery fails, report it and use explicitly supplied IDs, not invented alternatives. Never automatically replay or fallback an effectful task.",
    properties: {
      query: { type: "string", maxLength: 256 },
      offset: {
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        default: 0,
      },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    },
    required: [],
  },
  {
    name: "update_plan",
    description: "Persist independent task plans within this session. For each new multi-step task use action:create and a concise title; prior plans stay intact. To revise the same task use action:update with the returned planId (id in the result), sending its full steps. Never append an unrelated task to an old plan. Without selectors, continues the current unfinished plan or creates a new one after completion. Repeat calls are allowed throughout the session; simple questions need no plan.",
    properties: {
      action: { type: "string", enum: ["create", "update"] },
      planId: { type: "string", minLength: 1, maxLength: 128 },
      title: { type: "string", minLength: 1, maxLength: 256 },
      explanation: { type: "string" },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            step: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
          },
          required: ["step", "status"],
        },
      },
    },
    required: ["explanation", "steps"],
  },
  {
    name: "spawn_agent",
    description: "Start an independent child with inherited permission. Depth one, four active slots (released after cleanup), separate total limit 32 per run. Declare disjoint literal writePaths to reject overlapping active assignments; ownership is coordination, NOT a filesystem sandbox. Optional maxToolCalls may only lower the child budget. No automatic retry or model fallback.",
    properties: {
      task: { type: "string", minLength: 1, maxLength: 16384 },
      ownership: { type: "string", minLength: 1, maxLength: 4096 },
      model: { type: "string", minLength: 1, maxLength: 256 },
      writePaths: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 512 } },
      maxToolCalls: { type: "integer", minimum: 1, maximum: 10000 },
    },
    required: ["task"],
  },
  {
    name: "list_agents",
    description: "Page persisted children of this parent session. currentRun/active/controllable distinguish historical records from locally owned work; historical running status may be stale. No tasks are resumed.",
    properties: {
      offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      currentRun: { type: "boolean", default: false },
    },
    required: [],
  },
  {
    name: "wait_agents",
    description: "Wait for all/any selected children (default all current-run children), at most timeout_ms (default 30s; 0 polls). Returns completed summaries AND active statuses; timeout never cancels tasks. Historical child results are readable but not joined. Returned settled results are delivered once, avoiding automatic duplicate reconciliation. Use get_agent_result for truncated text; resolve_agent explicitly records handled failures.",
    properties: {
      ids: { type: "array", maxItems: 32, items: { type: "string", format: "uuid" } },
      mode: { type: "string", enum: ["all", "any"], default: "all" },
      timeout_ms: { type: "integer", minimum: 0, maximum: 120000, default: 30000 },
    },
    required: [],
  },
  {
    name: "cancel_agent",
    description: "Cancel and join a child owned by this run. Does not cancel siblings or erase failure; use resolve_agent with evidence after inspecting effects. Historical children cannot be cancelled here.",
    properties: { id: { type: "string", format: "uuid" } },
    required: ["id"],
  },
  {
    name: "get_agent_result",
    description: "Read a bounded page of a current or historical child's latest assistant result. Only direct children of this parent are accessible. Offsets count UTF-16 string units. Returns truncation, nextOffset, errors and reported usage; no task is resumed. This partial read does not mark a result fully delivered.",
    properties: {
      id: { type: "string", format: "uuid" },
      offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
      limit: { type: "integer", minimum: 1, maximum: 8192, default: 4096 },
    },
    required: ["id"],
  },
  {
    name: "send_agent_message",
    description: "Queue bounded guidance for an active child owned by this run. Consumed at the next model boundary, not an interrupt; queued does not mean executed. Cannot increase permissions, reopen settled tasks or replay effects. Queue limit eight messages.",
    properties: { id: { type: "string", format: "uuid" }, message: { type: "string", minLength: 1, maxLength: 16384 } },
    required: ["id", "message"],
  },
  {
    name: "resolve_agent",
    description: "After inspecting a settled child's outcome/effects, persist why its failure or cancellation is handled (e.g. independently completed and verified, or deliberately abandoned). Allows parent success without rewriting child status or replaying work. Never use to hide unresolved failures. Active tasks cannot be resolved.",
    properties: { id: { type: "string", format: "uuid" }, resolution: { type: "string", minLength: 1, maxLength: 4096 } },
    required: ["id", "resolution"],
  },
].map((d) => ({
  type: "function",
  function: {
    name: d.name,
    description: d.description,
    parameters: {
      type: "object",
      properties: d.properties,
      required: d.required,
      additionalProperties: false,
    },
  },
})) as ToolDefinition[];
export async function executeNative(
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
      if (!parsed.success)
        return {
          content: JSON.stringify({ error: "Invalid list_models arguments" }),
          isError: true,
        };
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
    case "update_plan": {
      const { plan } = updateSessionPlan(env.snapshot, args);
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
