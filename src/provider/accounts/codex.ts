import {
  claimString,
  decodeJwtClaims,
  generatePkce,
  jwtExpiresAt,
  randomToken,
} from "./crypto";
import { requestJson, serverMessage } from "./http";
import { AccountError } from "./types";
import type {
  AccountCallbackLogin,
  AccountDeviceLogin,
  AccountModel,
  AccountProfile,
  AccountProviderConfig,
  AccountQuota,
  AccountQuotaWindow,
  AccountRequestOptions,
  AccountTokens,
  DevicePollResult,
  LoginCompletion,
} from "./types";

// Codex CLI / ChatGPT account endpoints, matching Magpie's account.go and
// signin.go at pinned commit 2374ffe161439b02a8e7f23b793461b39a635bf8,
// plus Codex CLI's device flow (codex-rs/login/src/device_code_auth.rs).
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`;
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
export const CODEX_DEVICE_USERCODE_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`;
export const CODEX_DEVICE_TOKEN_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/token`;
export const CODEX_DEVICE_VERIFY_URL = `${CODEX_ISSUER}/codex/device`;
export const CODEX_DEVICE_REDIRECT = `${CODEX_ISSUER}/deviceauth/callback`;
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_CLIENT_VERSION = "0.159.0";
export const CODEX_SCOPES =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
export const CODEX_CALLBACK_REDIRECT = "http://localhost:1455/auth/callback";

const TOKEN_REFRESH_TIMEOUT_MS = 30_000;
const EXPIRY_MARGIN_MS = 30_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed > 0 ? Math.trunc(parsed) : undefined;
}

function codexTokens(input: {
  accessToken: string;
  refreshToken: string;
  idToken?: string | undefined;
  previous?: AccountTokens | undefined;
}): { tokens: AccountTokens; profile: AccountProfile } {
  const idClaims = input.idToken ? decodeJwtClaims(input.idToken) : undefined;
  const auth = record(idClaims?.["https://api.openai.com/auth"]);
  const email =
    claimString(idClaims, "email") ??
    claimString(idClaims, "https://api.openai.com/profile", "email");
  if (!email)
    throw new AccountError(
      "invalid-response",
      "ChatGPT didn't say which account signed in.",
    );
  const accountId =
    claimString(auth, "chatgpt_account_id") ?? input.previous?.accountId;
  const plan = claimString(auth, "chatgpt_plan_type");
  const profile: AccountProfile = {
    platform: "codex",
    user: email,
    ...(plan ? { plan } : {}),
    ...(accountId ? { accountId } : {}),
  };
  const expiresAt =
    jwtExpiresAt(input.accessToken) ?? input.previous?.expiresAt;
  const tokens: AccountTokens = {
    platform: "codex",
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    tokenType: "Bearer",
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(accountId ? { accountId } : {}),
    ...(input.previous?.endpoint ? { endpoint: input.previous.endpoint } : {}),
  };
  return { tokens, profile };
}

async function exchangeCodexCode(input: {
  code: string;
  verifier: string;
  redirectUri: string;
  options: AccountRequestOptions;
}): Promise<LoginCompletion> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: CODEX_CLIENT_ID,
    code_verifier: input.verifier,
  });
  const response = await requestJson({
    url: CODEX_TOKEN_URL,
    method: "POST",
    fetch: input.options.fetch,
    signal: input.options.signal,
    timeoutMs: input.options.requestTimeoutMs,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });
  if (response.status !== 200) {
    throw new AccountError(
      response.status === 429 ? "network" : "authorization-denied",
      serverMessage(
        response.body,
        "ChatGPT refused the sign-in; start it again.",
      ),
      response.status,
    );
  }
  const body = record(response.body);
  const accessToken =
    typeof body?.access_token === "string" ? body.access_token : "";
  const refreshToken =
    typeof body?.refresh_token === "string" ? body.refresh_token : "";
  const idToken =
    typeof body?.id_token === "string" ? body.id_token : undefined;
  if (!accessToken || !refreshToken || !idToken) {
    throw new AccountError(
      "invalid-response",
      "ChatGPT sent back no complete token set.",
    );
  }
  return codexTokens({ accessToken, refreshToken, idToken });
}

interface CodexDevicePoll {
  kind: "pending" | "complete";
  completion?: LoginCompletion;
}

async function pollCodexDevice(input: {
  deviceAuthId: string;
  userCode: string;
  options: AccountRequestOptions;
}): Promise<CodexDevicePoll> {
  const response = await requestJson({
    url: CODEX_DEVICE_TOKEN_URL,
    method: "POST",
    fetch: input.options.fetch,
    signal: input.options.signal,
    timeoutMs: input.options.requestTimeoutMs,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      device_auth_id: input.deviceAuthId,
      user_code: input.userCode,
    }),
  });
  if (response.status === 403 || response.status === 404)
    return { kind: "pending" };
  if (response.status === 410) {
    throw new AccountError(
      "device-expired",
      "The device code expired; start the sign-in again.",
    );
  }
  if (response.status !== 200) {
    throw new AccountError(
      "authorization-denied",
      serverMessage(response.body, "ChatGPT refused the device sign-in."),
      response.status,
    );
  }
  const body = record(response.body);
  const code =
    typeof body?.authorization_code === "string" ? body.authorization_code : "";
  const challenge =
    typeof body?.code_challenge === "string" ? body.code_challenge : "";
  const verifier =
    typeof body?.code_verifier === "string" ? body.code_verifier : "";
  if (!code || !challenge || !verifier) {
    throw new AccountError(
      "invalid-response",
      "ChatGPT sent back an incomplete device sign-in.",
    );
  }
  const completion = await exchangeCodexCode({
    code,
    verifier,
    redirectUri: CODEX_DEVICE_REDIRECT,
    options: input.options,
  });
  return { kind: "complete", completion };
}

/**
 * Codex CLI's device flow: the user code is public, while device_auth_id and
 * the polled authorization code stay inside this closure.
 */
export async function startCodexDeviceLogin(
  options: AccountRequestOptions = {},
): Promise<AccountDeviceLogin> {
  const requests = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, requests.signal])
    : requests.signal;
  const response = await requestJson({
    url: CODEX_DEVICE_USERCODE_URL,
    method: "POST",
    fetch: options.fetch,
    signal,
    timeoutMs: options.requestTimeoutMs,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  if (response.status === 404) {
    throw new AccountError(
      "unsupported",
      "ChatGPT device sign-in isn't enabled; use browser sign-in instead.",
      404,
    );
  }
  if (response.status !== 200) {
    throw new AccountError(
      "network",
      serverMessage(
        response.body,
        "ChatGPT couldn't start the device sign-in.",
      ),
      response.status,
    );
  }
  const body = record(response.body);
  const deviceAuthId =
    typeof body?.device_auth_id === "string" ? body.device_auth_id : "";
  const userCode =
    (typeof body?.user_code === "string" && body.user_code) ||
    (typeof body?.usercode === "string" ? body.usercode : "");
  if (!deviceAuthId || !userCode) {
    throw new AccountError(
      "invalid-response",
      "ChatGPT sent back no device code.",
    );
  }
  const intervalSeconds = finiteNumber(body?.interval) ?? 5;
  return {
    mode: "device",
    verificationUrl: CODEX_DEVICE_VERIFY_URL,
    userCode,
    intervalMs: Math.max(0, intervalSeconds * 1000),
    async poll(pollSignal?: AbortSignal): Promise<DevicePollResult> {
      const combined = pollSignal
        ? AbortSignal.any([pollSignal, requests.signal])
        : requests.signal;
      const result = await pollCodexDevice({
        deviceAuthId,
        userCode,
        options: { ...options, signal: combined },
      });
      return result.kind === "complete" && result.completion
        ? { status: "complete", ...result.completion }
        : { status: "pending" };
    },
    cancel() {
      requests.abort();
    },
  };
}

function callbackParams(raw: string, redirectUri: string): URLSearchParams {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AccountError(
      "invalid-callback",
      "Paste the whole address the browser ended on.",
    );
  }
  const expected = new URL(redirectUri);
  let hostname = "";
  try {
    hostname = url.hostname.toLowerCase();
  } catch {
    hostname = "";
  }
  const local =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1";
  if (
    url.protocol !== "http:" ||
    !local ||
    url.port !== expected.port ||
    url.pathname !== expected.pathname ||
    url.username ||
    url.password
  ) {
    throw new AccountError(
      "invalid-callback",
      "That address isn't this sign-in's callback.",
    );
  }
  return url.searchParams;
}

/** Codex's browser PKCE flow, finished by the address its page lands on. */
export async function startCodexCallbackLogin(
  options: AccountRequestOptions & {
    redirectUri?: string;
    randomBytes?: (length: number) => Uint8Array;
  } = {},
): Promise<AccountCallbackLogin> {
  const redirectUri = options.redirectUri ?? CODEX_CALLBACK_REDIRECT;
  const { verifier, challenge } = await generatePkce(options.randomBytes);
  const state = randomToken(24, options.randomBytes);
  const url = new URL(CODEX_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", CODEX_SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("originator", "codex_cli_rs");
  return {
    mode: "callback",
    url: url.toString(),
    state,
    redirectUri,
    async complete(
      callbackUrl: string,
      signal?: AbortSignal,
    ): Promise<LoginCompletion> {
      const params = callbackParams(callbackUrl, redirectUri);
      const error = params.get("error");
      if (error) {
        throw new AccountError(
          "authorization-denied",
          serverMessage(
            params.get("error_description") ?? error,
            "ChatGPT declined the sign-in.",
          ),
        );
      }
      if (params.get("state") !== state) {
        throw new AccountError(
          "state-mismatch",
          "That callback isn't from this sign-in.",
        );
      }
      const code = params.get("code");
      if (!code)
        throw new AccountError(
          "invalid-callback",
          "The callback carried no authorization code.",
        );
      return exchangeCodexCode({
        code,
        verifier,
        redirectUri,
        options: { ...options, signal },
      });
    },
  };
}

/**
 * Renews Codex tokens. OpenAI rotates the refresh token as it answers; once the
 * request is sent it is waited for even if the caller aborts, so a canceled
 * call doesn't leave the store holding a spent refresh token (Magpie's
 * codexRefresh does the same).
 */
export async function refreshCodexTokens(
  tokens: AccountTokens,
  options: AccountRequestOptions = {},
): Promise<AccountTokens> {
  if (tokens.platform !== "codex" || !tokens.refreshToken) {
    throw new AccountError(
      "reauthentication-required",
      "Codex is signed out; sign in again.",
    );
  }
  if (options.signal?.aborted) {
    throw new AccountError(
      "canceled",
      "The token refresh was canceled before it was sent.",
    );
  }
  const response = await requestJson({
    url: CODEX_TOKEN_URL,
    method: "POST",
    fetch: options.fetch,
    timeoutMs: options.requestTimeoutMs ?? TOKEN_REFRESH_TIMEOUT_MS,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      scope: "openid profile email",
    }),
  });
  if (
    response.status === 400 ||
    response.status === 401 ||
    response.status === 403
  ) {
    throw new AccountError(
      "reauthentication-required",
      "Codex sign-in expired; sign in again.",
      response.status,
    );
  }
  if (response.status !== 200) {
    throw new AccountError(
      response.status === 429 ? "network" : "invalid-response",
      serverMessage(
        response.body,
        "OpenAI couldn't refresh the Codex sign-in.",
      ),
      response.status,
    );
  }
  const body = record(response.body);
  const accessToken =
    typeof body?.access_token === "string" ? body.access_token : "";
  const refreshToken =
    typeof body?.refresh_token === "string" && body.refresh_token
      ? body.refresh_token
      : tokens.refreshToken;
  const idToken =
    typeof body?.id_token === "string" ? body.id_token : undefined;
  if (!accessToken) {
    throw new AccountError(
      "invalid-response",
      "OpenAI sent back no Codex access token.",
    );
  }
  return codexTokens({ accessToken, refreshToken, idToken, previous: tokens })
    .tokens;
}

function authorizedCodexHeaders(
  tokens: AccountTokens,
  accept: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${tokens.accessToken}`,
    Accept: accept,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    version: CODEX_CLIENT_VERSION,
    "User-Agent": `codex_cli_rs/${CODEX_CLIENT_VERSION}`,
    ...(tokens.accountId ? { "chatgpt-account-id": tokens.accountId } : {}),
  };
}

