import type { HostState } from "./host";
import type { RpcRequest, RpcResponse, RunEvent, WorkerMessage } from "./ipc";

/**
 * One controller/service for every host (desktop renderer IPC, LAN Web pages),
 * so a run started on a phone and a run started on the desktop share the same
 * approvals, steering and activity view.
 *
 * - `handle` accepts raw worker requests (desktop IPC forwarding).
 * - `request` is the in-process RPC path used by HTTP hosts. Its responses are
 *   consumed by the hub and are NOT broadcast to subscribers, so the desktop
 *   process never sees a response it has no pending entry for.
 * - `subscribe` receives every controller message, including responses that
 *   belong to `handle` calls (the worker forwards them to its parent).
 */
export interface RuntimeHost {
  handle(raw: unknown): Promise<void>;
  request(request: RpcRequest): Promise<RpcResponse>;
  subscribe(listener: (message: WorkerMessage) => void): () => void;
  recoveryEvents(): RunEvent[];
  hostState(): HostState;
  dispose(): Promise<void>;
}
