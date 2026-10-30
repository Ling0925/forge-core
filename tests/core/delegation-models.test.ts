import { expect, it, vi } from "vitest";
import { createDelegationModels } from "../../src/core/delegation-models";
import {
  defaultPublicSettings,
  publicProviderSourceSchema,
} from "../../src/shared/schemas";

const source = (id: string, patch = {}) =>
  publicProviderSourceSchema.parse({
    id,
    label: id,
    model: `${id}-default`,
    baseUrl: `https://${id}.invalid/v1`,
    apiMode: "chat-completions",
    revision: 1,
    hasApiKey: false,
    ...patch,
  });
const signal = () => new AbortController().signal;

it("discovers all sources, preserves opaque IDs, and resolves non-default catalog models", async () => {
  const listModels = vi.fn(async (id?: string) =>
    id === "a" ? ["a-default", "shared"] : ["cn:deepseek-v4.1-flash", "shared"],
  );
  const access = createDelegationModels({
    getSettings: async () => ({
      ...defaultPublicSettings,
      providerSources: [source("a"), source("b")],
    }),
    listModels,
  });
  expect(
    await access.resolve("cn:deepseek-v4.1-flash", undefined, signal()),
  ).toBe("b");
  expect(listModels.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
  expect((await access.list(signal())).models).toContainEqual({
    id: "cn:deepseek-v4.1-flash",
    providerSourceId: "b",
  });
  await expect(access.resolve("shared", undefined, signal())).rejects.toThrow(
    "multiple configured sources",
  );
  await expect(access.resolve("unknown", undefined, signal())).rejects.toThrow(
    "not found",
  );
  expect(await access.resolve("shared", "b", signal())).toBe("b");
  expect(await access.resolve("unlisted-but-explicit", "b", signal())).toBe(
    "b",
  );
  await expect(access.resolve("shared", "missing", signal())).rejects.toThrow(
    "Unknown providerSourceId",
  );
  const before = listModels.mock.calls.length;
  await expect(access.list(signal(), "missing")).rejects.toThrow(
    "Unknown providerSourceId",
  );
  expect(listModels).toHaveBeenCalledTimes(before);
  expect(
    (await access.list(signal(), "b")).models.every(
      (model) => model.providerSourceId === "b",
    ),
  ).toBe(true);
});

it("uses explicit configured declarations without requiring every provider to be online", async () => {
  const listModels = vi.fn(async () => {
    throw Error("PRIVATE_ENDPOINT_KEY");
  });
  const settings = {
    ...defaultPublicSettings,
    providerSources: [
      source("a"),
      source("b", {
        modelSelection: {
          mode: "selected",
          models: ["selected"],
          manual: [{ id: "manual", contextWindowTokens: null }],
          overrides: { override: {} },
        },
        modelAliases: { alias: "wire-id" },
      }),
    ],
  };
  const access = createDelegationModels({
    getSettings: async () => settings,
    listModels,
  });
  for (const id of ["b-default", "selected", "manual", "override", "alias"])
    expect(await access.resolve(id, undefined, signal())).toBe("b");
  expect(listModels).not.toHaveBeenCalled();
  const catalog = await access.list(signal());
  expect(catalog.models).toEqual([
    { id: "a-default", providerSourceId: "a" },
    { id: "selected", providerSourceId: "b" },
  ]);
  expect(catalog.unavailableSourceIds).toEqual(["a", "b"]);
  expect(JSON.stringify(catalog)).not.toContain("PRIVATE");
});

it("reports partial catalogs but refuses ambiguous inference from incomplete discovery", async () => {
  const access = createDelegationModels({
    getSettings: async () => ({
      ...defaultPublicSettings,
      providerSources: [source("a"), source("b")],
    }),
    listModels: async (id) => {
      if (id === "a") throw Error("PRIVATE");
      return ["catalog-only"];
    },
  });
  expect(await access.list(signal())).toMatchObject({
    unavailableSourceIds: ["a"],
  });
  await expect(
    access.resolve("catalog-only", undefined, signal()),
  ).rejects.toThrow("discovery is incomplete");
  expect(await access.resolve("catalog-only", "b", signal())).toBe("b");
});

it("fails closed for duplicate declarations and source removal without remembering a fallback", async () => {
  let sources = [
    source("a", { model: "same" }),
    source("b", { model: "same" }),
  ];
  const access = createDelegationModels({
    getSettings: async () => ({
      ...defaultPublicSettings,
      providerSources: sources,
    }),
    listModels: async () => [],
  });
  await expect(access.resolve("same", undefined, signal())).rejects.toThrow(
    "providerSourceId",
  );
  expect(await access.resolve("same", "b", signal())).toBe("b");
  sources = [sources[0]!];
  await expect(access.resolve("same", "b", signal())).rejects.toThrow(
    "Unknown providerSourceId",
  );
});

it("keeps environment-only hosts supported and checks cancellation", async () => {
  const listModels = vi.fn(async () => ["environment-model"]);
  const access = createDelegationModels({
    getSettings: async () => defaultPublicSettings,
    listModels,
  });
  expect(
    await access.resolve("exact-user-model", undefined, signal()),
  ).toBeUndefined();
  expect((await access.list(signal())).models).toEqual([
    { id: "environment-model" },
  ]);
  const controller = new AbortController();
  controller.abort();
  await expect(
    access.resolve("x", undefined, controller.signal),
  ).rejects.toMatchObject({ code: "cancelled" });
  await expect(access.list(controller.signal)).rejects.toMatchObject({
    code: "cancelled",
  });
  expect(listModels).toHaveBeenCalledTimes(1);
});
