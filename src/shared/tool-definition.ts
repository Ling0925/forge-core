import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ForgeError } from "./errors";
import {
  type ToolDefinition,
  jsonObjectSchema,
  toolDefinitionSchema,
} from "./schemas";

const definitionCache = new WeakMap<z.ZodType, Map<string, ToolDefinition>>();

/** Derive the provider contract from the executable input schema. Refinements
 * remain runtime checks; omitted fields are explicitly legacy-only inputs. */
export function defineTool(
  name: string,
  description: string,
  input: z.ZodType,
  legacyFields: readonly string[] = [],
): ToolDefinition {
  const key = JSON.stringify([name, description, legacyFields]);
  let definitions = definitionCache.get(input);
  const cached = definitions?.get(key);
  if (cached) return cached;
  const { $schema: _dialect, ...generated } = zodToJsonSchema(input, {
    target: "jsonSchema7",
    $refStrategy: "none",
    effectStrategy: "input",
  });
  const parameters = jsonObjectSchema.parse(generated);
  if (parameters.type !== "object")
    throw new ForgeError("internal", "Tool input must be an object schema.");
  const properties = jsonObjectSchema.parse(parameters.properties ?? {});
  const omitted = new Set(legacyFields);
  const definition = toolDefinitionSchema.parse({
    type: "function",
    function: {
      name,
      description,
      parameters: {
        ...parameters,
        properties: Object.fromEntries(
          Object.entries(properties).filter(([key]) => !omitted.has(key)),
        ),
        required: Array.isArray(parameters.required)
          ? parameters.required.filter(
              (key) => typeof key === "string" && !omitted.has(key),
            )
          : [],
      },
    },
  });
  if (!definitions) {
    definitions = new Map();
    definitionCache.set(input, definitions);
  }
  definitions.set(key, definition);
  return definition;
}
