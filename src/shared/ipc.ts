import { z } from "zod";
import { enqueueInputSchema, inputQueueSnapshotSchema, queuedInputSchema } from "./input-queue";
import { mcpRemoteRegisterInputSchema } from "../mcp/types";
import type { HtmlPreviewResponse } from "./html-preview";
import type { WorkspaceDirectoryPage } from "./workspaces";
import { publishedFileIdSchema, publishedFileResponseSchema, type PublishedFileResponse } from "./published-files";
import { type ImageAttachment, imageAttachmentsSchema } from "./images";
import {
  agentEventSchema,
  configureInputSchema,
  createSessionInputSchema,
  errorInfoSchema,
  permissionSchema,
  publicSettingsSchema,
  runInputSchema,
  sessionIdSchema,
  sessionSnapshotSchema,
  sessionSummarySchema,
} from "./schemas";
import type {
  ConfigureInput,
  CreateSessionInput,
  Permission,
  PublicSettings,
  RunInput,
  SessionId,
  SessionSnapshot,
  SessionSummary,
} from "./schemas";

export const IPC_CHANNELS = Object.freeze({
  request: "forge:request",
  event: "forge:event",
});
// Public DTOs deliberately omit instruction bodies, skill bodies and MCP environment.
export const projectContextDtoSchema = z
  .object({
    workspace: z.string().max(4096),
    instructionSources: z
      .array(
        z
          .object({
            path: z.string().max(4096),
            order: z.number().int().nonnegative(),
            bytes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(1024),
    skills: z
      .array(
        z
          .object({
            id: z.string().max(256),
            name: z.string().max(256),
            description: z.string().max(8192),
            version: z.string().max(256).nullable(),
            sourceDirectory: z.string().max(4096),
            provenance: z.enum(["workspace-forge", "workspace-agents", "user"]),
          })
          .strict(),
      )
      .max(1024),
    warnings: z.array(z.string().max(4096)).max(1024),
    counts: z
      .object({
        instructions: z.number().int().nonnegative(),
        skills: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .readonly();
export type ProjectContextDto = z.infer<typeof projectContextDtoSchema>;
const mcpStdioRegisterDtoSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    label: z.string().min(1).max(64),
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(8192)).max(64),
    enabled: z.boolean().optional(),
    requestTimeoutMs: z.number().int().min(1000).max(60000).optional(),
  })
  .strict()
  .readonly();
export const mcpRegisterDtoSchema = z.union([mcpStdioRegisterDtoSchema, mcpRemoteRegisterInputSchema]);
export type McpRegisterDto = z.infer<typeof mcpRegisterDtoSchema>;
export const mcpRecordDtoSchema = z
  .object({
    id: mcpStdioRegisterDtoSchema.unwrap().shape.id,
    label: mcpStdioRegisterDtoSchema.unwrap().shape.label,
    command: z.string().max(4096),
    args: mcpStdioRegisterDtoSchema.unwrap().shape.args,
    enabled: z.boolean(),
    requestTimeoutMs: z.number().int(),
    envNameCount: z.number().int().nonnegative(),
    hasPrivateEnv: z.boolean(),
    transport: z.enum(["stdio", "http", "sse"]).optional(),
    url: z.string().max(4096).optional(),
    headerCount: z.number().int().nonnegative().optional(),
    hasPrivateHeaders: z.boolean().optional(),
  })
  .strict()
  .readonly();
export type McpRecordDto = z.infer<typeof mcpRecordDtoSchema>;
export const mcpHealthDtoSchema = z
  .object({
    id: mcpStdioRegisterDtoSchema.unwrap().shape.id,
    enabled: z.boolean(),
    connected: z.boolean(),
    negotiatedProtocolVersion: z.string().max(128).nullable(),
    lastError: z.string().max(4096).nullable(),
    transport: z.enum(["stdio", "http", "sse"]).optional(),
  })
  .strict()
  .readonly();
export type McpHealthDto = z.infer<typeof mcpHealthDtoSchema>;
export const checkpointDtoSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().min(1).max(256),
    toolCallId: z.string().min(1).max(256),
    path: z.string().min(1).max(4096),
    kind: z.enum(["created", "modified"]),
    state: z.enum(["pending", "completed", "restored"]),
    beforeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    beforeMode: z.number().int().min(0).max(0o7777).nullable(),
    afterHash: z.string().regex(/^[a-f0-9]{64}$/),
    afterMode: z.number().int().min(0).max(0o7777).optional(),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    restoredAt: z.string().datetime().optional(),
  })
  .strict()
  .readonly();
export type CheckpointDto = z.infer<typeof checkpointDtoSchema>;
export const usageFilterSchema = z
  .object({
    workspace: z.string().optional(),
    days: z.number().int().positive().optional(),
  })
  .strict()
  .readonly()
  .optional();
export type UsageFilter = z.infer<typeof usageFilterSchema>;

export const modelUsageStatSchema = z
  .object({
    model: z.string(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    runCount: z.number().int().nonnegative(),
    sessionCount: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
export type ModelUsageStat = z.infer<typeof modelUsageStatSchema>;

export const dailyUsageStatSchema = z
  .object({
    date: z.string(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    runCount: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
export type DailyUsageStat = z.infer<typeof dailyUsageStatSchema>;

export const sessionUsageStatSchema = z
  .object({
    sessionId: sessionIdSchema,
    title: z.string(),
    workspace: z.string(),
    model: z.string(),
    updatedAt: z.string(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    runCount: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
export type SessionUsageStat = z.infer<typeof sessionUsageStatSchema>;

export const usageStatsDtoSchema = z
  .object({
    totalPromptTokens: z.number().int().nonnegative(),
    totalCompletionTokens: z.number().int().nonnegative(),
    totalCachedTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    totalSessions: z.number().int().nonnegative(),
    totalRuns: z.number().int().nonnegative(),
    averageCacheRate: z.number().min(0).max(1),
    models: z.array(modelUsageStatSchema).readonly(),
    daily: z.array(dailyUsageStatSchema).readonly(),
    topSessions: z.array(sessionUsageStatSchema).readonly(),
  })
  .strict()
  .readonly();
export type UsageStatsDto = z.infer<typeof usageStatsDtoSchema>;
export const externalUrlSchema = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !!url.hostname &&
        !url.username &&
        !url.password &&
        !Array.from(value).some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        })
      );
    } catch {
      return false;
    }
  }, "Expected HTTP(S) URL without credentials or control characters");
export const runIdSchema = z.string().uuid().brand<"RunId">();
export type RunId = z.infer<typeof runIdSchema>;
export const runHandleSchema = z
  .object({ runId: runIdSchema, sessionId: sessionIdSchema })
  .strict()
  .readonly();
export type RunHandle = z.infer<typeof runHandleSchema>;
const requestBase = { id: z.string().uuid() };
export const rpcRequestSchema = z
  .discriminatedUnion("method", [
    z.object({ ...requestBase, method: z.literal("enqueueInput"), input: enqueueInputSchema }).strict(),
    z.object({ ...requestBase, method: z.literal("listInputs"), sessionId: sessionIdSchema }).strict(),
    z.object({ ...requestBase, method: z.literal("cancelInput"), sessionId: sessionIdSchema, inputId: z.string().uuid() }).strict(),
    z.object({ ...requestBase, method: z.literal("pauseInputs"), sessionId: sessionIdSchema }).strict(),
    z.object({ ...requestBase, method: z.literal("resumeInputs"), sessionId: sessionIdSchema }).strict(),
    z.object({ ...requestBase, method: z.literal("getSettings") }).strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("updateSettings"),
        input: configureInputSchema,
      })
      .strict(),
    z.object({ ...requestBase, method: z.literal("listModels"), sourceId: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional() }).strict(),
    z.object({ ...requestBase, method: z.literal("listSessions") }).strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("createSession"),
        input: createSessionInputSchema,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("getSession"),
        sessionId: sessionIdSchema,
      })
      .strict(),
    z.object({ ...requestBase, method: z.literal("getPublishedFile"), sessionId: sessionIdSchema, fileId: publishedFileIdSchema }).strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("compactSession"),
        sessionId: sessionIdSchema,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("forkSession"),
        sessionId: sessionIdSchema,
        boundary: z.number().int().nonnegative().optional(),
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("renameSession"),
        sessionId: sessionIdSchema,
        title: z.string().trim().min(1).max(256),
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("archiveSession"),
        sessionId: sessionIdSchema,
        archived: z.boolean(),
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("getDiagnostics"),
        sessionId: sessionIdSchema,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("getProjectContext"),
        sessionId: sessionIdSchema,
      })
      .strict(),
    z.object({ ...requestBase, method: z.literal("listMcpServers") }).strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("registerMcpServer"),
        input: mcpRegisterDtoSchema,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("setMcpEnabled"),
        serverId: mcpStdioRegisterDtoSchema.unwrap().shape.id,
        enabled: z.boolean(),
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("removeMcpServer"),
        serverId: mcpStdioRegisterDtoSchema.unwrap().shape.id,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("getMcpHealth"),
        serverId: mcpStdioRegisterDtoSchema.unwrap().shape.id,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("listCheckpoints"),
        sessionId: sessionIdSchema,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("getCheckpointDiff"),
        sessionId: sessionIdSchema,
        checkpointId: z.string().uuid(),
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("restoreCheckpoint"),
        sessionId: sessionIdSchema,
        checkpointId: z.string().uuid(),
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("openExternal"),
        url: externalUrlSchema,
      })
      .strict(),
    z.object({ ...requestBase, method: z.literal("chooseWorkspace") }).strict(),
    z.object({ ...requestBase, method: z.literal("savePublishedFile"), sessionId: sessionIdSchema, fileId: publishedFileIdSchema }).strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("exportSession"),
        sessionId: sessionIdSchema,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("cancelSession"),
        sessionId: sessionIdSchema,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("startRun"),
        input: runInputSchema,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("cancelRun"),
        runId: runIdSchema,
      })
      .strict(),
    z.object({ ...requestBase, method: z.literal("setRunPermission"), runId: runIdSchema, permission: permissionSchema }).strict(),
    z.object({ ...requestBase, method: z.literal("steerRun"), runId: runIdSchema, prompt: z.string().trim().max(1000000), images: imageAttachmentsSchema.optional() }).strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("answerApproval"),
        runId: runIdSchema,
        approvalId: z.string().uuid(),
        approved: z.boolean(),
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("getUsageStats"),
        filter: usageFilterSchema,
      })
      .strict(),
  ])
  .readonly();
