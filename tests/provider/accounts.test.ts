import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { createAccountService } from "../../src/provider/accounts";
import type {
  AccountFetch,
  AccountTokens,
  SaveLoginInput,
} from "../../src/provider/accounts";
import { AccountError } from "../../src/provider/accounts";
import {
  CODEX_DEVICE_REDIRECT,
  CODEX_DEVICE_VERIFY_URL,
} from "../../src/provider/accounts/codex";
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

function codexTokens(now = NOW): Record<string, string> {
  return {
    access_token: jwt({ exp: Math.floor(now / 1000) + 3600, sub: "user-1" }),
    refresh_token: "refresh-secret-1",
    id_token: jwt({
      email: "dev@example.com",
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "plus",
        chatgpt_account_id: "acct-1",
      },
    }),
  };
}

function form(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

interface FixtureOptions {
  devicePolls?: (count: number) => Response;
  usercode?: () => Response;
  token?: () => Response;
  onTokenRequest?: (init: RequestInit | undefined) => void;
}

function codexFetch(options: FixtureOptions = {}): {
  fetch: AccountFetch;
  counts: { usercode: number; token: number };
} {
  const counts = { usercode: 0, token: 0 };
  const fetch: AccountFetch = async (input, init) => {
    const url = String(input);
    if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
      counts.usercode++;
      return (
        options.usercode?.() ??
        json({
          device_auth_id: "device-auth-secret",
          user_code: "ABCD-1234",
          interval: "0",
        })
      );
    }
    if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
      counts.token++;
      return (
        options.devicePolls?.(counts.token) ??
        json({
          authorization_code: "authorization-code-secret",
          code_challenge: "challenge",
          code_verifier: "verifier-secret",
        })
      );
    }
    if (url === "https://auth.openai.com/oauth/token") {
      options.onTokenRequest?.(init);
      return options.token?.() ?? json(codexTokens());
    }
    if (url === "https://chatgpt.com/backend-api/wham/usage") {
      return json({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 21,
            limit_window_seconds: 18_000,
            reset_at: 1_700_000_500,
          },
        },
      });
    }
    return json({ error: { message: "unexpected fixture URL" } }, 500);
  };
  return { fetch, counts };
}

function service(
  fetch: AccountFetch,
  overrides: Partial<Parameters<typeof createAccountService>[0]> = {},
): {
  service: ReturnType<typeof createAccountService>;
  saveLogin: Mock<(input: SaveLoginInput) => Promise<{ credentialId: string }>>;
} {
  const saveLogin = vi.fn<
    (input: SaveLoginInput) => Promise<{ credentialId: string }>
  >(async (_input) => ({ credentialId: "cred-1" }));
  return {
    service: createAccountService({
      fetch,
      now: () => NOW,
      saveLogin,
      devicePollFloorMs: 0,
      ...overrides,
    }),
    saveLogin,
  };
}

