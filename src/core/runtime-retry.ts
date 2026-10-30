/** Maximum additional provider attempts after the initial request (1+5=6 total). */
export const MAX_GENERATION_RETRIES = 5;
/** Abort-aware backoff between provider attempts; capped at the last entry. */
export const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000] as const;

/**
 * Wait before the next provider attempt, resolving early on cancellation.
 * The timer and abort listener are always cleaned up. Resolves (never rejects)
 * on abort so the following `check()`/request observes cancellation once.
 */
export const retryDelay = (ms: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
};
