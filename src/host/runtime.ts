import type {
  HarnessService,
  RpcRequest,
  RpcResponse,
  RuntimeHost,
  WorkerMessage,
} from "../shared";

import { createWorkerController, safeError } from "./controller";
import { requestTimeout } from "./request-timeout";

export function createRuntimeHub(
  service: HarnessService,
  options: { requestTimeoutMs?: number } = {},
): RuntimeHost {
  const listeners = new Set<(message: WorkerMessage) => void>();
  const pending = new Map<
    string,
    {
      request: RpcRequest;
      resolve: (response: RpcResponse) => void;
      cleanup: () => void;
    }
  >();
  let disposed = false;
  let closing: Promise<void> | undefined;
  const publish = (message: WorkerMessage): void => {
    for (const listener of [...listeners]) {
      try {
        listener(message);
      } catch {
        // A broken subscriber (or a closed worker port) must not take down the
        // shared runtime that other hosts are still using.
      }
    }
  };
  const controller = createWorkerController(service, (message) => {
    if (message.kind === "response") {
      const entry = pending.get(message.response.id);
      if (entry) {
        pending.delete(message.response.id);
        entry.cleanup();
        entry.resolve(message.response);
        return;
      }
    }
    publish(message);
  });
  const request = (
    rpc: RpcRequest,
    signal?: AbortSignal,
  ): Promise<RpcResponse> => {
    if (disposed)
      return Promise.reject(new Error("The shared runtime is closed."));
    if (pending.has(rpc.id))
      return Promise.reject(new Error("Duplicate runtime request id."));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<RpcResponse>((resolveResponse, reject) => {
      const timeout = requestTimeout(rpc, options.requestTimeoutMs);
      const abort = () => {
        cleanup();
        reject(signal?.reason);
      };
      const timer =
        timeout === undefined
          ? undefined
          : setTimeout(() => {
              cleanup();
              reject(
                new Error(
                  "The shared runtime did not answer in time; effects are uncertain. Do not retry automatically.",
                ),
              );
            }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      signal?.addEventListener("abort", abort, { once: true });
      // Retain correlation until the reply arrives, including after timeout or abort.
      pending.set(rpc.id, {
        request: rpc,
        resolve: resolveResponse,
        cleanup,
      });
      void controller.handle(rpc, signal).catch((error: unknown) => {
        const entry = pending.get(rpc.id);
        if (!entry) return;
        pending.delete(rpc.id);
        cleanup();
        reject(
          error instanceof Error ? error : new Error("Runtime request failed."),
        );
      });
    });
  };
  const dispose = (): Promise<void> => {
    if (closing) return closing;
    disposed = true;
    // The controller answers its own in-flight requests with a safe error while
    // it tears down; any request that raced past that point is settled here.
    closing = controller.dispose().finally(() => {
      for (const entry of pending.values()) {
        entry.cleanup();
        entry.resolve({
          id: entry.request.id,
          method: entry.request.method,
          ok: false,
          error: safeError,
        });
      }
      pending.clear();
      listeners.clear();
    });
    return closing;
  };
  return {
    handle: (raw) => controller.handle(raw),
    request,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recoveryEvents: () => controller.recoveryEvents(),
    hostState: () => controller.hostState(),
    dispose,
  };
}
