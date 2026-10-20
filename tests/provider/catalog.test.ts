import { expect, it } from "vitest";
import {
  catalogFromIds,
  mergeCatalog,
  normalizeModelCatalog,
  normalizeModelMetadata,
} from "../../src/provider/catalog";

it("reads OpenAI-compatible metadata exactly as reported, converting per-token prices", () => {
  const entry = normalizeModelMetadata({
    id: "gpt-5.4",
    object: "model",
    created: 1,
    context_length: 400000,
    top_provider: { max_completion_tokens: 128000 },
    architecture: {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
    supported_parameters: ["tools", "reasoning_effort"],
    pricing: { prompt: "0.0000025", completion: "0.00001" },
  });
  expect(entry).toMatchObject({
    id: "gpt-5.4",
    contextWindowTokens: 400000,
    maxOutputTokens: 128000,
    tools: true,
    vision: true,
  });
  expect(entry?.inputModalities).toEqual(["text", "image"]);
  expect(entry?.outputModalities).toEqual(["text"]);
  expect(entry?.pricing).toMatchObject({ input: 2.5, output: 10 });
  expect(entry?.provenance).toMatchObject({
    contextWindowTokens: "upstream",
    maxOutputTokens: "upstream",
    pricing: "upstream",
  });
});

it("reads Anthropic's display name and Gemini's limits, stripping the models/ prefix", () => {
  expect(
    normalizeModelMetadata({ id: "claude-opus-4-6", display_name: "Claude Opus 4.6" }),
  ).toMatchObject({ id: "claude-opus-4-6", displayName: "Claude Opus 4.6" });
  const gemini = normalizeModelMetadata(
    {
      name: "models/gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
    },
    { protocol: "gemini" },
  );
  expect(gemini).toMatchObject({
    id: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    contextWindowTokens: 1048576,
    maxOutputTokens: 65536,
  });
});

it("leaves unreported metadata unknown instead of guessing from the model name", () => {
  const entry = normalizeModelMetadata({
    id: "some-128k-model",
    object: "model",
    max_tokens: 4096,
  });
  expect(entry).toMatchObject({ id: "some-128k-model", contextWindowTokens: null });
  expect(entry?.maxOutputTokens).toBeUndefined();
  expect(entry?.vision).toBeUndefined();
  expect(entry?.tools).toBeUndefined();
  expect(entry?.pricing).toBeUndefined();
});

it("drops out-of-range numbers and unusable entries", () => {
  expect(
    normalizeModelMetadata({ id: "m", context_length: 10000001, max_output_tokens: 0 }),
  ).toMatchObject({ id: "m", contextWindowTokens: null });
  expect(
    normalizeModelMetadata({ id: "m", context_length: 10000001 })?.maxOutputTokens,
  ).toBeUndefined();
  for (const raw of [null, {}, { id: "" }, { id: "x".repeat(257) }])
    expect(normalizeModelMetadata(raw)).toBeUndefined();
});

it("keeps first-seen order and deduplicates exact IDs, including slashes", () => {
  const catalog = normalizeModelCatalog([
    { id: "vendor/model-a" },
    { id: "vendor/model-a" },
    { id: "model-b" },
    42,
  ]);
  expect(catalog.map((entry) => entry.id)).toEqual(["vendor/model-a", "model-b"]);
  expect(catalogFromIds(["a", "a", "b"]).map((entry) => entry.id)).toEqual(["a", "b"]);
});

it("merges per field by user > upstream > reference and never lets a null erase a value", () => {
  const merged = mergeCatalog(
    [
      {
        id: "m1",
        contextWindowTokens: 200000,
        maxOutputTokens: 8192,
        displayName: "Reference",
      },
    ],
    [
      { id: "m1", contextWindowTokens: null, displayName: "Upstream" },
      { id: "m2", contextWindowTokens: null },
    ],
    [{ id: "m2", contextWindowTokens: 1000 }],
  );
  const m1 = merged.find((entry) => entry.id === "m1");
  expect(m1).toMatchObject({
    contextWindowTokens: 200000,
    maxOutputTokens: 8192,
    displayName: "Upstream",
  });
  expect(m1?.provenance).toMatchObject({
    contextWindowTokens: "reference",
    maxOutputTokens: "reference",
    displayName: "upstream",
  });
  const m2 = merged.find((entry) => entry.id === "m2");
  expect(m2).toMatchObject({ contextWindowTokens: 1000 });
  expect(m2?.provenance?.contextWindowTokens).toBe("user");
  expect(merged.map((entry) => entry.id)).toEqual(["m1", "m2"]);
});

it("keeps the reference name under the upstream one and lets user pricing win field by field", () => {
  const merged = mergeCatalog(
    [{ id: "m", contextWindowTokens: null, pricing: { input: 1, output: 2 } }],
    [{ id: "m", contextWindowTokens: null, pricing: { input: 3 } }],
    [{ id: "m", contextWindowTokens: null, pricing: { input: 5, currency: "USD" } }],
  );
  expect(merged[0]?.pricing).toMatchObject({ input: 5, output: 2, currency: "USD" });
});
