import { ForgeError } from "./errors";
import { type ForgeBridge, type RpcRequest, type RpcResponse, type RunEvent, rpcRequestSchema, rpcResponseSchema, runEventSchema } from "./ipc";

export interface BridgeTransport {
  request(input: RpcRequest): Promise<unknown>;
  onEvent(listener: (raw: unknown) => void): void;
}
type Results = { [M in RpcRequest["method"]]: Extract<RpcResponse, { ok: true; method: M }>["result"] };

// LAN HTTP is not a secure context: randomUUID may be absent, getRandomValues is available.
export function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function createTransportBridge(transport: BridgeTransport): ForgeBridge {
  const listeners = new Set<(event: RunEvent) => void>();
  const events: RunEvent[] = [];
  let starting = 0;
  const deliver = (): void => {
    if (starting || !listeners.size) return;
    for (const event of events.splice(0)) for (const listener of listeners) {
      try { listener(event); } catch { /* Consumer isolation. */ }
    }
  };
  transport.onEvent((raw) => {
    const parsed = runEventSchema.safeParse(raw);
    if (parsed.success) { events.push(parsed.data); setTimeout(deliver, 0); }
  });
  async function request<M extends RpcRequest["method"]>(method: M, fields: object = {}): Promise<Results[M]> {
    const input = rpcRequestSchema.parse({ id: requestId(), method, ...fields });
    // Never replay uncertain effects when the transport fails.
    const response = rpcResponseSchema.safeParse(await transport.request(input));
    if (!response.success || response.data.id !== input.id || response.data.method !== method) throw new Error("Invalid host response.");
    if (!response.data.ok) {
      const { code, message, retryable } = response.data.error;
      throw new ForgeError(code, message, retryable);
    }
    return response.data.result as Results[M];
  }
  return Object.freeze({
    getHostState: () => request("getHostState"),
    inputQueue: {
      enqueue: input => request("enqueueInput", { input }),
      list: sessionId => request("listInputs", { sessionId }),
      cancel: (sessionId, inputId) => request("cancelInput", { sessionId, inputId }),
      pause: sessionId => request("pauseInputs", { sessionId }),
      resume: sessionId => request("resumeInputs", { sessionId }),
    },
    getSettings: () => request("getSettings"),
    modelAccess: (input) => request("modelAccess", { input }),
    updateSettings: (input) => request("updateSettings", { input }),
    listModels: (sourceId, refresh) => request("listModels", {
      ...(sourceId === undefined ? {} : { sourceId }),
      ...(refresh === undefined ? {} : { refresh }),
    }),
    listSessions: () => request("listSessions"),
    createSession: (input) => request("createSession", { input }),
    getSession: (sessionId) => request("getSession", { sessionId }),
    getSessionPage: (sessionId, page) => request("getSessionPage", {
      sessionId,
      ...(page === undefined ? {} : { page }),
    }),
    getPublishedFile: (sessionId, fileId) => request("getPublishedFile", { sessionId, fileId }),
    compactSession: (sessionId) => request("compactSession", { sessionId }),
    forkSession: (sessionId, boundary) => request("forkSession", { sessionId, boundary }),
    renameSession: (sessionId, title) => request("renameSession", { sessionId, title }),
    archiveSession: (sessionId, archived) => request("archiveSession", { sessionId, archived }),
    getUsageStats: (filter) => request("getUsageStats", filter ? { filter } : {}),
    getDiagnostics: (sessionId) => request("getDiagnostics", { sessionId }),
    getProjectContext: (sessionId) => request("getProjectContext", { sessionId }),
    listMcpServers: () => request("listMcpServers"),
    registerMcpServer: (input) => request("registerMcpServer", { input }),
    setMcpEnabled: async (serverId, enabled) => { await request("setMcpEnabled", { serverId, enabled }); },
    removeMcpServer: async (serverId) => { await request("removeMcpServer", { serverId }); },
    getMcpHealth: (serverId) => request("getMcpHealth", { serverId }),
    listCheckpoints: (sessionId) => request("listCheckpoints", { sessionId }),
    getCheckpointDiff: (sessionId, checkpointId) => request("getCheckpointDiff", { sessionId, checkpointId }),
    restoreCheckpoint: (sessionId, checkpointId) => request("restoreCheckpoint", { sessionId, checkpointId }),
    listWorkspaceEntries: (sessionId, path) => request("listWorkspaceEntries", path === undefined ? { sessionId } : { sessionId, path }),
    readWorkspaceFile: (sessionId, path) => request("readWorkspaceFile", { sessionId, path }),
    openExternal: async (url) => { await request("openExternal", { url }); },
    chooseWorkspace: () => request("chooseWorkspace"),
    exportSession: (sessionId) => request("exportSession", { sessionId }),
    cancelSession: (sessionId) => request("cancelSession", { sessionId }),
    async startRun(input) {
      starting++;
      try { return await request("startRun", { input }); }
      finally { starting--; setTimeout(deliver, 0); }
    },
    cancelRun: async (runId) => { await request("cancelRun", { runId }); },
    setRunPermission: (runId, permission) => request("setRunPermission", { runId, permission }),
    steerRun: async (runId, prompt, images) => { await request("steerRun", { runId, prompt, ...(images?.length ? { images } : {}) }); },
    answerApproval: async (runId, approvalId, approved) => { await request("answerApproval", { runId, approvalId, approved }); },
    onEvent(listener) { listeners.add(listener); setTimeout(deliver, 0); return () => { listeners.delete(listener); }; },
  } satisfies ForgeBridge);
}
