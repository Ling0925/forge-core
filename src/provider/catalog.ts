import type { ProviderProtocol } from "../shared/model-access";
import {
  type ModelCatalog,
  type ModelCatalogEntry,
  modelCatalogEntrySchema,
  modelCatalogSchema,
} from "../shared/model-catalog";
import { readModelContextWindow } from "./context-window";

type RecordValue = Readonly<Record<string, unknown>>;
type CatalogSource = "upstream" | "reference" | "user";
type CatalogOptions = Readonly<{
  protocol?: ProviderProtocol | undefined;
  pricingUnit?: "per-token" | "per-million" | undefined;
}>;

const MAX_TOKENS = 10_000_000;
const protocolNames = new Set<ProviderProtocol>([
  "chat-completions",
  "responses",
  "anthropic",
  "gemini",
]);

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function positiveToken(value: unknown): number | undefined {
  const number =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;
  return typeof number === "number" &&
    Number.isInteger(number) &&
    number > 0 &&
    number <= MAX_TOKENS
    ? number
    : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const number =
    typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value.trim())
      : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0
    ? number
    : undefined;
}

function booleanAt(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function nested(raw: RecordValue, ...path: readonly string[]): unknown {
  let current: unknown = raw;
  for (const key of path) {
    const object = record(current);
    if (!object) return undefined;
    current = object[key];
  }
  return current;
}

function firstString(
  raw: RecordValue,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = raw[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstToken(
  raw: RecordValue,
  names: readonly string[],
): number | undefined {
  for (const name of names) {
    const parsed = positiveToken(nested(raw, ...name.split(".")));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function modalities(
  raw: RecordValue,
  direction: "input" | "output",
): {
  value: string[] | undefined;
  present: boolean;
} {
  const candidates =
    direction === "input"
      ? [
          raw.inputModalities,
          raw.input_modalities,
          nested(raw, "architecture", "input_modalities"),
          nested(raw, "modalities", "input"),
          nested(raw, "capabilities", "input_modalities"),
        ]
      : [
          raw.outputModalities,
          raw.output_modalities,
          nested(raw, "architecture", "output_modalities"),
          nested(raw, "modalities", "output"),
          nested(raw, "capabilities", "output_modalities"),
        ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return { value: strings(candidate) ?? [], present: true };
    }
  }
  return { value: undefined, present: false };
}

function reasoningEfforts(raw: RecordValue): string[] | undefined {
  const candidates = [
    raw.reasoningEfforts,
    raw.reasoning_efforts,
    raw.reasoning_levels,
    raw.supported_reasoning_levels,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const efforts: string[] = [];
    for (const item of candidate) {
      const value = typeof item === "string" ? item : record(item)?.effort;
      if (
        typeof value === "string" &&
        value.trim() &&
        !efforts.includes(value.trim())
      )
        efforts.push(value.trim());
    }
    if (efforts.length) return efforts;
  }
  return undefined;
}

function protocol(value: string): ProviderProtocol | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/\/+$/, "");
  if (
    normalized === "chat" ||
    normalized === "chat-completions" ||
    normalized.endsWith("/chat/completions")
  )
    return "chat-completions";
  if (normalized === "responses" || normalized.endsWith("/responses"))
    return "responses";
  if (normalized === "anthropic" || normalized.endsWith("/messages"))
    return "anthropic";
  if (
    normalized === "gemini" ||
    normalized.includes("/v1beta/models") ||
    normalized.endsWith("generatecontent")
  )
    return "gemini";
  if (protocolNames.has(normalized as ProviderProtocol))
    return normalized as ProviderProtocol;
  return undefined;
}

function protocols(raw: RecordValue): ProviderProtocol[] | undefined {
  const candidates = [
    raw.protocols,
    raw.supported_endpoints,
    raw.native_endpoints,
    raw.supported_endpoints,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const out: ProviderProtocol[] = [];
    for (const item of candidate)
      if (typeof item === "string") {
        const found = protocol(item);
        if (found && !out.includes(found)) out.push(found);
      }
    if (out.length) return out;
  }
  const target =
    typeof raw.type_target === "string" ? raw.type_target : undefined;
  if (target === "openai") return ["chat-completions", "responses"];
  if (target === "anthropic") return ["anthropic"];
  if (target === "gemini") return ["gemini"];
  return undefined;
}

function pricing(
  raw: RecordValue,
  unit: CatalogOptions["pricingUnit"],
): ModelCatalogEntry["pricing"] {
  const source = record(raw.pricing);
  if (!source) return undefined;
  const perToken =
    unit === "per-token" ||
    (unit === undefined &&
      (source.prompt !== undefined || source.completion !== undefined) &&
      source.input === undefined &&
      source.output === undefined);
  const scale = perToken ? 1_000_000 : 1;
  const take = (...names: readonly string[]): number | undefined => {
    for (const name of names) {
      const value = nonNegative(source[name]);
      if (value !== undefined) return value * scale;
    }
    return undefined;
  };
  const input = take("input", "prompt", "input_per_million", "inputPerMillion");
  const output = take(
    "output",
    "completion",
    "output_per_million",
    "outputPerMillion",
  );
  const cacheRead = take(
    "cacheRead",
    "cache_read",
    "cache_read_input",
    "input_cache_read",
    "prompt_cache_hit",
  );
  if (input === undefined && output === undefined && cacheRead === undefined)
    return undefined;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(firstString(source, ["currency"])
      ? { currency: firstString(source, ["currency"]) }
      : {}),
    ...(firstString(source, ["source"])
      ? { source: firstString(source, ["source"]) }
      : {}),
    ...(firstString(source, ["updatedAt", "updated_at"])
      ? { updatedAt: firstString(source, ["updatedAt", "updated_at"]) }
      : {}),
  };
}

/**
 * Parse one upstream model object. Only fields the source actually reports are
 * copied; missing metadata stays unknown. No model name is used to infer a
 * context window or capability.
 */
export function normalizeModelMetadata(
  raw: unknown,
  options: CatalogOptions = {},
): ModelCatalogEntry | undefined {
  const fields = record(raw);
  if (!fields) return undefined;
  let id = firstString(fields, ["id", "model", "name"]);
  if (!id) return undefined;
  if (options.protocol === "gemini" && id.startsWith("models/"))
    id = id.slice("models/".length);
  if (!id || id.length > 256) return undefined;

  const displayNameValue = firstString(fields, [
    "displayName",
    "display_name",
    "label",
    "name",
  ]);
  const displayName =
    displayNameValue &&
    displayNameValue !== id &&
    displayNameValue !== `models/${id}`
      ? displayNameValue
      : undefined;
  const contextWindowTokens =
    readModelContextWindow(fields) ??
    firstToken(fields, [
      "inputTokenLimit",
      "contextWindowTokens",
      "context_window_tokens",
      "limit.context",
    ]);
  const maxOutputTokens = firstToken(fields, [
    "maxOutputTokens",
    "max_output_tokens",
    "outputTokenLimit",
    "max_completion_tokens",
    "top_provider.max_completion_tokens",
    "limit.output",
  ]);
  const input = modalities(fields, "input");
  const output = modalities(fields, "output");
  const explicitVision =
    booleanAt(fields.vision) ??
    booleanAt(fields.supports_vision) ??
    booleanAt(nested(fields, "capabilities", "vision")) ??
    booleanAt(nested(fields, "capabilities", "image_input"));
  const vision =
    explicitVision ??
    (input.present
      ? input.value?.some((value) => value.toLowerCase() === "image")
      : undefined);
  const supportedParameters = strings(fields.supported_parameters) ?? [];
  const tools =
    booleanAt(fields.tools) ??
    booleanAt(fields.supports_tools) ??
    booleanAt(nested(fields, "capabilities", "tools")) ??
    booleanAt(nested(fields, "capabilities", "function_calling")) ??
    (supportedParameters.some((value) =>
      ["tools", "tool_choice", "function_calling"].includes(
        value.toLowerCase(),
      ),
    )
      ? true
      : undefined);
  const efforts = reasoningEfforts(fields);
  const supportedProtocols = protocols(fields);
  const price = pricing(fields, options.pricingUnit);
  const provenance: Record<string, CatalogSource> = {};
  if (displayName !== undefined) provenance.displayName = "upstream";
  if (contextWindowTokens !== null && contextWindowTokens !== undefined)
    provenance.contextWindowTokens = "upstream";
  if (maxOutputTokens !== undefined) provenance.maxOutputTokens = "upstream";
  if (input.value !== undefined) provenance.inputModalities = "upstream";
  if (output.value !== undefined) provenance.outputModalities = "upstream";
  if (efforts !== undefined) provenance.reasoningEfforts = "upstream";
  if (tools !== undefined) provenance.tools = "upstream";
  if (vision !== undefined) provenance.vision = "upstream";
  if (supportedProtocols !== undefined) provenance.protocols = "upstream";
  if (price !== undefined) provenance.pricing = "upstream";

  return modelCatalogEntrySchema.parse({
    id,
    contextWindowTokens: contextWindowTokens ?? null,
    ...(displayName === undefined ? {} : { displayName }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(input.value === undefined ? {} : { inputModalities: input.value }),
    ...(output.value === undefined ? {} : { outputModalities: output.value }),
    ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
    ...(tools === undefined ? {} : { tools }),
    ...(vision === undefined ? {} : { vision }),
    ...(supportedProtocols === undefined
      ? {}
      : { protocols: supportedProtocols }),
    ...(price === undefined ? {} : { pricing: price }),
    ...(Object.keys(provenance).length ? { provenance } : {}),
  });
}

/** Normalize a list, preserving first-seen order and deduplicating exact IDs. */
export function normalizeModelCatalog(
  raw: readonly unknown[],
  options: CatalogOptions = {},
): ModelCatalog {
  const seen = new Set<string>();
  const out: ModelCatalogEntry[] = [];
  for (const item of raw) {
    const entry = normalizeModelMetadata(item, options);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return modelCatalogSchema.parse(out);
}

export function catalogFromIds(ids: readonly string[]): ModelCatalog {
  return normalizeModelCatalog(ids.map((id) => ({ id })));
}

function pickFirst<T>(
  entries: readonly Readonly<{
    source: CatalogSource;
    value: ModelCatalogEntry;
  }>[],
  value: (entry: ModelCatalogEntry) => T | undefined,
): Readonly<{ source: CatalogSource; value: T }> | undefined {
  for (const entry of entries) {
    const selected = value(entry.value);
    if (selected !== undefined)
      return { source: entry.source, value: selected };
  }
  return undefined;
}

function firstNonEmpty(
  entries: readonly Readonly<{
    source: CatalogSource;
    value: ModelCatalogEntry;
  }>[],
  value: (entry: ModelCatalogEntry) => readonly string[] | undefined,
  allowEmpty = false,
): Readonly<{ source: CatalogSource; value: readonly string[] }> | undefined {
  for (const entry of entries) {
    const selected = value(entry.value);
    if (selected !== undefined && (allowEmpty || selected.length > 0))
      return { source: entry.source, value: selected };
  }
  return undefined;
}

/**
 * Merge catalogs by exact model ID with per-field priority user > upstream >
 * reference. A null/absent upstream field does not erase a reference value.
 */
export function mergeCatalog(
  reference: ModelCatalog,
  upstream: ModelCatalog,
  user: ModelCatalog = [],
): ModelCatalog {
  const sources = [
    { source: "user" as const, models: user },
    { source: "upstream" as const, models: upstream },
    { source: "reference" as const, models: reference },
  ];
  const byId = new Map<
    string,
    Readonly<{ source: CatalogSource; value: ModelCatalogEntry }>[]
  >();
  const order: string[] = [];
  for (const source of [upstream, reference, user]) {
    for (const entry of source) {
      if (!order.includes(entry.id)) order.push(entry.id);
    }
  }
  for (const entry of order) {
    const entries: { source: CatalogSource; value: ModelCatalogEntry }[] = [];
    for (const source of sources) {
      for (const value of source.models)
        if (value.id === entry) entries.push({ source: source.source, value });
    }
    byId.set(entry, entries);
  }

  const merged: ModelCatalogEntry[] = [];
  for (const id of order) {
    const entries = byId.get(id) ?? [];
    const provenance: Record<string, CatalogSource> = {};
    const identity = entries.find((entry) => entry.value.provenance?.id);
    if (identity)
      provenance.id =
        identity.source === "user" ? "user" : identity.value.provenance!.id!;
    const pick = <T>(
      key: string,
      selected: Readonly<{ source: CatalogSource; value: T }> | undefined,
    ): T | undefined => {
      if (!selected) return undefined;
      const original = entries.find(
        (entry) =>
          entry.source === selected.source &&
          (entry.value as Record<string, unknown>)[key] === selected.value,
      )?.value.provenance?.[key];
      provenance[key] =
        selected.source === "user" ? "user" : (original ?? selected.source);
      return selected.value;
    };
    const displayName = pick(
      "displayName",
      pickFirst(entries, (entry) => entry.displayName),
    );
    const contextWindowTokens = pick(
      "contextWindowTokens",
      pickFirst(entries, (entry) => entry.contextWindowTokens ?? undefined),
    );
    const maxOutputTokens = pick(
      "maxOutputTokens",
      pickFirst(entries, (entry) => entry.maxOutputTokens ?? undefined),
    );
    const inputModalities = pick(
      "inputModalities",
      firstNonEmpty(entries, (entry) => entry.inputModalities, true),
    );
    const outputModalities = pick(
      "outputModalities",
      firstNonEmpty(entries, (entry) => entry.outputModalities, true),
    );
    const reasoningEffort = pick(
      "reasoningEffort",
      pickFirst(entries, (entry) => entry.reasoningEffort),
    );
    const reasoningEfforts = pick(
      "reasoningEfforts",
      firstNonEmpty(entries, (entry) => entry.reasoningEfforts),
    );
    const tools = pick(
      "tools",
      pickFirst(entries, (entry) => entry.tools),
    );
    const vision = pick(
      "vision",
      pickFirst(entries, (entry) => entry.vision),
    );
    const protocols = pick(
      "protocols",
      firstNonEmpty(entries, (entry) => entry.protocols),
    );
    const prices = entries.flatMap((entry) =>
      entry.value.pricing
        ? [{ source: entry.source, value: entry.value.pricing }]
        : [],
    );
    const price = prices.length
      ? (Object.assign(
          {},
          ...prices
            .slice()
            .reverse()
            .map((entry) => entry.value),
        ) as NonNullable<ModelCatalogEntry["pricing"]>)
      : undefined;
    if (prices[0]) {
      const first = prices[0];
      const original = entries.find(
        (entry) =>
          entry.source === first.source && entry.value.pricing === first.value,
      )?.value.provenance?.pricing;
      provenance.pricing =
        first.source === "user" ? "user" : (original ?? first.source);
    }

    merged.push(
      modelCatalogEntrySchema.parse({
        id,
        contextWindowTokens: contextWindowTokens ?? null,
        ...(displayName === undefined ? {} : { displayName }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(inputModalities === undefined ? {} : { inputModalities }),
        ...(outputModalities === undefined ? {} : { outputModalities }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
        ...(tools === undefined ? {} : { tools }),
        ...(vision === undefined ? {} : { vision }),
        ...(protocols === undefined ? {} : { protocols }),
        ...(price === undefined ? {} : { pricing: price }),
        ...(Object.keys(provenance).length ? { provenance } : {}),
      }),
    );
  }
  return modelCatalogSchema.parse(merged);
}
