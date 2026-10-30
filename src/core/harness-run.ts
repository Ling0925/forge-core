import {
  type createRouteState,
  createRoutedProvider,
} from "../provider/routing";
import type {
  ApprovalHandler,
  EventSink,
  LocalToolRegistry,
  RunControl,
} from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import { QueueAdmissionError } from "../shared/input-queue";
import { narrowestPermission } from "../shared/permissions";
import type { RootRunBudget } from "../shared/run-budget";
import { settingsFields } from "../shared/schemas";
import type {
  Permission,
  RunInput,
  SessionId,
  SessionSnapshot,
} from "../shared/schemas";
import type { openHarnessExperienceStore } from "../store/harness-experiences";
import type { openSessionStore } from "../store/sessions";
import type { openSettingsStore } from "../store/settings";
import type { openToolHooksStore } from "../store/tool-hooks";
import { assertAgentModel } from "./agent-profiles";
import type { createAgentWorktreeService } from "./agent-worktrees";
import { createDelegationModels } from "./delegation-models";
import {
  assertProviderEndpoint,
  type createProviderSelection,
  findRouteGroup,
  inferSourceId,
  queuedSelectionValidator,
  selectRouteGroup,
  selectSessionSource,
} from "./harness-provider-selection";
import type { createHarnessTitles } from "./harness-titles";
import type { createHarnessTools } from "./harness-tools";
import { inputPredecessor } from "./input-queue";
import { redactMemoryText } from "./memory-retrieval";
import type { createModelAccessService } from "./model-access";
import { createRootRunBudget } from "./run-budget";
import type { openRunMemory } from "./run-memory";
import { createAgentRuntime } from "./runtime";

type HarnessTools = ReturnType<typeof createHarnessTools>;
type ProviderSelection = ReturnType<typeof createProviderSelection>;

/** Everything one harness run borrows from its owning harness. */
export type HarnessRunDeps = {
  store: Awaited<ReturnType<typeof openSessionStore>>;
  settingsStore: Awaited<ReturnType<typeof openSettingsStore>>;
  modelAccess: ReturnType<typeof createModelAccessService>;
  routeState: ReturnType<typeof createRouteState>;
  queueProviderBinding: ProviderSelection["queueProviderBinding"];
  rememberSource: ProviderSelection["rememberSource"];
  buildTools: HarnessTools["buildTools"];
  buildProbeTools: HarnessTools["buildProbeTools"];
  stopTitle: ReturnType<typeof createHarnessTitles>["stopTitle"];
  startTitle: ReturnType<typeof createHarnessTitles>["startTitle"];
  runMemory: Awaited<ReturnType<typeof openRunMemory>>;
  toolHooksStore: Awaited<ReturnType<typeof openToolHooksStore>>;
  agentWorktrees: ReturnType<typeof createAgentWorktreeService>;
  getHarnessExperiences: () => ReturnType<typeof openHarnessExperienceStore>;
  asyncPermissions: Map<SessionId, () => Permission>;
  track: (
    id: SessionId,
    controller: AbortController,
    work: Promise<unknown>,
  ) => void;
  active: Map<SessionId, Promise<SessionSnapshot>>;
};

/**
 * One admitted run: lock the session, resolve its provider selection, build
 * tools and drive the agent runtime, then release everything it acquired.
 */
