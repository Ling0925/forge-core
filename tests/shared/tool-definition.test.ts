import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../../src/shared/tool-definition";

describe("executable tool contracts", () => {
  it("preserves strict objects, optional defaults and nested limits", () => {
    const input = z.object({
      action: z.enum(["read", "write"]),
      limit: z.number().int().min(1).max(10).default(5),
      items: z.array(z.object({ path: z.string().min(1) }).strict()).max(3).optional(),
    }).strict();
    const parameters = defineTool("test", "Test", input).function.parameters;
    expect(parameters).toMatchObject({ type: "object", additionalProperties: false, required: ["action"],
      properties: { action: { enum: ["read", "write"] }, limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
        items: { maxItems: 3, items: { type: "object", additionalProperties: false, required: ["path"] } } } });
    expect(input.parse({ action: "read" })).toEqual({ action: "read", limit: 5 });
    expect(input.safeParse({ action: "read", limit: 11 }).success).toBe(false);
  });

  it("omits explicit legacy inputs only from the provider contract", () => {
    const input = z.object({ path: z.string(), legacy: z.boolean().optional() }).strict();
    expect(defineTool("test", "Test", input, ["legacy"]).function.parameters.properties).toEqual({ path: { type: "string" } });
    expect(input.parse({ path: "a", legacy: true })).toEqual({ path: "a", legacy: true });
  });

  it("keeps semantic refinements in the parser without creating a union tool", () => {
    const input = z.object({ first: z.boolean(), second: z.boolean() }).strict()
      .refine(value => value.first !== value.second);
    expect(defineTool("test", "Test", input).function.parameters).toMatchObject({ type: "object", required: ["first", "second"] });
    expect(input.safeParse({ first: true, second: true }).success).toBe(false);
    expect(() => defineTool("test", "Test", z.string())).toThrow("object schema");
  });
});