export type RpcRequest = z.infer<typeof rpcRequestSchema>;
export const workerRequestSchema = rpcRequestSchema.refine(
  (request) =>
    request.method !== "chooseWorkspace" &&
    request.method !== "openExternal" &&
    request.method !== "exportSession" && request.method !== "savePublishedFile",
  "Workspace chooser is main-process only",
);
export type WorkerRequest = Exclude<
  RpcRequest,
  { readonly method: "chooseWorkspace" | "openExternal" | "exportSession" | "savePublishedFile" }
>;
const success = <M extends RpcRequest["method"], S extends z.ZodTypeAny>(
  method: M,
  result: S,
) =>
  z
    .object({
      id: requestBase.id,
      ok: z.literal(true),
      method: z.literal(method),
      result,
    })
    .strict()
    .readonly();
export const rpcResponseSchema = z.union([
  success("getSettings", publicSettingsSchema),
  success("updateSettings", publicSettingsSchema),
  success("listModels", z.array(z.string().min(1).max(256)).readonly()),
  success("listSessions", z.array(sessionSummarySchema).readonly()),
  success("enqueueInput", queuedInputSchema),
  success("listInputs", inputQueueSnapshotSchema),
  success("cancelInput", z.boolean()),
  success("pauseInputs", inputQueueSnapshotSchema),
  success("resumeInputs", inputQueueSnapshotSchema),
  success("createSession", sessionSnapshotSchema),
  success("getSession", sessionSnapshotSchema),
  success("getPublishedFile", publishedFileResponseSchema),
  success("compactSession", sessionSnapshotSchema),
  success("forkSession", sessionSnapshotSchema),
  success("renameSession", sessionSnapshotSchema),
  success("archiveSession", sessionSnapshotSchema),
  success(
    "getDiagnostics",
    z
      .object({
        transcriptChars: z.number().int().nonnegative(),
        projectedChars: z.number().int().nonnegative(),
        messageCount: z.number().int().nonnegative(),
        summaryFallback: z.boolean(),
      })
      .strict()
      .readonly(),
  ),
  success("getProjectContext", projectContextDtoSchema),
  success("listMcpServers", z.array(mcpRecordDtoSchema).max(32).readonly()),
  success("registerMcpServer", mcpRecordDtoSchema),
  success("setMcpEnabled", z.null()),
  success("removeMcpServer", z.null()),
  success("getMcpHealth", mcpHealthDtoSchema),
  success(
    "listCheckpoints",
    z.array(checkpointDtoSchema).max(10000).readonly(),
  ),
  success("getCheckpointDiff", z.string().max(262144)),
  success("restoreCheckpoint", sessionSnapshotSchema),
  success("openExternal", z.null()),
  success("chooseWorkspace", z.string().min(1).max(4096).nullable()),
  success("exportSession", z.boolean()),
  success("savePublishedFile", z.boolean()),
  success("cancelSession", z.boolean()),
  success("startRun", runHandleSchema),
  success("cancelRun", z.null()),
  success("setRunPermission", permissionSchema),
  success("steerRun", z.null()),
  success("answerApproval", z.null()),
  success("getUsageStats", usageStatsDtoSchema),
  z
    .object({
      id: requestBase.id,
      ok: z.literal(false),
      method: z.enum([
        "getSettings",
        "updateSettings",
        "listModels",
        "listSessions",
        "enqueueInput",
        "listInputs",
        "cancelInput",
        "pauseInputs",
        "resumeInputs",
        "createSession",
        "getSession",
        "getPublishedFile",
        "compactSession",
        "forkSession",
        "renameSession",
        "archiveSession",
        "getDiagnostics",
        "getProjectContext",
        "listMcpServers",
        "registerMcpServer",
        "setMcpEnabled",
        "removeMcpServer",
        "getMcpHealth",
        "listCheckpoints",
        "getCheckpointDiff",
        "restoreCheckpoint",
        "openExternal",
        "chooseWorkspace",
        "exportSession",
        "savePublishedFile",
        "cancelSession",
        "startRun",
        "cancelRun",
        "setRunPermission",
        "steerRun",
        "answerApproval",
        "getUsageStats",
      ]),
      error: errorInfoSchema,
    })
    .strict()
    .readonly(),
]);
export type RpcResponse = z.infer<typeof rpcResponseSchema>;
export const runEventSchema = z
  .object({ runId: runIdSchema, event: agentEventSchema })
  .strict()
  .readonly();
