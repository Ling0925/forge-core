import { assert, describe, expect, it } from "vitest";
import { z } from "zod";
import { type RawJson, chartRawSchema } from "../../src/shared/chart-spec";
import { type JsonValue, jsonValueSchema } from "../../src/shared/schemas/base";

const uncachedJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(uncachedJsonValueSchema).readonly(),
    z.record(uncachedJsonValueSchema).readonly(),
  ]),
);

const uncachedRawJsonSchema: z.ZodType<RawJson> = z.lazy(() =>
  z.union([
    z.string().max(2000),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(uncachedRawJsonSchema).max(4096),
    z
      .record(uncachedRawJsonSchema)
      .refine(
        (value) => Object.keys(value).length <= 256,
        "raw option objects accept at most 256 keys per level.",
      ),
  ]),
);

describe.each([
  {
    name: "jsonValueSchema",
    schema: jsonValueSchema,
    uncached: uncachedJsonValueSchema,
  },
  {
    name: "rawJsonSchema",
    schema: chartRawSchema.innerType().innerType().shape.option.innerType(),
    uncached: uncachedRawJsonSchema,
  },
])("$name", ({ schema, uncached }) => {
  it("preserves nested JSON results and readonly behavior", () => {
    const values: JsonValue[] = [
      null,
      true,
      false,
      -0,
      1.5,
      "text",
      [],
      {},
      [null, { values: [true, 1, "text", { empty: [] }] }],
      { nested: [{ values: [false, null, -2] }], empty: {} },
    ];
    function check(value: JsonValue) {
      const actual = schema.parse(value);
      const expected = uncached.parse(value);
      expect(actual).toStrictEqual(expected);
      expect(Object.isFrozen(actual)).toBe(Object.isFrozen(expected));
      if (value !== null && typeof value === "object") {
        for (const child of Object.values(value)) check(child);
      }
    }
    for (const value of values) check(value);
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("preserves errors for %s at every nesting level", (value) => {
    for (const input of [value, [value], { nested: [{ value }] }]) {
      const actual = schema.safeParse(input);
      const expected = uncached.safeParse(input);
      assert(!actual.success && !expected.success);
      expect(actual.error.message).toBe(expected.error.message);
      expect(JSON.stringify(actual.error.issues)).toBe(
        JSON.stringify(expected.error.issues),
      );
    }
  });

  it("reuses the union while validating changed inputs on every parse", () => {
    assert(schema instanceof z.ZodLazy);
    const union = schema.schema;
    const input: { nested: unknown[] } = { nested: ["first"] };
    expect(schema.parse(input)).toStrictEqual(uncached.parse(input));
    expect(schema.schema).toBe(union);

    input.nested.push(undefined);
    expect(schema.safeParse(input).success).toBe(false);
    expect(schema.schema).toBe(union);

    input.nested[1] = { value: [null, true, 2] };
    expect(schema.parse(input)).toStrictEqual(uncached.parse(input));
    expect(schema.schema).toBe(union);
  });
});
