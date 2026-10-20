import { z } from "zod";
import type { ProviderReason } from "../shared/errors";
import { ProviderError } from "./errors";

const detail = z.object({ code: z.string().nullish(), type: z.string().nullish() });
const failure = z.object({
  type: z.string(),
  code: z.string().nullish(),
  error: detail.nullish(),
  response: z.object({
    error: detail.nullish(),
    incomplete_details: z.object({ reason: z.string().optional() }).nullish(),
  }).optional(),
});

export function responseFailure(event: unknown): ProviderError {
  const parsed = failure.parse(event);
  const error = parsed.response?.error ?? parsed.error;
  const code = parsed.type === "response.incomplete"
    ? parsed.response?.incomplete_details?.reason
    : parsed.code ?? error?.code ?? error?.type;
  let reason: ProviderReason;
  let message: string;
  let retryable = false;
  switch (code) {
    case "rate_limit_exceeded":
    case "rate_limit_error":
      reason = "rate_limit_exceeded";
      message = "The provider rate limit was reached.";
      retryable = true;
      break;
    case "server_error":
    case "internal_error":
    case "overloaded_error":
      reason = "server_error";
      message = "The provider is temporarily unavailable.";
      retryable = true;
      break;
    case "invalid_api_key":
    case "authentication_error":
    case "permission_denied":
      reason = "authentication_error";
      message = "Provider authorization was rejected. Check provider credentials and access.";
      break;
    case "insufficient_quota":
      reason = "insufficient_quota";
      message = "The provider quota was exhausted. Check the account balance or usage limit.";
      break;
    case "max_output_tokens":
    case "max_messages":
      reason = "output_truncated";
      message = "The response reached its output limit before completing.";
      break;
    case "content_filter":
      reason = "content_filter";
      message = "The provider stopped the response because of content filtering.";
      break;
    case "invalid_request_error":
    case "invalid_prompt":
      reason = "invalid_request";
      message = "The provider rejected the request. Check the model and request parameters.";
      break;
    default:
      reason = parsed.type === "response.incomplete" ? "response_incomplete" : "provider_error_event";
      message = parsed.type === "response.incomplete" ? "The provider stopped before completing the response." : "The provider reported a generation failure.";
  }
  return new ProviderError("upstream", message, retryable, undefined, reason);
}
