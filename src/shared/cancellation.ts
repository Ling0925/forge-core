import { ForgeError } from "./errors";

export async function withCancellation<T>(
  work: Promise<T>,
  signal: AbortSignal,
  cancelled: () => Error = () =>
    new ForgeError("cancelled", "Operation cancelled."),
): Promise<T> {
  // Always observe work, including a rejection racing an already-aborted signal.
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(cancelled());
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
