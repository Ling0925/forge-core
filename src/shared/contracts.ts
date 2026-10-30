import { ForgeError } from "./errors";
import type { HarnessAdaptationHost } from "./harness-adaptation";
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
export type SteeringInput = string | Pick<RunInput, "prompt" | "images">;
/** Resolves after the message is saved, independently of model/tool progress. */
export type SteeringHandler = (input: SteeringInput) => Promise<void>;
export interface RunControl {
  /** Trusted queue binding; never accepted directly from public RunInput. */
  readonly providerBinding?: string;
  /** Trusted predecessor acknowledgment; never a public RunInput field. */
  readonly acknowledgedPredecessor?: string;
  /** Trusted durable completion notification; never a public RunInput field. */
  readonly inputOrigin?: "background_task";
  readonly getPermission?: () => Permission | undefined;
  /** Freeze host permission changes before persisting the terminal permission. */
  readonly onFinalizing?: () => void;
  /** final=true atomically closes an empty child queue before terminal cleanup. */
  readonly drainSteering: (final?: boolean) => readonly SteeringInput[];
  readonly onSteeringApplied?: () => void;
  /** Bind the run's sole writer after startup; unbind before terminal cleanup. */
  readonly setSteeringHandler?: (handler: SteeringHandler | undefined) => void;
}
export interface ModelProvider {
  readonly apiMode?: "chat-completions" | "responses" | "anthropic" | "gemini";
  /** Host-derived metadata for mixed routes with Responses candidates, not a setting or gateway support guarantee. */
  readonly mayUseWebSearch?: boolean;
  listModels(
    signal?: AbortSignal,
    refresh?: boolean,
  ): Promise<readonly string[]>;
  /** Complete normalized metadata from one catalog request; no guessed windows. */
  listModelCatalog?(
    signal?: AbortSignal,
    refresh?: boolean,
  ): Promise<import("./model-catalog").ModelCatalog>;
  getModelContextWindow?(
    model: string,
    signal?: AbortSignal,
  ): Promise<number | null>;
  complete(
    messages: readonly Message[],
    toolDefinitions: readonly ToolDefinition[],
    options: Readonly<{
      model: string;
      signal: AbortSignal;
      attempt?: number;
      sessionId?: string;
      onAttempt?: (selection: import("./model-access").ProviderAttempt) => void;
      /** Request-scoped authorization; omitted for title generation/compaction. */
      webSearch?: import("./web-search").WebSearchMode;
      onWebSearch?: (search: import("./web-search").WebSearchProgress) => void;
      onText: (text: string) => void;
      /** Optional live reasoning display; never persisted as assistant content. */
      onReasoning?: (text: string) => void;
      /** Ephemeral cumulative metadata; never execute or expose partial arguments. */
      onToolCall?: (preview: import("./schemas").ToolCallPreview) => void;
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
  /** Host-owned accounting for auxiliary inference; undefined marks missing usage. */
  readonly onModelUsage?: (
    usage: import("./schemas").Usage | undefined,
  ) => void;
  /** Host-owned observers; not model tools and never permission grants. */
  readonly onCommandStarted?: () => void;
  readonly onCommandOutput?: (
    stream: "stdout" | "stderr",
    text: string,
  ) => void;
}
export interface LocalToolRegistry {
  readonly definitions: readonly ToolDefinition[];
  /** Trusted host metadata: these calls have no effects or approval requests. */
  isConcurrencySafe?(call: ToolCall): boolean;
  execute(call: ToolCall, context: ToolContext): Promise<ToolResult>;
  /** Join and report only undelivered background work before model finalization. */
  settleBackground?(
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<ToolResult | undefined>;
  readonly commandTasks?: import("./task-view").CommandTaskAccess;
  dispose(): Promise<void>;
}
export type ToolArguments = Readonly<Record<string, JsonValue>>;
export interface SessionStore {
  /** Versioned persistence; optional for legacy/in-memory adapters. */
  readonly incremental?: import("./session-store").IncrementalSessionStore;
  list(): Promise<readonly SessionSummary[]>;
  get(id: SessionId): Promise<SessionSnapshot>;
  create(
    input: Readonly<{
      workspace: string;
      title: string;
      model: string;
      providerSourceId?: string;
      routeGroupId?: string;
      titleSource?: "default" | "user";
    }>,
  ): Promise<SessionSnapshot>;
  save(snapshot: SessionSnapshot): Promise<void>;
  acquire(id: SessionId, signal?: AbortSignal): Promise<() => Promise<void>>;
}
export interface SettingsStore {
  getPublic(): Promise<PublicSettings>;
  /** Without an id: the active source (legacy top-level settings when none). */
  getProviderConfig(
    sourceId?: string,
    credentialId?: string,
    model?: string,
  ): Promise<ProviderConfig>;
  /** Endpoint, credential and source metadata from the same immutable read. */
  getProviderSnapshot?(
    sourceId?: string,
    credentialId?: string,
    model?: string,
  ): Promise<{
    config: ProviderConfig;
    source?: import("./schemas").PublicProviderSource;
  }>;

  refreshAccount?(
    sourceId: string,
    credentialId: string,
    refresh: (
      tokens: import("./model-access").AccountTokens,
    ) => Promise<import("./model-access").AccountTokens>,
    model?: string,
  ): Promise<ProviderConfig>;
  update(input: ConfigureInput): Promise<PublicSettings>;
}
export interface HarnessService {
  readonly inputQueue?: import("./input-queue").InputQueueHost;
  /** Local task UI only; optional for older hosts and desktop adapters. */
  readonly tasks?: import("./task-view").TaskService;
  cancelSession(sessionId: SessionId): Promise<boolean>;
  getSettings(): Promise<PublicSettings>;
  updateSettings(input: ConfigureInput): Promise<PublicSettings>;
  modelAccess?(
    input: import("./model-access").ModelAccessRequest,
    signal?: AbortSignal,
  ): Promise<import("./model-access").ModelAccessResult>;
  listModelCatalog?(
    signal?: AbortSignal,
    sourceId?: string,
    refresh?: boolean,
  ): Promise<import("./model-catalog").ModelCatalog>;
  getToolHooks?(): Promise<import("./tool-hooks").ToolHooksConfig>;
  setToolHooks?(config: import("./tool-hooks").ToolHooksConfig): Promise<void>;
  listModels(
    signal?: AbortSignal,
    sourceId?: string,
    refresh?: boolean,
  ): Promise<readonly string[]>;
  getModelContextWindow?(
    model: string,
    signal?: AbortSignal,
    sourceId?: string,
  ): Promise<number | null>;
  listSessions(): Promise<readonly SessionSummary[]>;
  createSession(input: CreateSessionInput): Promise<SessionSnapshot>;
  getSession(id: SessionId): Promise<SessionSnapshot>;
  getPublishedFile?(
    sessionId: SessionId,
    fileId: string,
  ): Promise<import("./published-files").PublishedFileResponse>;
  run(
    input: RunInput,
    onEvent: EventSink,
    approve: ApprovalHandler,
    signal: AbortSignal,
    control?: RunControl,
  ): Promise<SessionSnapshot>;
  getProjectContext(
    id: SessionId,
  ): Promise<import("./project-context").ProjectContextCatalog>;
  listMcpServers(): Promise<readonly import("./mcp").McpServerRecord[]>;
  registerMcpServer(input: unknown): Promise<import("./mcp").McpServerRecord>;
  setMcpEnabled(
    id: string,
    enabled: boolean,
  ): Promise<import("./mcp").McpServerRecord>;
  removeMcpServer(id: string): Promise<void>;
  getMcpHealth(id: string): Promise<import("./mcp").McpHealth>;
  /** Optional plugin administration; absent on older hosts and CLI-only services. */
  listPlugins?(): Promise<readonly import("./plugins").PluginRecord[]>;
  configurePlugin?(
    input: import("./plugins").PluginConfigureInput,
  ): Promise<import("./plugins").PluginRecord>;
  checkPlugin?(pluginId: string): Promise<import("./plugins").PluginHealth>;
  /** Human-initiated browser control; Core validates the session before effects. */
  browser?(
    input: import("./plugins").BrowserRequest,
  ): Promise<import("./plugins").BrowserResponse>;
  listCheckpoints(
    id: SessionId,
  ): Promise<readonly import("./checkpoints").CheckpointMetadata[]>;
  getCheckpointDiff(id: SessionId, checkpointId: string): Promise<string>;
  restoreCheckpoint(
    id: SessionId,
    checkpointId: string,
  ): Promise<SessionSnapshot>;
  listWorkspaceEntries?(
    id: SessionId,
    path?: string,
  ): Promise<import("./ipc").WorkspaceDirectoryListingDto>;
  readWorkspaceFile?(
    id: SessionId,
    path: string,
  ): Promise<import("./ipc").WorkspaceFilePreviewDto>;
  compactSession(id: SessionId, signal?: AbortSignal): Promise<SessionSnapshot>;
  forkSession(id: SessionId, boundary?: number): Promise<SessionSnapshot>;
  renameSession(id: SessionId, title: string): Promise<SessionSnapshot>;
  archiveSession(id: SessionId, archived: boolean): Promise<SessionSnapshot>;
  getUsageStats?(
    filter?: import("./ipc").UsageFilter,
  ): Promise<import("./ipc").UsageStatsDto>;
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
  readonly rootBudget?: import("./run-budget").RootRunBudget;
  readonly sessionLock?: Readonly<{
    id: SessionId;
    release: () => Promise<void>;
  }>;
  readonly autoTitle?: Readonly<{
    secrets: readonly string[];
    start: (
      snapshot: SessionSnapshot,
      apply: (title: string) => Promise<boolean>,
    ) => void;
  }>;
  readonly runMemory?: {
    readonly record: (snapshot: SessionSnapshot) => Promise<void>;
    readonly restore: (
      snapshot: SessionSnapshot,
      at: string,
      /** Calibrated tokens of the upcoming request with this history/summary. */
      measureTokens: (snapshot: SessionSnapshot) => number,
    ) => Promise<SessionSnapshot>;
  };
  readonly store: SessionStore;
  readonly provider: ModelProvider;
  readonly tools: LocalToolRegistry;
  readonly toolHooks?: import("./tool-hooks").ToolHooksConfig;
  readonly agentWorktrees?: import("./agent-worktrees").AgentWorktreeService;
  readonly settings: PublicSettings;
  /** Fresh public role catalog for admission, never private provider configuration. */
  readonly getAgentProfiles?: () => Promise<
    readonly import("./agent-profiles").AgentProfile[]
  >;
  /** Cross-source discovery and exact child selection; never changes the parent's binding. */
  readonly delegationModels?: {
    list(
      signal: AbortSignal,
      providerSourceId?: string,
    ): Promise<{
      models: readonly { id: string; providerSourceId?: string }[];
      unavailableSourceIds: readonly string[];
    }>;
    resolve(
      model: string,
      providerSourceId: string | undefined,
      signal: AbortSignal,
    ): Promise<string | undefined>;
  };
  /** Only the active supervisor can create this identity-bound child capability. */
  readonly advisorParent?: import("./agent-coordination").AdvisorParentPort;
  readonly childToolFactory?: ToolFactory;
  readonly childContextFactory?: (
    workspace: string,
    input?: RunInput,
    signal?: AbortSignal,
  ) => Promise<{
    readonly tools: LocalToolRegistry;
    readonly instructions: string;
    readonly provider?: ModelProvider;
    readonly providerSourceId?: string;
  }>;
  readonly onChildOperation?: (
    id: SessionId,
    controller: AbortController,
    work: Promise<SessionSnapshot>,
  ) => void;
  readonly projectInstructions?: string;
  /** Trusted host support for explicitly requested Harness² preflight runs. */
  readonly harnessAdaptation?: HarnessAdaptationHost;
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
export const assertNever = (_value: never): never => {
  throw new ForgeError("internal", "An invariant was violated.");
};
