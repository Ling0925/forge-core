import { z } from "zod";
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
import { invalidToolInput, recoverToolInputError } from "../shared/tool-input";
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

  async function perform(
    call: ToolCall,
    context: ToolContext,
  ): Promise<ToolResult> {
    if (disposed) {
      throw new ForgeError("internal", "Skill tool disposed.");
    }
    const input = z.record(z.unknown()).parse(JSON.parse(call.function.arguments || "{}"));
    if ("tool" in input) return invalidToolInput("tool is not an accepted argument; use the declared parameters.");
    if (call.function.name === CONTEXT_INSTRUCTION_TOOL_NAME) {
      const args = contextPathArgumentsSchema.safeParse({
        tool: call.function.name,
        ...input,
      });
      if (!args.success) {
        return invalidToolInput(args.error);
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
        ...input,
      });
      if (!args.success) {
        return invalidToolInput(args.error);
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
          return invalidToolInput("Unknown skill. Use an ID from the discovered skill catalog.");
        }
        throw error;
      }
    }
    return encode({ error: "unknown_tool", tool: call.function.name }, true);
  }

  return {
    definitions: bundle.definitions,
    async execute(call, context) {
      try { return await perform(call, context); }
      catch (error) {
        const invalid = recoverToolInputError(error);
        if (invalid) return invalid;
        throw error;
      }
    },
    async dispose(): Promise<void> {
      disposed = true;
    },
  };
}
