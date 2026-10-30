import { randomUUID } from "node:crypto";
import { routeRetryControl } from "../provider/routing";
import {
  type ContextBudget,
  budgetUsage,
  measureContext,
  reportedContext,
} from "../shared/context-usage";
import type {
  AgentRuntimeDependencies,
  ApprovalHandler,
} from "../shared/contracts";
import {
  ForgeError,
  isRetryableProviderFailure,
  providerRetryReason,
} from "../shared/errors";
import type { RootRunBudget } from "../shared/run-budget";
import { providerResponseSchema } from "../shared/schemas";
import type {
  ContextUsage,
  Message,
  Permission,
  ProviderResponse,
  RunInput,
  SessionSnapshot,
  ToolDefinition,
} from "../shared/schemas";
import { addUsage } from "../shared/usage-totals";
import { agentAllowsWebSearch } from "./agent-profiles";
import type { createApprovalQueue } from "./approval-queue";
import { withCancellation } from "./cancellation";
import { type RetryStopReason, stoppedProviderRetry } from "./provider-retry";
import { compactContext } from "./runtime-context";
import type { createRunEvents } from "./runtime-events";
import { createGenerationStream } from "./runtime-generation";
import type { createRuntimeJournal } from "./runtime-journal";
import {
  MAX_GENERATION_RETRIES,
  RETRY_DELAYS_MS,
  retryDelay,
} from "./runtime-retry";
import type { LoadedRunState } from "./runtime-state";

type RunEvents = ReturnType<typeof createRunEvents>;

/** Run collaborators used while making one step's provider request. */
export type RunGenerationScope = {
  run: LoadedRunState;
  input: RunInput;
  deps: AgentRuntimeDependencies;
  signal: AbortSignal;
  rootBudget: RootRunBudget;
  approvalQueue: ReturnType<typeof createApprovalQueue>;
  approve: ApprovalHandler;
  check: () => void;
  save: ReturnType<typeof createRuntimeJournal>["save"];
  event: RunEvents["event"];
  ephemeral: RunEvents["ephemeral"];
  finishGeneration: RunEvents["finishGeneration"];
  effectivePermission: () => Permission;
  drainSteering: (final?: boolean) => Promise<boolean>;
  drainAdvisor: (force?: boolean) => Promise<boolean>;
};

/**
 * Decide whether this step may use provider-hosted web search, asking for
 * approval under workspace permission. Throws when the user denies it.
 */
export const resolveHostedSearch = async ({
  run,
  input,
  deps,
  signal,
  approvalQueue,
  approve,
  check,
  save,
  event,
  effectivePermission,
}: RunGenerationScope): Promise<"live" | "disabled"> => {
  // Hosted search is an ordinary Responses capability, not a user setting.
  // Mixed routes advertise whether any candidate may use it; the router
  // omits it for members using other protocols. Permission still applies.
  let webSearch: "live" | "disabled" =
    effectivePermission() !== "readonly" &&
    agentAllowsWebSearch(run.snapshot.agentProfile) &&
    (deps.provider.apiMode === "responses" ||
      deps.provider.mayUseWebSearch === true)
      ? "live"
      : "disabled";
  if (webSearch !== "disabled") {
    if (effectivePermission() === "workspace") {
      const request = {
        id: randomUUID(),
        sessionId: input.sessionId,
        toolCallId: `hosted-search:${run.turns}:${randomUUID()}`,
        toolName: "web_search",
        description:
          "Allow provider-hosted live web search if this request uses Responses? The provider may send generated queries to search services and fetch external pages. Queries can include conversation data and may incur provider charges. Local URL/SSRF rules cannot control this service; individual queries and URLs cannot be approved before execution. No Bing fallback.",
      };
      run.snapshot = { ...run.snapshot, status: "awaiting_approval" };
      event({ type: "state_changed", status: "awaiting_approval" });
      await save();
      let allowed = false;
      try {
        const work = approvalQueue.enqueue(() => {
          check();
          if (effectivePermission() === "readonly") return false;
          event({ type: "approval_requested", request });
          return approve(request, signal);
        });
        allowed = await withCancellation(work, signal);
      } finally {
        run.snapshot = { ...run.snapshot, status: "running" };
        event({ type: "state_changed", status: "running" });
        await save();
      }
      check();
      if (!allowed)
        throw new ForgeError(
          "tool",
          "Provider-hosted web search was denied; no provider request was sent.",
        );
    }
    // Permission can change while approval is pending; never use stale consent.
    if (effectivePermission() === "readonly") webSearch = "disabled";
  }
  return webSearch;
};

/**
 * Send one step's provider request, retrying only bounded transient failures
 * that provably executed nothing, then record context usage and the
 * provider-reported token totals for the step.
 */
