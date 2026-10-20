import { describe, expect, it, vi } from "vitest";
import {
  AccountError,
  COPILOT_API_BASE,
  COPILOT_CLIENT_ID,
  COPILOT_SESSION_URL,
  COPILOT_USER_URL,
  GITHUB_DEVICE_PAGE,
  GITHUB_DEVICE_URL,
  GITHUB_TOKEN_URL,
  GITHUB_USER_URL,
  getCopilotProviderConfig,
  getCopilotSessionToken,
  listCopilotModels,
  prepareCopilotHeaders,
  readCopilotQuota,
  refreshCopilotTokens,
  startCopilotDeviceLogin,
} from "../../src/provider/accounts";
import type { AccountFetch, AccountTokens } from "../../src/provider/accounts";

const NOW = 1_700_000_000_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function form(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

function header(
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  return (headers as Record<string, string>)[name];
}

function copilotTokens(overrides: Partial<AccountTokens> = {}): AccountTokens {
  return {
    platform: "copilot",
    accessToken: "gho_secret",
    tokenType: "oauth",
    accountId: "octocat",
    endpoint: COPILOT_API_BASE,
    ...overrides,
  };
}

function sessionBody(
  options: { token?: string; expiresAt?: number; api?: string } = {},
): unknown {
  return {
    token: options.token ?? "session-secret",
    expires_at: options.expiresAt ?? Math.floor(NOW / 1000) + 1800,
    endpoints: { api: options.api ?? COPILOT_API_BASE },
  };
}

describe("Copilot device sign-in", () => {
  it("uses GitHub's device grant and keeps the device code private", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let polls = 0;
    const fetch: AccountFetch = async (input, init) => {
      const url = String(input);
      requests.push(init ? { url, init } : { url });
      if (url === GITHUB_DEVICE_URL) {
        return json({
          device_code: "device-code-secret",
          user_code: "ABCD-1234",
          verification_uri: GITHUB_DEVICE_PAGE,
          interval: 0,
          expires_in: 900,
        });
      }
      if (url === GITHUB_TOKEN_URL) {
        polls++;
        if (polls === 1) return json({ error: "authorization_pending" });
        if (polls === 2) return json({ error: "slow_down" });
        return json({ access_token: "gho_secret" });
      }
      if (url === GITHUB_USER_URL) return json({ login: "octocat" });
      if (url === COPILOT_USER_URL) return json({ copilot_plan: "individual" });
      return json({ error: "unexpected fixture URL" }, 500);
    };

    const login = await startCopilotDeviceLogin({ fetch, now: () => NOW });
    expect(login).toMatchObject({
      mode: "device",
      verificationUrl: GITHUB_DEVICE_PAGE,
      userCode: "ABCD-1234",
      intervalMs: 0,
      expiresAt: NOW + 900_000,
    });
    expect(JSON.stringify(login)).not.toContain("device-code-secret");

    expect(await login.poll()).toEqual({ status: "pending" });
    expect(await login.poll()).toEqual({ status: "pending", intervalMs: 5000 });
    const done = await login.poll();
    expect(done.status).toBe("complete");
    if (done.status !== "complete")
      throw new Error("expected a completed device poll");
    expect(done.profile).toEqual({
      platform: "copilot",
      user: "octocat",
      plan: "Pro",
    });
    expect(done.tokens).toEqual({
      platform: "copilot",
      accessToken: "gho_secret",
      tokenType: "oauth",
      accountId: "octocat",
      endpoint: COPILOT_API_BASE,
    });
    expect(JSON.stringify(done)).not.toContain("device-code-secret");

    const start = requests.find((request) => request.url === GITHUB_DEVICE_URL);
    expect(start?.init?.method).toBe("POST");
    expect(header(start?.init, "Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(form(start?.init)).toEqual(
      new URLSearchParams({ client_id: COPILOT_CLIENT_ID, scope: "read:user" }),
    );

    const poll = form(
      requests.find((request) => request.url === GITHUB_TOKEN_URL)?.init,
    );
    expect(poll.get("client_id")).toBe(COPILOT_CLIENT_ID);
    expect(poll.get("device_code")).toBe("device-code-secret");
    expect(poll.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
  });

  it("reports an account without Copilot as no-subscription", async () => {
    const fetch: AccountFetch = async (input) => {
      const url = String(input);
      if (url === GITHUB_DEVICE_URL) {
        return json({ device_code: "device", user_code: "CODE", interval: 0 });
      }
      if (url === GITHUB_TOKEN_URL) return json({ access_token: "gho_secret" });
      if (url === GITHUB_USER_URL) return json({ login: "octocat" });
      if (url === COPILOT_USER_URL) return json({ message: "no seat" }, 404);
      return json({}, 500);
    };
    const login = await startCopilotDeviceLogin({ fetch, now: () => NOW });
    await expect(login.poll()).rejects.toMatchObject({
      code: "no-subscription",
      status: 404,
    });
  });

  it("turns expired and denied device grants into typed errors", async () => {
    const expired: AccountFetch = async (input) => {
      const url = String(input);
      if (url === GITHUB_DEVICE_URL)
        return json({ device_code: "device", user_code: "CODE", interval: 0 });
      return json({ error: "expired_token" });
    };
    const expiredLogin = await startCopilotDeviceLogin({
      fetch: expired,
      now: () => NOW,
    });
    await expect(expiredLogin.poll()).rejects.toMatchObject({
      code: "device-expired",
    });

    const denied: AccountFetch = async (input) => {
      const url = String(input);
      if (url === GITHUB_DEVICE_URL)
        return json({ device_code: "device", user_code: "CODE", interval: 0 });
      return json({ error: "access_denied" });
    };
    const deniedLogin = await startCopilotDeviceLogin({
      fetch: denied,
      now: () => NOW,
    });
    await expect(deniedLogin.poll()).rejects.toMatchObject({
      code: "authorization-denied",
    });
  });
});

describe("Copilot session tokens", () => {
  it("caches the short-lived session token and falls back from an unsafe API base", async () => {
    const cache = new Map();
    let calls = 0;
    const fetch: AccountFetch = async (input, init) => {
      calls++;
      expect(String(input)).toBe(COPILOT_SESSION_URL);
      expect(header(init, "Authorization")).toBe("token gho_secret");
      return json(sessionBody({ api: "http://api.example.com/v1" }));
    };
    const first = await getCopilotSessionToken("gho_secret", {
      fetch,
      now: () => NOW,
      sessionCache: cache,
    });
    expect(first).toMatchObject({
      token: "session-secret",
      apiBase: COPILOT_API_BASE,
    });
    expect(first.expiresAt).toBe((Math.floor(NOW / 1000) + 1800) * 1000);
    const second = await getCopilotSessionToken("gho_secret", {
      fetch,
      now: () => NOW,
      sessionCache: cache,
    });
    expect(second).toBe(first);
    expect(calls).toBe(1);

    const late = NOW + 1_700_000;
    const refreshed = await getCopilotSessionToken("gho_secret", {
      fetch,
      now: () => late,
      sessionCache: cache,
    });
    expect(refreshed).not.toBe(first);
    expect(calls).toBe(2);
  });

  it("treats a refused session exchange as a new sign-in", async () => {
    const fetch: AccountFetch = async () => json({ message: "bad token" }, 401);
    await expect(
      getCopilotSessionToken("gho_secret", {
        fetch,
        now: () => NOW,
        sessionCache: new Map(),
      }),
    ).rejects.toMatchObject({ code: "reauthentication-required", status: 401 });
  });
});

describe("Copilot provider configuration", () => {
  it("uses the session token, editor headers and body-dependent request headers", async () => {
    const cache = new Map();
    const token = "gho_learned";
    const fetch: AccountFetch = async (input) => {
      const url = String(input);
      if (url === COPILOT_SESSION_URL) return json(sessionBody());
      if (url === `${COPILOT_API_BASE}/models`) {
        return json({
          data: [
            {
              id: "gpt-4o",
              name: "GPT-4o",
              vendor: "OpenAI",
              model_picker_enabled: true,
              policy: { state: "enabled" },
              capabilities: {
                type: "chat",
                limits: { max_context_window_tokens: 128000 },
                supports: { reasoning_effort: ["low", "high"], vision: true },
              },
              billing: { is_premium: true },
              supported_endpoints: ["/chat/completions", "/responses"],
            },
          ],
        });
      }
      return json({}, 500);
    };
    const tokens = copilotTokens({ accessToken: token });
    await listCopilotModels(tokens, {
      fetch,
      now: () => NOW,
      sessionCache: cache,
    });
    const config = await getCopilotProviderConfig(tokens, "gpt-4o", {
      fetch,
      now: () => NOW,
      sessionCache: cache,
    });
    expect(config).toMatchObject({
      platform: "copilot",
      baseUrl: COPILOT_API_BASE,
      apiKey: "session-secret",
      apiMode: "responses",
      protocols: ["chat-completions", "responses"],
    });
    expect(config.headers).toMatchObject({
      "Editor-Version": "vscode/1.140.0",
      "Copilot-Integration-Id": "vscode-chat",
      "Openai-Intent": "conversation-panel",
      "X-Initiator": "user",
    });
    expect(
      config.prepareHeaders?.({
        messages: [{ role: "assistant", content: "hi" }],
      }),
    ).toEqual({ "X-Initiator": "agent" });
    expect(
      config.prepareHeaders?.({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://example.com/a.png" },
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      "X-Initiator": "user",
      "Copilot-Vision-Request": "true",
    });
  });

  it("refuses expired tokens and honors an abort before the session exchange", async () => {
    const expired = copilotTokens({ expiresAt: NOW - 1 });
    await expect(
      getCopilotProviderConfig(expired, "gpt-4o", {
        fetch: async () => json({}),
        now: () => NOW,
        sessionCache: new Map(),
      }),
    ).rejects.toMatchObject({ code: "reauthentication-required" });

    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn<AccountFetch>(async () => json(sessionBody()));
    await expect(
      getCopilotProviderConfig(
        copilotTokens({ accessToken: "gho_aborted" }),
        "gpt-4o",
        {
          fetch,
          now: () => NOW,
          sessionCache: new Map(),
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ code: "canceled" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      getCopilotProviderConfig(
        copilotTokens({ accessToken: "gho_aborted_bare" }),
        "gpt-4o",
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ code: "canceled" });
  });

  it("keeps GitHub tokens stable because they do not rotate", async () => {
    const tokens = copilotTokens();
    await expect(
      refreshCopilotTokens(tokens, { now: () => NOW }),
    ).resolves.toBe(tokens);
    await expect(
      refreshCopilotTokens(
        { ...tokens, expiresAt: NOW - 1 },
        { now: () => NOW },
      ),
    ).rejects.toMatchObject({ code: "reauthentication-required" });
  });
});

describe("Copilot models", () => {
  it("lists only chat models with picker metadata and maps their protocols", async () => {
    const cache = new Map();
    const fetch: AccountFetch = async (input, init) => {
      const url = String(input);
      if (url === COPILOT_SESSION_URL) return json(sessionBody());
      if (url === `${COPILOT_API_BASE}/models`) {
        expect(header(init, "Authorization")).toBe("Bearer session-secret");
        expect(header(init, "Editor-Version")).toBe("vscode/1.140.0");
        return json({
          data: [
            {
              id: "gpt-4o",
              name: "GPT-4o",
              vendor: "OpenAI",
              model_picker_enabled: true,
              policy: { state: "enabled" },
              capabilities: {
                type: "chat",
                limits: { max_context_window_tokens: 128000 },
                supports: { reasoning_effort: ["low", "high"], vision: true },
              },
              billing: { is_premium: true },
              supported_endpoints: ["/chat/completions", "/responses"],
            },
            {
              id: "copilot-search",
              capabilities: { type: "chat" },
              model_picker_enabled: true,
            },
            {
              id: "gpt-hidden",
              capabilities: { type: "chat" },
              model_picker_enabled: false,
            },
            {
              id: "text-embedding",
              capabilities: { type: "embedding" },
              model_picker_enabled: true,
            },
            {
              id: "claude-3-5-sonnet",
              vendor: "Anthropic",
              model_picker_enabled: true,
              capabilities: { type: "chat" },
              supported_endpoints: ["/v1/messages"],
            },
          ],
        });
      }
      return json({}, 500);
    };
    const models = await listCopilotModels(
      copilotTokens({ accessToken: "gho_models" }),
      {
        fetch,
        now: () => NOW,
        sessionCache: cache,
      },
    );
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "gpt-4o",
      displayName: "GPT-4o",
      protocols: ["chat-completions", "responses"],
      contextWindowTokens: 128000,
      reasoningEfforts: ["low", "high"],
      vendor: "OpenAI",
      premium: true,
      vision: true,
    });
    expect(models[1]).toMatchObject({
      id: "claude-3-5-sonnet",
      protocols: ["anthropic"],
    });
  });

  it("reports an empty or refused catalog", async () => {
    const cache = new Map();
    const empty: AccountFetch = async (input) => {
      return String(input) === COPILOT_SESSION_URL
        ? json(sessionBody())
        : json({ data: [] });
    };
    await expect(
      listCopilotModels(copilotTokens({ accessToken: "gho_empty" }), {
        fetch: empty,
        now: () => NOW,
        sessionCache: cache,
      }),
    ).rejects.toMatchObject({ code: "invalid-response" });

    const refused: AccountFetch = async (input) => {
      return String(input) === COPILOT_SESSION_URL
        ? json(sessionBody())
        : json({ message: "no" }, 401);
    };
    await expect(
      listCopilotModels(copilotTokens({ accessToken: "gho_refused" }), {
        fetch: refused,
        now: () => NOW,
        sessionCache: new Map(),
      }),
    ).rejects.toMatchObject({ code: "reauthentication-required", status: 401 });
  });
});

describe("Copilot quota", () => {
  it("normalizes plan windows and reset timestamps", async () => {
    let authorization = "";
    const fetch: AccountFetch = async (input, init) => {
      expect(String(input)).toBe(COPILOT_USER_URL);
      authorization = header(init, "Authorization") ?? "";
      expect(header(init, "Editor-Version")).toBe("vscode/1.140.0");
      return json({
        copilot_plan: "individual",
        quota_reset_date_utc: "2026-01-01",
        quota_snapshots: {
          chat: { unlimited: true, quota_reset_at: 1_700_000_000 },
          premium_interactions: {
            unlimited: false,
            entitlement: 300,
            quota_remaining: 75,
            percent_remaining: 25,
            quota_reset_at: 1_700_000_000,
          },
          completions: { unlimited: false, entitlement: 0 },
        },
      });
    };
    const quota = await readCopilotQuota(copilotTokens(), {
      fetch,
      now: () => NOW,
    });
    expect(quota).toMatchObject({
      platform: "copilot",
      plan: "Pro",
      updatedAt: NOW,
    });
    expect(quota.windows).toEqual([
      {
        id: "chat",
        name: "Chat requests",
        remaining: null,
        limit: null,
        used: null,
        usedPercent: null,
        resetAt: 1_700_000_000_000,
        unlimited: true,
      },
      {
        id: "premium_interactions",
        name: "Premium requests",
        remaining: 75,
        limit: 300,
        used: 225,
        usedPercent: 75,
        resetAt: 1_700_000_000_000,
        unlimited: false,
      },
    ]);
    expect(authorization).toBe("token gho_secret");
    expect(JSON.stringify(quota)).not.toContain("gho_secret");
  });

  it("shows an exhausted premium allowance and hides zero entitlements", async () => {
    const fetch: AccountFetch = async () =>
      json({
        copilot_plan: "business",
        quota_snapshots: {
          premium_interactions: { unlimited: true, has_quota: false },
          chat: { unlimited: false, entitlement: 0 },
        },
      });
    const quota = await readCopilotQuota(copilotTokens(), {
      fetch,
      now: () => NOW,
    });
    expect(quota.plan).toBe("Business");
    expect(quota.windows).toEqual([
      {
        id: "premium_interactions",
        name: "Premium requests",
        remaining: 0,
        limit: null,
        used: null,
        usedPercent: 100,
        resetAt: null,
        unlimited: false,
      },
    ]);
  });

  it("maps a missing seat to no-subscription", async () => {
    await expect(
      readCopilotQuota(copilotTokens(), {
        fetch: async () => json({}, 404),
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "no-subscription", status: 404 });
    await expect(
      readCopilotQuota(copilotTokens(), {
        fetch: async () => json([]),
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(AccountError);
  });
});

describe("prepareCopilotHeaders", () => {
  it("marks the initiator and vision requests without exposing the body", () => {
    expect(
      prepareCopilotHeaders({ messages: [{ role: "user", content: "hi" }] }),
    ).toEqual({
      "X-Initiator": "user",
    });
    expect(
      prepareCopilotHeaders({ input: [{ role: "assistant", content: "hi" }] }),
    ).toEqual({
      "X-Initiator": "agent",
    });
    expect(
      prepareCopilotHeaders({
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_image", image_url: "https://example.com/a.png" },
            ],
          },
        ],
      }),
    ).toEqual({ "X-Initiator": "user", "Copilot-Vision-Request": "true" });
  });
});
