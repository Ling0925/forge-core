import { expect, it } from "vitest";
import { readModelContextWindow } from "../../src/provider/context-window";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  resolveContextWindow,
} from "../../src/shared/context-usage";

it.each([
  "context_length",
  "context_window",
  "max_model_len",
  "max_input_tokens",
])(
  "reads numeric and string %s without clamping to the unknown-model default",
  (field) => {
    for (const value of [128000, 1000000, "1000000"]) {
      const reported = readModelContextWindow({ [field]: value });
      expect(reported).toBe(Number(value));
      expect(resolveContextWindow("gateway/alias", {}, reported)).toBe(
        Number(value),
      );
      expect(
        resolveContextWindow(
          "gateway/alias",
          { modelContextWindows: { "gateway/alias": 64000 } },
          reported,
        ),
      ).toBe(64000);
    }
  },
);

it.each([
  null,
  undefined,
  0,
  -1,
  1.5,
  10000001,
  Number.POSITIVE_INFINITY,
  Number.NaN,
  true,
  {},
  [],
  "",
  "300K",
  "1e6",
  "-1",
  "1.5",
])("ignores invalid optional window metadata: %s", (value) => {
  expect(readModelContextWindow({ context_length: value })).toBeNull();
  expect(
    readModelContextWindow({
      context_length: value,
      max_input_tokens: 1000000,
    }),
  ).toBe(1000000);
});

it("reads nested input limits but never invents a window from output limits or model names", () => {
  expect(
    readModelContextWindow({ top_provider: { context_length: "524288" } }),
  ).toBe(524288);
  expect(
    readModelContextWindow({ context_length: 128000, context_window: 64000 }),
  ).toBe(128000);
  for (const metadata of [
    null,
    [],
    { id: "1M-context", max_tokens: 1000000, max_output_tokens: 8192 },
    { top_provider: true },
  ]) {
    expect(readModelContextWindow(metadata)).toBeNull();
    expect(
      resolveContextWindow("unknown", {}, readModelContextWindow(metadata)),
    ).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  }
});

it("resolves windows: per-model setting, reported, known table, configured default, built-in default", () => {
  expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(128000);
  const settings = {
    modelContextWindows: { pinned: 64000 },
    defaultContextWindowTokens: 300000,
  };
  expect(resolveContextWindow("pinned", settings, 1000000)).toBe(64000);
  expect(resolveContextWindow("gpt-4o", settings, 1000000)).toBe(1000000);
  expect(resolveContextWindow("o3-mini", settings, null)).toBe(200000);
  expect(resolveContextWindow("unknown", settings, null)).toBe(300000);
  expect(resolveContextWindow("unknown", {}, null)).toBe(128000);
});
