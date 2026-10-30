import { describe, expect, it } from "vitest";
import { assertNever } from "./contracts";
import { ForgeError, toErrorInfo } from "./errors";
import {
  configureInputSchema,
  defaultPublicSettings,
  providerConfigSchema,
  publicSettingsSchema,
  runInputSchema,
} from "./schemas";

const sessionId = "00000000-0000-4000-8000-000000000001";

describe("settings and resume contracts", () => {
  it("accepts first-launch defaults without a configured provider", () => {
    expect(publicSettingsSchema.parse(defaultPublicSettings).isConfigured).toBe(
      false,
    );
    expect(defaultPublicSettings.defaultPermission).toBe("workspace");
    expect(
      providerConfigSchema.safeParse({
        baseUrl: "",
        apiKey: "",
        requestTimeoutMs: defaultPublicSettings.requestTimeoutMs,
      }).success,
    ).toBe(false);
  });

  it("derives configuration status and keeps it noneditable", () => {
    expect(
      publicSettingsSchema.safeParse({
        ...defaultPublicSettings,
        isConfigured: true,
      }).success,
    ).toBe(false);
    expect(
      configureInputSchema.safeParse({ settings: { isConfigured: true } })
        .success,
    ).toBe(false);
    expect(
      configureInputSchema.parse({
        settings: { baseUrl: "", model: "" },
        apiKey: "",
      }),
    ).toEqual({
      settings: { baseUrl: "", model: "" },
      apiKey: "",
    });
    expect(configureInputSchema.parse({}).apiKey).toBeUndefined();
  });

  it("rejects unsafe endpoints and multiline keys", () => {
    for (const baseUrl of [
      "file:///tmp",
      "https://user:pass@example.invalid",
      "https://example.invalid?x=1",
      "https://example.invalid#x",
    ]) {
      expect(
        configureInputSchema.safeParse({ settings: { baseUrl } }).success,
      ).toBe(false);
      expect(
        providerConfigSchema.safeParse({
          baseUrl,
          apiKey: "",
          requestTimeoutMs: 1000,
        }).success,
      ).toBe(false);
    }
    for (const apiKey of ["test\rvalue", "test\nvalue"]) {
      expect(configureInputSchema.safeParse({ apiKey }).success).toBe(false);
      expect(
        providerConfigSchema.safeParse({
          baseUrl: "https://example.invalid",
          apiKey,
          requestTimeoutMs: 1000,
        }).success,
      ).toBe(false);
    }
    expect(
      publicSettingsSchema.parse({
        ...defaultPublicSettings,
        baseUrl: "https://example.invalid",
        model: "test-model",
        isConfigured: true,
      }).hasApiKey,
    ).toBe(false);
  });

  it.each([
    { browserAllowedOrigins: ["https://example.invalid"] },
    { browserAllowedOrigins: [] },
    { browserExecutablePath: "/usr/bin/chromium" },
    { browserExecutablePath: "" },
  ])("rejects retired global browser settings %j", (settings) => {
    expect(defaultPublicSettings).not.toHaveProperty("browserAllowedOrigins");
    expect(defaultPublicSettings).not.toHaveProperty("browserExecutablePath");
    expect(configureInputSchema.safeParse({ settings }).success).toBe(false);
    expect(
      publicSettingsSchema.safeParse({ ...defaultPublicSettings, ...settings })
        .success,
    ).toBe(false);
    expect(
      providerConfigSchema.safeParse({
        baseUrl: "https://example.invalid",
        apiKey: "k",
        requestTimeoutMs: 1000,
        ...settings,
      }).success,
    ).toBe(false);
  });

  it("accepts an optional nonempty resume model override", () => {
    const input = { sessionId, prompt: "Continue" };
    expect(runInputSchema.parse(input).model).toBeUndefined();
    expect(
      runInputSchema.parse({ ...input, model: " next-model " }).model,
    ).toBe("next-model");
    for (const model of ["", "   "]) {
      expect(runInputSchema.safeParse({ ...input, model }).success).toBe(false);
    }
  });
});

describe("safe errors", () => {
  it("preserves authored typed failures but not upstream details", () => {
    expect(
      toErrorInfo(new ForgeError("busy", "Session is already running.", true)),
    ).toEqual({
      code: "busy",
      message: "Session is already running.",
      retryable: true,
    });
    const fallback = {
      code: "internal",
      message: "An unexpected failure occurred.",
      retryable: false,
    };
    expect(toErrorInfo(new Error("untrusted diagnostic"))).toEqual(fallback);
    expect(
      toErrorInfo({
        code: "provider",
        message: "untrusted body",
        retryable: true,
      }),
    ).toEqual(fallback);
    expect(
      toErrorInfo({
        get message() {
          throw new Error("Must not read this");
        },
      }),
    ).toEqual(fallback);
  });

  it("does not expose validation issue values", () => {
    const parsed = configureInputSchema.safeParse({ apiKey: "test\nvalue" });
    if (parsed.success) {
      throw new ForgeError("internal", "Test expected validation failure.");
    }
    expect(toErrorInfo(parsed.error)).toEqual({
      code: "invalid_input",
      message: "Input failed validation.",
      retryable: false,
    });
  });

  it("makes exhaustive-switch invariant failures typed and safe", () => {
    const fail = (): never => {
      throw new ForgeError("internal", "An invariant was violated.");
    };
    expect(() => assertNever(fail())).toThrow(ForgeError);
    expect(
      toErrorInfo(new ForgeError("internal", "An invariant was violated.")),
    ).toEqual({
      code: "internal",
      message: "An invariant was violated.",
      retryable: false,
    });
  });
});
