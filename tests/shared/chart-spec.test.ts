import { describe, expect, it } from "vitest";
import {
  CHART_MAX_JSON_CHARS,
  chartFence,
  chartFenceBody,
  parseChartFence,
  validateChartSpec,
} from "../../src/shared/chart-spec";
import { runInputSchema } from "../../src/shared/schemas";
import { createChartToolRegistry } from "../../src/tools/chart";

const sessionId = "00000000-0000-0000-0000-000000000000" as never;

describe("chart spec validation", () => {
  it("accepts every friendly chart type", () => {
    const cases: unknown[] = [
      { chart: { type: "bar", categories: ["a"], series: [{ values: [1] }] } },
      {
        chart: {
          type: "bar",
          categories: ["a"],
          series: [{ values: [1] }],
          horizontal: true,
          stack: true,
        },
      },
      {
        chart: {
          type: "line",
          categories: ["a"],
          series: [{ values: [1] }],
          area: true,
        },
      },
      {
        chart: {
          type: "bar-line",
          categories: ["a"],
          bars: [{ values: [1] }],
          lines: [{ values: [2] }],
        },
      },
      {
        chart: {
          type: "candlestick",
          categories: ["d"],
          ohlc: [[1, 2, 0.5, 3]],
        },
      },
      {
        chart: {
          type: "pie",
          series: [{ data: [{ name: "x", value: 1 }] }],
          donut: true,
          rose: true,
        },
      },
      {
        chart: {
          type: "funnel",
          series: [{ data: [{ name: "x", value: 1 }] }],
        },
      },
      {
        chart: {
          type: "radar",
          indicators: [{ name: "a" }, { name: "b" }, { name: "c", max: 10 }],
          series: [{ values: [1, 2, 3] }],
        },
      },
      { chart: { type: "scatter", series: [{ points: [[1, 2]] }] } },
      {
        chart: {
          type: "heatmap",
          xCategories: ["x"],
          yCategories: ["y"],
          data: [[0, 0, 5]],
        },
      },
      { chart: { type: "gauge", value: 42, unit: "%" } },
      { chart: { type: "table", columns: ["c"], rows: [[1], [null]] } },
    ];
    for (const spec of cases) {
      const result = validateChartSpec(spec);
      expect(result.ok, JSON.stringify(spec)).toBe(true);
    }
  });

  it("rejects non-finite numbers, empty data and unknown keys", () => {
    expect(
      validateChartSpec({
        chart: {
          type: "bar",
          categories: ["a"],
          series: [{ values: [Number.POSITIVE_INFINITY] }],
        },
      }).ok,
    ).toBe(false);
    expect(
      validateChartSpec({
        chart: { type: "bar", categories: [], series: [{ values: [1] }] },
      }).ok,
    ).toBe(false);
    expect(
      validateChartSpec({
        chart: {
          type: "bar",
          categories: ["a"],
          series: [{ values: [1] }],
          extra: 1,
        },
      }).ok,
    ).toBe(false);
  });

  it("requires exactly one of chart or raw", () => {
    expect(validateChartSpec({}).ok).toBe(false);
    expect(
      validateChartSpec({
        chart: { type: "gauge", value: 1 },
        raw: { option: { series: [] } },
      }).ok,
    ).toBe(false);
  });

  it("bounds the raw passthrough payload", () => {
    expect(
      validateChartSpec({ raw: { option: { series: [{ type: "graph" }] } } })
        .ok,
    ).toBe(true);
    expect(validateChartSpec({ raw: { option: [] } }).ok).toBe(false);
    expect(validateChartSpec({ raw: { option: "nope" } }).ok).toBe(false);
    // Depth bomb beyond RAW_DEPTH_LIMIT.
    let deep: Record<string, unknown> = { end: 1 };
    for (let index = 0; index < 30; index += 1) deep = { nested: deep };
    expect(validateChartSpec({ raw: { option: deep } }).ok).toBe(false);
    // Oversized JSON budget.
    const huge = {
      raw: { option: { blob: "x".repeat(CHART_MAX_JSON_CHARS + 10) } },
    };
    expect(validateChartSpec(huge).ok).toBe(false);
  });

  it("round-trips the canonical fence", () => {
    const spec = {
      title: "T",
      note: "n",
      chart: { type: "gauge" as const, value: 7 },
    };
    const fence = chartFence(spec);
    const body = fence.slice("```chart\n".length, -"\n```".length);
    const parsed = parseChartFence(body);
    expect(parsed.ok).toBe(true);
    expect(parseChartFence("{not json").ok).toBe(false);
    expect(chartFenceBody(fence)).toBe(body);
    expect(chartFenceBody(body)).toBe(body);
  });
});

describe("run input uiHost marker", () => {
  it("accepts web and rejects anything else", () => {
    const base = { sessionId, prompt: "hi" };
    expect(runInputSchema.safeParse({ ...base, uiHost: "web" }).success).toBe(
      true,
    );
    expect(runInputSchema.safeParse({ ...base, uiHost: "cli" }).success).toBe(
      false,
    );
    expect(runInputSchema.safeParse(base).success).toBe(true);
  });
});

describe("render_chart tool", () => {
  const context = {
    sessionId,
    toolCallId: "call-1",
    workspace: process.cwd(),
    permission: "readonly" as const,
    signal: new AbortController().signal,
    approve: async () => false,
    onEvent: () => undefined,
  };

  it("returns a canonical fence for a valid spec", async () => {
    const registry = createChartToolRegistry();
    const result = await registry.execute(
      {
        id: "call-1",
        type: "function",
        function: {
          name: "render_chart",
          arguments: JSON.stringify({
            spec: {
              chart: {
                type: "line",
                categories: ["a"],
                series: [{ values: [1] }],
              },
            },
          }),
        },
      },
      context,
    );
    const payload = JSON.parse(result.content) as {
      ok: boolean;
      fence: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.fence.startsWith("```chart\n")).toBe(true);
    expect(
      parseChartFence(payload.fence.slice("```chart\n".length, -"\n```".length))
        .ok,
    ).toBe(true);
    expect(result.isError).toBe(false);
  });

  it("reports field errors instead of throwing", async () => {
    const registry = createChartToolRegistry();
    const result = await registry.execute(
      {
        id: "call-2",
        type: "function",
        function: {
          name: "render_chart",
          arguments: JSON.stringify({
            spec: { chart: { type: "bar", categories: [], series: [] } },
          }),
        },
      },
      context,
    );
    const payload = JSON.parse(result.content) as {
      ok: boolean;
      errors: string[];
    };
    expect(result.isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.errors.length).toBeGreaterThan(0);
  });

  it("survives malformed arguments", async () => {
    const registry = createChartToolRegistry();
    const result = await registry.execute(
      {
        id: "call-3",
        type: "function",
        function: { name: "render_chart", arguments: "{" },
      },
      context,
    );
    expect(result.isError).toBe(true);
  });
});
