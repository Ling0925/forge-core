import { randomUUID } from "node:crypto";
import {
  listWorkspaceDirectory,
  readWorkspaceFilePreview,
} from "../core/workspace-files";
import type { HarnessService, SteeringHandler } from "../shared/contracts";
import { ForgeError, toErrorInfo } from "../shared/errors";
import { HOST_PROTOCOL_VERSION, type HostState } from "../shared/host";
import { QueueAdmissionError } from "../shared/input-queue";
import {
  type RpcRequest,
  type RunEvent,
  type RunId,
  type WorkerMessage,
  projectContextDtoSchema,
  runIdSchema,
  workerMessageSchema,
  workerRequestSchema,
} from "../shared/ipc";
import {
  type AgentEvent,
  type ApprovalRequest,
  type ErrorInfo,
  type Permission,
  type RunInput,
  approvalRequestSchema,
} from "../shared/schemas";
import { paginateSession } from "../shared/session-page";

export const safeError = {
  code: "internal",
  message: "The operation could not be completed.",
  retryable: false,
} as const;
type Approval = {
  request: ApprovalRequest;
  answer?: boolean;
  resolve?: (answer: boolean) => void;
  consumed: boolean;
  claimed: boolean;
};

export function createWorkerController(
  service: HarnessService,
  send: (message: WorkerMessage) => void,
) {
  const hostId = randomUUID();
  const runs = new Map<
    RunId,
    {
      input: RunInput;
      abort: AbortController;
      approvals: Map<string, Approval>;
      finished: boolean;
      permission: Permission | undefined;
      permissionChanged: boolean;
      recovery: Map<string, AgentEvent>;
      steering: Extract<RpcRequest, { method: "steerRun" }>[];
      applyingSteering: Extract<RpcRequest, { method: "steerRun" }>[];
      acceptingSteering: boolean;
      acceptSteering: SteeringHandler | undefined;
      terminal?: Extract<AgentEvent, { type: "run_finished" }>;
      completion?: Promise<unknown>;
    }
  >();
  const pending = new Map<string, RpcRequest>();
  const operations = new Set<Promise<unknown>>();
  // Duplicate suppression only needs to cover the request's in-flight lifetime plus
  // brief replay jitter; the FIFO bound keeps long-lived sessions from growing memory.
  const seen = new Set<string>();
  const seenLimit = 4096;
  let disposed = false;
  let closing: Promise<void> | undefined;
  const emit = (message: WorkerMessage): void => {
    send(workerMessageSchema.parse(message));
  };
  const respond = (
    request: RpcRequest,
    result: unknown,
    error?: ErrorInfo,
  ): void => {
    if (!pending.delete(request.id)) return;
    const parsed = workerMessageSchema.safeParse({
      kind: "response",
      response: error
        ? { id: request.id, method: request.method, ok: false, error }
        : { id: request.id, method: request.method, ok: true, result },
    });
    emit(
      parsed.success
        ? parsed.data
        : {
            kind: "response",
            response: {
              id: request.id,
              method: request.method,
              ok: false,
              error: safeError,
            },
          },
    );
  };
  const event = (runId: RunId, value: AgentEvent): void => {
    const run = runs.get(runId);
    if (
      !run ||
      run.finished ||
      disposed ||
      value.sessionId !== run.input.sessionId
    )
      return;
    if (value.type === "run_started") run.permission = value.permission;
    if (value.type === "run_finished") {
      run.terminal = value;
      run.acceptingSteering = false;
      return;
    }
    if (value.type === "approval_requested") {
      const approval = approvalRequestSchema.parse(value.request);
      if (
        approval.sessionId !== run.input.sessionId ||
        run.approvals.has(approval.id)
      )
        throw new ForgeError("invalid_input", "Invalid approval request.");
      run.approvals.set(approval.id, {
        request: approval,
        consumed: false,
        claimed: false,
      });
      if (
        !approval.childSessionId &&
        (run.permission === "unrestricted" ||
          (run.permissionChanged && run.permission === "readonly"))
      ) {
        const pendingApproval = run.approvals.get(approval.id);
        if (pendingApproval) {
          pendingApproval.consumed = true;
          pendingApproval.answer = run.permission === "unrestricted";
        }
        return;
      }
    }
    const parsed = workerMessageSchema.parse({
      kind: "event",
      data: { runId, event: value },
    });
    if (
      value.type === "run_started" ||
      value.type === "state_changed" ||
      value.type === "permission_changed" ||
      value.type === "provider_retry"
    )
      run.recovery.set(value.type, value);
    if (value.type === "agent_progress") {
      const key = `agent-progress:${value.childSessionId}`;
      const childKeys = [...run.recovery.keys()].filter(key => key.startsWith("agent-progress:"));
      if (run.recovery.has(key) || childKeys.length < 32) run.recovery.set(key, value);
    }
    if (value.type === "agent_update" && !["running", "awaiting_approval"].includes(value.status))
      run.recovery.delete(`agent-progress:${value.childSessionId}`);
    if (value.type === "generation_started") {
      // Replay only the current attempt, in lifecycle order. Never concatenate
      // a new generation with the previous generation's bounded preview.
      for (const key of run.recovery.keys())
        if (["generation_started", "generation_finished", "text_delta", "reasoning_delta"].includes(key) || key.startsWith("tool-preview:"))
          run.recovery.delete(key);
      run.recovery.set(value.type, value);
    }
    if (value.type === "generation_finished") run.recovery.set(value.type, value);
    if (value.type === "tool_call_preview") {
      const key = `tool-preview:${value.previewId}`;
      if (run.recovery.has(key) || run.recovery.size < 264)
        run.recovery.set(key, value);
    }
    if (value.type === "tool_started" && value.previewId)
      run.recovery.delete(`tool-preview:${value.previewId}`);
    if (
      value.type === "tool_preview_reset" ||
      value.type === "retry_reset" ||
      value.type === "error"
    )
      for (const key of run.recovery.keys())
        if (key.startsWith("tool-preview:")) run.recovery.delete(key);
    if (value.type === "tool_started" || value.type === "retry_reset") {
      run.recovery.delete("text_delta");
      run.recovery.delete("reasoning_delta");
    }
    if (
      value.type === "context_usage" ||
      value.type === "tool_started" ||
      value.type === "retry_reset"
    )
      run.recovery.delete("provider_retry");
    if (value.type === "text_delta" || value.type === "reasoning_delta") {
      const previous = run.recovery.get(value.type);
      const text =
        previous && previous.generationId === value.generationId &&
        (previous.type === "text_delta" || previous.type === "reasoning_delta")
          ? previous.text
          : "";
      // Keep one extra character so the renderer can still indicate truncation.
      run.recovery.set(value.type, {
        ...value,
        text: (text + value.text).slice(0, 131073),
      });
    }
    emit(parsed);
  };
  // Every attached client (desktop window, Web, Android) shares this one
  // controller, so a settlement must be broadcast to all subscribers instead of
  // only replying to the caller. Otherwise the other surfaces keep a stale
  // approval card. The payload is limited to the approval id and the decision:
  // no request body, command, tool arguments or credential. Callers mark the
  // approval `consumed` first, so each approval settles at most one event.
  const settleApproval = (
    runId: RunId,
    approval: Approval,
    approved: boolean,
  ): void => {
    const run = runs.get(runId);
    if (!run || run.finished) return;
    event(runId, {
      type: "approval_resolved",
      sessionId: run.input.sessionId,
      timestamp: new Date().toISOString(),
      approvalId: approval.request.id,
      approved,
    });
  };
  const finish = (
    runId: RunId,
    error?: ErrorInfo,
  ): "completed" | "failed" | "cancelled" | "interrupted" => {
    const run = runs.get(runId);
    if (!run) return "interrupted";
    const base = {
      sessionId: run.input.sessionId,
      timestamp: new Date().toISOString(),
    };
    if (error && !run.abort.signal.aborted)
      event(runId, { ...base, type: "error", error });
    const terminal: AgentEvent =
      run.terminal && !error
        ? run.terminal
        : {
            ...base,
            type: "run_finished",
            status: run.abort.signal.aborted
              ? "cancelled"
              : error
                ? "failed"
                : "completed",
            turns: 0,
            toolCalls: 0,
          };
    run.finished = true;
    for (const request of [...run.steering, ...run.applyingSteering])
      respond(request, null, {
        code: "cancelled",
        message: "插话未写入会话，草稿已保留。请核对记录后手动发送。",
        retryable: false,
      });
    for (const approval of run.approvals.values()) approval.resolve?.(false);
    runs.delete(runId);
    emit({ kind: "event", data: { runId, event: terminal } });
    void service.inputQueue
      ?.finished(run.input.sessionId, terminal.status)
      .catch(() => undefined);
    return terminal.status;
  };
  const startRun = (
    input: RunInput,
    providedRunId?: RunId,
    providerBinding?: string,
    acknowledgedPredecessor?: string,
  ) => {
    if (
      [...runs.values()].some((run) => run.input.sessionId === input.sessionId)
    )
      throw providerBinding
        ? new QueueAdmissionError()
        : new ForgeError(
            "busy",
            "This session already has an active run.",
            true,
          );
    const runId = providedRunId ?? runIdSchema.parse(randomUUID());
    const run: NonNullable<ReturnType<typeof runs.get>> = {
      input,
      abort: new AbortController(),
      approvals: new Map<string, Approval>(),
      finished: false,
      permission: undefined,
      permissionChanged: false,
      recovery: new Map<string, AgentEvent>(),
      steering: [],
      applyingSteering: [],
      acceptingSteering: true,
      acceptSteering: undefined,
    };
    runs.set(runId, run);
    // The response is posted before even synchronous service callbacks execute.
    const operation = Promise.resolve()
      .then(() =>
        service.run(
          input,
          (value) => event(runId, value),
          (rawApproval, signal) => {
            const approval = approvalRequestSchema.parse(rawApproval);
            if (
              signal.aborted ||
              run.abort.signal.aborted ||
              disposed ||
              run.finished
            )
              return Promise.resolve(false);
            const entry = run.approvals.get(approval.id);
            if (
              !entry ||
              JSON.stringify(entry.request) !== JSON.stringify(approval) ||
              entry.claimed
            )
              throw new ForgeError(
                "invalid_input",
                "Approval does not match the pending action.",
              );
            entry.claimed = true;
            if (entry.consumed) return Promise.resolve(entry.answer === true);
            return new Promise<boolean>((resolve) => {
              const settle = (answer: boolean): void => {
                entry.consumed = true;
                entry.answer = answer;
                signal.removeEventListener("abort", abort);
                run.abort.signal.removeEventListener("abort", abort);
                resolve(answer);
              };
              const abort = (): void => settle(false);
              entry.resolve = settle;
              signal.addEventListener("abort", abort, { once: true });
              run.abort.signal.addEventListener("abort", abort, {
                once: true,
              });
            });
          },
          run.abort.signal,
          {
            drainSteering: (final) => {
              const requests = run.steering.splice(0);
              run.applyingSteering.push(...requests);
              if (final && requests.length === 0) run.acceptingSteering = false;
              return requests.map((request) =>
                request.images?.length
                  ? { prompt: request.prompt, images: request.images }
                  : request.prompt,
              );
            },
            onSteeringApplied: () => {
              for (const request of run.applyingSteering.splice(0))
                respond(request, null);
            },
            setSteeringHandler: (handler) => {
              run.acceptSteering = handler;
              if (!handler) { run.acceptingSteering = false; return; }
              // Requests received during startup join the runtime's sole writer
              // as soon as it is ready, not at the next provider boundary.
              for (const request of run.steering.splice(0)) {
                void handler({ prompt: request.prompt, ...(request.images?.length ? { images: request.images } : {}) })
                  .then(() => respond(request, null), error => respond(request, null, toErrorInfo(error)));
              }
            },
            getPermission: () => run.permission,
            ...(providerBinding ? { providerBinding } : {}),
            ...(acknowledgedPredecessor ? { acknowledgedPredecessor } : {}),
          },
        ),
      )
      .then(
        () => finish(runId),
        (error) => {
          const status = finish(runId, toErrorInfo(error));
          if (error instanceof QueueAdmissionError) throw error;
          return status;
        },
      );
    run.completion = operation;
    operations.add(operation);
    void operation
      .finally(() => operations.delete(operation))
      .catch(() => undefined);
    return { handle: { runId, sessionId: input.sessionId }, operation };
  };
  const queueReady = service.inputQueue?.attach({
    isBusy: (sessionId) =>
      [...runs.values()].some((run) => run.input.sessionId === sessionId),
    start: (input, runId, binding, predecessor) =>
      startRun(input, runIdSchema.parse(runId), binding, predecessor).operation,
  });
  void queueReady?.catch(() => undefined);
  const queue = async () => {
    if (!service.inputQueue)
      throw new ForgeError(
        "not_found",
        "Durable inputs are unavailable on this host.",
      );
    await queueReady;
    return service.inputQueue;
  };
  const hostState = (): HostState => ({
    hostId,
    protocolVersion: HOST_PROTOCOL_VERSION,
    runs: [...runs].map(([runId, run]) => {
      const state = run.recovery.get("state_changed");
      return {
        runId,
        sessionId: run.input.sessionId,
        status: state?.type === "state_changed" ? state.status : "running",
        stopping: run.abort.signal.aborted,
        ...(run.permission ? { permission: run.permission } : {}),
        pendingApprovals: [...run.approvals.values()]
          .filter((item) => !item.consumed)
          .map((item) => item.request),
      };
    }),
  });
  const handle = async (raw: unknown): Promise<void> => {
    const parsed = workerRequestSchema.safeParse(raw);
    if (!parsed.success) return;
    const request = parsed.data;
    if (seen.has(request.id)) return;
    seen.add(request.id);
    // Set iteration is insertion-ordered, so this evicts the oldest entry.
    if (seen.size > seenLimit)
      for (const oldest of seen) {
        seen.delete(oldest);
        break;
      }
    pending.set(request.id, request);
    if (disposed) {
      respond(request, null, safeError);
      return;
    }
    try {
      switch (request.method) {
        case "getHostState":
          respond(request, hostState());
          break;
        case "getSettings":
          respond(request, await service.getSettings());
          break;
        case "updateSettings":
          respond(request, await service.updateSettings(request.input));
          break;
        case "listModels":
          respond(
            request,
            await service.listModels(undefined, request.sourceId, request.refresh),
          );
          break;
        case "modelAccess":
          if (!service.modelAccess) throw new ForgeError("not_found", "Model access is unavailable on this host.");
          respond(request, await service.modelAccess(request.input));
          break;
        case "listSessions":
          respond(request, await service.listSessions());
          break;
        case "createSession":
          respond(request, await service.createSession(request.input));
          break;
        case "getSession":
          respond(request, await service.getSession(request.sessionId));
          break;
        case "getSessionPage":
          respond(
            request,
            paginateSession(await service.getSession(request.sessionId), request.page),
          );
          break;
        case "getPublishedFile":
          if (!service.getPublishedFile)
            throw new ForgeError(
              "not_found",
              "File attachments are unavailable on this host.",
            );
          respond(
            request,
            await service.getPublishedFile(request.sessionId, request.fileId),
          );
          break;
        case "getProjectContext": {
          const catalog = await service.getProjectContext(request.sessionId);
          respond(
            request,
            projectContextDtoSchema.parse({
              ...catalog,
              instructionSources: catalog.instructionSources.map(
                ({ path, order, bytes }) => ({ path, order, bytes }),
              ),
            }),
          );
          break;
        }
        case "listMcpServers":
          respond(request, await service.listMcpServers());
          break;
        case "registerMcpServer":
          respond(request, await service.registerMcpServer(request.input));
          break;
        case "setMcpEnabled":
          await service.setMcpEnabled(request.serverId, request.enabled);
          respond(request, null);
          break;
        case "removeMcpServer":
          await service.removeMcpServer(request.serverId);
          respond(request, null);
          break;
        case "getMcpHealth": {
          const health = await service.getMcpHealth(request.serverId);
          respond(request, {
            ...health,
            negotiatedProtocolVersion: health.negotiatedProtocolVersion ?? null,
            lastError: health.lastError ?? null,
          });
          break;
        }
        case "listCheckpoints":
          respond(request, await service.listCheckpoints(request.sessionId));
          break;
        case "getCheckpointDiff":
          respond(
            request,
            await service.getCheckpointDiff(
              request.sessionId,
              request.checkpointId,
            ),
          );
          break;
        case "restoreCheckpoint":
          respond(
            request,
            await service.restoreCheckpoint(
              request.sessionId,
              request.checkpointId,
            ),
          );
          break;
        case "cancelSession":
          respond(request, await service.cancelSession(request.sessionId));
          break;
        case "getUsageStats":
          if (!service.getUsageStats)
            throw new ForgeError(
              "not_found",
              "Usage statistics are unavailable on this host.",
            );
          respond(request, await service.getUsageStats(request.filter));
          break;
        case "listWorkspaceEntries": {
          if (service.listWorkspaceEntries) {
            respond(
              request,
              await service.listWorkspaceEntries(
                request.sessionId,
                request.path,
              ),
            );
            break;
          }
          const session = await service.getSession(request.sessionId);
          respond(
            request,
            await listWorkspaceDirectory(session.workspace, request.path),
          );
          break;
        }
        case "readWorkspaceFile": {
          if (service.readWorkspaceFile) {
            respond(
              request,
              await service.readWorkspaceFile(request.sessionId, request.path),
            );
            break;
          }
          const session = await service.getSession(request.sessionId);
          respond(
            request,
            await readWorkspaceFilePreview(session.workspace, request.path),
          );
          break;
        }
        case "compactSession":
          respond(request, await service.compactSession(request.sessionId));
          break;
        case "forkSession":
          respond(
            request,
            await service.forkSession(request.sessionId, request.boundary),
          );
          break;
        case "renameSession":
          respond(
            request,
            await service.renameSession(request.sessionId, request.title),
          );
          break;
        case "archiveSession":
          respond(
            request,
            await service.archiveSession(request.sessionId, request.archived),
          );
          break;
        case "getDiagnostics":
          respond(request, await service.getDiagnostics(request.sessionId));
          break;
        case "enqueueInput":
          respond(request, await (await queue()).enqueue(request.input));
          break;
        case "listInputs":
          respond(request, await (await queue()).list(request.sessionId));
          break;
        case "cancelInput":
          respond(
            request,
            await (await queue()).cancel(request.sessionId, request.inputId),
          );
          break;
        case "pauseInputs":
          respond(request, await (await queue()).pause(request.sessionId));
          break;
        case "resumeInputs":
          respond(request, await (await queue()).resume(request.sessionId));
          break;
        case "startRun": {
          const run = startRun(request.input);
          respond(request, run.handle);
          break;
        }
        case "steerRun": {
          if (!request.prompt && !request.images?.length)
            throw new ForgeError("invalid_input", "请输入消息或添加图片。");
          const run = runs.get(request.runId);
          if (
            !run ||
            run.finished ||
            run.abort.signal.aborted ||
            !run.acceptingSteering
          )
            throw new ForgeError(
              "not_found",
              "当前运行已结束或正在收尾，草稿已保留。请手动发送下一轮。",
            );
          if (run.acceptSteering) {
            await run.acceptSteering({ prompt: request.prompt, ...(request.images?.length ? { images: request.images } : {}) });
            respond(request, null);
            break;
          }
          const queued = [...run.steering, ...run.applyingSteering];
          if (
            queued.length >= 1000 ||
            queued.reduce(
              (size, item) =>
                size +
                Buffer.byteLength(
                  JSON.stringify({ prompt: item.prompt, images: item.images }),
                ),
              Buffer.byteLength(
                JSON.stringify({
                  prompt: request.prompt,
                  images: request.images,
                }),
              ),
            ) >
              16 * 1024 * 1024
          )
            throw new ForgeError("invalid_input", "插话队列已满，草稿已保留。");
          run.steering.push(request);
          break;
        }
        case "setRunPermission": {
          const run = runs.get(request.runId);
          if (!run || run.finished || run.abort.signal.aborted)
            throw new ForgeError("not_found", "The run is no longer active.");
          const snapshot = await service.getSession(run.input.sessionId);
          if (run.finished || run.abort.signal.aborted)
            throw new ForgeError("not_found", "The run is no longer active.");
          const levels = ["readonly", "workspace", "unrestricted"] as const;
          const ceiling =
            run.input.mode === "plan"
              ? "readonly"
              : (snapshot.permissionCeiling ?? "unrestricted");
          if (levels.indexOf(request.permission) > levels.indexOf(ceiling))
            throw new ForgeError(
              "invalid_input",
              "当前运行的只读模式或子代理权限上限不允许此权限。",
            );
          run.permission = request.permission;
          run.permissionChanged = true;
          for (const approval of run.approvals.values()) {
            if (
              approval.consumed ||
              approval.request.childSessionId ||
              request.permission === "workspace"
            )
              continue;
            approval.consumed = true;
            approval.answer = request.permission === "unrestricted";
            approval.resolve?.(approval.answer);
            // Permission changes settle pending root approvals implicitly, so
            // every other client must retire the same card.
            settleApproval(request.runId, approval, approval.answer);
          }
          event(request.runId, {
            type: "permission_changed",
            sessionId: run.input.sessionId,
            timestamp: new Date().toISOString(),
            permission: request.permission,
          });
          respond(request, request.permission);
          break;
        }
        case "cancelRun": {
          const run = runs.get(request.runId);
          if (!run)
            throw new ForgeError(
              "not_found",
              "The run or approval is no longer active.",
            );
          run.abort.abort();
          if (request.wait) await run.completion;
          respond(request, null);
          break;
        }
        case "answerApproval": {
          const run = runs.get(request.runId);
          const answer = run?.approvals.get(request.approvalId);
          if (
            !answer ||
            answer.consumed ||
            run?.abort.signal.aborted ||
            run?.finished
          )
            throw new ForgeError(
              "not_found",
              "The run or approval is no longer active.",
            );
          answer.consumed = true;
          answer.answer = request.approved;
          answer.resolve?.(request.approved);
          // Retire the card on every surface before acknowledging the decision.
          settleApproval(request.runId, answer, request.approved);
          respond(request, null);
          break;
        }
      }
    } catch (error) {
      respond(request, null, toErrorInfo(error));
    }
  };
  const dispose = (): Promise<void> => {
    if (closing) return closing;
    disposed = true;
    for (const run of runs.values()) run.abort.abort();
    for (const request of pending.values()) respond(request, null, safeError);
    closing = Promise.resolve().then(async () => {
      try {
        await service.dispose();
      } finally {
        await Promise.allSettled([...operations]);
        runs.clear();
      }
    });
    return closing;
  };
  const dispatch = (raw: unknown): Promise<void> => {
    const operation = handle(raw);
    operations.add(operation);
    void operation
      .finally(() => operations.delete(operation))
      .catch(() => undefined);
    return operation;
  };
  const recoveryEvents = (): RunEvent[] => {
    const result: RunEvent[] = [];
    for (const [runId, run] of runs) {
      if (run.finished) continue;
      const base = {
        sessionId: run.input.sessionId,
        timestamp: new Date().toISOString(),
      };
      const started = run.recovery.get("run_started");
      if (started) result.push({ runId, event: started });
      const permission = run.recovery.get("permission_changed");
      if (permission) result.push({ runId, event: permission });
      const retry = run.recovery.get("provider_retry");
      if (retry) result.push({ runId, event: retry });
      result.push({
        runId,
        event: run.recovery.get("state_changed") ?? {
          ...base,
          type: "state_changed",
          status: "running",
        },
      });
      const generationStarted = run.recovery.get("generation_started");
      if (generationStarted) result.push({ runId, event: generationStarted });
      for (const type of ["reasoning_delta", "text_delta"] as const) {
        const event = run.recovery.get(type);
        if (
          event &&
          (event.type === "reasoning_delta" || event.type === "text_delta")
        ) {
          // Recovery retains one extra character to signal UI truncation, but
          // every network event must still respect the 131072-character schema.
          for (let offset = 0; offset < event.text.length; offset += 131072)
            result.push({
              runId,
              event: {
                ...event,
                text: event.text.slice(offset, offset + 131072),
              },
            });
        }
      }
      for (const [key, event] of run.recovery)
        if (key.startsWith("tool-preview:") || key.startsWith("agent-progress:")) result.push({ runId, event });
      const generationFinished = run.recovery.get("generation_finished");
      if (generationFinished) result.push({ runId, event: generationFinished });
      for (const approval of run.approvals.values()) {
        if (!approval.consumed)
          result.push({
            runId,
            event: {
              ...base,
              type: "approval_requested",
              request: approval.request,
            },
          });
      }
    }
    return result;
  };
  return { handle: dispatch, dispose, recoveryEvents, hostState };
}
