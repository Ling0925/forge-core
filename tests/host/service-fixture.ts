import { mcpRegisterInputSchema } from "../../src/mcp/types";
import type { HarnessService } from "../../src/shared/contracts";

/**
 * Neutral host-test defaults for public service methods that the local host
 * controller exposes but these protocol cases do not exercise. This fixture
 * deliberately has no CLI or renderer dependency.
 */
export const extendedService = (): Pick<
  HarnessService,
  | "getProjectContext"
  | "listMcpServers"
  | "registerMcpServer"
  | "setMcpEnabled"
  | "removeMcpServer"
  | "getMcpHealth"
  | "listCheckpoints"
  | "getCheckpointDiff"
  | "restoreCheckpoint"
> => ({
  getProjectContext: async () => ({
    workspace: "/tmp",
    instructionSources: [],
    skills: [],
    warnings: [],
    counts: { instructions: 0, skills: 0, warnings: 0 },
  }),
  listMcpServers: async () => [],
  registerMcpServer: async (raw) => {
    const input = mcpRegisterInputSchema.parse(raw);
    return {
      id: input.id,
      label: input.label,
      command: input.command,
      args: input.args,
      enabled: input.enabled ?? true,
      requestTimeoutMs: input.requestTimeoutMs ?? 15000,
      envNameCount: Object.keys(input.envNames).length,
      hasPrivateEnv: Object.keys(input.env).length > 0,
    };
  },
  setMcpEnabled: async (id, enabled) => ({
    id,
    enabled,
    label: id,
    command: "node",
    args: [],
    requestTimeoutMs: 15000,
    envNameCount: 0,
    hasPrivateEnv: false,
  }),
  removeMcpServer: async () => undefined,
  getMcpHealth: async (id) => ({
    id,
    enabled: false,
    connected: false,
    negotiatedProtocolVersion: undefined,
    lastError: undefined,
  }),
  listCheckpoints: async () => [],
  getCheckpointDiff: async () => "",
  restoreCheckpoint: async () => {
    throw new Error("No checkpoint to restore");
  },
});
