import type { ModelProvider } from "../shared/contracts";
import { ForgeError, isRetryableProviderFailure } from "../shared/errors";
import type {
  ProviderAttempt,
  RouteGroup,
  RouteMember,
} from "../shared/model-access";
import type {
  ProviderConfig,
  ProviderResponse,
  ToolCallPreview,
  Usage,
} from "../shared/schemas";
import type { WebSearchProgress } from "../shared/web-search";

/**
 * Explicit route-group selection, adapted from Magpie's gateway
 * `routing.go`, `fallback.go` and `affinity.go` (see THIRD_PARTY_NOTICES.md).
 * Magpie spreads one provider's requests over every key or account it has,
 * rests one that failed, keeps a conversation on the account that answered
 * it, and only falls to another model while none of the reply has been sent.
 * Forge keeps that shape but only covers what it can observe locally:
 *
 * - `order`, `rotate` and `usage` need no vendor data at all; `usage` counts
 *   what this process actually served, decayed by `ROUTE_USAGE_HALF_LIFE_MS`
 *   like Magpie's one-hour half-life;
 * - `smart` and `pace` are honoured only from real quota readings the caller
 *   passes in. With none, selection falls back to the declared order and the
 *   attempt says so, rather than inventing a balance;
 * - one `complete()` sends at most one upstream request. The runtime owns the
 *   single bounded attempt budget, so a group never multiplies retries;
 * - only a failure that provably never reached the provider hands the next
 *   runtime attempt to another member. Streamed content, a hosted search,
 *   cancellation or a non-retryable rejection ends the turn instead of being
 *   replayed;
 * - a failed attempt reports no usage, so its cost stays unknown instead of
 *   becoming zero;
 * - nothing here groups models by name, overrides a directly selected model,
 *   or records credentials, request bodies or keys.
 */

/** How long served tokens stop counting against a candidate (Magpie's usageHalfLife). */
export const ROUTE_USAGE_HALF_LIFE_MS = 60 * 60_000;
/** Rest taken after a provably unexecuted failure, before a new request may pick it. */
export const ROUTE_REST_MS = {
  /** Magpie rests a rate-limited key a minute, longer each time it fails again. */
  rate: 60_000,
  /** A rate limit that keeps coming back is waited out no longer than this. */
  rateCap: 30 * 60_000,
  /** Out of quota, with no word of when it resets (Magpie quotaRest). */
  quota: 15 * 60_000,
  /** Server, network, timeout or stream framing trouble: Magpie's fallbackCooldown. */
  transport: 60_000,
} as const;

/** What the request itself needs, so a caller can exclude known incompatibility. */
export interface RouteRequest {
  readonly hasImages: boolean;
  readonly hasTools: boolean;
}

/** A reading the caller obtained from the service; absent fields stay unknown. */
export interface RouteQuota {
  readonly remaining?: number | undefined;
  readonly limit?: number | undefined;
  /** Epoch milliseconds the window refills; `pace` needs it and will not guess. */
  readonly resetsAt?: number | undefined;
}

export interface ResolvedRouteMember {
  readonly provider: ModelProvider;
  /** Exact wire ID after the user's explicit alias, never guessed. */
  readonly actualModel?: string | undefined;
  /** Private config; only protocol and credential identifier enter events. */
  readonly config?: ProviderConfig | undefined;
}

export interface RouteCandidateState {
  started: number;
  succeeded: number;
  failed: number;
  uncertain: number;
  /** Decayed served tokens; an answer that reported none still counts as one. */
  servedTokens: number;
  servedAt: number;
  consecutiveFailures: number;
  restingUntil: number;
  lastUsedAt: number;
}

export type RouteAttemptKind =
  | "succeeded"
  | "unexecuted"
  | "uncertain"
  | "cancelled"
  | "rejected";

export interface RouteLastAttempt {
  readonly key: string;
  readonly kind: RouteAttemptKind;
  readonly at: number;
}

export interface RouteState {
  readonly candidates: Map<string, RouteCandidateState>;
  /** sessionId → the member that answered it, for explicit stickiness. */
  readonly sticky: Map<string, string>;
  /** groupId → next rotation cursor. */
  readonly rotate: Map<string, number>;
  readonly last: Map<string, RouteLastAttempt>;
}

