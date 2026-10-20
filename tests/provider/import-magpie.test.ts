import { expect, it } from "vitest";
import { parseMagpieImport } from "../../src/provider/import-magpie";
import { ForgeError } from "../../src/shared/errors";

const parse = (value: unknown) => parseMagpieImport(JSON.stringify(value));
const first = (value: unknown) => {
  const parsed = parse(value);
  expect(parsed.candidates).toHaveLength(1);
  return parsed.candidates[0]!;
};

it("maps Magpie's models field to all, none and selected without touching slashed IDs", () => {
  const all = first({ preset: "ollama", key: "" }).save.source;
  expect(all.modelSelection).toEqual({ mode: "all" });
  expect(all.model).toBe("");

  const none = first({ preset: "ollama", models: [] }).save.source;
  expect(none.modelSelection).toEqual({ mode: "none" });
  expect(none.model).toBe("");

  const selected = first({
    preset: "openrouter",
    key: "sk-or",
    models: ["vendor/model-a", "vendor/model-a", "model-b"],
  }).save.source;
  expect(selected.modelSelection).toEqual({
    mode: "selected",
    models: ["vendor/model-a", "model-b"],
  });
  // Magpie's single `model` keeps its first selected ID, slashes included.
  expect(selected.model).toBe("vendor/model-a");

  expect(parse({ preset: "openai", models: "gpt-5.4" }).warnings).toContain(
    "Magpie models is not an array; the source was left as all models.",
  );
});

it("takes endpoints from the preset and region, and lets explicit endpoints win", () => {
  const moonshot = first({ preset: "moonshot", region: "cn", key: "sk-ms" }).save
    .source;
  expect(moonshot.preset).toBe("moonshot");
  expect(moonshot.baseUrl).toBe("https://api.moonshot.cn/v1");
  expect(moonshot.apiMode).toBe("chat-completions");
  expect(moonshot.endpoints).toEqual({
    "chat-completions": "https://api.moonshot.cn/v1",
    anthropic: "https://api.moonshot.cn/anthropic",
  });

  const overridden = first({
    preset: "openai",
    chat: "https://gateway.example.com/v1",
  }).save.source;
  expect(overridden.endpoints).toEqual({
    "chat-completions": "https://gateway.example.com/v1",
    responses: "https://api.openai.com/v1",
  });
  expect(overridden.baseUrl).toBe("https://gateway.example.com/v1");
});

it("chooses the endpoint named by baseAPI and keeps a custom provider without a preset", () => {
  const relay = first({
    baseAPI: "anthropic",
    chat: "https://relay.example.com/v1",
    anthropic: "https://relay.example.com/anthropic",
    key: "sk-relay",
  }).save.source;
  expect(relay.apiMode).toBe("anthropic");
  expect(relay.baseUrl).toBe("https://relay.example.com/anthropic");
  expect(relay.preset).toBeUndefined();

  const warned = parse({ preset: "unknown-vendor", chat: "https://x.example.com" });
  expect(warned.warnings.join(" ")).toContain("Unknown preset unknown-vendor");
  expect(warned.candidates[0]?.save.source.preset).toBeUndefined();
});

it("skips a provider without any HTTP(S) endpoint instead of inventing one", () => {
  const parsed = parse([{ name: "Nowhere", key: "sk-x" }, { name: "Still nowhere" }]);
  expect(parsed.candidates).toHaveLength(0);
  expect(parsed.warnings).toEqual([
    "No HTTP(S) endpoint was found; the provider was skipped.",
    "Nowhere was skipped.",
    "No HTTP(S) endpoint was found; the provider was skipped.",
    "Still nowhere was skipped.",
  ]);
});

it("imports keys as isolated credentials, keeping disabled entries and the first active key", () => {
  const candidate = first({
    chat: "https://api.example.com/v1",
    key: "primary-key",
    keys: [
      { key: "secondary-key", name: "backup", off: true },
      { key: "primary-key" },
      { key: "third-key", protocol: "anthropic" },
    ],
  });
  const credentials = candidate.save.credentials ?? [];
  expect(credentials.map((entry) => entry.apiKey)).toEqual([
    "primary-key",
    "secondary-key",
    "third-key",
  ]);
  expect(credentials[0]).toMatchObject({
    type: "api-key",
    enabled: true,
    label: "Primary key",
  });
  expect(credentials[0]?.id).toMatch(/^key-[0-9a-f]{16}$/);
  expect(credentials[1]?.enabled).toBe(false);
  expect(credentials[2]?.protocol).toBe("anthropic");
  expect(candidate.save.source.activeCredentialId).toBe(credentials[0]?.id);
  // The legacy single-key field still exists for older hosts.
  expect(candidate.save.apiKey).toBe("primary-key");
});

