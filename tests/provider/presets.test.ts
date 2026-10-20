import { expect, it } from "vitest";
import {
  findProviderPreset,
  presetEndpoints,
  providerPresets,
} from "../../src/provider/presets";

const protocols = ["chat-completions", "responses", "anthropic", "gemini"];

it.each([
  "openai",
  "anthropic",
  "deepseek",
  "moonshot",
  "zhipu",
  "minimax",
  "openrouter",
  "ollama",
  "lmstudio",
  "custom",
  "google", "google-vertex", "azure", "bedrock",
])("ships the %s preset", (id) => {
  const preset = findProviderPreset(id);
  expect(preset?.id).toBe(id);
  expect(preset?.name).toBeTruthy();
  expect(["vendor", "relay", "local", "custom"]).toContain(preset?.kind);
});

it("describes only public fields: no secret, sponsored placement or editor note", () => {
  const presetFields = new Set([
    "id",
    "name",
    "kind",
    "endpoints",
    "regionLabel",
    "regions",
    "website",
    "keysUrl",
    "noKey",
  ]);
  const regionFields = new Set(["id", "name", "endpoints", "website", "keysUrl"]);
  for (const preset of providerPresets) {
    for (const key of Object.keys(preset)) expect(presetFields).toContain(key);
    for (const region of preset.regions ?? [])
      for (const key of Object.keys(region)) expect(regionFields).toContain(key);
  }
});

it("uses absolute HTTP(S) endpoints for known protocols and keeps several protocols where the vendor serves them", () => {
  for (const preset of providerPresets) {
    // Azure has a user-owned resource, not a shared public endpoint.
    if (preset.kind === "custom" || preset.id === "azure") {
      expect(preset.endpoints).toEqual({});
      continue;
    }
    expect(Object.keys(preset.endpoints).length).toBeGreaterThan(0);
    for (const [protocol, endpoint] of Object.entries(preset.endpoints)) {
      expect(protocols).toContain(protocol);
      const url = new URL(endpoint as string);
      expect(["http:", "https:"]).toContain(url.protocol);
      expect(url.username).toBe("");
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
    }
  }
  expect(findProviderPreset("openai")?.endpoints.responses).toBeTruthy();
  expect(findProviderPreset("anthropic")?.endpoints.anthropic).toBeTruthy();
  expect(findProviderPreset("deepseek")?.endpoints.anthropic).toBeTruthy();
  expect(findProviderPreset("openrouter")?.endpoints.anthropic).toBeTruthy();
});

it("keeps regions as separate endpoint sets instead of one guessed endpoint", () => {
  const moonshot = findProviderPreset("moonshot");
  expect(
    moonshot?.regions?.map((region) => region.id).sort(),
  ).toEqual(["cn", "global"]);
  expect(presetEndpoints("moonshot", "cn")?.["chat-completions"]).toBe(
    "https://api.moonshot.cn/v1",
  );
  expect(presetEndpoints("moonshot", "global")?.["chat-completions"]).toBe(
    "https://api.moonshot.ai/v1",
  );
  // A region overrides only the protocols it lists.
  expect(presetEndpoints("moonshot", "cn")?.anthropic).toBe(
    "https://api.moonshot.cn/anthropic",
  );
  expect(presetEndpoints("moonshot", "unknown-region")).toBeUndefined();
  expect(presetEndpoints("not-a-preset")).toBeUndefined();
});

it("marks local servers that normally run without a key", () => {
  expect(findProviderPreset("ollama")?.noKey).toBe(true);
  expect(findProviderPreset("lmstudio")?.noKey).toBe(true);
  expect(findProviderPreset("openai")?.noKey).toBeUndefined();
  // The custom slot carries no endpoint so the user must supply one.
  expect(findProviderPreset("custom")?.endpoints).toEqual({});
});

it("matches preset ids case-insensitively and trims padding", () => {
  expect(findProviderPreset("  OpenAI ")).toBe(findProviderPreset("openai"));
  expect(findProviderPreset("deep-sample")).toBeUndefined();
});
