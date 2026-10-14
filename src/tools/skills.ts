import {
  CONTEXT_INSTRUCTION_TOOL_NAME,
  LOAD_SKILL_TOOL_NAME,
  type ProjectContextService,
  contextPathArgumentsSchema,
  createProjectContextTool,
  loadSkillArgumentsSchema,
} from "../context/project-context";
import type { LocalToolRegistry, ToolContext } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import type { JsonValue, ToolCall, ToolResult } from "../shared/schemas";

export interface SkillToolOptions {
  readonly context: ProjectContextService;
}

function encode(value: JsonValue, isError = false): ToolResult {
  return { content: JSON.stringify(value), isError };
}

/**
 * Wraps a ProjectContextService as a LocalToolRegistry-shaped bundle exposing
 * the read-only `project_context` and `load_skill` native tools. Skill files
 * are instructions only: this registry performs no mutations, runs no commands
 * and grants no permissions; all other tools still obey core policy.
 */
export function createSkillTool(
  service: ProjectContextService,
  _options: SkillToolOptions = { context: service },
): LocalToolRegistry {
  const bundle = createProjectContextTool(service);
  let disposed = false;

  async function execute(
    call: ToolCall,
    context: ToolContext,
  ): Promise<ToolResult> {
    if (disposed) {
      throw new ForgeError("internal", "Skill tool disposed.");
    }
    if (call.function.name === CONTEXT_INSTRUCTION_TOOL_NAME) {
      const args = contextPathArgumentsSchema.safeParse({
        tool: call.function.name,
        ...(JSON.parse(call.function.arguments || "{}") as { path?: string }),
      });
      if (!args.success) {
        return encode(
          { error: "invalid_input", message: "Path is required." },
          true,
        );
      }
      const sources = await service.resolveInstructions(
        args.data.path,
        context.signal,
      );
      return encode({
        sources: sources.map((source) => ({
          path: source.path,
          order: source.order,
          bytes: source.bytes,
          body: source.body,
        })),
        count: sources.length,
      });
    }
    if (call.function.name === LOAD_SKILL_TOOL_NAME) {
      const args = loadSkillArgumentsSchema.safeParse({
        tool: call.function.name,
        ...(JSON.parse(call.function.arguments || "{}") as { skill?: string }),
      });
      if (!args.success) {
        return encode(
          { error: "invalid_input", message: "Skill id required." },
          true,
        );
      }
      try {
        const record = await service.loadSkill(args.data.skill, context.signal);
        return encode({
          id: record.id,
          name: record.name,
          description: record.description,
          version: record.version,
          sourceDirectory: record.sourceDirectory,
          body: record.body,
        });
      } catch (error) {
        if (error instanceof ForgeError && error.code === "invalid_input") {
          return encode(
            { error: "unknown_skill", skill: args.data.skill },
            true,
          );
        }
        throw error;
      }
    }
    return encode({ error: "unknown_tool", tool: call.function.name }, true);
  }

  return {
    definitions: bundle.definitions,
    execute,
    async dispose(): Promise<void> {
      disposed = true;
    },
  };
}