function assertUsable(tokens: AccountTokens, now: number): void {
  if (
    tokens.expiresAt !== undefined &&
    tokens.expiresAt <= now + EXPIRY_MARGIN_MS
  ) {
    throw new AccountError(
      "reauthentication-required",
      "Codex sign-in expired; sign in again.",
    );
  }
}

export async function listCodexModels(
  tokens: AccountTokens,
  options: AccountRequestOptions = {},
): Promise<AccountModel[]> {
  const now = options.now?.() ?? Date.now();
  assertUsable(tokens, now);
  const url = `${CODEX_BASE_URL}/models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`;
  const response = await requestJson({
    url,
    fetch: options.fetch,
    signal: options.signal,
    timeoutMs: options.requestTimeoutMs,
    maxBytes: 4 * 1024 * 1024,
    headers: authorizedCodexHeaders(tokens, "application/json"),
  });
  if (response.status === 401 || response.status === 403) {
    throw new AccountError(
      "reauthentication-required",
      "Codex sign-in was refused; sign in again.",
      response.status,
    );
  }
  if (response.status !== 200) {
    throw new AccountError(
      "invalid-response",
      serverMessage(
        response.body,
        "ChatGPT didn't list the account's Codex models.",
      ),
      response.status,
    );
  }
  const models = record(response.body)?.models;
  if (!Array.isArray(models)) {
    throw new AccountError(
      "invalid-response",
      "ChatGPT's model list wasn't readable.",
    );
  }
  const entries = models
    .map((value) => record(value))
    .filter((value): value is Record<string, unknown> => !!value)
    .map((value) => ({ value, priority: finiteNumber(value.priority) ?? 0 }))
    .sort((a, b) => a.priority - b.priority);
  const result: AccountModel[] = [];
  for (const { value } of entries) {
    const id = typeof value.slug === "string" ? value.slug : "";
    if (!id || value.visibility === "hide") continue;
    const inputs = Array.isArray(value.input_modalities)
      ? value.input_modalities.filter(
          (item): item is string => typeof item === "string",
        )
      : undefined;
    const efforts = Array.isArray(value.supported_reasoning_levels)
      ? value.supported_reasoning_levels
          .map((level) => record(level)?.effort)
          .filter(
            (effort): effort is string =>
              typeof effort === "string" && !!effort,
          )
      : [];
    const contextWindow = positiveInteger(value.context_window);
    const maxContextWindow = positiveInteger(value.max_context_window);
    result.push({
      id,
      protocols: ["responses"],
      ...(typeof value.display_name === "string" && value.display_name
        ? { displayName: value.display_name }
        : {}),
      ...(contextWindow !== undefined
        ? { contextWindowTokens: contextWindow }
        : {}),
      ...(maxContextWindow !== undefined &&
      contextWindow !== undefined &&
      maxContextWindow > contextWindow
        ? { maxContextWindowTokens: maxContextWindow }
        : {}),
      ...(efforts.length ? { reasoningEfforts: efforts } : {}),
      ...(inputs ? { inputModalities: inputs } : {}),
      ...(inputs ? { vision: inputs.includes("image") } : {}),
    });
  }
  if (!result.length) {
    throw new AccountError(
      "invalid-response",
      "ChatGPT listed no Codex models for this account.",
    );
  }
  return result;
}

