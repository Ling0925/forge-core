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
  return {
    definitions,
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
    async dispose(): Promise<void> {
      disposal ??= Promise.allSettled(
        registries.map((registry) => registry.dispose()),
      ).then(() => undefined);
      await disposal;
    },
  };
}
