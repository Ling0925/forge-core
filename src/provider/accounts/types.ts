import type {
  AccountTokens,
  ProviderProtocol,
} from "../../shared/model-access";

// Subscription account adapters adapted from Magpie's provider account code.
// Source provenance and MIT license: THIRD_PARTY_NOTICES.md.
export type AccountPlatform = AccountTokens["platform"];
export type { AccountTokens, ProviderProtocol };

/** Injected network boundary; the default is the global fetch. */
export type AccountFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type AccountLoginMode = "device" | "callback";
export type AccountLoginStatus =
  | "waiting"
  | "done"
  | "failed"
  | "canceled"
  | "expired";

/** Public account projection. Never contains tokens, device codes or verifiers. */
export interface AccountProfile {
  platform: AccountPlatform;
  user?: string;
  plan?: string;
  accountId?: string;
  host?: string;
}

export interface AccountLoginSnapshot {
  loginId: string;
  platform: AccountPlatform;
  mode: AccountLoginMode;
  status: AccountLoginStatus;
  expiresAt: number;
  verificationUrl?: string;
  userCode?: string;
  account?: AccountProfile;
  credentialId?: string;
  error?: string;
  errorCode?: AccountErrorCode;
}

export interface LoginCompletion {
  tokens: AccountTokens;
  profile: AccountProfile;
}

export type DevicePollResult =
  | { status: "pending"; intervalMs?: number }
  | ({ status: "complete" } & LoginCompletion);

export interface AccountDeviceLogin {
  mode: "device";
  verificationUrl: string;
  userCode: string;
  intervalMs: number;
  expiresAt?: number;
  poll(signal?: AbortSignal): Promise<DevicePollResult>;
  cancel(): void;
}

export interface AccountCallbackLogin {
  mode: "callback";
  url: string;
  state: string;
  redirectUri: string;
  complete(callbackUrl: string, signal?: AbortSignal): Promise<LoginCompletion>;
}

export type AccountLogin = AccountDeviceLogin | AccountCallbackLogin;

/** Public model metadata returned by an account's own catalog endpoint. */
export interface AccountModel {
  id: string;
  displayName?: string;
  protocols: ProviderProtocol[];
  contextWindowTokens?: number | null;
  maxContextWindowTokens?: number | null;
  reasoningEfforts?: string[];
  inputModalities?: string[];
  vision?: boolean;
  vendor?: string;
  premium?: boolean;
}

export interface AccountProviderConfig {
  platform: AccountPlatform;
  baseUrl: string;
  /** Short-lived credential used by the protocol adapter; never public. */
  apiKey: string;
  apiMode: ProviderProtocol;
  headers: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** Protocols known for the requested model, from the account's own catalog. */
  protocols?: ProviderProtocol[];
  /**
   * Codex's backend expects Codex CLI's Responses shape. Adapters that can
   * apply a whole-body transform should call this before sending.
   */
  prepareBody?: (body: Record<string, unknown>) => Record<string, unknown>;
  /** Per-request headers that depend on the body (Copilot initiator/vision). */
  prepareHeaders?: (body: Record<string, unknown>) => Record<string, string>;
}

/** One subscription allowance window, with unknown amounts kept null. */
export interface AccountQuotaWindow {
  id: string;
  name: string;
  remaining: number | null;
  limit: number | null;
  used: number | null;
  usedPercent: number | null;
  resetAt: number | null;
  unlimited: boolean;
}

export interface AccountQuota {
  platform: AccountPlatform;
  windows: AccountQuotaWindow[];
  updatedAt: number;
  plan?: string;
}

export type AccountErrorCode =
  | "canceled"
  | "login-not-found"
  | "login-expired"
  | "invalid-callback"
  | "state-mismatch"
  | "authorization-denied"
  | "device-expired"
  | "reauthentication-required"
  | "no-subscription"
  | "network"
  | "invalid-response"
  | "unsupported";

export class AccountError extends Error {
  readonly code: AccountErrorCode;
  readonly status?: number;

  constructor(code: AccountErrorCode, message: string, status?: number) {
    super(message);
    this.name = "AccountError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface AccountRequestOptions {
  fetch?: AccountFetch | undefined;
  signal?: AbortSignal | undefined;
  now?: (() => number) | undefined;
  requestTimeoutMs?: number | undefined;
}

export interface AccountProviderConfigOptions extends AccountRequestOptions {
  /** Copilot session-token cache; a fresh one per service keeps tests isolated. */
  sessionCache?: Map<string, CopilotSessionToken>;
}

export interface CopilotSessionToken {
  token: string;
  expiresAt: number;
  apiBase: string;
}

export interface AccountLoginStartOptions extends AccountRequestOptions {
  platform: AccountPlatform;
  sourceId: string;
  label?: string;
  mode?: AccountLoginMode;
  /** Codex browser-callback mode only; defaults to Codex CLI's port 1455. */
  redirectUri?: string;
  randomBytes?: (length: number) => Uint8Array;
}

export interface SaveLoginInput {
  platform: AccountPlatform;
  sourceId: string;
  label: string;
  tokens: AccountTokens;
  profile: AccountProfile;
}

export interface SaveLoginResult {
  credentialId?: string;
}

export interface AccountServiceOptions {
  /** The host must persist tokens here; they are never returned to renderers. */
  // biome-ignore lint/suspicious/noConfusingVoidType: hosts may persist without returning a result.
  saveLogin(input: SaveLoginInput): Promise<SaveLoginResult | void>;
  loadTokens?(
    sourceId: string,
    credentialId: string,
  ): Promise<AccountTokens | undefined>;
  fetch?: AccountFetch;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  /** Device endpoint polling floor; upstream uses one second. Tests may lower it. */
  devicePollFloorMs?: number;
  loginTtlMs?: number;
  quotaTtlMs?: number;
  requestTimeoutMs?: number;
}
