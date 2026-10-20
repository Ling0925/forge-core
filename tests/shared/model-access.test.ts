import { expect, it } from "vitest";
import { modelCatalogSchema } from "../../src/shared/model-catalog";
import { modelSelectionSchema, providerHeadersSchema, routeGroupSchema } from "../../src/shared/model-access";
import { configureInputSchema, publicProviderSourceSchema } from "../../src/shared/schemas";

it("keeps exact upstream IDs and unknown capabilities separate from false", () => {
  const [entry] = modelCatalogSchema.parse([{ id: "org/model/version", contextWindowTokens: null }]);
  expect(entry?.id).toBe("org/model/version");
  expect(entry?.vision).toBeUndefined();
  expect(entry?.tools).toBeUndefined();
  expect(modelCatalogSchema.parse([{ ...entry, tools: false }])[0]?.tools).toBe(false);
});
it("keeps all, none and an explicit selection distinct", () => {
  expect(["all", "none", "selected"].map(mode => modelSelectionSchema.parse({ mode, models: [] }).mode)).toEqual(["all", "none", "selected"]);
  expect(routeGroupSchema.parse({ id: "group", label: "same name", strategy: "order", members: [{ sourceId: "a", model: "org/model" }, { sourceId: "b", model: "org/model" }] }).members).toHaveLength(2);
});
it("private fields cannot be serialized as a public source", () => {
  const source = { id: "a", label: "A", baseUrl: "http://localhost:1234/v1", model: "", revision: 1, hasApiKey: true };
  expect(publicProviderSourceSchema.safeParse({ ...source, apiKey: "not-public" }).success).toBe(false);
  expect(publicProviderSourceSchema.safeParse({ ...source, credentials: [{ id: "key", label: "Key", enabled: true, type: "api-key", status: "ready", apiKey: "not-public" }] }).success).toBe(false);
});
it("accepts local no-key sources and arbitrary vendor parameters, rejects transport injection", () => {
  const source = { id: "a", label: "A", baseUrl: "http://localhost:1234/v1", model: "", apiMode: "gemini" };
  expect(configureInputSchema.safeParse({ source: { type: "save", source, apiKey: "", connection: { extraBody: { vendor_feature: { anything: true } } } } }).success).toBe(true);
  expect(providerHeadersSchema.safeParse({ "X-Vendor-Option": "custom" }).success).toBe(true);
  expect(providerHeadersSchema.safeParse({ "X-Value": "a\r\nb" }).success).toBe(false);
  expect(providerHeadersSchema.safeParse({ "Content-Length": "1" }).success).toBe(false);
  expect(configureInputSchema.safeParse({ source: { type: "save", source, connection: { extraBody: { invalid: () => 1 } } } }).success).toBe(false);
});
