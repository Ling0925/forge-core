import { z } from "zod";
import type {
  AgentRuntimeDependencies,
  ApprovalHandler,
} from "../shared/contracts";
import type {
  Permission,
  RunInput,
  SessionSnapshot,
  ToolDefinition,
  ToolResult,
} from "../shared/schemas";
import { taskPlanSchema } from "../shared/schemas";
const modelListArgs = z
  .object({
    query: z.string().max(256).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
const MODEL_CATALOG_BYTES = 32768;

export const nativeDefinitions: readonly ToolDefinition[] = [
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
    description: "Persist plan and explain changes",
    properties: {
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
    description:
      "Start concurrent independent agent, depth one, max four. Permission inherited.",
    properties: {
      task: { type: "string" },
      ownership: { type: "string" },
      model: { type: "string" },
    },
    required: ["task"],
  },
  {
    name: "list_agents",
    description: "List persisted children",
    properties: {},
    required: [],
  },
  {
    name: "wait_agents",
    description: "Join children, obtain results",
    properties: { ids: { type: "array", items: { type: "string" } } },
    required: [],
  },
  {
    name: "cancel_agent",
    description: "Cancel and join child",
    properties: { id: { type: "string" } },
    required: ["id"],
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
export const agentSummary = (s: SessionSnapshot) => ({
  id: s.id,
  status: s.status,
  model: s.model,
  summary:
    s.messages
      .filter((m) => m.role === "assistant")
      .at(-1)
      ?.content?.slice(0, 4096) ?? "No result",
  errors: s.events.filter((e) => e.type === "error").slice(-1),
});
export async function executeNative(
  name: string,
  args: Record<string, unknown>,
  env: {
    deps: AgentRuntimeDependencies;
    snapshot: SessionSnapshot;
    input: RunInput;
    permission: Permission;
    signal: AbortSignal;
    children: Map<
      string,
      { controller: AbortController; work: Promise<SessionSnapshot> }
    >;
    savePlan: (plan: ReturnType<typeof taskPlanSchema.parse>) => Promise<void>;
    runChild: (
      input: RunInput,
      approve: ApprovalHandler,
      signal: AbortSignal,
    ) => Promise<SessionSnapshot>;
    approveChild: (id: SessionSnapshot["id"]) => ApprovalHandler;
  },
): Promise<ToolResult> {
  const output = (value: unknown): ToolResult => ({
    content: JSON.stringify(value).slice(0, 131072),
    isError: false,
  });
  const { deps, snapshot, input, children } = env;
  switch (name) {
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
      const plan = taskPlanSchema.parse(args);
      await env.savePlan(plan);
      return output(plan);
    }
    case "spawn_agent": {
      if (snapshot.parentSessionId || children.size >= 4)
        return {
          content: "Agent depth/concurrency limit reached",
          isError: true,
        };
      if (
        typeof args.task !== "string" ||
        !args.task.trim() ||
        args.task.length > 16384
      )
        return { content: "Invalid task", isError: true };
      const child = await deps.store.create({
        workspace: snapshot.workspace,
        title: args.task.slice(0, 256),
        model: typeof args.model === "string" ? args.model : snapshot.model,
      });
      await deps.store.save({
        ...child,
        parentSessionId: input.sessionId,
        agentTask: args.task,
        ownership:
          typeof args.ownership === "string"
            ? args.ownership.slice(0, 4096)
            : undefined,
        permissionCeiling: env.permission,
      });
      const controller = new AbortController();
      const work = env.runChild(
        {
          sessionId: child.id,
          model: child.model,
          prompt: `${args.task}\nOwnership: ${String(args.ownership ?? "unspecified")}`,
          permission: env.permission,
          ...(input.mode ? { mode: input.mode } : {}),
        },
        env.approveChild(child.id),
        AbortSignal.any([env.signal, controller.signal]),
      );
      void work.catch(() => undefined); // always joined by root finish
      children.set(child.id, { controller, work });
      deps.onChildOperation?.(child.id, controller, work);
      return output({ childSessionId: child.id, model: child.model });
    }
    case "list_agents":
      return output(
        (await deps.store.list()).filter(
          (s) => s.parentSessionId === input.sessionId,
        ),
      );
    case "wait_agents": {
      const ids = Array.isArray(args.ids)
        ? args.ids.map(String)
        : [...children.keys()];
      return output(
        await Promise.all(
          ids.map(async (id) => {
            const c = children.get(id);
            return c
              ? agentSummary(await c.work)
              : { id, error: "Not child of this run" };
          }),
        ),
      );
    }
    case "cancel_agent": {
      const c = children.get(String(args.id));
      if (!c) return { content: "Unknown child", isError: true };
      c.controller.abort();
      return output(agentSummary(await c.work));
    }
    default:
      return { content: "Unknown native tool", isError: true };
  }
}