function durationName(seconds: number | undefined): string {
  if (seconds && seconds > 0 && seconds % 86_400 === 0)
    return `${seconds / 86_400} days`;
  if (seconds && seconds > 0 && seconds % 3_600 === 0)
    return `${seconds / 3_600} hours`;
  return "Allowance";
}

function codexWindow(
  id: string,
  value: unknown,
  now: number,
): AccountQuotaWindow | undefined {
  const window = record(value);
  if (!window) return undefined;
  const usedPercent = finiteNumber(window.used_percent);
  const span = positiveInteger(window.limit_window_seconds);
  const resetAt = finiteNumber(window.reset_at);
  const resetAfter = finiteNumber(window.reset_after_seconds);
  const resetMs =
    resetAt !== undefined && resetAt > 0
      ? resetAt * 1000
      : resetAfter !== undefined && resetAfter >= 0
        ? now + resetAfter * 1000
        : null;
  return {
    id,
    name: durationName(span),
    remaining: null,
    limit: null,
    used: null,
    usedPercent:
      usedPercent !== undefined
        ? Math.min(100, Math.max(0, usedPercent))
        : null,
    resetAt: resetMs,
    unlimited: false,
  };
}

export async function readCodexQuota(
  tokens: AccountTokens,
  options: AccountRequestOptions = {},
): Promise<AccountQuota> {
  const now = options.now?.() ?? Date.now();
  const usageBase = CODEX_BASE_URL.replace(/\/codex$/, "");
  const response = await requestJson({
    url: `${usageBase}/wham/usage`,
    fetch: options.fetch,
    signal: options.signal,
    timeoutMs: options.requestTimeoutMs,
    headers: authorizedCodexHeaders(tokens, "application/json"),
  });
  if (response.status === 401 || response.status === 403) {
    throw new AccountError(
      "reauthentication-required",
      "Codex sign-in was refused; sign in again.",
      response.status,
    );
  }
  if (response.status !== 200) {
    throw new AccountError(
      "invalid-response",
      serverMessage(
        response.body,
        "ChatGPT didn't return this account's usage.",
      ),
      response.status,
    );
  }
  const body = record(response.body);
  if (!body)
    throw new AccountError(
      "invalid-response",
      "ChatGPT's usage answer wasn't readable.",
    );
  const rateLimit = record(body.rate_limit);
  const windows: AccountQuotaWindow[] = [];
  const primary = codexWindow("primary", rateLimit?.primary_window, now);
  const secondary = codexWindow("secondary", rateLimit?.secondary_window, now);
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  const credits = record(body.credits);
  if (credits?.has_credits === true) {
    const balance = finiteNumber(credits.balance);
    windows.push({
      id: "credits",
      name: "Credits",
      remaining: credits.unlimited === true ? null : (balance ?? null),
      limit: null,
      used: null,
      usedPercent: null,
      resetAt: null,
      unlimited: credits.unlimited === true,
    });
  }
  const plan =
    typeof body.plan_type === "string" && body.plan_type
      ? body.plan_type
      : undefined;
  return {
    platform: "codex",
    windows,
    updatedAt: now,
    ...(plan ? { plan } : {}),
  };
}