it("maps Magpie's authHeader spelling and forwards explicit auth/headers/extraBody/proxy", () => {
  const base = "https://api.example.com/v1";
  expect(first({ chat: base, key: "k", authHeader: "x-api-key" }).save.connection?.auth)
    .toEqual({ type: "api-key" });
  expect(first({ chat: base, key: "k", authHeader: "bearer" }).save.connection?.auth)
    .toEqual({ type: "bearer" });
  expect(first({ chat: base, key: "k", authHeader: "both" }).save.connection?.auth)
    .toEqual({ type: "auto" });
  expect(
    first({
      chat: base,
      key: "k",
      auth: { type: "header", header: "X-Custom", prefix: "Key " },
    }).save.connection?.auth,
  ).toEqual({ type: "header", header: "X-Custom", prefix: "Key " });

  const connection = first({
    chat: base,
    key: "k",
    headers: { "x-org": "acme", "bad header": "v", Host: "evil" },
    extraBody: { temperature: 0.4, model: "other", stream: false, "!tools": [] },
    proxy: "http://127.0.0.1:7890",
  });
  expect(connection.save.connection?.headers).toEqual({ "x-org": "acme" });
  expect(connection.save.connection?.extraBody).toEqual({ temperature: 0.4 });
  expect(connection.save.connection?.proxyUrl).toBe("http://127.0.0.1:7890/");
  const warnings = connection.warnings.join(" ");
  expect(warnings).toContain("header bad header is invalid");
  expect(warnings).toContain("reserved or repeated");
});

it("rejects a provider whose only endpoint is not an HTTP(S) base URL", () => {
  const parsed = parse({
    name: "Bad",
    chat: "https://user:pass@example.com/v1",
    key: "sk-bad",
  });
  expect(parsed.candidates).toHaveLength(0);
  expect(parsed.warnings.join(" ")).toContain("must be an HTTP(S) base URL");
});

it("never puts a credential into warnings", () => {
  const parsed = parse({
    name: "Secretive",
    chat: "https://api.example.com/v1",
    proxy: "not a url sk-super-secret",
  });
  expect(JSON.stringify(parsed.warnings)).not.toContain("sk-super-secret");
  expect(parsed.candidates[0]?.save.source.id).toBe("secretive");
});

it("reads a provider wrapper, an array, and a magpie://import link", () => {
  const wrapped = parse({
    providers: [
      { name: "One", chat: "https://one.example.com" },
      { name: "Two", chat: "https://two.example.com" },
    ],
  });
  expect(wrapped.candidates.map((entry) => entry.ref)).toEqual(["one", "two"]);

  const linked = parseMagpieImport(
    "magpie://import?preset=openai&key=sk-link&models=gpt-5.4,o3&name=Linked",
  );
  expect(linked.candidates[0]?.save.source).toMatchObject({
    label: "Linked",
    preset: "openai",
    modelSelection: { mode: "selected", models: ["gpt-5.4", "o3"] },
  });
  expect(linked.candidates[0]?.save.apiKey).toBe("sk-link");
});

it("suffixes duplicate generated source IDs instead of overwriting", () => {
  const parsed = parse([
    { chat: "https://one.example.com" },
    { chat: "https://two.example.com" },
  ]);
  expect(parsed.candidates.map((entry) => entry.save.source.id)).toEqual([
    "imported",
    "imported-2",
  ]);
});

it("rejects empty, non-JSON and non-import link text with a typed invalid_input error", () => {
  for (const value of ["", "not json", "magpie://elsewhere?key=x"]) {
    let error: unknown;
    try {
      parseMagpieImport(value);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ForgeError);
    expect((error as ForgeError).code).toBe("invalid_input");
  }
});
