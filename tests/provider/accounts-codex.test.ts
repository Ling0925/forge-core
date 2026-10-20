import { describe, expect, it, vi } from "vitest";
import {
  AccountError,
  CODEX_AUTHORIZE_URL,
  CODEX_BASE_URL,
  CODEX_CALLBACK_REDIRECT,
  CODEX_CLIENT_ID,
  CODEX_DEVICE_REDIRECT,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_DEVICE_USERCODE_URL,
  CODEX_DEVICE_VERIFY_URL,
  CODEX_TOKEN_URL,
  getCodexProviderConfig,
  listCodexModels,
  prepareCodexBody,
  readCodexQuota,
  refreshCodexTokens,
  startCodexCallbackLogin,
  startCodexDeviceLogin,
} from "../../src/provider/accounts";
import type { AccountFetch, AccountTokens } from "../../src/provider/accounts";
import { pkceChallenge } from "../../src/provider/accounts/crypto";

const NOW = 1_700_000_000_000;

function base64(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function jwt(claims: Record<string, unknown>): string {
  return `${base64({ alg: "none", typ: "JWT" })}.${base64(claims)}.sig`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenResponse(
  options: {
    expiresInSeconds?: number;
    refreshToken?: string | undefined;
    email?: string;
  } = {},
): Record<string, unknown> {
  const expiresInSeconds = options.expiresInSeconds ?? 3600;
  return {
    access_token: jwt({
      exp: Math.floor(NOW / 1000) + expiresInSeconds,
      sub: "user-1",
    }),
    ...(options.refreshToken === undefined
      ? {}
      : { refresh_token: options.refreshToken }),
    id_token: jwt({
      email: options.email ?? "dev@example.com",
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "plus",
        chatgpt_account_id: "acct-1",
      },
    }),
  };
}

function storedTokens(overrides: Partial<AccountTokens> = {}): AccountTokens {
  return {
    platform: "codex",
    accessToken: jwt({ exp: Math.floor(NOW / 1000) + 3600 }),
    refreshToken: "refresh-1",
    expiresAt: NOW + 3_600_000,
    accountId: "acct-1",
    tokenType: "Bearer",
    ...overrides,
  };
}

function form(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

function jsonBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function header(
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  return (headers as Record<string, string>)[name];
}

describe("Codex device sign-in", () => {
  it("polls with the device id kept private and exchanges the code as a form", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let polls = 0;
    const fetch: AccountFetch = async (input, init) => {
      const url = String(input);
      requests.push(init ? { url, init } : { url });
      if (url === CODEX_DEVICE_USERCODE_URL) {
        return json({
          device_auth_id: "device-auth-secret",
          user_code: "ABCD-1234",
          interval: "0",
        });
      }
      if (url === CODEX_DEVICE_TOKEN_URL) {
        polls++;
        return polls === 1
          ? json({}, 403)
          : json({
              authorization_code: "authorization-code-secret",
              code_challenge: "challenge",
              code_verifier: "verifier-secret",
            });
      }
      if (url === CODEX_TOKEN_URL)
        return json(tokenResponse({ refreshToken: "refresh-1" }));
      return json({ error: "unexpected fixture URL" }, 500);
    };

    const login = await startCodexDeviceLogin({ fetch, now: () => NOW });
    expect(login).toMatchObject({
      mode: "device",
      verificationUrl: CODEX_DEVICE_VERIFY_URL,
      userCode: "ABCD-1234",
      intervalMs: 0,
    });
    expect(JSON.stringify(login)).not.toContain("device-auth-secret");

    expect(await login.poll()).toEqual({ status: "pending" });
    const done = await login.poll();
    expect(done.status).toBe("complete");
    if (done.status !== "complete")
      throw new Error("expected a completed device poll");
    expect(done.profile).toMatchObject({
      platform: "codex",
      user: "dev@example.com",
      plan: "plus",
      accountId: "acct-1",
    });
    expect(done.tokens).toMatchObject({
      platform: "codex",
      refreshToken: "refresh-1",
      accountId: "acct-1",
      tokenType: "Bearer",
    });
    expect(JSON.stringify(done)).not.toContain("device-auth-secret");
    expect(JSON.stringify(done)).not.toContain("authorization-code-secret");

    const usercode = requests.find(
      (request) => request.url === CODEX_DEVICE_USERCODE_URL,
    );
    expect(usercode?.init?.method).toBe("POST");
    expect(header(usercode?.init, "Content-Type")).toBe("application/json");
    expect(jsonBody(usercode?.init)).toEqual({ client_id: CODEX_CLIENT_ID });

    const tokenRequest = requests.find(
      (request) => request.url === CODEX_TOKEN_URL,
    );
    const exchange = form(tokenRequest?.init);
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("authorization-code-secret");
    expect(exchange.get("code_verifier")).toBe("verifier-secret");
    expect(exchange.get("redirect_uri")).toBe(CODEX_DEVICE_REDIRECT);
    expect(exchange.get("client_id")).toBe(CODEX_CLIENT_ID);
  });

  it("reports a server without device sign-in as unsupported", async () => {
    const fetch: AccountFetch = async () => json({ error: "not found" }, 404);
    await expect(startCodexDeviceLogin({ fetch })).rejects.toMatchObject({
      code: "unsupported",
      status: 404,
    });
  });

  it("times out a device handshake without leaking the server message", async () => {
    const fetch: AccountFetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("access_token=timed-out-secret")),
          { once: true },
        );
      });
    await expect(
      startCodexDeviceLogin({ fetch, requestTimeoutMs: 10 }),
    ).rejects.toMatchObject({
      code: "network",
      message: "The account service did not answer in time.",
    });
  });
});