export type RunEvent = z.infer<typeof runEventSchema>;
export const workerMessageSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("ready") }).strict(),
    z
      .object({ kind: z.literal("response"), response: rpcResponseSchema })
      .strict(),
    z.object({ kind: z.literal("event"), data: runEventSchema }).strict(),
  ])
  .readonly();
export type WorkerMessage = z.infer<typeof workerMessageSchema>;

export interface ForgeBridge {
  readonly inputQueue?: import("./input-queue").InputQueueService;
  /** Web launch-workspace policy; absent on desktop and older hosts. */
  readonly restrictWorkspace?: boolean;
  getSettings(): Promise<PublicSettings>;
  updateSettings(input: ConfigureInput): Promise<PublicSettings>;
  listModels(sourceId?: string): Promise<readonly string[]>;
  listSessions(): Promise<readonly SessionSummary[]>;
  createSession(input: CreateSessionInput): Promise<SessionSnapshot>;
  getSession(sessionId: SessionId): Promise<SessionSnapshot>;
  getPublishedFile(sessionId: SessionId, fileId: string): Promise<PublishedFileResponse>;
  compactSession(sessionId: SessionId): Promise<SessionSnapshot>;
  forkSession(
    sessionId: SessionId,
    boundary?: number,
  ): Promise<SessionSnapshot>;
  renameSession(sessionId: SessionId, title: string): Promise<SessionSnapshot>;
  archiveSession(
    sessionId: SessionId,
    archived: boolean,
  ): Promise<SessionSnapshot>;
  getDiagnostics(sessionId: SessionId): Promise<{
    transcriptChars: number;
    projectedChars: number;
    messageCount: number;
    summaryFallback: boolean;
  }>;
  getUsageStats?(filter?: UsageFilter): Promise<UsageStatsDto>;
  getProjectContext(sessionId: SessionId): Promise<ProjectContextDto>;
  listMcpServers(): Promise<readonly McpRecordDto[]>;
  registerMcpServer(input: McpRegisterDto): Promise<McpRecordDto>;
  setMcpEnabled(serverId: string, enabled: boolean): Promise<void>;
  removeMcpServer(serverId: string): Promise<void>;
  getMcpHealth(serverId: string): Promise<McpHealthDto>;
  listCheckpoints(sessionId: SessionId): Promise<readonly CheckpointDto[]>;
  getCheckpointDiff(
    sessionId: SessionId,
    checkpointId: string,
  ): Promise<string>;
  restoreCheckpoint(
    sessionId: SessionId,
    checkpointId: string,
  ): Promise<SessionSnapshot>;
  openExternal(url: string): Promise<void>;
  chooseWorkspace(): Promise<string | null>;
  /** Web-only server directory browser; absent on fixed-workspace and desktop hosts. */
  browseWorkspaces?(path?: string): Promise<WorkspaceDirectoryPage>;
  exportSession(sessionId: SessionId): Promise<boolean>;
  cancelSession(sessionId: SessionId): Promise<boolean>;
  startRun(input: RunInput): Promise<RunHandle>;
  cancelRun(runId: RunId): Promise<void>;
  setRunPermission(runId: RunId, permission: Permission): Promise<Permission>;
  steerRun(runId: RunId, prompt: string, images?: readonly ImageAttachment[]): Promise<void>;
  answerApproval(
    runId: RunId,
    approvalId: string,
    approved: boolean,
  ): Promise<void>;
  onEvent(listener: (event: RunEvent) => void): () => void;
  /**
   * Web-only sandboxed HTML preview. Absent on hosts without an authenticated
   * preview endpoint (the desktop bridge), so callers must probe for it.
   */
  previewHtml?(html: string): Promise<HtmlPreviewResponse>;
  previewFile?(path: string): Promise<HtmlPreviewResponse>;
  /** Desktop native save dialog. No renderer-chosen output path or content. */
  savePublishedFile?(sessionId: SessionId, fileId: string): Promise<boolean>;
}

declare global {
  interface Window {
    readonly forge: ForgeBridge;
  }
}
