import type { AdvisorCoordinator } from "../shared/agent-coordination";
import {
  measureContext,
  resolveContextBudget,
  resolveContextWindow,
} from "../shared/context-usage";
import type {
  AgentRuntime,
  AgentRuntimeDependencies,
  RunControl,
} from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import { executionTurns } from "../shared/execution";
import { agentEventSchema, runInputSchema } from "../shared/schemas";
import type { Message, SessionSnapshot } from "../shared/schemas";
import { createAdvisorCoordinator } from "./advisor";
import { DEFAULT_MAX_AGENT_DEPTH, agentDepth } from "./agent-operations";
import { assertAgentModel, isAgentToolAllowed } from "./agent-profiles";
import { createAgentSupervisor } from "./agent-supervisor";
import { nativeDefinitions, nativeDefinitionsFor } from "./agents";
import { createApprovalQueue } from "./approval-queue";
import { withCancellation } from "./cancellation";
import { projectSummary } from "./context";
import { harnessStrategyMessage } from "./harness-adaptation";
import { buildSystemInstructions } from "./prompts";
import { createRootRunBudget } from "./run-budget";
import { seedContextScale } from "./runtime-context";
import { createRunEvents } from "./runtime-events";
import { createRunFinish } from "./runtime-finish";
import { runHarnessPreflight } from "./runtime-harness-preflight";
import { createRuntimeJournal } from "./runtime-journal";
import { createEffectivePermission } from "./runtime-permission";
import {
  requestGeneration,
  resolveHostedSearch,
} from "./runtime-provider-request";
import { reconcileQuietStep } from "./runtime-reconciliation";
import {
  closeCalls,
  interruptStaleRun,
  recordRunFailure,
} from "./runtime-recovery";
import { type LoadedRunState, createRunState } from "./runtime-state";
import { createRunSteering } from "./runtime-steering";
import { prepareStepContext } from "./runtime-step-context";
import { executeResponseToolCalls } from "./runtime-tool-calls";
import { createModelUsageObserver } from "./runtime-usage";
import { claimAutoTitle } from "./session-title";
import { createToolFailureGuard } from "./tool-failure-guard";
import { createToolHookService } from "./tool-hooks";

export { withCancellation } from "./cancellation";
export {
  CONTEXT_SCALE_FLOOR,
  compactContext,
  seedContextScale,
} from "./runtime-context";
export {
  MAX_GENERATION_RETRIES,
  RETRY_DELAYS_MS,
  retryDelay,
} from "./runtime-retry";

