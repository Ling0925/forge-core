import { z } from "zod";

/**
 * Chart attachment contract shared by the Web host and the Web renderer.
 *
 * Two layers:
 * - `chartSpecSchema` (friendly layer): a small, closed grammar the model can
 *   always emit; the renderer compiles it into ECharts options.
 * - `raw` (passthrough layer): a native ECharts option object. It is only ever
 *   handed to the renderer's ECharts instance (never eval'd, never HTML), but
 *   it is still size- and shape-bounded here so oversized or hostile payloads
 *   cannot ride along in a tool result or transcript.
 *
 * `render_chart` (Web host only) validates against this contract and returns a
 * canonical ` ```chart ` fence; the renderer parses the same fence with the
 * same schema, so what validates is what renders.
 */

const NAME_LIMIT = 120;
const NOTE_LIMIT = 2000;
const RAW_DEPTH_LIMIT = 24;
const RAW_NODES_LIMIT = 4000;
const RAW_STRING_LIMIT = 2000;

const name = z.string().min(1).max(NAME_LIMIT);
const number = z.number().finite();
const numArray = z.array(number).min(1).max(512);
const seriesName = z.string().min(1).max(NAME_LIMIT).optional();

/** A numeric series: either explicit values or a category-aligned value list. */
const valuesSeries = z
  .object({
    name: seriesName,
    values: numArray,
  })
  .strict();

const namedValuesSeries = z
  .object({
    name: seriesName,
    data: z
      .array(z.object({ name, value: number }).strict())
      .min(1)
      .max(512),
  })
  .strict();

const categoryAxis = {
  categories: z.array(name).min(1).max(512),
};

const axisExtra = {
  title: z.string().min(1).max(NAME_LIMIT).optional(),
  stack: z.boolean().optional(),
};

const barSeries = z
  .object({
    type: z.literal("bar"),
    ...categoryAxis,
    series: z.array(valuesSeries).min(1).max(12),
    horizontal: z.boolean().optional(),
    ...axisExtra,
  })
  .strict();

const lineSeries = z
  .object({
    type: z.literal("line"),
    ...categoryAxis,
    series: z.array(valuesSeries).min(1).max(12),
    area: z.boolean().optional(),
    ...axisExtra,
  })
  .strict();

/** Bar + line combo: `bars` render as columns, `lines` as polylines on the same axes. */
const barLineSeries = z
  .object({
    type: z.literal("bar-line"),
    ...categoryAxis,
    bars: z.array(valuesSeries).min(1).max(8),
    lines: z.array(valuesSeries).min(1).max(8),
    ...axisExtra,
  })
  .strict();

const candlestickSeries = z
  .object({
    type: z.literal("candlestick"),
    ...categoryAxis,
    /** One [open, close, low, high] per category, ECharts tuple order. */
    ohlc: z
      .array(z.tuple([number, number, number, number]))
      .min(1)
      .max(512),
    name: seriesName,
    ...axisExtra,
  })
  .strict();

const pieSeries = z
  .object({
    type: z.literal("pie"),
    series: z.array(namedValuesSeries).length(1),
    donut: z.boolean().optional(),
    rose: z.boolean().optional(),
    note: z.string().min(1).max(NOTE_LIMIT).optional(),
  })
  .strict();

const funnelSeries = z
  .object({
    type: z.literal("funnel"),
    series: z.array(namedValuesSeries).length(1),
    note: z.string().min(1).max(NOTE_LIMIT).optional(),
  })
  .strict();

const radarSeries = z
  .object({
    type: z.literal("radar"),
    indicators: z
      .array(z.object({ name, max: number.optional() }).strict())
      .min(3)
      .max(12),
    series: z.array(valuesSeries).min(1).max(8),
    note: z.string().min(1).max(NOTE_LIMIT).optional(),
  })
  .strict();