describe("account login service", () => {
  it("completes Codex device sign-in without exposing private token material", async () => {
    const fixture = codexFetch({
      devicePolls: (count) =>
        count === 1
          ? json({}, 403)
          : json({
              authorization_code: "authorization-code-secret",
              code_challenge: "challenge",
              code_verifier: "verifier-secret",
            }),
    });
    let exchange: URLSearchParams | undefined;
    fixture.fetch = (() => {
      const fetch = fixture.fetch;
      return async (input, init) => {
        if (String(input) === "https://auth.openai.com/oauth/token")
          exchange = form(init);
        return fetch(input, init);
      };
    })();
    const { service: accounts, saveLogin } = service(fixture.fetch);

    const started = await accounts.startLogin({
      platform: "codex",
      sourceId: "codex-main",
    });
    expect(started).toMatchObject({
      platform: "codex",
      mode: "device",
      status: "waiting",
      verificationUrl: CODEX_DEVICE_VERIFY_URL,
      userCode: "ABCD-1234",
    });
    expect(JSON.stringify(started)).not.toContain("device-auth-secret");

    expect(await accounts.pollLogin(started.loginId)).toMatchObject({
      status: "waiting",
    });
    const done = await accounts.pollLogin(started.loginId);
    expect(done).toMatchObject({
      status: "done",
      account: {
        platform: "codex",
        user: "dev@example.com",
        plan: "plus",
        accountId: "acct-1",
      },
      credentialId: "cred-1",
    });
    expect(exchange?.get("code")).toBe("authorization-code-secret");
    expect(exchange?.get("code_verifier")).toBe("verifier-secret");
    expect(exchange?.get("redirect_uri")).toBe(CODEX_DEVICE_REDIRECT);
    expect(exchange?.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");

    const saved = saveLogin.mock.calls[0]?.[0];
    expect(saved).toMatchObject({
      platform: "codex",
      sourceId: "codex-main",
      label: "dev@example.com",
      tokens: {
        platform: "codex",
        accessToken: expect.any(String),
        refreshToken: "refresh-secret-1",
      },
    });
    expect(saved?.tokens.accountId).toBe("acct-1");
    expect(saved?.tokens.expiresAt).toBe(
      (Math.floor(NOW / 1000) + 3600) * 1000,
    );

    const serialized = JSON.stringify(done);
    expect(serialized).not.toContain("refresh-secret-1");
    expect(serialized).not.toContain(saved?.tokens.accessToken);
    expect(serialized).not.toContain("authorization-code-secret");
    expect(serialized).not.toContain("verifier-secret");

    // Terminal flows answer idempotently and no longer hit the network.
    const countBefore = fixture.counts.usercode + fixture.counts.token;
    expect(await accounts.pollLogin(started.loginId)).toMatchObject({
      status: "done",
    });
    expect(fixture.counts.usercode + fixture.counts.token).toBe(countBefore);
    expect(accounts.cancelLogin(started.loginId)).toMatchObject({
      status: "done",
    });
  });

  it("cancels an in-flight device poll and never saves its late result", async () => {
    let release: ((response: Response) => void) | undefined;
    let startedPoll: (() => void) | undefined;
    const pollStarted = new Promise<void>((resolve) => {
      startedPoll = resolve;
    });
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetch: AccountFetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/deviceauth/usercode")) {
        return json({
          device_auth_id: "device-secret",
          user_code: "CODE-1",
          interval: "0",
        });
      }
      if (url.endsWith("/deviceauth/token")) {
        startedPoll?.();
        return pending;
      }
      return json(codexTokens());
    };
    const { service: accounts, saveLogin } = service(fetch);
    const started = await accounts.startLogin({
      platform: "codex",
      sourceId: "codex-main",
    });
    const polling = accounts.pollLogin(started.loginId);
    await pollStarted;
    expect(accounts.cancelLogin(started.loginId)).toMatchObject({
      status: "canceled",
    });
    release?.(json({}, 403));
    expect(await polling).toMatchObject({ status: "canceled" });
    expect(saveLogin).not.toHaveBeenCalled();
  });

  it("expires a login without polling and rejects forged callback states", async () => {
    let now = NOW;
    let tokenPolls = 0;
    const fixture = codexFetch({
      devicePolls: () => {
        tokenPolls++;
        return json({}, 403);
      },
    });
    const saveLogin = vi.fn(async () => ({ credentialId: "cred-1" }));
    const accounts = createAccountService({
      fetch: fixture.fetch,
      now: () => now,
      saveLogin,
      devicePollFloorMs: 0,
      loginTtlMs: 1000,
    });
    const device = await accounts.startLogin({
      platform: "codex",
      sourceId: "codex-main",
    });
    now += 1001;
    expect(await accounts.pollLogin(device.loginId)).toMatchObject({
      status: "expired",
      errorCode: "login-expired",
    });
    expect(tokenPolls).toBe(0);

    now = NOW;
    const callback = await accounts.startLogin({
      platform: "codex",
      sourceId: "codex-main",
      mode: "callback",
    });
    const url = new URL(callback.verificationUrl ?? "");
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();
    await expect(
      accounts.completeLogin(
        callback.loginId,
        "http://localhost:1455/auth/callback?code=bad&state=forged",
      ),
    ).rejects.toMatchObject({ code: "state-mismatch" });
    await expect(
      accounts.completeLogin(
        callback.loginId,
        "http://localhost:9999/auth/callback?code=bad&state=forged",
      ),
    ).rejects.toMatchObject({ code: "invalid-callback" });
    expect(await accounts.pollLogin(callback.loginId)).toMatchObject({
      status: "waiting",
    });

    let verifier = "";
    const fetchWithVerifier: AccountFetch = async (input, init) => {
      if (String(input).endsWith("/oauth/token"))
        verifier = form(init).get("code_verifier") ?? "";
      return responseFor(String(input), init);
    };
    async function responseFor(
      requestUrl: string,
      init: RequestInit | undefined,
    ): Promise<Response> {
      if (requestUrl.endsWith("/oauth/token")) return json(codexTokens());
      if (requestUrl.endsWith("/auth/callback")) return json({});
      return fixture.fetch(requestUrl, init);
    }
    const accounts2 = createAccountService({
      fetch: fetchWithVerifier,
      now: () => NOW,
      saveLogin,
      devicePollFloorMs: 0,
    });
    const callback2 = await accounts2.startLogin({
      platform: "codex",
      sourceId: "codex-main",
      mode: "callback",
    });
    const state2 =
      new URL(callback2.verificationUrl ?? "").searchParams.get("state") ?? "";
    const done = await accounts2.completeLogin(
      callback2.loginId,
      `http://localhost:1455/auth/callback?code=code-2&state=${encodeURIComponent(state2)}`,
    );
    expect(done).toMatchObject({
      status: "done",
      account: { user: "dev@example.com" },
    });
    const challenge = new URL(callback2.verificationUrl ?? "").searchParams.get(
      "code_challenge",
    );
    expect(await pkceChallenge(verifier)).toBe(challenge);
  });

  it("marks save failures and upstream errors failed with redacted messages", async () => {
    const fixture = codexFetch({
      devicePolls: (count) =>
        count === 1
          ? json({}, 403)
          : json({
              authorization_code: "authorization-code-secret",
              code_challenge: "challenge",
              code_verifier: "verifier-secret",
            }),
    });
    const saveLogin = vi.fn(async () => {
      throw new Error("couldn't save refresh_token=refresh-secret-9");
    });
    const accounts = createAccountService({
      fetch: fixture.fetch,
      now: () => NOW,
      saveLogin,
      devicePollFloorMs: 0,
    });
    const started = await accounts.startLogin({
      platform: "codex",
      sourceId: "codex-main",
    });
    await accounts.pollLogin(started.loginId);
    const failed = await accounts.pollLogin(started.loginId);
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed.error).toContain("couldn't save");
    expect(failed.error).toContain("[redacted]");
    expect(failed.error).not.toContain("refresh-secret-9");
    expect(JSON.stringify(failed)).not.toContain("refresh-secret-1");
  });

  it("reports device-flow availability and replaces an older login for the same source", async () => {
    let userCodes = 0;
    const fixture = codexFetch({
      usercode: () => {
        userCodes++;
        return json({
          device_auth_id: `device-${userCodes}`,
          user_code: `CODE-${userCodes}`,
          interval: "0",
        });
      },
    });
    const { service: accounts } = service(fixture.fetch);
    const first = await accounts.startLogin({
      platform: "codex",
      sourceId: "codex-main",
    });
    const second = await accounts.startLogin({
      platform: "codex",
      sourceId: "codex-main",
    });
    expect(first.loginId).not.toBe(second.loginId);
    expect(await accounts.pollLogin(first.loginId)).toMatchObject({
      status: "canceled",
    });
    expect(second.userCode).toBe("CODE-2");

    const unavailable = codexFetch({ usercode: () => json({}, 404) });
    const { service: other } = service(unavailable.fetch);
    const failed = await other.startLogin({
      platform: "codex",
      sourceId: "codex-main",
    });
    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "unsupported",
    });

    await expect(accounts.pollLogin("missing")).rejects.toBeInstanceOf(
      AccountError,
    );
    expect(() => accounts.cancelLogin("missing")).toThrow(AccountError);
    await expect(
      accounts.completeLogin(
        second.loginId,
        "http://localhost:1455/auth/callback",
      ),
    ).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("caches quota per credential for the configured TTL", async () => {
    let now = NOW;
    let calls = 0;
    const tokens: AccountTokens = {
      platform: "codex",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: NOW + 3_600_000,
      accountId: "acct-1",
    };
    const fixture = codexFetch();
    const fetch: AccountFetch = async (input, init) => {
      if (String(input).endsWith("/wham/usage")) calls++;
      return fixture.fetch(input, init);
    };
    const accounts = createAccountService({
      fetch,
      now: () => now,
      saveLogin: async () => ({}),
      loadTokens: async () => tokens,
      quotaTtlMs: 60_000,
    });
    const first = await accounts.readQuota("codex-main", "cred-1");
    expect(first).toMatchObject({
      platform: "codex",
      plan: "plus",
      updatedAt: NOW,
      windows: [
        {
          id: "primary",
          name: "5 hours",
          usedPercent: 21,
          resetAt: 1_700_000_500_000,
          remaining: null,
          limit: null,
        },
      ],
    });
    expect(JSON.stringify(first)).not.toContain("access-secret");
    await accounts.readQuota("codex-main", "cred-1");
    expect(calls).toBe(1);
    now += 60_001;
    await accounts.readQuota("codex-main", "cred-1");
    expect(calls).toBe(2);
    await accounts.readQuota("codex-main", "cred-2");
    expect(calls).toBe(3);
  });
});

