import { describe, expect, it } from "vitest";
import { ProviderError } from "../../src/provider/errors";
import {
  ROUTE_USAGE_HALF_LIFE_MS,
  type RouteQuota,
  createRouteState,
  createRoutedProvider,
  decayedServedTokens,
  routeRetryControl,
} from "../../src/provider/routing";
import type { ModelProvider } from "../../src/shared/contracts";
import type {
  ProviderAttempt,
  RouteGroup,
  RouteMember,
} from "../../src/shared/model-access";
import { routeGroupSchema } from "../../src/shared/model-access";
import type {
  Message,
  ProviderResponse,
  ToolDefinition,
} from "../../src/shared/schemas";
import { providerConfigSchema } from "../../src/shared/schemas";
import type { WebSearchProgress } from "../../src/shared/web-search";

const messages: readonly Message[] = [{ role: "user", content: "hi" }];
const imageMessages: readonly Message[] = [
  {
    role: "user",
    content: "look",
    images: [{ name: "shot.png", dataUrl: "data:image/png;base64,AAAA" }],
  },
];
const tools: readonly ToolDefinition[] = [];

const member = (
  sourceId: string,
  model: string,
  extra: Partial<RouteMember> = {},
): RouteMember => ({
  sourceId,
  model,
  ...extra,
});

const answer = (content: string, totalTokens?: number): ProviderResponse => ({
  message: { role: "assistant", content },
  ...(totalTokens === undefined
    ? {}
    : {
        usage: { promptTokens: totalTokens, completionTokens: 0, totalTokens },
      }),
});

const providerOf = (complete: ModelProvider["complete"]): ModelProvider => ({
  listModels: async () => [],
  complete,
});

interface RunOverrides {
  readonly attempt?: number;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly messages?: readonly Message[];
  readonly onWebSearch?: (search: WebSearchProgress) => void;
}

function routed(options: {
  readonly strategy: RouteGroup["strategy"];
  readonly members: readonly RouteMember[];
  readonly providers: readonly ModelProvider[];
  readonly sticky?: boolean;
  readonly exclude?: (
    candidate: RouteMember,
    request: {
      readonly hasImages: boolean;
      readonly hasTools: boolean;
    },
  ) => string | undefined;
  readonly quota?: (candidate: RouteMember) => RouteQuota | undefined;
  readonly now?: () => number;
}) {
  const attempts: ProviderAttempt[] = [];
  const served: RouteMember[] = [];
  const group = routeGroupSchema.parse({
    id: "group-1",
    label: "Primary",
    strategy: options.strategy,
    ...(options.sticky === true ? { sticky: true } : {}),
    members: options.members,
  });
  const provider = createRoutedProvider({
    group,
    state: createRouteState(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.quota === undefined ? {} : { quota: options.quota }),
    resolve: (candidate) => {
      served.push(candidate);
      const index = options.members.findIndex(
        (entry) =>
          entry.sourceId === candidate.sourceId &&
          entry.model === candidate.model &&
          entry.credentialId === candidate.credentialId &&
          (entry.enabled ?? true) === (candidate.enabled ?? true),
      );
      const resolved = index < 0 ? undefined : options.providers[index];
      if (resolved === undefined)
        throw new Error("Fixture has no provider for the member");
      return {
        provider: resolved,
        config: providerConfigSchema.parse({
          baseUrl: "https://example.test/v1",
          apiKey: "sk-test-secret",
          apiMode: "chat-completions",
          requestTimeoutMs: 60_000,
        }),
      };
    },
  });
  const control = routeRetryControl(provider);
  if (control === undefined)
    throw new Error("Routed provider must expose retry control");
  const run = (overrides: RunOverrides = {}) =>
    provider.complete(overrides.messages ?? messages, tools, {
      model: "group-1",
      signal: overrides.signal ?? new AbortController().signal,
      ...(overrides.attempt === undefined
        ? {}
        : { attempt: overrides.attempt }),
      sessionId: overrides.sessionId ?? "session-1",
      ...(overrides.onWebSearch === undefined
        ? {}
        : { onWebSearch: overrides.onWebSearch }),
      onText: () => {},
      onAttempt: (attempt) => attempts.push(attempt),
    });
  return { attempts, control, provider, run, served };
}

