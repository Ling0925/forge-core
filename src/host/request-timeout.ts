import type { RpcRequest } from "../shared";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export function requestTimeout(
  request: { method: RpcRequest["method"]; wait?: boolean | undefined },
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): number | undefined {
  switch (request.method) {
    case "decideOutbox":
    case "decideSuggestion":
    case "stopWorkItem":
    case "resumeWorkItem":
    case "compactSession":
    case "listModels":
    case "modelAccess":
    case "browser":
    case "startRun":
    case "steerRun":
    case "enqueueInput":
    case "resumeInputs":
    case "cancelSession":
    case "getMcpHealth":
    case "setMcpEnabled":
    case "removeMcpServer":
    case "checkPlugin":
    case "configurePlugin":
    case "getUsageStats":
      return undefined;
    case "cancelRun":
      return request.wait ? undefined : timeoutMs;
    default:
      return timeoutMs;
  }
}
