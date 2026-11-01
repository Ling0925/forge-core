import { ZodError } from "zod";
import { errorInfoSchema } from "./schemas/events";
import type { ErrorInfo } from "./schemas/events";

/**
 * Static, bounded reason codes for provider protocol framing/finish failures.
 * These are authored public labels only; never upstream response bodies.
 */
const protocolReasons = [
  "invalid_response",
  "invalid_json",
  "invalid_chunk",
  "missing_finish",
  "unterminated_event",
  "output_limit",
  "output_truncated",
  "invalid_finish",
  "invalid_tool_call",
  "provider_error_event",
  "missing_completion",
  "unexpected_frame",
] as const;
export type ProtocolReason = (typeof protocolReasons)[number];

const upstreamReasons = [
  "rate_limit_exceeded",
  "server_error",
  "authentication_error",
  "insufficient_quota",
  "invalid_request",
  "content_filter",
  "response_incomplete",
] as const;
export type UpstreamReason = (typeof upstreamReasons)[number];
export const providerReasons = [
  ...protocolReasons,
  ...upstreamReasons,
] as const;
export type ProviderReason = (typeof providerReasons)[number];
export const providerFailures = [
  "http",
  "protocol",
  "network",
  "timeout",
  "aborted",
  "upstream",
  "observer",
] as const;
export type ProviderFailure = (typeof providerFailures)[number];
export type ProviderRetryReason = Exclude<
  ProviderFailure,
  "aborted" | "observer"
>;

/**
 * A provider failure is worth one bounded retry only when the request never
 * produced a validated response and the failure is transient. Cancellation,
 * observer failures, auth rejection and every non-provider category must fail
 * immediately; replaying them cannot succeed and may repeat side effects.
 */
export const isRetryableProviderFailure = (error: unknown): boolean => {
  if (!(error instanceof ProviderError))
    return (
      error instanceof ForgeError &&
      error.code === "provider" &&
      error.retryable &&
      providerRetryReason(error) !== undefined
    );
  if (error.classification === "upstream") return error.retryable;
  if (error.classification === "protocol") {
    switch (error.reason) {
      case undefined:
      case "missing_finish":
      case "unterminated_event":
      case "missing_completion":
      case "provider_error_event":
        return true;
      default:
        return false;
    }
  }
  if (error.classification === "network" || error.classification === "timeout")
    return true;
  if (error.classification !== "http") return false;
  const status = error.status;
  return (
    status === 408 ||
    status === 429 ||
    (typeof status === "number" && status >= 500)
  );
};

/** Bounded reason label for the retry status event; never upstream text. */
export const providerRetryReason = (
  error: unknown,
): ProviderRetryReason | undefined => {
  if (
    !(error instanceof ForgeError) ||
    error.code !== "provider" ||
    (!(error instanceof ProviderError) && !error.retryable) ||
    !("classification" in error)
  )
    return undefined;
  switch (error.classification) {
    case "protocol":
    case "network":
    case "timeout":
    case "http":
    case "upstream":
      return error.classification;
    default:
      return undefined;
  }
};

export class ForgeError extends Error {
  readonly code: ErrorInfo["code"];
  readonly retryable: boolean;

  // Messages must be authored safe public text, never upstream exception text or bodies.
  constructor(code: ErrorInfo["code"], message: string, retryable = false) {
    const info = errorInfoSchema.parse({ code, message, retryable });
    super(info.message);
    this.name = "ForgeError";
    this.code = info.code;
    this.retryable = info.retryable;
  }
}

export class ProviderError extends ForgeError {
  readonly classification: ProviderFailure;
  readonly status: number | undefined;
  readonly reason: ProviderReason | undefined;
  constructor(
    classification: ProviderFailure,
    message: string,
    retryable = false,
    status?: number,
    reason?: ProviderReason,
  ) {
    super(
      "provider",
      classification === "protocol" ||
        classification === "http" ||
        classification === "upstream"
        ? `${message} [${classification}${status === undefined ? "" : ` HTTP ${status}`}]${reason === undefined ? "" : ` (${reason})`}`
        : message,
      retryable,
    );
    this.name = "ProviderError";
    this.classification = classification;
    this.status = status;
    this.reason = reason;
  }
}

export function formatValidationError(error: ZodError): string {
  return `Invalid arguments: ${error.issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.join(".").slice(0, 128) || "arguments";
      switch (issue.code) {
        case "invalid_type":
          return `${path}: expected ${issue.expected}, received ${issue.received}`;
        case "too_big":
          return `${path}: maximum ${issue.maximum}`;
        case "too_small":
          return `${path}: minimum ${issue.minimum}`;
        case "invalid_enum_value":
          return `${path}: allowed ${JSON.stringify(issue.options).slice(0, 256)}`;
        case "unrecognized_keys":
          return `${path}: unexpected fields; use only the declared parameters`;
        case "custom":
          return `${path}: ${issue.message.slice(0, 256)}`;
        default:
          return `${path}: invalid value (${issue.code})`;
      }
    })
    .join("; ")}.`;
}

export const toErrorInfo = (error: unknown): ErrorInfo => {
  if (error instanceof ForgeError) {
    return errorInfoSchema.parse({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    });
  }
  if (error instanceof ZodError) {
    return errorInfoSchema.parse({
      code: "invalid_input",
      message: "Input failed validation.",
      retryable: false,
    });
  }
  return errorInfoSchema.parse({
    code: "internal",
    message: "An unexpected failure occurred.",
    retryable: false,
  });
};