export const createAgentRuntime = (
  deps: AgentRuntimeDependencies,
): AgentRuntime => ({
  async run(rawInput, onEvent, approve, callerSignal, control?: RunControl) {
    const input = runInputSchema.parse(rawInput);
    if (input.harness && !deps.harnessAdaptation)
      throw new ForgeError(
        "invalid_input",
        "This runtime host does not support Harness adaptation.",
      );
    if (
      input.harness?.experience === "read-write" &&
      !deps.harnessAdaptation?.experiences
    )
      throw new ForgeError(
        "invalid_input",
        "This runtime host does not support Harness experience persistence.",
      );
    const rootBudget =
      deps.rootBudget ??
      createRootRunBudget({ rootSessionId: input.sessionId });
    rootBudget.check();
    const signal = callerSignal;
    const runtimeDeps = { ...deps, rootBudget };
    const hooks = deps.toolHooks
      ? createToolHookService(deps.toolHooks)
      : undefined;
    const hasToolHooks =
      !!deps.toolHooks &&
      [
        deps.toolHooks.beforeTool,
        deps.toolHooks.afterTool,
        deps.toolHooks.toolError,
      ].some((entries) => entries.length > 0);
    let release: () => Promise<void>;
    try {
      release =
        deps.sessionLock?.id === input.sessionId
          ? deps.sessionLock.release
          : await deps.store.acquire(input.sessionId, signal);
    } catch (error) {
      if (!deps.rootBudget) rootBudget.close();
      throw error;
    }
    const run = createRunState();
    const effectivePermission = createEffectivePermission(
      run,
      input,
      deps,
      control,
    );
    const onModelUsage = createModelUsageObserver(
      run,
      rootBudget,
      input.sessionId,
    );
    const checkToolFailure = createToolFailureGuard();
    const approvalQueue = createApprovalQueue();
    const now = deps.now ?? (() => new Date().toISOString());
    const {
      notify,
      event,
      finishGeneration,
      closeStep,
      hookDiagnostics,
      ephemeral,
    } = createRunEvents(run, input.sessionId, onEvent, now);
    const check = (): void => {
      rootBudget.check();
      if (signal.aborted) throw new ForgeError("cancelled", "Run cancelled.");
    };
    const journal = createRuntimeJournal(deps.store, input, {
      current: () => run.snapshot,
      replace: (value) => {
        run.snapshot = value;
      },
      now,
      check,
    });
    const advisor: AdvisorCoordinator = createAdvisorCoordinator({
      parentSessionId: input.sessionId,
      parentRunId: rootBudget.snapshot().rootRunId,
      isChildActive: (id) => {
        const child = supervisor.native.children.get(id);
        return !!child?.active && !child.controller.signal.aborted;
      },
      persist: async (request) => notify(await journal.acceptAdvisor(request)),
      now,
    });
    const supervisor = createAgentSupervisor({
      deps: runtimeDeps,
      parentSessionId: input.sessionId,
      signal,
      approvalQueue,
      approve,
      advisor,
      parentModel: () => run.snapshot?.model ?? deps.settings.model,
      createRuntime: createAgentRuntime,
      emitUpdate: event,
      emitProgress: (body) => ephemeral(body),
      emitApproval: (request) => event({ type: "approval_requested", request }),
    });
    const save = journal.save;
    const settleWrites = journal.settle;
    const includeSteering = journal.includeSteering;
    const acceptSteering = journal.acceptSteering;
    const { drainAdvisor, closeSteering, drainSteering } = createRunSteering({
      run,
      journal,
      advisor,
      control,
      check,
      event,
    });
    const finish = createRunFinish({
      run,
      input,
      deps,
      signal,
      control,
      rootBudget,
      hooks,
      advisor,
      supervisor,
      save,
      settleWrites,
      includeSteering,
      closeSteering,
      event,
      notify,
      now,
      closeStep,
      hookDiagnostics,
      effectivePermission,
    });
    // One shared view of this run's collaborators; each extracted helper
    // takes the subset it needs. The snapshot is loaded before any of them run.
    const scope = {
      run: run as LoadedRunState,
      input,
      deps,
      runtimeDeps,
      signal,
      rootBudget,
      hooks,
      hasToolHooks,
      approvalQueue,
      approve,
      supervisor,
      check,
      save,
      event,
      ephemeral,
      closeStep,
      finishGeneration,
      hookDiagnostics,
      effectivePermission,
      onModelUsage,
      checkToolFailure,
      drainSteering,
      drainAdvisor,
    };
    try {
      run.snapshot = await journal.read();
      rootBudget.enter(input.sessionId);
      assertAgentModel(run.snapshot.agentProfile, input);
      run.canDelegate =
        (await agentDepth(
          run.snapshot,
          (id) => deps.store.get(id),
          deps.settings.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH,
        )) < (deps.settings.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH);
      const roleDefinitions = nativeDefinitionsFor(
        Boolean(run.snapshot.parentSessionId),
        Boolean(deps.advisorParent),
        run.canDelegate,
      );
      const allowTool = (name: string, args?: unknown) =>
        isAgentToolAllowed(run.snapshot?.agentProfile, name, args) &&
        (!nativeDefinitions.some((item) => item.function.name === name) ||
          roleDefinitions.some((item) => item.function.name === name));
      const definitions = [
        ...deps.tools.definitions,
        ...roleDefinitions,
      ].filter((item) => allowTool(item.function.name));
      // Recovery describes old requests; it does not revive their waiters or tools.
      for (const request of run.snapshot.advisorRequests ?? [])
        if (request.status === "pending")
          notify(
            await journal.acceptAdvisor({
              ...request,
              status: "interrupted",
              updatedAt: now(),
            }),
          );
      const toolNames = definitions.map(
        (definition) => definition.function.name,
      );
      let currentInstructions = buildSystemInstructions({
        session: run.snapshot,
        permission: effectivePermission(),
        mode: input.mode,
        projectInstructions: deps.projectInstructions,
        toolNames,
        canDelegate: run.canDelegate,
      });
      const project = (state: SessionSnapshot) => {
        const projected = projectSummary(state).map((message, index) =>
          index === 0 && message.role === "system"
            ? { role: "system" as const, content: currentInstructions }
            : message,
        );
        const messages =
          projected[0]?.role === "system"
            ? projected
            : [
                { role: "system" as const, content: currentInstructions },
                ...projected,
              ];
        const guidance =
          run.adaptation?.status === "adopted"
            ? harnessStrategyMessage(run.adaptation.strategy)
            : undefined;
        // A lower-trust reference before the actual user turns, included in
        // context accounting but never installed as system policy or history.
        if (guidance) messages.splice(1, 0, guidance);
        return messages;
      };
      const prompt: Message = {
        role: "user",
        content: input.prompt,
        ...(control?.inputOrigin === "background_task"
          ? { origin: "agent_reconciliation" as const }
          : {}),
        ...(input.images?.length ? { images: input.images } : {}),
      };
      run.contextScale = seedContextScale(
        run.snapshot.events,
        input.model ?? run.snapshot.model,
      );
      if (deps.runMemory)
        run.snapshot = await deps.runMemory.restore(
          run.snapshot,
          now(),
          (state) => {
            // Count the upcoming request without appending new inputs to the old
            // checkpoint: its hash and summary boundary must remain about past work.
            const upcoming = {
              ...state,
              messages: [...state.messages, ...journal.pendingMessages, prompt],
            };
            return (
              measureContext(project(upcoming), null, definitions).usedTokens *
              run.contextScale
            );
          },
        );
      if (
        run.snapshot.status === "running" ||
        run.snapshot.status === "awaiting_approval"
      )
        await interruptStaleRun(run as LoadedRunState, event, save);
      check();
      const permission = effectivePermission();
      const {
        pendingTool: _pending,
        routeGroupId: previousRoute,
        ...settled
      } = run.snapshot;
      const routeGroupId =
        input.routeGroupId ??
        (input.model !== undefined || input.providerSourceId !== undefined
          ? undefined
          : previousRoute);
      run.snapshot = {
        ...settled,
        ...(routeGroupId ? { routeGroupId } : {}),
        model: input.model ?? run.snapshot.model,
        ...(input.providerSourceId
          ? { providerSourceId: input.providerSourceId }
          : {}),
        messages: closeCalls(
          run.snapshot.messages,
          "prior execution was interrupted; inspect effects before retry",
        ),
      };
      includeSteering(); // Recover accepted inputs after closing any interrupted tool calls.
      currentInstructions = buildSystemInstructions({
        session: run.snapshot,
        permission,
        mode: input.mode,
        projectInstructions: deps.projectInstructions,
        toolNames,
        canDelegate: run.canDelegate,
      });
      if (
        !run.snapshot.contextSummary &&
        !run.snapshot.messages.some((message) => message.role === "system")
      )
        run.snapshot = {
          ...run.snapshot,
          messages: [
            {
              role: "system",
              content: currentInstructions,
            },
            ...run.snapshot.messages,
          ],
        };
      run.turn = (executionTurns(run.snapshot).at(-1)?.turn ?? 0) + 1;
      run.snapshot = {
        ...run.snapshot,
        status: "running",
        messages: [...run.snapshot.messages, prompt],
      };
      const claimed = claimAutoTitle(
        run.snapshot,
        deps.autoTitle?.secrets ?? [],
      );
      const shouldName = claimed !== run.snapshot;
      run.snapshot = claimed;
      const started = agentEventSchema.parse({
        type: "run_started",
        turn: run.turn,
        budget: rootBudget.snapshot(
          run.snapshot.parentSessionId ? input.sessionId : undefined,
        ),
        sessionId: input.sessionId,
        timestamp: now(),
        messageIndex: run.snapshot.messages.length - 1,
        model: run.snapshot.model,
        permission,
        title: run.snapshot.title,
      });
      run.snapshot = {
        ...run.snapshot,
        events: [...run.snapshot.events, started],
      };
      await save();
      journal.openSteering();
      control?.setSteeringHandler?.(acceptSteering);
      notify(started);
      check();
      rootBudget.checkAdmission();
      if (shouldName && deps.autoTitle) {
        const fallback = run.snapshot.title;
        deps.autoTitle.start(run.snapshot, async (title) => {
          if (!run.acceptingTitle || !run.snapshot) return false;
          if (
            run.snapshot.titleSource !== "auto" ||
            run.snapshot.title !== fallback
          )
            return true;
          run.snapshot = { ...run.snapshot, title };
          await save();
          if (run.acceptingTitle) ephemeral({ type: "title_changed", title });
          return true;
        });
      }
      check();
      rootBudget.checkAdmission();
      if (input.harness && run.snapshot.agentProfile)
        throw new ForgeError(
          "invalid_input",
          "Harness adaptation cannot bypass a configured specialist's tool policy.",
        );
      if (input.harness) await runHarnessPreflight(scope, input.harness);
      let reportedWindow: number | null = null;
      if (!deps.settings.modelContextWindows?.[run.snapshot.model]) {
        const metadataSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(2000),
        ]);
        try {
          reportedWindow = await withCancellation(
            deps.provider.getModelContextWindow?.(
              run.snapshot.model,
              metadataSignal,
            ) ?? Promise.resolve(null),
            metadataSignal,
          );
        } catch {
          /* Optional metadata must not prevent a model request. */
        }
      }
      const windowTokens = resolveContextWindow(
        run.snapshot.model,
        deps.settings,
        reportedWindow,
      );
      const budget = resolveContextBudget(windowTokens, deps.settings);
      // Raw size of the exact messages a request would carry. `measureContext` is
      // a character heuristic, not the provider tokenizer, so this must not be
      // compared against a token budget directly: over recorded turns real input
      // exceeded the trigger on 788 turns while the raw estimate never once
      // crossed it, so an all-raw check lets the request grow past the window.
      const contextSize = (messages: readonly Message[]) =>
        budget.unit === "tokens"
          ? measureContext(messages, windowTokens, definitions).usedTokens
          : JSON.stringify(messages).length;
      // Every budget comparison below uses the calibrated size, and every raw
      // limit handed to trimming is divided by the scale, so the messages that
      // leave Forge are the ones measured against the budget.
      while (true) {
        const scale = budget.unit === "tokens" ? run.contextScale : 1;
        const calibratedSize = (messages: readonly Message[]) =>
          contextSize(messages) * scale;
        const rawLimit = budget.limit / scale;
        const rawTarget = budget.target / scale;
        check();
        rootBudget.checkAdmission();
        currentInstructions = buildSystemInstructions({
          session: run.snapshot,
          permission: effectivePermission(),
          mode: input.mode,
          projectInstructions: deps.projectInstructions,
          toolNames,
        });
        await drainSteering();
        await drainAdvisor();
        check();
        const { context, projectedUsage } = await prepareStepContext(scope, {
          project,
          contextSize,
          calibratedSize,
          rawLimit,
          rawTarget,
          budget,
          windowTokens,
          definitions,
          currentInstructions,
        });
        run.phase = "provider";
        run.turns += 1;
        run.activeStep = run.turns;
        event({
          type: "step_started",
          turn: run.turn,
          step: run.activeStep,
          messageIndex: run.snapshot.messages.length,
        });
        await save();
        const webSearch = await resolveHostedSearch(scope);
        const { response, previews } = await requestGeneration(scope, {
          webSearch,
          context,
          projectedUsage,
          project,
          rawLimit,
          contextSize,
          windowTokens,
          budget,
          definitions,
        });
        run.snapshot = {
          ...run.snapshot,
          messages: [...run.snapshot.messages, response.message],
        };
        run.incompleteText = "";
        run.phase = "storage";
        const calls = response.message.tool_calls ?? [];
        if (calls.length === 0) closeStep("completed");
        await save();
        finishGeneration("completed");
        if (
          response.message.citations?.length ||
          response.message.webSearches?.length
        )
          ephemeral({
            type: "web_search_result",
            citations: response.message.citations ?? [],
            webSearches: response.message.webSearches ?? [],
          });
        if (calls.length === 0) {
          if (
            (await reconcileQuietStep(scope, response, previews)) === "continue"
          )
            continue;
          return await finish("completed");
        }
        await executeResponseToolCalls(scope, {
          calls,
          response,
          previews,
          allowTool,
        });
      }
    } catch (error) {
      if (!run.snapshot) throw error;
      const safe = recordRunFailure(run as LoadedRunState, error, {
        signal,
        sessionId: input.sessionId,
        now,
        finishGeneration,
        event,
      });
      return await finish(safe.code === "cancelled" ? "cancelled" : "failed");
    } finally {
      closeSteering();
      run.acceptingTitle = false;
      // Cleanup still joins children if terminal persistence or a hook throws.
      try {
        try {
          await advisor.close("interrupted");
        } finally {
          await supervisor.settle(true);
        }
      } finally {
        try {
          await hooks?.dispose();
        } finally {
          try {
            await journal.pendingWrite;
            await release();
          } finally {
            if (!deps.rootBudget) rootBudget.close();
          }
        }
      }
    }
  },
});