const CODEX_STRIPPED_FIELDS = [
  "max_output_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "previous_response_id",
  "user",
  "safety_identifier",
  "prompt_cache_options",
];

/**
 * The Responses shape Codex CLI sends: streaming only, nothing stored, no
 * sampling knobs or explicit cache options, and encrypted reasoning carried
 * across turns. Codex's own instruction prompt is not injected here; that is
 * a Responses-adapter integration point.
 */
export function prepareCodexBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  let copy: Record<string, unknown>;
  try {
    copy = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  } catch {
    copy = { ...body };
  }
  for (const key of CODEX_STRIPPED_FIELDS) delete copy[key];
  if (copy.service_tier !== "priority" && copy.service_tier !== "ultrafast") {
    // biome-ignore lint/performance/noDelete: the Responses payload must omit the key.
    delete copy.service_tier;
  }
  if (typeof copy.input === "string") {
    copy.input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: copy.input }],
      },
    ];
  }
  const reasoning = record(copy.reasoning);
  if (reasoning) {
    if (reasoning.effort === "ultra") reasoning.effort = "max";
    copy.reasoning = reasoning;
  }
  if (reasoning?.effort === "none") {
    // biome-ignore lint/performance/noDelete: the Responses payload must omit the key.
    delete copy.include;
  } else {
    if (reasoning && reasoning.summary === undefined)
      reasoning.summary = "auto";
    const include = Array.isArray(copy.include)
      ? copy.include.filter((item): item is string => typeof item === "string")
      : [];
    if (!include.includes("reasoning.encrypted_content")) {
      include.push("reasoning.encrypted_content");
    }
    copy.include = include;
  }
  copy.store = false;
  copy.stream = true;
  copy.tool_choice = "auto";
  if (copy.parallel_tool_calls === undefined) copy.parallel_tool_calls = true;
  if (copy.text === undefined) copy.text = { verbosity: "medium" };
  return copy;
}