describe("routed provider", () => {
  it("sends to the first declared member, records the selection and hides the key", async () => {
    const seen: string[] = [];
    const first = providerOf(async (_messages, _tools, request) => {
      seen.push(request.model);
      return answer("first", 7);
    });
    const second = providerOf(async () => {
      throw new Error("the second member must not be called");
    });
    const fixture = routed({
      strategy: "order",
      members: [member("src-a", "model-a"), member("src-b", "model-b")],
      providers: [first, second],
    });

    const response = await fixture.run();

    expect(response.message.content).toBe("first");
    expect(seen).toEqual(["model-a"]);
    expect(fixture.served.map((candidate) => candidate.sourceId)).toEqual([
      "src-a",
    ]);
    expect(
      fixture.attempts.map((attempt) => [
        attempt.outcome,
        attempt.attempt,
        attempt.reason,
      ]),
    ).toEqual([
      ["started", 0, "order:first"],
      ["succeeded", 0, "order:first"],
    ]);
    expect(fixture.attempts[1]).toMatchObject({
      groupId: "group-1",
      sourceId: "src-a",
      model: "model-a",
      apiMode: "chat-completions",
      usage: { totalTokens: 7 },
    });
    expect(JSON.stringify(fixture.attempts)).not.toContain("sk-test-secret");
  });

  it("binds each member's own source, model and credential exactly", async () => {
    const candidates = [
      member("src-a", "model-a", { credentialId: "cred-1" }),
      member("src-a", "model-a", { credentialId: "cred-2" }),
    ];
    const seen: string[] = [];
    const providers = candidates.map((_candidate, index) =>
      providerOf(async (_messages, _tools, request) => {
        seen.push(request.model);
        return answer(`answer-${index}`);
      }),
    );
    const fixture = routed({
      strategy: "rotate",
      members: candidates,
      providers,
    });

    await fixture.run();
    await fixture.run();

    expect(seen).toEqual(["model-a", "model-a"]);
    expect(fixture.served.map((candidate) => candidate.credentialId)).toEqual([
      "cred-1",
      "cred-2",
    ]);
    expect(
      fixture.attempts
        .filter((attempt) => attempt.outcome === "started")
        .map((attempt) => attempt.credentialId),
    ).toEqual(["cred-1", "cred-2"]);
    expect([...(await fixture.provider.listModels())].sort()).toEqual([
      "model-a",
    ]);
  });

  it("moves to the next member only when the failed request provably never ran", async () => {
    const first = providerOf(async () => {
      throw new ProviderError(
        "network",
        "The provider connection failed.",
        true,
      );
    });
    const second = providerOf(async () => answer("second"));
    const fixture = routed({
      strategy: "order",
      members: [member("src-a", "model-a"), member("src-b", "model-b")],
      providers: [first, second],
    });

    await expect(fixture.run()).rejects.toBeInstanceOf(ProviderError);
    expect(fixture.control.mayRetry("session-1")).toBe(true);
    expect(fixture.attempts.map((attempt) => attempt.outcome)).toEqual([
      "started",
      "failed",
    ]);

    await fixture.run({ attempt: 1 });

    expect(fixture.served.map((candidate) => candidate.sourceId)).toEqual([
      "src-a",
      "src-b",
    ]);
    expect(
      fixture.attempts.map((attempt) => [attempt.outcome, attempt.attempt]),
    ).toEqual([
      ["started", 0],
      ["failed", 0],
      ["started", 1],
      ["succeeded", 1],
    ]);
    const failure = fixture.attempts[1];
    expect(failure).not.toHaveProperty("usage");
    expect(failure?.errorCode).toBe("provider");
  });

  it("refuses to replay an attempt that streamed output or started a hosted search", async () => {
    const streamed = providerOf(async (_messages, _tools, request) => {
      request.onText("half an answer");
      throw new ProviderError("protocol", "Incomplete fixture response.", true);
    });
    const other = providerOf(async () => answer("must not run"));
    const partial = routed({
      strategy: "order",
      members: [member("src-a", "model-a"), member("src-b", "model-b")],
      providers: [streamed, other],
    });

    await expect(partial.run()).rejects.toBeInstanceOf(ProviderError);
    expect(partial.control.mayRetry("session-1")).toBe(false);
    await expect(partial.run({ attempt: 1 })).rejects.toMatchObject({
      code: "provider",
    });
    expect(partial.served).toHaveLength(1);

    const searched = providerOf(async (_messages, _tools, request) => {
      request.onWebSearch?.({ id: "search-1", status: "searching" });
      throw new ProviderError(
        "network",
        "The provider connection failed.",
        true,
      );
    });
    const hosted = routed({
      strategy: "order",
      members: [member("src-a", "model-a"), member("src-b", "model-b")],
      providers: [searched, other],
    });

    await expect(
      hosted.run({ onWebSearch: () => undefined }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(hosted.control.mayRetry("session-1")).toBe(false);
  });

  it("never switches members after cancellation or a request-shaped rejection", async () => {
    const controller = new AbortController();
    const cancelled = providerOf(async () => {
      controller.abort();
      throw new ProviderError(
        "network",
        "The provider connection failed.",
        true,
      );
    });
    const cancelledRoute = routed({
      strategy: "order",
      members: [member("src-a", "model-a"), member("src-b", "model-b")],
      providers: [cancelled, providerOf(async () => answer("second"))],
    });

    await expect(
      cancelledRoute.run({ signal: controller.signal }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(cancelledRoute.control.mayRetry("session-1")).toBe(false);

    const rejected = providerOf(async () => {
      throw new ProviderError(
        "http",
        "The provider rejected the request.",
        false,
        400,
      );
    });
    const rejectedRoute = routed({
      strategy: "order",
      members: [member("src-a", "model-a")],
      providers: [rejected],
    });

    await expect(rejectedRoute.run()).rejects.toBeInstanceOf(ProviderError);
    expect(rejectedRoute.control.mayRetry("session-1")).toBe(false);
  });

  it("keeps a sticky conversation with the member that answered it", async () => {
    let clock = 1_000_000;
    let firstCalls = 0;
    const first = providerOf(async () => {
      firstCalls += 1;
      if (firstCalls === 1)
        throw new ProviderError(
          "network",
          "The provider connection failed.",
          true,
        );
      return answer("first");
    });
    const second = providerOf(async () => answer("second"));
    const fixture = routed({
      strategy: "order",
      sticky: true,
      members: [member("src-a", "model-a"), member("src-b", "model-b")],
      providers: [first, second],
      now: () => clock,
    });

    await expect(fixture.run()).rejects.toBeInstanceOf(ProviderError);
    await fixture.run({ attempt: 1 });
    // Past the failed member's rest, plain order would pick it again.
    clock += 2 * 60_000;
    await fixture.run({ sessionId: "session-1" });
    await fixture.run({ sessionId: "session-2" });

    const started = fixture.attempts.filter(
      (attempt) => attempt.outcome === "started",
    );
    expect(
      started.map((attempt) => [attempt.sourceId, attempt.reason]),
    ).toEqual([
      ["src-a", "order:first"],
      ["src-b", "order:first"],
      ["src-b", "sticky"],
      ["src-a", "order:first"],
    ]);
    // A different conversation has no affinity yet: order picks the rested first member.
    expect(fixture.served.map((candidate) => candidate.sourceId)).toEqual([
      "src-a",
      "src-b",
      "src-b",
      "src-a",
    ]);
  });

  it("rotates fresh requests and skips a member that is resting", async () => {
    const clock = 0;
    const candidates = [
      member("src-a", "model-a"),
      member("src-b", "model-b"),
      member("src-c", "model-c"),
    ];
    const providers = candidates.map((_candidate, index) =>
      providerOf(async () => answer(`answer-${index}`)),
    );
    const fixture = routed({
      strategy: "rotate",
      members: candidates,
      providers,
      now: () => clock,
    });

    await fixture.run();
    await fixture.run();
    await fixture.run();
    await fixture.run();

    expect(fixture.served.map((candidate) => candidate.sourceId)).toEqual([
      "src-a",
      "src-b",
      "src-c",
      "src-a",
    ]);

    const failing = providerOf(async () => {
      throw new ProviderError(
        "http",
        "The provider rate limit was reached.",
        true,
        429,
      );
    });
    const resting = routed({
      strategy: "rotate",
      members: [member("src-a", "model-a"), member("src-b", "model-b")],
      providers: [failing, providerOf(async () => answer("second"))],
      now: () => clock,
    });
    await expect(resting.run({ sessionId: "other" })).rejects.toBeInstanceOf(
      ProviderError,
    );
    // A new conversation must not pay the rate-limited member's rest again.
    await resting.run({ sessionId: "fresh" });
    expect(resting.served.map((candidate) => candidate.sourceId)).toEqual([
      "src-a",
      "src-b",
    ]);

    // When every member is resting, the group still sends instead of failing
    // locally; the least-rested candidate would be the same declared order.
    const allResting = routed({
      strategy: "order",
      members: [member("src-a", "model-a")],
      providers: [failing],
      now: () => clock,
    });
    await expect(allResting.run()).rejects.toBeInstanceOf(ProviderError);
    await expect(allResting.run({ sessionId: "next" })).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(allResting.served.map((candidate) => candidate.sourceId)).toEqual([
      "src-a",
      "src-a",
    ]);
    expect(
      allResting.attempts.filter((attempt) => attempt.outcome === "started")[1],
    ).toMatchObject({
      reason: "order:all-resting",
    });
  });

  it("uses locally served tokens and halves them every half-life", async () => {
    const clock = 1_000_000;
    const candidates = [member("src-a", "model-a"), member("src-b", "model-b")];
    const tokens: Record<string, number> = { "src-a": 1_000, "src-b": 10 };
    const providers = candidates.map((candidate) =>
      providerOf(async () =>
        answer(candidate.sourceId, tokens[candidate.sourceId]),
      ),
    );
    const fixture = routed({
      strategy: "usage",
      members: candidates,
      providers,
      now: () => clock,
    });

    await fixture.run();
    await fixture.run();
    await fixture.run();

    expect(fixture.served.map((candidate) => candidate.sourceId)).toEqual([
      "src-a",
      "src-b",
      "src-b",
    ]);

    const served = {
      started: 1,
      succeeded: 1,
      failed: 0,
      uncertain: 0,
      servedTokens: 1_000,
      servedAt: clock,
      consecutiveFailures: 0,
      restingUntil: 0,
      lastUsedAt: clock,
    };
    expect(decayedServedTokens(served, clock)).toBe(1_000);
    expect(
      decayedServedTokens(served, clock + ROUTE_USAGE_HALF_LIFE_MS),
    ).toBeCloseTo(500);
    expect(
      decayedServedTokens(served, clock + 2 * ROUTE_USAGE_HALF_LIFE_MS),
    ).toBeCloseTo(250);
  });

  it("honours smart and pace only from real quota readings", async () => {
    const candidates = [member("src-a", "model-a"), member("src-b", "model-b")];
    const now = 1_000_000;
    const readings = new Map<
      string,
      { remaining?: number; limit?: number; resetsAt?: number }
    >([
      ["src-a", { remaining: 90, limit: 100, resetsAt: now + 2 * 3_600_000 }],
      ["src-b", { remaining: 50, limit: 100, resetsAt: now + 10 * 3_600_000 }],
    ]);
    const providers = candidates.map((_candidate, index) =>
      providerOf(async () => answer(`answer-${index}`)),
    );

    const smart = routed({
      strategy: "smart",
      members: candidates,
      providers,
      quota: (candidate) => {
        const reading = readings.get(candidate.sourceId);
        return reading === undefined
          ? undefined
          : {
              ...(reading.remaining === undefined
                ? {}
                : { remaining: reading.remaining }),
              ...(reading.limit === undefined ? {} : { limit: reading.limit }),
            };
      },
      now: () => now,
    });
    await smart.run();
    expect(smart.served.map((candidate) => candidate.sourceId)).toEqual([
      "src-a",
    ]);

    const pace = routed({
      strategy: "pace",
      members: candidates,
      providers,
      quota: (candidate) => readings.get(candidate.sourceId),
      now: () => now,
    });
    await pace.run();
    expect(pace.served.map((candidate) => candidate.sourceId)).toEqual([
      "src-a",
    ]);

    const noQuota = routed({
      strategy: "smart",
      members: candidates,
      providers,
    });
    await noQuota.run();
    expect(noQuota.served.map((candidate) => candidate.sourceId)).toEqual([
      "src-a",
    ]);
    expect(noQuota.attempts[0]).toMatchObject({ reason: "smart:no-quota" });

    // Only members with a real reading are scored; a missing reading never
    // becomes an assumed balance.
    const partial = routed({
      strategy: "smart",
      members: candidates,
      providers,
      quota: (candidate) =>
        candidate.sourceId === "src-b"
          ? { remaining: 1, limit: 100 }
          : undefined,
    });
    await partial.run();
    expect(partial.served.map((candidate) => candidate.sourceId)).toEqual([
      "src-b",
    ]);
    expect(partial.attempts[0]).toMatchObject({ reason: "smart:quota" });
  });

  it("excludes only known incompatibility before sending", async () => {
    const candidates = [member("src-a", "model-a"), member("src-b", "model-b")];
    const providers = candidates.map((_candidate, index) =>
      providerOf(async () => answer(`answer-${index}`)),
    );
    const fixture = routed({
      strategy: "order",
      members: candidates,
      providers,
      exclude: (candidate, request) =>
        request.hasImages && candidate.sourceId === "src-a"
          ? "images"
          : undefined,
    });

    await fixture.run({ messages: imageMessages });
    await fixture.run();

    expect(fixture.served.map((candidate) => candidate.sourceId)).toEqual([
      "src-b",
      "src-a",
    ]);
    expect(
      fixture.attempts.filter((attempt) => attempt.outcome === "started"),
    ).toHaveLength(2);
  });

  it("fails before sending when every member is known to be incompatible", async () => {
    const candidates = [member("src-a", "model-a"), member("src-b", "model-b")];
    const calls: string[] = [];
    const providers = candidates.map((candidate) =>
      providerOf(async () => {
        calls.push(candidate.sourceId);
        return answer("never");
      }),
    );
    const fixture = routed({
      strategy: "order",
      members: candidates,
      providers,
      exclude: () => "images",
    });

    await expect(
      fixture.run({ messages: imageMessages }),
    ).rejects.toMatchObject({ code: "provider" });
    expect(calls).toEqual([]);
    expect(fixture.attempts).toEqual([]);
  });
});