describe("Codex callback sign-in", () => {
  it("builds a PKCE URL and rejects forged, foreign and denied callbacks", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch: AccountFetch = async (input, init) => {
      requests.push(
        init ? { url: String(input), init } : { url: String(input) },
      );
      return json(tokenResponse({ refreshToken: "refresh-1" }));
    };
    const login = await startCodexCallbackLogin({ fetch, now: () => NOW });
    const url = new URL(login.url);
    expect(`${url.origin}${url.pathname}`).toBe(CODEX_AUTHORIZE_URL);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CODEX_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(CODEX_CALLBACK_REDIRECT);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("state")).toBe(login.state);

    await expect(
      login.complete(
        `${CODEX_CALLBACK_REDIRECT}?code=forged&state=not-this-state`,
      ),
    ).rejects.toMatchObject({ code: "state-mismatch" });
    await expect(
      login.complete(
        `http://127.0.0.1:9999/auth/callback?code=x&state=${login.state}`,
      ),
    ).rejects.toMatchObject({ code: "invalid-callback" });
    await expect(
      login.complete(
        `${CODEX_CALLBACK_REDIRECT}?error=access_denied&error_description=no%20access&state=${login.state}`,
      ),
    ).rejects.toMatchObject({ code: "authorization-denied" });

    const done = await login.complete(
      `${CODEX_CALLBACK_REDIRECT}?code=authorization-code-2&state=${encodeURIComponent(login.state)}`,
    );
    expect(done.profile.user).toBe("dev@example.com");
    const exchange = form(requests.at(-1)?.init);
    expect(exchange.get("code")).toBe("authorization-code-2");
    expect(exchange.get("redirect_uri")).toBe(CODEX_CALLBACK_REDIRECT);
    expect(await pkceChallenge(exchange.get("code_verifier") ?? "")).toBe(
      url.searchParams.get("code_challenge"),
    );
  });

  it("does not exchange a callback after cancellation", async () => {
    const fetch = vi.fn<AccountFetch>(async () => json(tokenResponse()));
    const login = await startCodexCallbackLogin({ fetch });
    const controller = new AbortController();
    controller.abort();
    await expect(
      login.complete(
        `${CODEX_CALLBACK_REDIRECT}?code=x&state=${login.state}`,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "canceled" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Codex token refresh", () => {
  it("posts the documented refresh grant and rotates the refresh token", async () => {
    const seen: Record<string, unknown>[] = [];
    const fetch: AccountFetch = async (_input, init) => {
      seen.push(jsonBody(init));
      return json(
        tokenResponse({ expiresInSeconds: 7200, refreshToken: "refresh-2" }),
      );
    };
    const refreshed = await refreshCodexTokens(storedTokens(), {
      fetch,
      now: () => NOW,
    });
    expect(refreshed.accessToken).not.toBe(storedTokens().accessToken);
    expect(refreshed.refreshToken).toBe("refresh-2");
    expect(refreshed.expiresAt).toBe((Math.floor(NOW / 1000) + 7200) * 1000);
    expect(seen[0]).toEqual({
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      scope: "openid profile email",
    });
  });

  it("keeps the previous refresh token when the answer omits it", async () => {
    const fetch: AccountFetch = async () =>
      json(tokenResponse({ expiresInSeconds: 7200, refreshToken: undefined }));
    const refreshed = await refreshCodexTokens(storedTokens(), {
      fetch,
      now: () => NOW,
    });
    expect(refreshed.refreshToken).toBe("refresh-1");
    expect(refreshed.accountId).toBe("acct-1");
  });

  it("asks for a new sign-in when OpenAI rejects the grant", async () => {
    const fetch: AccountFetch = async () =>
      json({ error: "invalid_grant" }, 400);
    await expect(
      refreshCodexTokens(storedTokens(), { fetch }),
    ).rejects.toMatchObject({
      code: "reauthentication-required",
      status: 400,
    });
  });

  it("does not send after cancellation but waits for a sent rotation", async () => {
    const never = vi.fn<AccountFetch>(async () => json({}));
    await expect(
      refreshCodexTokens(storedTokens(), {
        fetch: never,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: "canceled" });
    expect(never).not.toHaveBeenCalled();

    let release: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn<AccountFetch>(() => pending);
    const controller = new AbortController();
    const refreshing = refreshCodexTokens(storedTokens(), {
      fetch,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    release?.(
      json(
        tokenResponse({ expiresInSeconds: 7200, refreshToken: "refresh-2" }),
      ),
    );
    await expect(refreshing).resolves.toMatchObject({
      platform: "codex",
      refreshToken: "refresh-2",
    });
  });
});

describe("Codex provider configuration", () => {
  it("returns the Responses endpoint, account headers and body rewrite", async () => {
    const tokens = storedTokens();
    const config = await getCodexProviderConfig(tokens, "gpt-5-codex", {
      now: () => NOW,
    });
    expect(config).toMatchObject({
      platform: "codex",
      baseUrl: CODEX_BASE_URL,
      apiMode: "responses",
      protocols: ["responses"],
    });
    expect(config.apiKey).toBe(tokens.accessToken);
    expect(config.headers).toMatchObject({
      Accept: "text/event-stream",
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      "chatgpt-account-id": "acct-1",
    });
    expect(config.extraBody).toMatchObject({
      store: false,
      stream: true,
      tool_choice: "auto",
      parallel_tool_calls: true,
      text: { verbosity: "medium" },
    });

    const prepare = config.prepareBody;
    expect(prepare).toBeDefined();
    if (!prepare) throw new Error("expected a Codex body transform");
    const prepared = prepare({
      model: "gpt-5-codex",
      input: "hello",
      temperature: 0.2,
      max_output_tokens: 10,
      previous_response_id: "resp-1",
      store: true,
      service_tier: "default",
      reasoning: { effort: "ultra" },
    });
    expect(prepared.temperature).toBeUndefined();
    expect(prepared.max_output_tokens).toBeUndefined();
    expect(prepared.previous_response_id).toBeUndefined();
    expect(prepared.service_tier).toBeUndefined();
    expect(prepared.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ]);
    expect(prepared.reasoning).toEqual({ effort: "max", summary: "auto" });
    expect(prepared.include).toContain("reasoning.encrypted_content");
    expect(prepared.store).toBe(false);
    expect(prepared.stream).toBe(true);
    expect(config.prepareHeaders?.({ prompt_cache_key: "thread-1" })).toEqual({
      "session-id": "thread-1",
      "thread-id": "thread-1",
    });

    const noReasoning = prepareCodexBody({
      input: [],
      reasoning: { effort: "none" },
      include: ["x"],
    });
    expect(noReasoning.include).toBeUndefined();
    expect(
      prepareCodexBody({ input: [], service_tier: "priority" }).service_tier,
    ).toBe("priority");
  });

  it("refuses an expired access token before making a request", async () => {
    const expired = storedTokens({ expiresAt: NOW - 1 });
    await expect(
      getCodexProviderConfig(expired, "gpt-5-codex", { now: () => NOW }),
    ).rejects.toMatchObject({
      code: "reauthentication-required",
    });
  });
});

describe("Codex models and usage", () => {
  it("maps the account catalog and sends the account id", async () => {
    let authorization = "";
    let account = "";
    const fetch: AccountFetch = async (_input, init) => {
      authorization = header(init, "Authorization") ?? "";
      account = header(init, "chatgpt-account-id") ?? "";
      return json({
        models: [
          {
            slug: "gpt-5-codex",
            display_name: "GPT-5 Codex",
            priority: 0,
            context_window: 272000,
            max_context_window: 400000,
            input_modalities: ["text", "image"],
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
          },
          { slug: "hidden-model", priority: 1, visibility: "hide" },
          { slug: "gpt-5", priority: 2, context_window: "400000" },
        ],
      });
    };
    const models = await listCodexModels(storedTokens(), {
      fetch,
      now: () => NOW,
    });
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "gpt-5-codex",
      displayName: "GPT-5 Codex",
      protocols: ["responses"],
      contextWindowTokens: 272000,
      maxContextWindowTokens: 400000,
      reasoningEfforts: ["low", "high"],
      vision: true,
    });
    expect(models[1]).toMatchObject({ id: "gpt-5", protocols: ["responses"] });
    expect(models.some((model) => model.id === "hidden-model")).toBe(false);
    expect(authorization).toBe(`Bearer ${storedTokens().accessToken}`);
    expect(account).toBe("acct-1");
  });

  it("rejects an unusable token or a refused model list", async () => {
    const fetch = vi.fn<AccountFetch>(async () => json({ models: [] }));
    await expect(
      listCodexModels(storedTokens({ expiresAt: NOW - 1 }), {
        fetch,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "reauthentication-required" });
    expect(fetch).not.toHaveBeenCalled();

    await expect(
      listCodexModels(storedTokens(), {
        fetch: async () => json({}, 401),
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "reauthentication-required", status: 401 });
  });

  it("normalizes usage windows and credits without leaking the token", async () => {
    let authorization = "";
    const fetch: AccountFetch = async (_input, init) => {
      authorization = header(init, "Authorization") ?? "";
      return json({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 21,
            limit_window_seconds: 18000,
            reset_at: 1_700_000_500,
          },
          secondary_window: {
            used_percent: 110,
            limit_window_seconds: 604800,
            reset_after_seconds: 60,
          },
        },
        credits: { has_credits: true, unlimited: false, balance: 12.5 },
      });
    };
    const quota = await readCodexQuota(storedTokens(), {
      fetch,
      now: () => NOW,
    });
    expect(quota).toMatchObject({
      platform: "codex",
      plan: "plus",
      updatedAt: NOW,
    });
    expect(quota.windows).toEqual([
      {
        id: "primary",
        name: "5 hours",
        remaining: null,
        limit: null,
        used: null,
        usedPercent: 21,
        resetAt: 1_700_000_500_000,
        unlimited: false,
      },
      {
        id: "secondary",
        name: "7 days",
        remaining: null,
        limit: null,
        used: null,
        usedPercent: 100,
        resetAt: NOW + 60_000,
        unlimited: false,
      },
      {
        id: "credits",
        name: "Credits",
        remaining: 12.5,
        limit: null,
        used: null,
        usedPercent: null,
        resetAt: null,
        unlimited: false,
      },
    ]);
    expect(authorization).toBe(`Bearer ${storedTokens().accessToken}`);
    expect(JSON.stringify(quota)).not.toContain(storedTokens().accessToken);
  });

  it("reports refused or unreadable usage answers", async () => {
    await expect(
      readCodexQuota(storedTokens(), { fetch: async () => json({}, 403) }),
    ).rejects.toMatchObject({ code: "reauthentication-required", status: 403 });
    await expect(
      readCodexQuota(storedTokens(), { fetch: async () => json([]) }),
    ).rejects.toBeInstanceOf(AccountError);
  });
});