function codexSessionHeaders(
  body: Record<string, unknown>,
): Record<string, string> {
  const key =
    typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : "";
  return key ? { "session-id": key, "thread-id": key } : {};
}

export async function getCodexProviderConfig(
  tokens: AccountTokens,
  _model?: string,
  options: AccountRequestOptions | AbortSignal = {},
): Promise<AccountProviderConfig> {
  const request =
    options instanceof AbortSignal ? { signal: options } : options;
  const now = request.now?.() ?? Date.now();
  assertUsable(tokens, now);
  return {
    platform: "codex",
    baseUrl: CODEX_BASE_URL,
    apiKey: tokens.accessToken,
    apiMode: "responses",
    protocols: ["responses"],
    headers: {
      Accept: "text/event-stream",
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      version: CODEX_CLIENT_VERSION,
      "User-Agent": `codex_cli_rs/${CODEX_CLIENT_VERSION}`,
      ...(tokens.accountId ? { "chatgpt-account-id": tokens.accountId } : {}),
    },
    extraBody: {
      store: false,
      stream: true,
      tool_choice: "auto",
      parallel_tool_calls: true,
      text: { verbosity: "medium" },
    },
    prepareBody: prepareCodexBody,
    prepareHeaders: codexSessionHeaders,
  };
}
