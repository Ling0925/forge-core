import { ForgeError } from "../shared/errors";

/** Race even adapters that fail to honor cancellation; never replay their uncertain effects. */
export const withCancellation = async <T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> => {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw new ForgeError("cancelled", "Operation cancelled.");
  }
  let cancel = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new ForgeError("cancelled", "Operation cancelled."));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};
