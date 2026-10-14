import { ForgeError } from "./errors";
import type {
  AgentEvent,
  ApprovalRequest,
  ConfigureInput,
  CreateSessionInput,
  JsonValue,
  Message,
  Permission,
  ProviderConfig,
  ProviderResponse,
  PublicSettings,
  RunInput,
  SessionId,
  SessionSnapshot,
  SessionSummary,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "./schemas";

export type EventSink = (event: AgentEvent) => void;
export type ApprovalHandler = (
  request: ApprovalRequest,
  signal: AbortSignal,
) => Promise<boolean>;
export interface RunControl {
  readonly drainSteering: () => readonly string[];
}
export interface ModelProvider {
  listModels(signal?: AbortSignal): Promise<readonly string[]>;
  getModelContextWindow?(model: string, signal?: AbortSignal): Promise<number | null>;
  complete(
    messages: readonly Message[],
    toolDefinitions: readonly ToolDefinition[],
    options: Readonly<{
      model: string;
      signal: AbortSignal;
      onText: (text: string) => void;
    }>,
  ): Promise<ProviderResponse>;
}
export interface ToolContext {
  readonly sessionId: SessionId;
  readonly toolCallId: string;
  readonly workspace: string;
  readonly permission: Permission;
  readonly signal: AbortSignal;
  readonly approve: ApprovalHandler;
  readonly onEvent: EventSink;
}
export interface LocalToolRegistry {
  readonly definitions: readonly ToolDefinition[];
  execute(call: ToolCall, context: ToolContext): Promise<ToolResult>;
  dispose(): Promise<void>;
}
export type ToolArguments = Readonly<Record<string, JsonValue>>;
export interface SessionStore {
  list(): Promise<readonly SessionSummary[]>;
  get(id: SessionId): Promise<SessionSnapshot>;
  create(
    input: Readonly<{ workspace: string; title: string; model: string; titleSource?: "default" | "user" }>,
  ): Promise<SessionSnapshot>;
  save(snapshot: SessionSnapshot): Promise<void>;
  acquire(id: SessionId, signal?: AbortSignal): Promise<() => Promise<void>>;
}
export interface SettingsStore {
  getPublic(): Promise<PublicSettings>;
  getProviderConfig(): Promise<ProviderConfig>;
  update(input: ConfigureInput): Promise<PublicSettings>;
}
export interface HarnessService {
  cancelSession(sessionId: SessionId): Promise<boolean>;
  getSettings(): Promise<PublicSettings>;
  updateSettings(input: ConfigureInput): Promise<PublicSettings>;
  listModels(signal?: AbortSignal): Promise<readonly string[]>;
  getModelContextWindow?(model: string, signal?: AbortSignal): Promise<number | null>;
  listSessions(): Promise<readonly SessionSummary[]>;
  createSession(input: CreateSessionInput): Promise<SessionSnapshot>;
  getSession(id: SessionId): Promise<SessionSnapshot>;
  run(
    input: RunInput,
    onEvent: EventSink,
    approve: ApprovalHandler,
    signal: AbortSignal,
    control?: RunControl,
  ): Promise<SessionSnapshot>;
  getProjectContext(
    id: SessionId,
  ): Promise<import("../context/index").ProjectContextCatalog>;
  listMcpServers(): ReturnType<import("../mcp/registry").McpService["list"]>;
  registerMcpServer(
    input: Parameters<import("../mcp/registry").McpService["register"]>[0],
  ): ReturnType<import("../mcp/registry").McpService["register"]>;
  setMcpEnabled(
    id: string,
    enabled: boolean,
  ): ReturnType<import("../mcp/registry").McpService["setEnabled"]>;
  removeMcpServer(
    id: string,
  ): ReturnType<import("../mcp/registry").McpService["remove"]>;
  getMcpHealth(
    id: string,
  ): ReturnType<import("../mcp/registry").McpService["health"]>;
  listCheckpoints(
    id: SessionId,
  ): Promise<readonly import("../store/checkpoints").CheckpointMetadata[]>;
  getCheckpointDiff(id: SessionId, checkpointId: string): Promise<string>;
  restoreCheckpoint(
    id: SessionId,
    checkpointId: string,
  ): Promise<SessionSnapshot>;
  compactSession(id: SessionId, signal?: AbortSignal): Promise<SessionSnapshot>;
  forkSession(id: SessionId, boundary?: number): Promise<SessionSnapshot>;
  renameSession(id: SessionId, title: string): Promise<SessionSnapshot>;
  archiveSession(id: SessionId, archived: boolean): Promise<SessionSnapshot>;
  getDiagnostics(id: SessionId): Promise<
    Readonly<{
      transcriptChars: number;
      projectedChars: number;
      messageCount: number;
      summaryFallback: boolean;
    }>
  >;
  dispose(): Promise<void>;
}
export type ProviderFactory = (config: ProviderConfig) => ModelProvider;
export type ToolFactory = (
  workspace: string,
) => LocalToolRegistry | Promise<LocalToolRegistry>;
export interface HarnessOptions {
  readonly stateDir?: string;
  readonly providerFactory?: ProviderFactory;
  readonly toolFactory?: ToolFactory;
}
export interface AgentRuntimeDependencies {
  readonly store: SessionStore;
  readonly provider: ModelProvider;
  readonly tools: LocalToolRegistry;
  readonly settings: PublicSettings;
  readonly childToolFactory?: ToolFactory;
  readonly onChildOperation?: (
    id: SessionId,
    controller: AbortController,
    work: Promise<SessionSnapshot>,
  ) => void;
  readonly projectInstructions?: string;
  readonly now?: () => string;
}
export interface AgentRuntime {
  run(
    input: RunInput,
    onEvent: EventSink,
    approve: ApprovalHandler,
    signal: AbortSignal,
    control?: RunControl,
  ): Promise<SessionSnapshot>;
}
export interface BrowserToolOptions {
  readonly executablePath?: string;
  readonly allowedOrigins: readonly string[];
  readonly headless?: boolean;
}
export const assertNever = (_value: never): never => {
  throw new ForgeError("internal", "An invariant was violated.");
};
