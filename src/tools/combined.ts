import type { LocalToolRegistry, ToolContext } from "../shared/contracts";
import type { ToolCall, ToolDefinition, ToolResult } from "../shared/schemas";

export function createCombinedToolRegistry(
  ...registries: readonly LocalToolRegistry[]
): LocalToolRegistry {
  const owners = new Map<string, LocalToolRegistry>();
  for (const registry of registries)
    for (const definition of registry.definitions) {
      const name = definition.function.name;
      if (owners.has(name)) throw new Error(`Duplicate tool name: ${name}`);
      owners.set(name, registry);
    }
  const definitions: readonly ToolDefinition[] = registries.flatMap(
    (registry) => [...registry.definitions],
  );
  let disposal: Promise<void> | undefined;
  const commandAccess = registries.flatMap(registry => registry.commandTasks ? [registry.commandTasks] : []);
  return {
    definitions,
    isConcurrencySafe: call => owners.get(call.function.name)?.isConcurrencySafe?.(call) === true,
    ...(commandAccess.length ? { commandTasks: {
      list: (id: import("../shared/schemas").SessionId) => commandAccess.flatMap(access => [...access.list(id)]),
      read: (id: import("../shared/schemas").SessionId, taskId: string, offset: number, limit: number) =>
        commandAccess.map(access => access.read(id, taskId, offset, limit)).find(Boolean),
      async stop(id: import("../shared/schemas").SessionId, taskId: string) {
        for (const access of commandAccess) if (await access.stop(id, taskId)) return true;
        return false;
      },
    } } : {}),
    async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
      if (disposal)
        return { content: "Tool registry is disposed.", isError: true };
      const owner = owners.get(call.function.name);
      if (!owner)
        return {
          content: JSON.stringify({ error: "Unknown tool." }),
          isError: true,
        };
      return owner.execute(call, context);
    },
    async settleBackground(sessionId, signal) {
      const reports = (await Promise.all(registries.map(registry => registry.settleBackground?.(sessionId, signal))))
        .filter((report): report is ToolResult => report !== undefined);
      if (!reports.length) return undefined;
      if (reports.length === 1) return reports[0];
      return { content: JSON.stringify(reports), isError: reports.some(report => report.isError) };
    },
    async dispose(): Promise<void> {
      disposal ??= Promise.allSettled(
        registries.map((registry) => registry.dispose()),
      ).then(results => {
        if (results.some(result => result.status === "rejected"))
          throw new Error("Tool registry cleanup failed; inspect remaining resources.");
      });
      await disposal;
    },
  };
}
