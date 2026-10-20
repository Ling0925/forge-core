import { requestJson, serverMessage } from "./http";
import { AccountError } from "./types";
import type {
  AccountDeviceLogin,
  AccountModel,
  AccountProfile,
  AccountProviderConfig,
  AccountProviderConfigOptions,
  AccountQuota,
  AccountQuotaWindow,
  AccountRequestOptions,
  AccountTokens,
  CopilotSessionToken,
  DevicePollResult,
  LoginCompletion,
  ProviderProtocol,
} from "./types";

// GitHub Copilot's editor OAuth app and endpoints, matching Magpie's
// copilot_signin.go / account.go / copilot_ghe.go (github.com only).
export const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const GITHUB_DEVICE_URL = "https://github.com/login/device/code";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_DEVICE_PAGE = "https://github.com/login/device";
export const GITHUB_USER_URL = "https://api.github.com/user";
export const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";
export const COPILOT_SESSION_URL =
  "https://api.github.com/copilot_internal/v2/token";
export const COPILOT_API_BASE = "https://api.githubcopilot.com";

const EDITOR_HEADERS: Readonly<Record<string, string>> = {
  "Editor-Version": "vscode/1.140.0",
  "Editor-Plugin-Version": "copilot-chat/0.68.0",
  "Copilot-Integration-Id": "vscode-chat",
  "User-Agent": "GitHubCopilotChat/0.68.0",
  "X-GitHub-Api-Version": "2026-01-09",
};

const INTERNAL_MODEL =
  /^(copilot-search|exec-agent|trajectory)|-(secondary|tertiary|4th|free-auto)$/;
const COPILOT_PLANS: Readonly<Record<string, string>> = {
  free: "Free",
  individual: "Pro",
  individual_pro: "Pro+",
  individual_max: "Max",
  individual_edu: "Education",
  business: "Business",
  enterprise: "Enterprise",
};

// Protocols learned from the last /models answer, by GitHub token and model.
const learnedProtocols = new Map<string, Map<string, ProviderProtocol[]>>();
// Copilot session tokens, by GitHub token. They are never persisted or logged.
const defaultSessionCache = new Map<string, CopilotSessionToken>();

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

function unixMs(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  if (parsed === undefined || parsed <= 0) return undefined;
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function formBody(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: "application/json",
  };
}

function editorHeaders(): Record<string, string> {
  return { ...EDITOR_HEADERS };
}