describe("account service cancellation, disposal and quota freshness", () => {
  it("merges the caller's signal into startLogin and cancels timely", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetch: AccountFetch = async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    };
    const accounts = createAccountService({
      fetch,
      now: () => NOW,
      saveLogin: async () => ({}),
    });
    const aborted = createAccountService({
      fetch,
      now: () => NOW,
      saveLogin: async () => ({}),
    });
    await expect(
      aborted.startLogin({
        platform: "codex",
        sourceId: "codex-main",
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: "canceled" });

    const controller = new AbortController();
    const started = accounts.startLogin({
      platform: "codex",
      sourceId: "codex-main",
      signal: controller.signal,
    });
    expect(requestSignal).toBeDefined();
    controller.abort();
    await expect(started).resolves.toMatchObject({ status: "canceled" });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("waits for an in-flight save before dispose resolves", async () => {
    let release: ((value: { credentialId: string }) => void) | undefined;
    const saveLogin = vi.fn(
      () =>
        new Promise<{ credentialId: string }>((resolve) => {
          release = resolve;
        }),
    );
    const fixture = codexFetch();
    const accounts = createAccountService({
      fetch: fixture.fetch,
      now: () => NOW,
      saveLogin,
      devicePollFloorMs: 0,
    });
    const started = await accounts.startLogin({
      platform: "codex",
      sourceId: "codex-main",
    });
    const polling = accounts.pollLogin(started.loginId);
    await vi.waitFor(() => expect(saveLogin).toHaveBeenCalledTimes(1));

    let disposed = false;
    const disposal = accounts.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    release?.({ credentialId: "cred-late" });
    await disposal;
    expect(disposed).toBe(true);
    expect(await polling).toMatchObject({
      status: "canceled",
      loginId: started.loginId,
    });
    expect(JSON.stringify(await polling)).not.toContain("cred-late");
    await expect(accounts.pollLogin(started.loginId)).rejects.toMatchObject({
      code: "login-not-found",
    });
  });

  it("reloads and validates stored credentials before serving cached quota", async () => {
    let tokens: AccountTokens | undefined = {
      platform: "codex",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: NOW + 3_600_000,
      accountId: "acct-1",
    };
    let reads = 0;
    const fixture = codexFetch();
    const fetch: AccountFetch = async (input, init) => {
      if (String(input).endsWith("/wham/usage")) reads++;
      return fixture.fetch(input, init);
    };
    const accounts = createAccountService({
      fetch,
      now: () => NOW,
      saveLogin: async () => ({}),
      loadTokens: async () => tokens,
      quotaTtlMs: 60_000,
    });
    await accounts.readQuota("codex-main", "cred-1");
    expect(reads).toBe(1);

    tokens = undefined;
    await expect(
      accounts.readQuota("codex-main", "cred-1"),
    ).rejects.toMatchObject({
      code: "reauthentication-required",
    });
    expect(reads).toBe(1);

    tokens = {
      platform: "codex",
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: NOW + 3_600_000,
      accountId: "acct-1",
    };
    await accounts.readQuota("codex-main", "cred-1");
    expect(reads).toBe(2);

    tokens = { ...tokens, expiresAt: NOW - 1 };
    await expect(
      accounts.readQuota("codex-main", "cred-1"),
    ).rejects.toMatchObject({
      code: "reauthentication-required",
    });
    expect(reads).toBe(2);
  });
});
