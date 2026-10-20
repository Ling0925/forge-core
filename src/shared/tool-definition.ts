import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ForgeError } from "./errors";
import { jsonObjectSchema, toolDefinitionSchema, type ToolDefinition } from "./schemas";

/** Derive the provider contract from the executable input schema. Refinements
 * remain runtime checks; omitted fields are explicitly legacy-only inputs. */
export function defineTool(
  name: string,
  description: string,
  input: z.ZodType,
  legacyFields: readonly string[] = [],
): ToolDefinition {
  const { $schema: _dialect, ...generated } = zodToJsonSchema(input, {
    target: "jsonSchema7", $refStrategy: "none", effectStrategy: "input",
  });
  const parameters = jsonObjectSchema.parse(generated);
  if (parameters.type !== "object")
    throw new ForgeError("internal", "Tool input must be an object schema.");
  const properties = jsonObjectSchema.parse(parameters.properties ?? {});
  const omitted = new Set(legacyFields);
  return toolDefinitionSchema.parse({
    type: "function",
    function: {
      name, description,
      parameters: {
        ...parameters,
        properties: Object.fromEntries(Object.entries(properties).filter(([key]) => !omitted.has(key))),
        required: Array.isArray(parameters.required)
          ? parameters.required.filter(key => typeof key === "string" && !omitted.has(key)) : [],
      },
    },
  });
}