function sessionHeaders(token: string): Record<string, string> {
  return {
    ...EDITOR_HEADERS,
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

export function copilotPlanLabel(plan: unknown, accessSku?: unknown): string {
  if (accessSku === "free_educational_quota") return "Education";
  if (accessSku === "free_limited_copilot") return "Free";
  if (typeof plan !== "string" || !plan) return "";
  const known = COPILOT_PLANS[plan.toLowerCase()];
  if (known) return known;
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

interface CopilotIdentity {
  user: string;
  plan: string;
}

async function copilotIdentity(
  token: string,
  options: AccountRequestOptions,
): Promise<CopilotIdentity> {
  const userResponse = await requestJson({
    url: GITHUB_USER_URL,
    fetch: options.fetch,
    signal: options.signal,
    timeoutMs: options.requestTimeoutMs,
    headers: githubHeaders(token),
  });
  const userBody = record(userResponse.body);
  const login = typeof userBody?.login === "string" ? userBody.login : "";
  if (userResponse.status !== 200 || !login) {
    throw new AccountError(
      "authorization-denied",
      serverMessage(
        userResponse.body,
        "GitHub didn't say whose account signed in.",
      ),
      userResponse.status,
    );
  }
  const entitlementResponse = await requestJson({
    url: COPILOT_USER_URL,
    fetch: options.fetch,
    signal: options.signal,
    timeoutMs: options.requestTimeoutMs,
    headers: githubHeaders(token),
  });
  if (
    entitlementResponse.status === 401 ||
    entitlementResponse.status === 403 ||
    entitlementResponse.status === 404
  ) {
    throw new AccountError(
      "no-subscription",
      `${login} has no Copilot subscription.`,
      entitlementResponse.status,
    );
  }
  if (entitlementResponse.status !== 200) {
    throw new AccountError(
      "invalid-response",
      serverMessage(
        entitlementResponse.body,
        "GitHub didn't return this account's Copilot plan.",
      ),
      entitlementResponse.status,
    );
  }
  const entitlement = record(entitlementResponse.body);
  return {
    user: login,
    plan: copilotPlanLabel(
      entitlement?.copilot_plan,
      entitlement?.access_type_sku,
    ),
  };
}

function copilotTokens(
  token: string,
  identity: CopilotIdentity,
): LoginCompletion {
  const profile: AccountProfile = {
    platform: "copilot",
    user: identity.user,
    ...(identity.plan ? { plan: identity.plan } : {}),
  };
  return {
    profile,
    tokens: {
      platform: "copilot",
      accessToken: token,
      tokenType: "oauth",
      accountId: identity.user,
      endpoint: COPILOT_API_BASE,
    },
  };
}

interface CopilotDevicePoll {
  kind: "pending" | "complete";
  intervalMs?: number;
  completion?: LoginCompletion;
}

async function pollCopilotDevice(input: {
  deviceCode: string;
  options: AccountRequestOptions;
}): Promise<CopilotDevicePoll> {
  const response = await requestJson({
    url: GITHUB_TOKEN_URL,
    method: "POST",
    fetch: input.options.fetch,
    signal: input.options.signal,
    timeoutMs: input.options.requestTimeoutMs,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: formBody({
      client_id: COPILOT_CLIENT_ID,
      device_code: input.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const body = record(response.body);
  const error = typeof body?.error === "string" ? body.error : "";
  if (response.status !== 200 && !error) {
    throw new AccountError(
      "network",
      serverMessage(response.body, "GitHub didn't answer the device sign-in."),
      response.status,
    );
  }
  if (error === "authorization_pending") return { kind: "pending" };
  if (error === "slow_down") return { kind: "pending", intervalMs: 5000 };
  if (error === "expired_token") {
    throw new AccountError(
      "device-expired",
      "The device code expired; start the sign-in again.",
    );
  }
  if (error === "access_denied") {
    throw new AccountError(
      "authorization-denied",
      "The sign-in was declined on GitHub.",
    );
  }
  if (error) {
    throw new AccountError(
      "authorization-denied",
      serverMessage(
        body?.error_description ?? error,
        "GitHub refused the sign-in.",
      ),
      response.status,
    );
  }
  const token = typeof body?.access_token === "string" ? body.access_token : "";
  if (!token) {
    throw new AccountError(
      "invalid-response",
      "GitHub sent back no sign-in token.",
    );
  }
  const identity = await copilotIdentity(token, input.options);
  return { kind: "complete", completion: copilotTokens(token, identity) };
}

/** GitHub's device flow under Copilot's editor OAuth app. */
export async function startCopilotDeviceLogin(
  options: AccountRequestOptions = {},
): Promise<AccountDeviceLogin> {
  const requests = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, requests.signal])
    : requests.signal;
  const response = await requestJson({
    url: GITHUB_DEVICE_URL,
    method: "POST",
    fetch: options.fetch,
    signal,
    timeoutMs: options.requestTimeoutMs,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: formBody({ client_id: COPILOT_CLIENT_ID, scope: "read:user" }),
  });
  const body = record(response.body);
  if (response.status !== 200) {
    throw new AccountError(
      "network",
      serverMessage(response.body, "GitHub couldn't start the device sign-in."),
      response.status,
    );
  }
  const deviceCode =
    typeof body?.device_code === "string" ? body.device_code : "";
  const userCode = typeof body?.user_code === "string" ? body.user_code : "";
  if (!deviceCode || !userCode) {
    throw new AccountError(
      "invalid-response",
      "GitHub sent back no device code.",
    );
  }
  const verificationUrl =
    typeof body?.verification_uri === "string" && body.verification_uri
      ? body.verification_uri
      : GITHUB_DEVICE_PAGE;
  const intervalSeconds = finiteNumber(body?.interval) ?? 5;
  const ttlSeconds = finiteNumber(body?.expires_in);
  const expiresAt =
    ttlSeconds !== undefined && ttlSeconds > 0
      ? (options.now?.() ?? Date.now()) + ttlSeconds * 1000
      : undefined;
  return {
    mode: "device",
    verificationUrl,
    userCode,
    intervalMs: Math.max(0, intervalSeconds * 1000),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    async poll(pollSignal?: AbortSignal): Promise<DevicePollResult> {
      const combined = pollSignal
        ? AbortSignal.any([pollSignal, requests.signal])
        : requests.signal;
      const result = await pollCopilotDevice({
        deviceCode,
        options: { ...options, signal: combined },
      });
      if (result.kind === "complete" && result.completion) {
        return { status: "complete", ...result.completion };
      }
      return {
        status: "pending",
        ...(result.intervalMs !== undefined
          ? { intervalMs: result.intervalMs }
          : {}),
      };
    },
    cancel() {
      requests.abort();
    },
  };
}

function safeApiBase(value: unknown): string {
  if (typeof value !== "string") return COPILOT_API_BASE;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return COPILOT_API_BASE;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return COPILOT_API_BASE;
  }
}

/** GitHub OAuth token -> short-lived Copilot API session token. */
export async function getCopilotSessionToken(
  githubToken: string,
  options: AccountProviderConfigOptions = {},
): Promise<CopilotSessionToken> {
  const now = options.now?.() ?? Date.now();
  const cache = options.sessionCache ?? defaultSessionCache;
  const cached = cache.get(githubToken);
  if (cached && cached.expiresAt - 2 * 60_000 > now) return cached;
  const response = await requestJson({
    url: COPILOT_SESSION_URL,
    fetch: options.fetch,
    signal: options.signal,
    timeoutMs: options.requestTimeoutMs,
    headers: githubHeaders(githubToken),
  });
  if (response.status === 401 || response.status === 403) {
    throw new AccountError(
      "reauthentication-required",
      "Copilot sign-in was refused; sign in again.",
      response.status,
    );
  }
  if (response.status !== 200) {
    throw new AccountError(
      "invalid-response",
      serverMessage(response.body, "GitHub didn't issue a Copilot session."),
      response.status,
    );
  }
  const body = record(response.body);
  const token = typeof body?.token === "string" ? body.token : "";
  if (!token)
    throw new AccountError(
      "invalid-response",
      "GitHub sent back no Copilot session token.",
    );
  const endpoints = record(body?.endpoints);
  const session: CopilotSessionToken = {
    token,
    expiresAt: unixMs(body?.expires_at) ?? now,
    apiBase: safeApiBase(endpoints?.api),
  };
  cache.set(githubToken, session);
  return session;
}

function endpointProtocols(endpoints: unknown): ProviderProtocol[] {
  if (!Array.isArray(endpoints) || endpoints.length === 0)
    return ["chat-completions"];
  const protocols: ProviderProtocol[] = [];
  for (const item of endpoints) {
    if (typeof item !== "string") continue;
    const path = item.replace(/\/$/, "").replace(/^\/v1(?=\/)/, "");
    const protocol =
      path === "/chat/completions"
        ? "chat-completions"
        : path === "/responses"
          ? "responses"
          : path === "/messages"
            ? "anthropic"
            : undefined;
    if (protocol && !protocols.includes(protocol)) protocols.push(protocol);
  }
  return protocols.length ? protocols : ["chat-completions"];
}

export async function listCopilotModels(
  tokens: AccountTokens,
  options: AccountProviderConfigOptions = {},
): Promise<AccountModel[]> {
  const session = await getCopilotSessionToken(tokens.accessToken, options);
  const response = await requestJson({
    url: `${session.apiBase}/models`,
    fetch: options.fetch,
    signal: options.signal,
    timeoutMs: options.requestTimeoutMs,
    maxBytes: 4 * 1024 * 1024,
    headers: sessionHeaders(session.token),
  });
  if (response.status === 401 || response.status === 403) {
    throw new AccountError(
      "reauthentication-required",
      "Copilot sign-in was refused; sign in again.",
      response.status,
    );
  }
  if (response.status !== 200) {
    throw new AccountError(
      "invalid-response",
      serverMessage(
        response.body,
        "Copilot didn't list this account's models.",
      ),
      response.status,
    );
  }
  const data = record(response.body)?.data;
  if (!Array.isArray(data)) {
    throw new AccountError(
      "invalid-response",
      "Copilot's model list wasn't readable.",
    );
  }
  const models: AccountModel[] = [];
  const protocolsByModel = new Map<string, ProviderProtocol[]>();
  for (const value of data) {
    const entry = record(value);
    if (!entry) continue;
    const capabilities = record(entry.capabilities);
    if (capabilities?.type !== "chat") continue;
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!id || INTERNAL_MODEL.test(id) || entry.vendor === "Experimental")
      continue;
    if (entry.model_picker_enabled !== true && !entry.model_picker_category)
      continue;
    const policy = record(entry.policy);
    if (policy && policy.state !== "enabled" && !policy.terms) continue;
    const protocols = endpointProtocols(entry.supported_endpoints);
    protocolsByModel.set(id, protocols);
    const supports = record(capabilities.supports);
    const efforts = Array.isArray(supports?.reasoning_effort)
      ? supports.reasoning_effort.filter(
          (effort): effort is string => typeof effort === "string",
        )
      : [];
    const limits = record(capabilities.limits);
    const contextWindow = finiteNumber(limits?.max_context_window_tokens);
    const billing = record(entry.billing);
    models.push({
      id,
      protocols,
      ...(typeof entry.name === "string" && entry.name
        ? { displayName: entry.name }
        : {}),
      ...(contextWindow !== undefined && contextWindow > 0
        ? { contextWindowTokens: Math.trunc(contextWindow) }
        : {}),
      ...(efforts.length ? { reasoningEfforts: efforts } : {}),
      ...(typeof entry.vendor === "string" && entry.vendor
        ? { vendor: entry.vendor }
        : {}),
      ...(billing && typeof billing.is_premium === "boolean"
        ? { premium: billing.is_premium }
        : {}),
      ...(supports && typeof supports.vision === "boolean"
        ? { vision: supports.vision }
        : {}),
    });
  }
  if (!models.length) {
    throw new AccountError(
      "invalid-response",
      "Copilot listed no chat models for this account.",
    );
  }
  learnedProtocols.set(tokens.accessToken, protocolsByModel);
  return models;
}

interface CopilotQuotaWire {
  unlimited: boolean;
  hasQuota?: boolean;
  entitlement?: number;
  remaining?: number;
  percentRemaining?: number;
  overage: boolean;
  resetAt: number | null;
}

function quotaWire(
  value: unknown,
  fallbackReset: number | null,
): CopilotQuotaWire | undefined {
  const entry = record(value);
  if (!entry) return undefined;
  const hasQuota = bool(entry.has_quota);
  const entitlement = finiteNumber(entry.entitlement);
  const remaining = finiteNumber(entry.quota_remaining);
  const percentRemaining = finiteNumber(entry.percent_remaining);
  return {
    unlimited: entry.unlimited === true,
    ...(hasQuota !== undefined ? { hasQuota } : {}),
    ...(entitlement !== undefined ? { entitlement } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(percentRemaining !== undefined ? { percentRemaining } : {}),
    overage: entry.overage_permitted === true,
    resetAt: (() => {
      const seconds = finiteNumber(entry.quota_reset_at);
      if (seconds !== undefined && seconds > 0) return seconds * 1000;
      return fallbackReset;
    })(),
  };
}

function parseResetDate(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function readCopilotQuota(
  tokens: AccountTokens,
  options: AccountRequestOptions = {},
): Promise<AccountQuota> {
  const now = options.now?.() ?? Date.now();
  const response = await requestJson({
    url: COPILOT_USER_URL,
    fetch: options.fetch,
    signal: options.signal,
    timeoutMs: options.requestTimeoutMs,
    headers: { ...githubHeaders(tokens.accessToken), ...editorHeaders() },
  });
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  ) {
    throw new AccountError(
      "no-subscription",
      "This account has no Copilot subscription.",
      response.status,
    );
  }
  if (response.status !== 200) {
    throw new AccountError(
      "invalid-response",
      serverMessage(
        response.body,
        "GitHub didn't return this account's Copilot usage.",
      ),
      response.status,
    );
  }
  const body = record(response.body);
  if (!body)
    throw new AccountError(
      "invalid-response",
      "Copilot's usage answer wasn't readable.",
    );
  const plan = copilotPlanLabel(body.copilot_plan, body.access_type_sku);
  const fallbackReset =
    parseResetDate(body.quota_reset_date_utc) ??
    parseResetDate(body.quota_reset_date);
  const snapshots = record(body.quota_snapshots);
  const windows: AccountQuotaWindow[] = [];
  const names: Array<[string, string]> = [
    ["chat", "Chat requests"],
    ["premium_interactions", "Premium requests"],
    ["completions", "Completions"],
  ];
  for (const [id, name] of names) {
    const wire = quotaWire(snapshots?.[id], fallbackReset);
    if (!wire) continue;
    if (wire.unlimited) {
      if (id === "premium_interactions" && wire.hasQuota === false) {
        windows.push({
          id,
          name,
          remaining: 0,
          limit: null,
          used: null,
          usedPercent: 100,
          resetAt: wire.resetAt,
          unlimited: false,
        });
      } else {
        windows.push({
          id,
          name,
          remaining: null,
          limit: null,
          used: null,
          usedPercent: null,
          resetAt: wire.resetAt,
          unlimited: true,
        });
      }
      continue;
    }
    if (wire.entitlement === undefined || wire.entitlement <= 0) continue;
    const limit = wire.entitlement;
    const used =
      wire.remaining !== undefined ? Math.max(0, limit - wire.remaining) : null;
    const usedPercent =
      used !== null
        ? Math.min(100, (100 * used) / limit)
        : wire.percentRemaining !== undefined
          ? Math.min(100, Math.max(0, 100 - wire.percentRemaining))
          : null;
    if (usedPercent === null) continue;
    windows.push({
      id,
      name,
      remaining: wire.remaining ?? null,
      limit,
      used: used === null ? null : Math.round(used * 100) / 100,
      usedPercent: Math.round(usedPercent * 100) / 100,
      resetAt: wire.resetAt,
      unlimited: false,
    });
  }
  return {
    platform: "copilot",
    windows,
    updatedAt: now,
    ...(plan ? { plan } : {}),
  };
}

function lastRole(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (Array.isArray(messages) && messages.length) {
    const last = record(messages[messages.length - 1]);
    return typeof last?.role === "string" ? last.role : "";
  }
  if (typeof body.input === "string") return "user";
  if (Array.isArray(body.input) && body.input.length) {
    const last = record(body.input[body.input.length - 1]);
    return typeof last?.role === "string" ? last.role : "";
  }
  return "";
}

/** Per-request Copilot headers, including the body-dependent initiator/vision. */
export function prepareCopilotHeaders(
  body: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Initiator": lastRole(body) === "user" ? "user" : "agent",
  };
  let serialized = "";
  try {
    serialized = JSON.stringify(body);
  } catch {
    serialized = "";
  }
  if (
    serialized.includes('"image_url"') ||
    serialized.includes('"input_image"') ||
    serialized.includes('"type":"image"')
  ) {
    headers["Copilot-Vision-Request"] = "true";
  }
  return headers;
}

function chooseApiMode(
  protocols: ProviderProtocol[] | undefined,
  model: string | undefined,
): ProviderProtocol {
  if (!protocols?.length) return "chat-completions";
  if (
    protocols.includes("anthropic") &&
    model?.toLowerCase().includes("claude")
  )
    return "anthropic";
  if (protocols.includes("responses")) return "responses";
  if (protocols.includes("chat-completions")) return "chat-completions";
  return protocols[0] ?? "chat-completions";
}

export async function getCopilotProviderConfig(
  tokens: AccountTokens,
  model?: string,
  options: AccountProviderConfigOptions | AbortSignal = {},
): Promise<AccountProviderConfig> {
  const request =
    options instanceof AbortSignal ? { signal: options } : options;
  const now = request.now?.() ?? Date.now();
  if (tokens.expiresAt !== undefined && tokens.expiresAt <= now) {
    throw new AccountError(
      "reauthentication-required",
      "Copilot sign-in expired; sign in again.",
    );
  }
  const session = await getCopilotSessionToken(tokens.accessToken, request);
  const protocols = model
    ? learnedProtocols.get(tokens.accessToken)?.get(model)
    : undefined;
  return {
    platform: "copilot",
    baseUrl: session.apiBase,
    apiKey: session.token,
    apiMode: chooseApiMode(protocols, model),
    headers: {
      ...editorHeaders(),
      "Openai-Intent": "conversation-panel",
      "X-Initiator": "user",
    },
    ...(protocols ? { protocols } : {}),
    prepareHeaders: prepareCopilotHeaders,
  };
}

/** GitHub OAuth tokens don't rotate or expire on their own. */
export async function refreshCopilotTokens(
  tokens: AccountTokens,
  options: AccountRequestOptions = {},
): Promise<AccountTokens> {
  if (tokens.platform !== "copilot") {
    throw new AccountError(
      "reauthentication-required",
      "Copilot is signed out; sign in again.",
    );
  }
  const now = options.now?.() ?? Date.now();
  if (tokens.expiresAt !== undefined && tokens.expiresAt <= now) {
    throw new AccountError(
      "reauthentication-required",
      "Copilot sign-in expired; sign in again.",
    );
  }
  return tokens;
}
