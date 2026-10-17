import type { ForgeBridge } from "./ipc";
import { mcpRegisterDtoSchema } from "./ipc";
import { createSessionInputSchema, type SessionId } from "./schemas";

// Structural host port: both HarnessService and ForgeBridge satisfy it.
export type SlashService = Pick<ForgeBridge,
  "createSession" | "getSession" | "listSessions" | "forkSession" | "renameSession" |
  "archiveSession" | "getDiagnostics" | "listCheckpoints" |
  "getCheckpointDiff" | "restoreCheckpoint"
> & {
  setMcpEnabled(id: string, enabled: boolean): Promise<unknown>;
  removeMcpServer(id: string): Promise<unknown>;
  compactSession(id: SessionId, signal?: AbortSignal): ReturnType<ForgeBridge["compactSession"]>;
  getProjectContext(id: SessionId): Promise<{ readonly skills: readonly unknown[] }>;
  listMcpServers(): Promise<readonly unknown[]>;
  registerMcpServer(input: Parameters<ForgeBridge["registerMcpServer"]>[0]): Promise<unknown>;
  getMcpHealth(id: string): Promise<unknown>;
};

export const createSlashActions = (service: SlashService) => ({
  newSession: (workspace: string, model: string) => service.createSession(createSessionInputSchema.parse({ workspace, model })),
  fork: (id: SessionId, value: string) => service.forkSession(id, value ? Number(value) : undefined),
  rename: (id: SessionId, value: string) => service.renameSession(id, value),
  archive: (id: SessionId) => service.archiveSession(id, true),
  compact: (id: SessionId, signal?: AbortSignal) => service.compactSession(id, signal),
  plan: async (id: SessionId) => (await service.getSession(id)).plan ?? null,
  sessions: () => service.listSessions(),
  diagnostics: (id: SessionId) => service.getDiagnostics(id),
  context: (id: SessionId) => service.getProjectContext(id),
  skills: async (id: SessionId) => (await service.getProjectContext(id)).skills,
  export: (id: SessionId) => service.getSession(id),
  checkpoints: async (id: SessionId, words: readonly string[]) => {
    const action = words[0] ?? "list";
    if (action === "list") return { kind: "data" as const, data: await service.listCheckpoints(id) };
    if (action === "diff" && words[1] && words.length === 2)
      return { kind: "text" as const, text: await service.getCheckpointDiff(id, words[1]) };
    if (action === "restore" && words[1] && words.length === 2)
      return { kind: "snapshot" as const, snapshot: await service.restoreCheckpoint(id, words[1]) };
    throw Error("Expected /checkpoints [list|diff ID|restore ID].");
  },
  mcp: async (words: readonly string[]): Promise<unknown> => {
    const [action, id, ...extra] = words;
    if (action === "list") return service.listMcpServers();
    if (action === "register" && id && extra.length >= 2)
      return service.registerMcpServer(mcpRegisterDtoSchema.parse({ id, label: extra[0], command: extra[1], args: extra.slice(2) }));
    if (id && (action === "enable" || action === "disable")) return service.setMcpEnabled(id, action === "enable");
    if (id && action === "remove") return service.removeMcpServer(id);
    if (id && action === "health") return service.getMcpHealth(id);
    throw Error("Expected /mcp list|register|enable|disable|remove|health.");
  },
});