export const createRouteState = (): RouteState => ({
  candidates: new Map(),
  sticky: new Map(),
  rotate: new Map(),
  last: new Map(),
});

export interface RouteRetryControl {
  readonly groupId: string;
  /** True only when the last routed request for this session provably never ran. */
  readonly mayRetry: (sessionId?: string) => boolean;
}

export interface RoutedProviderOptions {
  readonly group: RouteGroup;
  /** Exact member binding: the caller resolves source/model/credential, never this module. */
  readonly resolve: (
    member: RouteMember,
    signal: AbortSignal,
  ) => ResolvedRouteMember | Promise<ResolvedRouteMember>;
  readonly state?: RouteState;
  /**
   * Known incompatibility only, applied before sending. `undefined` means the
   * capability is unknown, which keeps the member rather than excluding it.
   */
  readonly exclude?: (
    member: RouteMember,
    request: RouteRequest,
  ) => string | undefined;
  /** Real quota readings for `smart`/`pace`; never inferred or cached here. */
  readonly quota?: (member: RouteMember) => RouteQuota | undefined;
  /** Uniform protocol of every member, when they share one (hosted search needs it). */
  readonly apiMode?: ModelProvider["apiMode"];
  /** Smallest known candidate window; unknown is null, never a guessed limit. */
  readonly contextWindow?: number | null;
  readonly now?: () => number;
}

const memberKey = (member: RouteMember): string =>
  `${member.sourceId}\u0000${member.model}\u0000${member.credentialId ?? ""}`;

const candidateOf = (state: RouteState, key: string): RouteCandidateState => {
  const known = state.candidates.get(key);
  if (known) return known;
  const created: RouteCandidateState = {
    started: 0,
    succeeded: 0,
    failed: 0,
    uncertain: 0,
    servedTokens: 0,
    servedAt: 0,
    consecutiveFailures: 0,
    restingUntil: 0,
    lastUsedAt: 0,
  };
  state.candidates.set(key, created);
  return created;
};

/** Tokens a candidate served, halved every half-life, as Magpie's tokenUse.now. */
export const decayedServedTokens = (
  candidate: RouteCandidateState,
  now: number,
): number =>
  candidate.servedAt > 0
    ? candidate.servedTokens *
      2 ** (-Math.max(0, now - candidate.servedAt) / ROUTE_USAGE_HALF_LIFE_MS)
    : 0;

interface ClassifiedFailure {
  readonly classification?: string | undefined;
  readonly status?: number | undefined;
  readonly reason?: string | undefined;
}

// An empty stream is not proof that the server did nothing: connection loss,
// timeouts and even a 5xx can follow accepted work. Only an explicit capacity
// rejection qualifies for automatic cross-candidate replay.
const wasRejectedBeforeExecution = (error: unknown): boolean => {
  if (!isRetryableProviderFailure(error)) return false;
  const failure = error as ClassifiedFailure;
  return (failure.classification === "http" && failure.status === 429) ||
    (failure.classification === "upstream" && failure.reason === "rate_limit_exceeded");
};
const isCancellation = (error: unknown): boolean =>
  (error instanceof ForgeError && error.code === "cancelled") ||
  (typeof error === "object" &&
    error !== null &&
    (error as ClassifiedFailure).classification === "aborted");

/**
 * How long a candidate sits out after a provably unexecuted failure. Only
 * structured error facts are read: never a vendor body, and never to decide
 * that a request-shaped rejection (400/401/403/404) is the endpoint's fault.
 */
const restAfterFailure = (
  error: unknown,
  consecutiveFailures: number,
): number => {
  if (!(error instanceof ForgeError) || error.code !== "provider") return 0;
  const failure = error as ForgeError & ClassifiedFailure;
  if (failure.reason === "insufficient_quota") return ROUTE_REST_MS.quota;
  if (failure.status === 429 || failure.reason === "rate_limit_exceeded")
    return Math.min(
      ROUTE_REST_MS.rate * 2 ** Math.max(0, consecutiveFailures - 1),
      ROUTE_REST_MS.rateCap,
    );
  if (
    failure.classification === "network" ||
    failure.classification === "timeout"
  )
    return ROUTE_REST_MS.transport;
  if (failure.classification === "protocol") return ROUTE_REST_MS.transport;
  if (
    failure.classification === "http" &&
    failure.status !== undefined &&
    failure.status >= 500
  )
    return ROUTE_REST_MS.transport;
  return 0;
};

