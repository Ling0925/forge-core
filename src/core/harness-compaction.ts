import type { createRouteState } from "../provider/routing";
import {
  budgetUsage,
  measureContext,
  resolveContextBudget,
  resolveContextWindow,
} from "../shared/context-usage";
import type { SessionId, SessionSnapshot } from "../shared/schemas";
import type { openSettingsStore } from "../store/settings";
import { withCancellation } from "./cancellation";
import { projectSummary } from "./context";
import {
  findRouteGroup,
  selectRouteGroup,
  selectSessionSource,
} from "./harness-provider-selection";
import { routedProviderFor } from "./harness-route-provider";
import type { createModelAccessService } from "./model-access";
import { summarizeWorkingState } from "./working-memory";

export type HarnessCompactionDeps = {
  settingsStore: Awaited<ReturnType<typeof openSettingsStore>>;
  modelAccess: ReturnType<typeof createModelAccessService>;
  /** The harness-wide route state shared with runs. */
  routeState: ReturnType<typeof createRouteState>;
};

/**
 * Manual compaction of one locked session: summarize working state into 80%
 * of the model window and record compaction plus projected context usage.
 */
export const compactSessionSnapshot = async (
  { settingsStore, modelAccess, routeState }: HarnessCompactionDeps,
  id: SessionId,
  s: SessionSnapshot,
  signal: AbortSignal,
): Promise<SessionSnapshot> => {
  const settings = await settingsStore.getPublic();
  // Compaction names no model or source, so the session's own binding (or
  // the remembered fallback) decides, exactly as for an input-less run.
  const { providerSourceId, routeGroupId } = selectSessionSource(settings, s);
  // Like a run: an explicit group, or a credential rotation group for a
  // direct source with several enabled credentials, goes through the route.
  const selectedGroup = selectRouteGroup(
    settings,
    providerSourceId,
    s.model,
    findRouteGroup(settings, routeGroupId),
  );
  const prepared = selectedGroup
    ? await modelAccess.prepareRoute(selectedGroup, signal)
    : undefined;
  const resolved =
    prepared?.base ??
    (await modelAccess.resolveProvider(
      providerSourceId,
      undefined,
      signal,
      s.model,
    ));
  const provider =
    selectedGroup && prepared
      ? routedProviderFor({
          group: selectedGroup,
          prepared,
          routeState,
          modelAccess,
        }).auxiliary(id)
      : resolved.provider;
  const bound =
    providerSourceId && providerSourceId !== s.providerSourceId
      ? { ...s, providerSourceId }
      : s;
  let reported: number | null = prepared?.contextWindow ?? null;
  const metadataSignal = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
  try {
    reported ??= await withCancellation(
      resolved.provider.getModelContextWindow?.(
        resolved.actualModel ?? s.model,
        metadataSignal,
      ) ?? Promise.resolve(null),
      metadataSignal,
    );
  } catch {
    /* Optional metadata must not prevent compaction. */
  }
  const window = resolveContextWindow(s.model, settings, reported);
  const next = await summarizeWorkingState(
    bound,
    provider,
    signal,
    s.messages.length,
    Math.floor(window * 0.8),
  );
  const last = s.events.at(-1);
  // Also repair the stale meter on sessions compacted by older versions.
  if (
    next === s &&
    last?.type === "context_usage" &&
    last.usage.basis === "projected"
  )
    return s;
  const before = projectSummary(s);
  const after = projectSummary(next);
  const usage = measureContext(after, window);
  // Retain the last known tool-definition overhead without opening tool/MCP
  // services just to render an estimate. Tool results themselves are compacted.
  const previous = s.events.findLast(
    (event) =>
      event.type === "context_usage" && event.usage.basis === "projected",
  );
  const toolOverhead =
    previous?.type === "context_usage"
      ? Math.max(
          0,
          previous.usage.parts.tools -
            measureContext(before, window).parts.tools,
        )
      : 0;
  const timestamp = new Date().toISOString();
  return {
    ...next,
    updatedAt: timestamp,
    events: [
      ...next.events,
      {
        type: "context_compacted",
        sessionId: id,
        timestamp,
        removedMessages: Math.max(0, before.length - after.length),
        beforeChars: JSON.stringify(before).length,
        afterChars: JSON.stringify(after).length,
      },
      {
        type: "context_usage",
        sessionId: id,
        timestamp,
        usage: {
          ...usage,
          ...budgetUsage(resolveContextBudget(window, settings)),
          usedTokens: usage.usedTokens + toolOverhead,
          parts: {
            ...usage.parts,
            tools: usage.parts.tools + toolOverhead,
          },
        },
      },
    ],
  };
};
