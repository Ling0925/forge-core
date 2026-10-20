import { ForgeError } from "../shared/errors";
import type { ProtocolReason, ProviderReason } from "../shared/errors";

export type ProviderFailure =
  | "http"
  | "protocol"
  | "network"
  | "timeout"
  | "aborted"
  | "upstream"
  | "observer";
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
      classification === "protocol" || classification === "http" || classification === "upstream"
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

export const protocol = (
  reason: ProtocolReason = "invalid_response",
): ProviderError =>
  new ProviderError(
    "protocol",
    "The provider returned an invalid or incomplete response.",
    false,
    undefined,
    reason,
  );

export const httpError = (status: number): ProviderError => {
  const message =
    status === 401 || status === 403
      ? "Provider authorization was rejected. Check provider credentials and access."
      : status === 404
        ? "The provider resource was not found. Check endpoint and model."
        : status === 408
          ? "The provider request timed out."
          : status === 429
            ? "The provider rate limit was reached."
            : status >= 500
              ? "The provider is temporarily unavailable."
              : "The provider rejected the request.";
  return new ProviderError(
    "http",
    message,
    status === 408 || status === 429 || status >= 500,
    status,
  );
};