interface SelectionInput {
  readonly group: RouteGroup;
  readonly state: RouteState;
  readonly request: RouteRequest;
  readonly attempt: number;
  readonly sessionId: string | undefined;
  readonly now: number;
  readonly exclude: RoutedProviderOptions["exclude"];
  readonly quota: RoutedProviderOptions["quota"];
}

interface Selection {
  readonly member: RouteMember;
  readonly key: string;
  readonly reason: string;
}

const firstMember = (members: readonly RouteMember[]): RouteMember => {
  const [first] = members;
  if (!first)
    throw new ForgeError("provider", "Route group has no eligible member.");
  return first;
};

const quotaShare = (quota: RouteQuota | undefined): number | undefined => {
  if (!quota || quota.remaining === undefined) return undefined;
  if (quota.limit !== undefined && quota.limit > 0)
    return quota.remaining / quota.limit;
  return quota.remaining;
};

/** Share left per hour until the window refills (Magpie's Allowance.Pace). */
const paceScore = (
  quota: RouteQuota | undefined,
  now: number,
): number | undefined => {
  const share = quotaShare(quota);
  if (share === undefined || !quota || quota.resetsAt === undefined)
    return undefined;
  return share / Math.max(1, (quota.resetsAt - now) / 3_600_000);
};

const selectMember = (input: SelectionInput): Selection => {
  const enabled = input.group.members.filter(
    (member) => member.enabled !== false,
  );
  if (enabled.length === 0)
    throw new ForgeError("provider", "Route group has no enabled member.");

  const excluded = new Map<string, string>();
  for (const member of enabled) {
    const reason = input.exclude?.(member, input.request);
    if (reason !== undefined) excluded.set(memberKey(member), reason);
  }
  const capable = enabled.filter((member) => !excluded.has(memberKey(member)));
  if (capable.length === 0) {
    const reasons = [...new Set(excluded.values())].sort().join(", ");
    throw new ForgeError(
      "provider",
      `No route group member can serve this request${reasons === "" ? "" : ` (${reasons})`}.`,
    );
  }

  // A resting member waits at the back of the line (Magpie); when every member
  // is resting the group still sends, rather than inventing a local failure.
  const open = capable.filter(
    (member) =>
      (input.state.candidates.get(memberKey(member))?.restingUntil ?? 0) <=
      input.now,
  );
  const healthy = open.length > 0 ? open : capable;

  // Attempt > 0 means the runtime is retrying; that is only possible when the
  // previous request never ran, and it must not pick the same member again.
  const failedKey =
    input.attempt > 0
      ? input.state.last.get(input.sessionId ?? "")?.key
      : undefined;
  const moved =
    failedKey === undefined
      ? healthy
      : healthy.filter((member) => memberKey(member) !== failedKey);
  const pool = moved.length > 0 ? moved : healthy;

  if (input.group.sticky && input.sessionId !== undefined) {
    const kept = input.state.sticky.get(input.sessionId);
    const sticky = pool.find((member) => memberKey(member) === kept);
    if (sticky)
      return { member: sticky, key: memberKey(sticky), reason: "sticky" };
  }

  switch (input.group.strategy) {
    case "order": {
      const member = firstMember(pool);
      return {
        member,
        key: memberKey(member),
        reason: open.length === 0 ? "order:all-resting" : "order:first",
      };
    }
    case "rotate": {
      const cursor = input.state.rotate.get(input.group.id) ?? 0;
      const member = pool[cursor % pool.length] ?? firstMember(pool);
      // Only a fresh request (not a retry) advances the rotation.
      if (input.attempt === 0)
        input.state.rotate.set(input.group.id, cursor + 1);
      return { member, key: memberKey(member), reason: "rotate" };
    }
    case "usage": {
      let best = firstMember(pool);
      let bestTokens = decayedServedTokens(
        candidateOf(input.state, memberKey(best)),
        input.now,
      );
      for (const member of pool) {
        const tokens = decayedServedTokens(
          candidateOf(input.state, memberKey(member)),
          input.now,
        );
        if (tokens < bestTokens) {
          best = member;
          bestTokens = tokens;
        }
      }
      return { member: best, key: memberKey(best), reason: "usage" };
    }
    case "smart":
    case "pace": {
      const scored: { member: RouteMember; score: number }[] = [];
      for (const member of pool) {
        const reading = input.quota?.(member);
        const score =
          input.group.strategy === "smart"
            ? quotaShare(reading)
            : paceScore(reading, input.now);
        if (score !== undefined) scored.push({ member, score });
      }
      if (scored.length === 0) {
        // No real quota reading: declare the fallback instead of faking one.
        const member = firstMember(pool);
        return {
          member,
          key: memberKey(member),
          reason: `${input.group.strategy}:no-quota`,
        };
      }
      let best = scored[0];
      if (!best)
        throw new ForgeError("provider", "Route group has no eligible member.");
      for (const candidate of scored)
        if (candidate.score > best.score) best = candidate;
      return {
        member: best.member,
        key: memberKey(best.member),
        reason: `${input.group.strategy}:quota`,
      };
    }
  }
};