export const requestGeneration = async (
  {
    run,
    input,
    deps,
    signal,
    rootBudget,
    check,
    save,
    event,
    ephemeral,
    finishGeneration,
    drainSteering,
    drainAdvisor,
  }: RunGenerationScope,
  {
    webSearch,
    context: initialContext,
    projectedUsage: initialUsage,
    project,
    rawLimit,
    contextSize,
    windowTokens,
    budget,
    definitions,
  }: {
    webSearch: "live" | "disabled";
    context: ReturnType<typeof compactContext>;
    projectedUsage: ContextUsage;
    project: (state: SessionSnapshot) => Message[];
    rawLimit: number;
    contextSize: (messages: readonly Message[]) => number;
    windowTokens: number;
    budget: ContextBudget;
    definitions: readonly ToolDefinition[];
  },
) => {
  let context = initialContext;
  let projectedUsage = initialUsage;
  // One provider request per agent turn. Only requests without hosted
  // search may retry transient failures, without consuming turns or
  // re-running any completed local tool. A route group shares this one
  // budget and may only move to another member while nothing was sent.
  let attempt = 0;
  const routing = routeRetryControl(deps.provider);
  let response: ProviderResponse;
  let previews: ReturnType<typeof createGenerationStream>["previews"];
  for (;;) {
    const generationId = randomUUID();
    const stream = createGenerationStream(
      { generationId, previewPrefix: `${run.turns}:${attempt}` },
      {
        emit: ephemeral,
        retainText: (text) => {
          run.incompleteText += text;
        },
      },
    );
    previews = stream.previews;
    check();
    rootBudget.checkAdmission();
    const attemptStart = run.incompleteText.length;
    try {
      // Inputs can arrive during compaction, approval or retry backoff.
      // Re-project at the actual request boundary, never mutate an in-flight payload.
      const steered = await drainSteering();
      const advised = await drainAdvisor();
      if (steered || advised) {
        context = compactContext(project(run.snapshot), rawLimit, contextSize);
        projectedUsage = {
          ...measureContext(context.messages, windowTokens, definitions),
          ...budgetUsage(budget),
        };
        event({ type: "context_usage", usage: projectedUsage });
      }
      run.generation = {
        id: generationId,
        step: run.activeStep,
        finished: false,
      };
      event({
        type: "generation_started",
        generationId,
        messageIndex: run.snapshot.messages.length,
      });
      response = await withCancellation(
        deps.provider.complete(context.messages, definitions, {
          model: run.snapshot.model,
          signal,
          attempt,
          sessionId: input.sessionId,
          // Bounded, key-free selection record; the group provider owns
          // candidate binding and emits one record per attempt.
          onAttempt: (selection) =>
            event({ type: "provider_attempt", selection }),
          webSearch,
          ...stream.callbacks,
        }),
        signal,
      )
        .then(providerResponseSchema.parse)
        .finally(stream.close);
      // The provider cannot choose the local identity of its saved output.
      response = {
        ...response,
        message: { ...response.message, generationId },
      };
      rootBudget.observeUsage(input.sessionId, response.usage);
      break;
    } catch (error) {
      // Also cover providers that throw synchronously before a promise
      // exists: no timer or late callback may outlive this attempt.
      stream.close();
      rootBudget.observeUsage(input.sessionId, undefined);
      // Never retry cancellation, observer failures, auth rejection or
      // non-provider errors; only bounded transient provider failures.
      if (signal.aborted) throw error;
      // A hosted search may have run/billed without a final frame. Routed
      // members keep their own proof-of-nonexecution gate; do not weaken it.
      const stopped: RetryStopReason | undefined = !isRetryableProviderFailure(
        error,
      )
        ? "non_retryable_failure"
        : webSearch !== "disabled" && routing === undefined
          ? "hosted_search_may_have_executed"
          : attempt >= MAX_GENERATION_RETRIES
            ? "retry_limit_reached"
            : routing !== undefined && !routing.mayRetry(input.sessionId)
              ? "route_execution_uncertain"
              : undefined;
      if (stopped)
        throw stoppedProviderRetry(
          error,
          stopped,
          attempt,
          MAX_GENERATION_RETRIES,
        );
      attempt += 1;
      run.retries += 1;
      run.hadProviderRetries = true;
      // Discard only this attempt's partial draft; prior messages and
      // already-persisted tool evidence stay untouched.
      run.incompleteText = run.incompleteText.slice(0, attemptStart);
      finishGeneration("superseded");
      ephemeral({ type: "retry_reset", generationId });
      event({
        type: "provider_retry",
        attempt,
        maxAttempts: MAX_GENERATION_RETRIES,
        reason: providerRetryReason(error) ?? "protocol",
      });
      await save();
      await retryDelay(RETRY_DELAYS_MS[attempt - 1] ?? 8_000, signal);
    }
  }
  check();
  const incoming = response.usage;
  event({
    type: "context_usage",
    usage: incoming
      ? reportedContext(projectedUsage, incoming, response.message)
      : {
          ...measureContext(
            [...context.messages, response.message],
            windowTokens,
            definitions,
          ),
          ...budgetUsage(budget),
        },
  });
  if (incoming) {
    run.reportedUsageTurns += 1;
    // Learn this run's estimate error from the provider's real input count.
    // Only positive measurements are usable, and the scale only ever grows,
    // so a light turn cannot mask a heavier one later in the same run.
    if (projectedUsage.usedTokens > 0 && incoming.promptTokens > 0)
      run.contextScale = Math.max(
        run.contextScale,
        incoming.promptTokens / projectedUsage.usedTokens,
      );
    // Aggregate only provider-reported cache counts; never invent cached usage.
    run.usage = addUsage(run.usage, incoming);
  }
  return { response, previews };
};
