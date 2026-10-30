import { z } from "zod";
import {
  type ChartValidation,
  chartFence,
  validateChartSpec,
} from "../shared/chart-spec";
import type { LocalToolRegistry } from "../shared/contracts";
import type { ToolCall, ToolResult } from "../shared/schemas";
import { defineTool } from "../shared/tool-definition";

export const RENDER_CHART_TOOL_NAME = "render_chart";

const specArgumentsSchema = z
  .object({
    spec: z
      .unknown()
      .describe(
        "Chart spec object: {title?, note?, chart:{friendly grammar}} or {title?, raw:{native ECharts option}}. See the tool description for shapes and limits.",
      ),
  })
  .strict();

const definition = defineTool(
  RENDER_CHART_TOOL_NAME,
  "Validate one chart specification and echo it back as a canonical ```chart fenced JSON block; the Web session renders that fence inline as an interactive chart. Pure validation: no files, commands or network, and it is safe in read-only mode. Call it BEFORE writing the fence into your reply. The spec is a JSON object with optional title/note and exactly one of: `chart` (friendly grammar) or `raw` (native ECharts option object). Friendly `chart` shapes: {type:'bar',categories,series:[{name,values:number[]}],horizontal?,stack?,title?}; {type:'line',categories,series:[{name,values}],area?,stack?,title?}; {type:'bar-line',categories,bars:[...],lines:[...],title?}; {type:'candlestick',categories,ohlc:[[open,close,low,high],...]}; {type:'pie'|'funnel',series:[{name?,data:[{name,value}]}],donut?,rose?}; {type:'radar',indicators:[{name,max?}],series:[{name,values}]}; {type:'scatter',series:[{name?,points:[[x,y],...]}],xTitle?,yTitle?}; {type:'heatmap',xCategories,yCategories,data:[[xIndex,yIndex,value],...]}; {type:'gauge',value,min?,max?,unit?,name?}; {type:'table',columns,rows:[[string|number|null],...]}. Numeric arrays are capped (about 512 points per series); larger data must be aggregated first. On success the result is the exact fence text to paste; on failure the result lists field-by-field errors to fix.",
  specArgumentsSchema,
);

function encode(value: Record<string, unknown>, isError: boolean): ToolResult {
  return { content: JSON.stringify(value), isError };
}

function respond(validation: ChartValidation): ToolResult {
  if (validation.ok)
    return encode(
      {
        ok: true,
        // The renderer consumes this fence verbatim; paste it as its own block.
        fence: chartFence(validation.spec),
        hint: "粘贴下面这段围栏到回复正文中即可渲染图表；不要改动其中 JSON。",
      },
      false,
    );
  return encode({ ok: false, errors: validation.errors }, true);
}

/**
 * Web-host-only tool registry: a pure chart validator with no side effects, so
 * it never requests approval and stays available under read-only permission.
 */
export function createChartToolRegistry(): LocalToolRegistry {
  let disposed = false;
  return {
    definitions: [definition],
    isConcurrencySafe: (call) => call.function.name === RENDER_CHART_TOOL_NAME,
    async execute(call: ToolCall): Promise<ToolResult> {
      if (disposed)
        return encode({ error: "Chart tool registry is disposed." }, true);
      let spec: unknown;
      try {
        const parsed = specArgumentsSchema.parse(
          JSON.parse(call.function.arguments || "{}"),
        );
        spec = parsed.spec;
      } catch {
        return encode(
          { ok: false, errors: ["参数必须是合法的 {spec: {...}} JSON 对象。"] },
          true,
        );
      }
      return respond(validateChartSpec(spec));
    },
    async dispose() {
      disposed = true;
    },
  };
}
