import { expect, it } from "vitest";
import {
  ForgeError,
  ProviderError,
  isRetryableProviderFailure,
  providerRetryReason,
  toErrorInfo,
} from "../../src/shared/errors";

it("classifies only ProviderError instances", () => {
  const error = new ProviderError("http", "Provider unavailable.", true, 503);
  expect(isRetryableProviderFailure(error)).toBe(true);
  expect(providerRetryReason(error)).toBe("http");
  expect(toErrorInfo(error)).toEqual({
    code: "provider",
    message: "Provider unavailable. [http HTTP 503]",
    retryable: true,
  });
  const lookalike = Object.assign(
    new ForgeError("provider", "Other failure."),
    {
      classification: "http",
      status: 503,
    },
  );
  expect(isRetryableProviderFailure(lookalike)).toBe(false);
  expect(providerRetryReason(lookalike)).toBeUndefined();
});