const scatterSeries = z
  .object({
    type: z.literal("scatter"),
    series: z
      .array(
        z
          .object({
            name: seriesName,
            points: z
              .array(z.tuple([number, number]))
              .min(1)
              .max(2048),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    xTitle: z.string().min(1).max(NAME_LIMIT).optional(),
    yTitle: z.string().min(1).max(NAME_LIMIT).optional(),
  })
  .strict();

const heatmapSeries = z
  .object({
    type: z.literal("heatmap"),
    xCategories: z.array(name).min(1).max(64),
    yCategories: z.array(name).min(1).max(64),
    /** [xIndex, yIndex, value] triples over the category grids above. */
    data: z
      .array(
        z.tuple([z.number().int().min(0), z.number().int().min(0), number]),
      )
      .min(1)
      .max(2048),
    xTitle: z.string().min(1).max(NAME_LIMIT).optional(),
    yTitle: z.string().min(1).max(NAME_LIMIT).optional(),
  })
  .strict();

const gaugeSeries = z
  .object({
    type: z.literal("gauge"),
    value: number,
    min: number.optional(),
    max: number.optional(),
    unit: z.string().min(1).max(24).optional(),
    name: seriesName,
  })
  .strict();

const tableSeries = z
  .object({
    type: z.literal("table"),
    columns: z.array(name).min(1).max(24),
    rows: z
      .array(z.array(z.union([name, number, z.null()])).max(24))
      .min(1)
      .max(512),
  })
  .strict();

export const chartFriendlySchema = z.discriminatedUnion("type", [
  barSeries,
  lineSeries,
  barLineSeries,
  candlestickSeries,
  pieSeries,
  funnelSeries,
  radarSeries,
  scatterSeries,
  heatmapSeries,
  gaugeSeries,
  tableSeries,
]);
export type ChartFriendly = z.infer<typeof chartFriendlySchema>;

/** Bounded JSON value for the raw passthrough layer (no functions, no depth bombs). */
export type RawJson =
  | string
  | number
  | boolean
  | null
  | readonly RawJson[]
  | { readonly [key: string]: RawJson };

const rawJsonSchema: z.ZodType<RawJson> = z.lazy(() =>
  z.union([
    z.string().max(RAW_STRING_LIMIT),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(rawJsonSchema).max(4096),
    z
      .record(rawJsonSchema)
      .refine(
        (value) => Object.keys(value).length <= 256,
        "raw option objects accept at most 256 keys per level.",
      ),
  ]),
);

function rawNodeCount(value: RawJson): number {
  if (Array.isArray(value))
    return 1 + value.reduce((sum: number, item) => sum + rawNodeCount(item), 0);
  if (value !== null && typeof value === "object")
    return (
      1 +
      Object.values(value).reduce(
        (sum: number, item) => sum + rawNodeCount(item),
        0,
      )
    );
  return 1;
}

function rawDepth(value: RawJson): number {
  if (Array.isArray(value))
    return 1 + (value.length ? Math.max(...value.map(rawDepth)) : 0);
  if (value !== null && typeof value === "object") {
    const children = Object.values(value);
    return 1 + (children.length ? Math.max(...children.map(rawDepth)) : 0);
  }
  return 1;
}

/**
 * Native ECharts option escape hatch. Kept as a bounded JSON record rather
 * than a fixed grammar: the renderer hands it to `echarts.setOption` directly,
 * which cannot execute code, and the bounds here stop pathological payloads.
 */
export const chartRawSchema = z
  .object({
    option: rawJsonSchema.refine(
      (value) =>
        value !== null && typeof value === "object" && !Array.isArray(value),
      "raw.option must be an ECharts option object.",
    ),
  })
  .strict()
  .refine(
    (value) => rawDepth(value.option) <= RAW_DEPTH_LIMIT,
    `raw option nests deeper than ${RAW_DEPTH_LIMIT} levels.`,
  )
  .refine(
    (value) => rawNodeCount(value.option) <= RAW_NODES_LIMIT,
    `raw option exceeds ${RAW_NODES_LIMIT} JSON nodes.`,
  );

export const chartSpecSchema = z
  .object({
    title: z.string().min(1).max(NAME_LIMIT).optional(),
    note: z.string().min(1).max(NOTE_LIMIT).optional(),
    /** Preferred: the closed friendly grammar. */
    chart: chartFriendlySchema.optional(),
    /** Escape hatch: a native ECharts option object (Web renderer only). */
    raw: chartRawSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.chart) !== Boolean(value.raw),
    "Provide exactly one of `chart` (friendly grammar) or `raw` (ECharts option).",
  )
  .readonly();
export type ChartSpec = z.infer<typeof chartSpecSchema>;

/** Total serialized budget for one chart payload (tool argument and fence alike). */
export const CHART_MAX_JSON_CHARS = 200_000;

export function chartJsonTooLarge(value: unknown): boolean {
  try {
    return JSON.stringify(value).length > CHART_MAX_JSON_CHARS;
  } catch {
    return true;
  }
}

export type ChartValidation =
  | { ok: true; spec: ChartSpec }
  | { ok: false; errors: string[] };

/** Shared by the render_chart tool and the renderer fence parser. */
export function validateChartSpec(value: unknown): ChartValidation {
  if (chartJsonTooLarge(value))
    return {
      ok: false,
      errors: [
        `图表 JSON 超过 ${CHART_MAX_JSON_CHARS} 字符上限；请减少数据点或拆分为多张图。`,
      ],
    };
  const parsed = chartSpecSchema.safeParse(value);
  if (parsed.success) return { ok: true, spec: parsed.data };
  const errors = parsed.error.issues
    .slice(0, 12)
    .map(
      (issue) =>
        `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`,
    );
  if (parsed.error.issues.length > errors.length)
    errors.push(
      `（另有 ${parsed.error.issues.length - errors.length} 项问题未列出）`,
    );
  return { ok: false, errors };
}

/** Parse the body of a ` ```chart ` fence. Never throws. */
export function parseChartFence(source: string): ChartValidation {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return {
      ok: false,
      errors: [
        `不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  return validateChartSpec(value);
}

/** Canonical fence text returned by render_chart and copyable by the UI. */
export function chartFence(spec: unknown): string {
  return `\`\`\`chart\n${JSON.stringify(spec, null, 2)}\n\`\`\``;
}

/** Strip a ```chart (or bare ```) fence wrapper, returning the JSON body. */
export function chartFenceBody(fence: string): string {
  const trimmed = fence.trim();
  const match = /^```[a-z]*[^\n]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}
