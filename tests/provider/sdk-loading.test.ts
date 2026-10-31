import { afterEach, expect, it, vi } from "vitest";
import { httpError, protocol } from "../../src/provider/errors";
import { defaultPublicSettings } from "../../src/shared/schemas";

afterEach(() => {
  vi.doUnmock("openai");
  vi.doUnmock("@anthropic-ai/sdk");
  vi.unstubAllGlobals();
  vi.resetModules();
});

const config = {
  baseUrl: "http://127.0.0.1:1/v1",
  apiKey: "",
  requestTimeoutMs: defaultPublicSettings.requestTimeoutMs,
};

it.each([
  ["openai", "chat-completions"],
  ["openai", "responses"],
  ["@anthropic-ai/sdk", "anthropic"],
] as const)(
  "shares a failed %s import across requests and provider instances",
  async (sdk, apiMode) => {
    let imports = 0;
    const failure = new Error("SDK_IMPORT_FAILURE");
    vi.doMock(sdk, () => {
      imports++;
      throw failure;
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { createModelProvider } = await import("../../src/provider/openai");
    const provider = createModelProvider({ ...config, apiMode });
    expect(imports).toBe(0);
    const [importError, completeError] = await Promise.all([
      provider.listModels().catch((error: unknown) => error),
      provider
        .complete([{ role: "user", content: "hello" }], [], {
          model: "fixture",
          signal: new AbortController().signal,
          onText: () => {},
        })
        .catch((error: unknown) => error),
    ]);
    expect(importError).toMatchObject({ cause: failure });
    expect(importError).not.toHaveProperty("classification");
    expect(completeError).toBe(importError);
    await expect(
      createModelProvider({ ...config, apiMode }).listModels(),
    ).rejects.toBe(importError);
    expect(imports).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each(["openai", "anthropic"] as const)(
  "classifies %s errors created outside a provider before and after caching",
  async (sdk) => {
    const errors =
      sdk === "openai"
        ? await import("openai/core/error")
        : await import("@anthropic-ai/sdk/core/error");
    const BaseError =
      "OpenAIError" in errors ? errors.OpenAIError : errors.AnthropicError;
    const { withSdkRequest } = await import("../../src/provider/sdk-transport");
    const failures = [
      [
        new errors.APIError(401, {}, "PRIVATE_HTTP", new Headers()),
        httpError(401),
      ],
      [
        new errors.APIConnectionError({ message: "PRIVATE_CONNECTION" }),
        {
          classification: "network",
          message: "The provider connection failed.",
          retryable: true,
        },
      ],
      [
        new errors.APIError(undefined, {}, "PRIVATE_EVENT", undefined),
        protocol("provider_error_event"),
      ],
      [new BaseError("PRIVATE_SDK"), protocol()],
    ] as const;
    for (const [error, expected] of [...failures, ...failures]) {
      await expect(
        withSdkRequest(config, { idle: false }, async () => {
          throw error;
        }),
      ).rejects.toMatchObject({
        classification: expected.classification,
        message: expected.message,
        retryable: expected.retryable,
      });
    }
  },
);
