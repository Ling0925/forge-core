import { describe, expect, it } from "vitest";
import {
  MAX_PROVIDER_JSON_CHARS,
  parseProviderJson,
} from "../../src/provider/bounded-json";

describe("bounded provider JSON", () => {
  it("ignores nesting characters and escaped quotes inside strings", () => {
    const value = { text: '[{\\"'.repeat(100), items: [1, null, true] };
    expect(parseProviderJson(JSON.stringify(value))).toEqual(value);
  });

  it("accepts depth 64 but rejects depth 65 with the protocol error", () => {
    const nested = (depth: number) =>
      `${"[".repeat(depth)}0${"]".repeat(depth)}`;
    expect(() => parseProviderJson(nested(64))).not.toThrow();
    expect(() => parseProviderJson(nested(65))).toThrow(
      expect.objectContaining({
        classification: "protocol",
        reason: "invalid_json",
        retryable: false,
      }),
    );
  });

  it("accepts the character limit and rejects larger responses before parsing", () => {
    expect(
      parseProviderJson(`${" ".repeat(MAX_PROVIDER_JSON_CHARS - 1)}0`),
    ).toBe(0);
    expect(() =>
      parseProviderJson(`${" ".repeat(MAX_PROVIDER_JSON_CHARS)}0`),
    ).toThrow(
      expect.objectContaining({ reason: "output_limit", retryable: false }),
    );
  });

  it.each(["{", '{"x":}', '"unterminated', "[}"])(
    "rejects malformed JSON as a non-retryable protocol error: %s",
    (text) => {
      expect(() => parseProviderJson(text)).toThrow(
        expect.objectContaining({
          classification: "protocol",
          reason: "invalid_json",
          retryable: false,
        }),
      );
    },
  );
});
