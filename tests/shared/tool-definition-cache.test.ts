import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ForgeError } from "../../src/shared/errors";
import {
  type JsonValue,
  jsonObjectSchema,
  toolDefinitionSchema,
} from "../../src/shared/schemas";
import { defineTool } from "../../src/shared/tool-definition";

vi.mock("zod-to-json-schema", { spy: true });

function uncachedDefinition(
  name: string,
  description: string,
  input: z.ZodType,
  legacyFields: readonly string[] = [],
) {
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
  return toolDefinitionSchema.parse({
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
}

function objectsIn(value: JsonValue): object[] {
  if (value === null || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(objectsIn)];
}

describe("tool definition cache", () => {
  it("reuses a recursively frozen definition equal to the uncached result without parsing again", () => {
    const input = z
      .object({
        action: z.enum(["read", "write"]),
        items: z.array(z.object({ path: z.string().min(1) }).strict()),
        options: z.object({ enabled: z.boolean() }).default({ enabled: true }),
        label: z.string().optional(),
      })
      .strict()
      .refine((value) => value.items.length > 0);
    const expected = uncachedDefinition("test", "Test", input);
    vi.mocked(zodToJsonSchema).mockClear();
    const parseObject = vi.spyOn(jsonObjectSchema, "parse");
    const parseDefinition = vi.spyOn(toolDefinitionSchema, "parse");

    const first = defineTool("test", "Test", input);
    const second = defineTool("test", "Test", input);

    expect(zodToJsonSchema).toHaveBeenCalledTimes(1);
    expect(parseObject).toHaveBeenCalledTimes(2);
    expect(parseDefinition).toHaveBeenCalledTimes(1);
    expect(first).toEqual(expected);
    expect(second).toBe(first);
    for (const object of objectsIn(first)) {
      expect(Object.isFrozen(object)).toBe(true);
      expect(Reflect.set(object, "type", "mutated")).toBe(false);
    }
    expect(defineTool("test", "Test", input)).toEqual(expected);
    expect(zodToJsonSchema).toHaveBeenCalledTimes(1);
  });

  it("converts new schema identities after changes without replacing earlier entries", () => {
    const input = z.object({ path: z.string() }).strict();
    const changed = input.extend({ recursive: z.boolean() });
    const equivalent = z.object({ path: z.string() }).strict();
    const expected = uncachedDefinition("test", "Test", input);
    const changedExpected = uncachedDefinition("test", "Test", changed);
    vi.mocked(zodToJsonSchema).mockClear();

    const first = defineTool("test", "Test", input);
    const second = defineTool("test", "Test", changed);
    const third = defineTool("test", "Test", equivalent);
    expect(first).toEqual(expected);
    expect(second).toEqual(changedExpected);
    expect(third).toEqual(expected);
    expect(third).not.toBe(first);
    expect(zodToJsonSchema).toHaveBeenCalledTimes(3);
    expect(defineTool("test", "Test", input)).toBe(first);
    expect(defineTool("test", "Test", changed)).toBe(second);
    expect(zodToJsonSchema).toHaveBeenCalledTimes(3);
  });

  it("keys definitions by name, description and legacy field contents", () => {
    const input = z
      .object({
        path: z.string(),
        legacy: z.boolean(),
        "path,legacy": z.string(),
        optional: z.string().optional(),
      })
      .strict();
    const cases = [
      { name: "first", description: "First", legacyFields: ["legacy"] },
      { name: "second", description: "First", legacyFields: ["legacy"] },
      { name: "first", description: "Second", legacyFields: ["legacy"] },
      { name: "first", description: "First", legacyFields: ["path"] },
      { name: "first", description: "First", legacyFields: [] },
      { name: "first", description: "First", legacyFields: ["path,legacy"] },
      { name: "first", description: "First", legacyFields: ["path", "legacy"] },
    ];
    const expected = cases.map(({ name, description, legacyFields }) =>
      uncachedDefinition(name, description, input, legacyFields),
    );
    vi.mocked(zodToJsonSchema).mockClear();

    const definitions = cases.map(({ name, description, legacyFields }) =>
      defineTool(name, description, input, legacyFields),
    );
    expect(definitions).toEqual(expected);
    for (const [
      index,
      { name, description, legacyFields },
    ] of cases.entries()) {
      expect(defineTool(name, description, input, [...legacyFields])).toBe(
        definitions[index],
      );
    }
    const legacyFields = ["legacy"];
    expect(defineTool("first", "First", input, legacyFields)).toBe(
      definitions[0],
    );
    legacyFields[0] = "path";
    expect(defineTool("first", "First", input, legacyFields)).toBe(
      definitions[3],
    );
    expect(defineTool("first", "First", input)).toBe(definitions[4]);
    expect(zodToJsonSchema).toHaveBeenCalledTimes(cases.length);
  });

  it("does not cache validation failures", () => {
    const input = z.object({ path: z.string() });
    const parseDefinition = vi.spyOn(toolDefinitionSchema, "parse");
    expect(() => defineTool("invalid name", "Test", input)).toThrow(z.ZodError);
    expect(defineTool("valid", "Test", input).function.name).toBe("valid");
    expect(() => defineTool("invalid name", "Test", input)).toThrow(z.ZodError);
    expect(zodToJsonSchema).toHaveBeenCalledTimes(3);
    expect(parseDefinition).toHaveBeenCalledTimes(3);

    const nonObject = z.string();
    expect(() => defineTool("test", "Test", nonObject)).toThrow(
      new ForgeError("internal", "Tool input must be an object schema."),
    );
    expect(() => defineTool("test", "Test", nonObject)).toThrow(
      new ForgeError("internal", "Tool input must be an object schema."),
    );
    expect(zodToJsonSchema).toHaveBeenCalledTimes(5);
  });

  it("retries conversion after a conversion failure", () => {
    const input = z.object({ path: z.string() });
    const error = new Error("Conversion failed");
    vi.mocked(zodToJsonSchema).mockImplementationOnce(() => {
      throw error;
    });

    expect(() => defineTool("test", "Test", input)).toThrow(error);
    const definition = defineTool("test", "Test", input);
    expect(defineTool("test", "Test", input)).toBe(definition);
    expect(zodToJsonSchema).toHaveBeenCalledTimes(2);
  });
});