export const createHarnessRun = (deps: HarnessRunDeps) => {
  const {
    store,
    settingsStore,
    modelAccess,
    routeState,
    queueProviderBinding,
    rememberSource,
    buildTools,
    buildProbeTools,
    stopTitle,
    startTitle,
    runMemory,
    toolHooksStore,
    agentWorktrees,
    getHarnessExperiences,
    asyncPermissions,
    track,
    active,
  } = deps;
  return async (
    input: RunInput,
    onEvent: EventSink,
    approve: ApprovalHandler,
    signal: AbortSignal,
    control: RunControl | undefined,
  ): Promise<SessionSnapshot> => {
    let tools: LocalToolRegistry | undefined;
    let releaseSession: (() => Promise<void>) | undefined;
    let rootBudget: RootRunBudget | undefined;
    try {
      await stopTitle(input.sessionId);
      try {
        releaseSession = await store.acquire(input.sessionId, signal);
      } catch (error) {
        if (
          control?.providerBinding &&
          error instanceof ForgeError &&
          error.code === "busy"
        )
          throw new QueueAdmissionError();
        throw error;
      }
      if (signal.aborted) throw new ForgeError("cancelled", "Run cancelled.");
      const [settings, snapshot] = await Promise.all([
        settingsStore.getPublic(),
        store.get(input.sessionId),
      ]);
      // A role's model is frozen with its session, including manual continuation.
      assertAgentModel(snapshot.agentProfile, input);
      // Recheck under the actual execution lock, before provider/tool construction.
      if (control?.providerBinding) {
        const predecessor = inputPredecessor(snapshot);
        if (
          predecessor.unsafe &&
          control.acknowledgedPredecessor !== predecessor.token
        )
          throw new QueueAdmissionError();
      }
      if (asyncPermissions.has(input.sessionId)) {
        asyncPermissions.set(input.sessionId, () =>
          narrowestPermission(
            input.mode === "plan"
              ? "readonly"
              : (control?.getPermission?.() ??
                  input.permission ??
                  settings.defaultPermission),
            snapshot.permissionCeiling,
          ),
        );
      }
      rootBudget = createRootRunBudget({ rootSessionId: input.sessionId });
      const { providerSourceId, routeGroupId } = selectSessionSource(
        settings,
        snapshot,
        input,
      );
      const group = findRouteGroup(settings, routeGroupId);
      if (input.harness && routeGroupId)
        throw new ForgeError(
          "invalid_input",
          "Harness adaptation requires a direct model selection, not a route group.",
        );
      const requestedModel = settingsFields.model.parse(
        input.model ?? snapshot.model,
      );
      const selectedGroup = selectRouteGroup(
        settings,
        providerSourceId,
        requestedModel,
        group,
      );
      if (
        control?.providerBinding &&
        control.providerBinding !==
          (await queueProviderBinding(
            settings,
            requestedModel,
            providerSourceId,
            routeGroupId,
          ))
      )
        throw new ForgeError(
          "invalid_input",
          "The queued provider selection changed before execution. Nothing was replayed.",
        );
      const validateSelection = queuedSelectionValidator(
        control,
        settings,
        requestedModel,
        providerSourceId,
        routeGroupId,
      );
      const prepared = selectedGroup
        ? await modelAccess.prepareRoute(
            selectedGroup,
            signal,
            validateSelection,
          )
        : undefined;
      const resolved =
        prepared?.base ??
        (await modelAccess.resolveProvider(
          providerSourceId,
          undefined,
          signal,
          requestedModel,
          validateSelection,
        ));
      const { config } = resolved;
      assertProviderEndpoint(config.baseUrl);
      // An explicit source (or one the model alone identifies) is what the
      // user just chose, so remember it as the fallback for the next run.
      await rememberSource(
        input.providerSourceId ?? inferSourceId(settings, input.model),
      );
      rootBudget.checkAdmission();
      const provider =
        selectedGroup && prepared
          ? createRoutedProvider({
              group: selectedGroup,
              state: routeState,
              ...(prepared.apiMode ? { apiMode: prepared.apiMode } : {}),
              mayUseWebSearch: prepared.mayUseWebSearch,
              contextWindow: prepared.contextWindow,
              quota: prepared.quota,
              exclude: prepared.exclude,
              resolve: (member, requestSignal) =>
                modelAccess.resolveProvider(
                  member.sourceId,
                  member.credentialId,
                  requestSignal,
                  member.model,
                  validateSelection,
                ),
            })
          : resolved.provider;
      if (signal.aborted) throw new ForgeError("cancelled", "Run cancelled.");
      const built = await buildTools(
        snapshot.workspace,
        settings,
        config.apiKey,
        provider,
        input.uiHost,
      );
      tools = built.tools;
      rootBudget.checkAdmission();
      const budget = rootBudget;
      const result = await createAgentRuntime({
        rootBudget: budget,
        store,
        sessionLock: { id: input.sessionId, release: releaseSession },
        autoTitle: {
          secrets: [config.apiKey, config.baseUrl],
          start: (claimed, apply) =>
            startTitle(claimed, apply, {
              signal,
              provider: resolved.provider,
              secrets: [config.apiKey, config.baseUrl],
              beginUsage: () => budget.beginUsage(input.sessionId),
            }),
        },
        runMemory,
        toolHooks: await toolHooksStore.get(),
        agentWorktrees,
        settings,
        getAgentProfiles: async () =>
          (await settingsStore.getPublic()).agentProfiles ?? [],
        delegationModels: createDelegationModels({
          getSettings: () => settingsStore.getPublic(),
          listModels: async (sourceId, requestSignal) => {
            const resolved = await modelAccess.resolveProvider(
              sourceId,
              undefined,
              requestSignal,
            );
            return resolved.provider.listModels(requestSignal);
          },
        }),
        provider,
        tools,
        projectInstructions: built.instructions,
        ...(input.harness
          ? {
              harnessAdaptation: {
                createProbeTools: () =>
                  buildProbeTools(snapshot.workspace, config.apiKey),
                redact: (text: string) =>
                  redactMemoryText(text, [config.apiKey, config.baseUrl]),
                experiences: {
                  list: async (scope) =>
                    (await getHarnessExperiences()).list(scope),
                  save: async (experience) =>
                    (await getHarnessExperiences()).save(experience),
                },
              },
            }
          : {}),
        onChildOperation: track,
        childContextFactory: async (workspace, childInput, childSignal) => {
          // Delegated model IDs remain exact, even when the parent chose a group.
          const current = await settingsStore.getPublic();
          // Admission already resolved an exact source. Never fall back to the parent's provider.
          const childSourceId = childInput?.providerSourceId;
          const child = await modelAccess.resolveProvider(
            childSourceId,
            undefined,
            childSignal ?? signal,
            childInput?.model,
          );
          return {
            ...(await buildTools(
              workspace,
              current,
              child.config.apiKey,
              child.provider,
              input.uiHost,
            )),
            provider: child.provider,
            ...(childSourceId ? { providerSourceId: childSourceId } : {}),
          };
        },
      }).run(
        {
          ...input,
          ...(providerSourceId ? { providerSourceId } : {}),
          ...(routeGroupId ? { routeGroupId } : {}),
        },
        onEvent,
        approve,
        signal,
        control,
      );
      return result;
    } finally {
      try {
        if (tools) await tools.dispose();
      } finally {
        try {
          await releaseSession?.();
        } finally {
          rootBudget?.close();
          active.delete(input.sessionId);
          const reader = asyncPermissions.get(input.sessionId);
          if (reader) {
            const permission = reader();
            asyncPermissions.set(input.sessionId, () => permission);
          }
        }
      }
    }
  };
};
