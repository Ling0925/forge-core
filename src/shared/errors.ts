import { ZodError } from "zod";
import { errorInfoSchema } from "./schemas";
import type { ErrorInfo } from "./schemas";

/**
 * Static, bounded reason codes for provider protocol framing/finish failures.
 * These are authored public labels only; never upstream response bodies.
 */
export type ProtocolReason =
  | "invalid_response"
  | "invalid_json"
  | "invalid_chunk"
  | "missing_finish"
  | "unterminated_event"
  | "output_limit"
  | "output_truncated"
  | "invalid_finish"
  | "invalid_tool_call"
  | "provider_error_event"
  | "missing_completion"
  | "unexpected_frame";

export type ProviderRetryReason = "protocol" | "network" | "timeout" | "http";

type ClassifiedProviderError = ForgeError & {
  readonly classification: string;
  readonly status?: number | undefined;
};

/**
 * A provider failure is worth one bounded retry only when the request never
 * produced a validated response and the failure is transient. Cancellation,
 * observer failures, auth rejection and every non-provider category must fail
 * immediately; replaying them cannot succeed and may repeat side effects.
 */
export const isRetryableProviderFailure = (error: unknown): boolean => {
  if (!(error instanceof ForgeError) || error.code !== "provider") return false;
  const candidate = error as Partial<ClassifiedProviderError>;
  if (typeof candidate.classification !== "string") return false;
  if (
    candidate.classification === "protocol" ||
    candidate.classification === "network" ||
    candidate.classification === "timeout"
  )
    return true;
  if (candidate.classification !== "http") return false;
  const status = candidate.status;
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
  if (!(error instanceof ForgeError) || error.code !== "provider") return undefined;
  const candidate = error as Partial<ClassifiedProviderError>;
  switch (candidate.classification) {
    case "protocol":
    case "network":
    case "timeout":
    case "http":
      return candidate.classification;
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
