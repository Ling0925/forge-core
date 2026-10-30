import { ForgeError } from "../shared/errors";

export type RetryStopReason =
  | "non_retryable_failure"
  | "hosted_search_may_have_executed"
  | "route_execution_uncertain"
  | "retry_limit_reached";
const explanation: Record<RetryStopReason, string> = {
  non_retryable_failure: "This failure is not eligible for automatic retry.",
  hosted_search_may_have_executed:
    "Hosted search may already have executed or been billed, even without output. Inspect before resuming; nothing was replayed automatically.",
  route_execution_uncertain:
    "The route cannot prove that the request was unexecuted. Inspect before resuming; no automatic failover or replay.",
  retry_limit_reached:
    "The bounded retry limit was reached. Completed local tools were not replayed.",
};

/** Keep the provider's retryable classification distinct from the actual run decision.
 * Uses the existing public message field so old strict clients remain compatible. */
export function stoppedProviderRetry(
  error: unknown,
  reason: RetryStopReason,
  retries: number,
  maxRetries: number,
): unknown {
  if (!(error instanceof ForgeError) || error.code !== "provider") return error;
  return new ForgeError(
    error.code,
    `${error.message.slice(0, 1024)} [automatic_retry=stopped; reason=${reason}; retries=${retries}/${maxRetries}] ${explanation[reason]}`,
    error.retryable,
  );
}