const attemptUsage = (
  usage: Usage | undefined,
): ProviderAttempt["usage"] | undefined =>
  usage === undefined
    ? undefined
    : {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        ...(usage.cachedPromptTokens === undefined
          ? {}
          : { cachedPromptTokens: usage.cachedPromptTokens }),
      };

/** The runtime asks this before spending another attempt on a routed request. */
export const routeRetryControl = (
  provider: ModelProvider,
): RouteRetryControl | undefined =>
  (provider as ModelProvider & { readonly routeControl?: RouteRetryControl })
    .routeControl;

export function createRoutedProvider(
  options: RoutedProviderOptions,
): ModelProvider & { readonly routeControl: RouteRetryControl } {
  const { group } = options;
  const state = options.state ?? createRouteState();
  const now = options.now ?? (() => Date.now());

  const control: RouteRetryControl = {
    groupId: group.id,
    mayRetry: (sessionId) =>
      state.last.get(sessionId ?? "")?.kind === "unexecuted",
  };

  const complete: ModelProvider["complete"] = async (
    messages,
    toolDefinitions,
    completeOptions,
  ) => {
    const attempt = completeOptions.attempt ?? 0;
    const chain = completeOptions.sessionId ?? "";
    if (attempt > 0 && state.last.get(chain)?.kind !== "unexecuted")
      throw new ForgeError(
        "provider",
        "A routed attempt is only retried when the previous request provably never ran.",
      );

    const request: RouteRequest = {
      hasImages: messages.some(
        (message) =>
          message.role === "user" && (message.images?.length ?? 0) > 0,
      ),
      hasTools: toolDefinitions.length > 0,
    };
    const selection = selectMember({
      group,
      state,
      request,
      attempt,
      sessionId: completeOptions.sessionId,
      now: now(),
      exclude: options.exclude,
      quota: options.quota,
    });
    const { member } = selection;

    let resolved: ResolvedRouteMember;
    try {
      resolved = await options.resolve(member, completeOptions.signal);
    } catch (error) {
      // Nothing was sent, so the runtime may spend its next attempt elsewhere.
      const kind: RouteAttemptKind =
        completeOptions.signal.aborted || isCancellation(error)
          ? "cancelled"
          : "unexecuted";
      state.last.set(chain, { key: selection.key, kind, at: now() });
      throw error;
    }

    const apiMode =
      resolved.config?.apiMode ??
      resolved.provider.apiMode ??
      options.apiMode ??
      "unknown";
    const report = (record: ProviderAttempt): void => {
      try {
        completeOptions.onAttempt?.(record);
      } catch {
        /* Observers never fail a provider request. */
      }
    };
    const record = (
      outcome: ProviderAttempt["outcome"],
      timestamp: string,
      extra: Pick<ProviderAttempt, "usage" | "errorCode"> = {},
    ): ProviderAttempt => ({
      sourceId: member.sourceId,
      model: resolved.actualModel ?? member.model,
      ...(resolved.config ? { reasoningEffort: resolved.config.reasoningEffort ?? "default" } : {}),
      ...((resolved.config?.credentialId ?? member.credentialId) === undefined
        ? {}
        : { credentialId: resolved.config?.credentialId ?? member.credentialId }),
      apiMode,
      groupId: group.id,
      attempt,
      reason: selection.reason,
      outcome,
      timestamp,
      ...(extra.usage === undefined ? {} : { usage: extra.usage }),
      ...(extra.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
    });

    report(record("started", new Date(now()).toISOString()));

    /** Any streamed content makes the attempt's real outcome unknown. */
    let streamed = false;
    let hostedSearch = false;
    let response: ProviderResponse;
    try {
      response = await resolved.provider.complete(messages, toolDefinitions, {
        model: member.model,
        signal: completeOptions.signal,
        ...(completeOptions.attempt === undefined
          ? {}
          : { attempt: completeOptions.attempt }),
        ...(completeOptions.sessionId === undefined
          ? {}
          : { sessionId: completeOptions.sessionId }),
        ...(completeOptions.webSearch === undefined
          ? {}
          : { webSearch: completeOptions.webSearch }),
        ...(completeOptions.onWebSearch === undefined
          ? {}
          : {
              onWebSearch: (search: WebSearchProgress) => {
                hostedSearch = true;
                completeOptions.onWebSearch?.(search);
              },
            }),
        onText: (text: string) => {
          if (text !== "") streamed = true;
          completeOptions.onText(text);
        },
        ...(completeOptions.onReasoning === undefined
          ? {}
          : {
              onReasoning: (text: string) => {
                if (text !== "") streamed = true;
                completeOptions.onReasoning?.(text);
              },
            }),
        ...(completeOptions.onToolCall === undefined
          ? {}
          : {
              onToolCall: (preview: ToolCallPreview) => {
                streamed = true;
                completeOptions.onToolCall?.(preview);
              },
            }),
      });
    } catch (error) {
      const at = now();
      const kind: RouteAttemptKind =
        completeOptions.signal.aborted || isCancellation(error)
          ? "cancelled"
          : streamed || hostedSearch
            ? "uncertain"
            : wasRejectedBeforeExecution(error)
              ? "unexecuted"
              : isRetryableProviderFailure(error) ? "uncertain" : "rejected";
      const candidate = candidateOf(state, selection.key);
      candidate.started += 1;
      if (kind === "unexecuted" || kind === "rejected") candidate.failed += 1;
      if (kind === "uncertain") candidate.uncertain += 1;
      if (kind === "unexecuted") {
        candidate.consecutiveFailures += 1;
        candidate.restingUntil = Math.max(
          candidate.restingUntil,
          at + restAfterFailure(error, candidate.consecutiveFailures),
        );
      }
      state.last.set(chain, { key: selection.key, kind, at });
      report(
        record("failed", new Date(at).toISOString(), {
          errorCode: error instanceof ForgeError ? error.code : undefined,
        }),
      );
      throw error;
    }

    const at = now();
    const candidate = candidateOf(state, selection.key);
    candidate.started += 1;
    candidate.succeeded += 1;
    candidate.consecutiveFailures = 0;
    candidate.restingUntil = 0;
    candidate.lastUsedAt = at;
    // An answer that reported no tokens still counts as one, as in Magpie, so
    // "least used" cannot become a permanent tie between silent candidates.
    candidate.servedTokens =
      decayedServedTokens(candidate, at) +
      Math.max(1, response.usage?.totalTokens ?? 0);
    candidate.servedAt = at;
    if (group.sticky && completeOptions.sessionId !== undefined)
      state.sticky.set(completeOptions.sessionId, selection.key);
    state.last.set(chain, { key: selection.key, kind: "succeeded", at });
    report(
      record("succeeded", new Date(at).toISOString(), {
        usage: attemptUsage(response.usage),
      }),
    );
    return response;
  };

  return {
    ...(options.apiMode === undefined ? {} : { apiMode: options.apiMode }),
    ...(options.contextWindow === undefined ? {} : { getModelContextWindow: async () => options.contextWindow ?? null }),
    // Exact member model ids, in declared order: no network and no aliases.
    listModels: async () => [
      ...new Set(
        group.members
          .filter((member) => member.enabled !== false)
          .map((member) => member.model),
      ),
    ],
    complete,
    routeControl: control,
  };
}
