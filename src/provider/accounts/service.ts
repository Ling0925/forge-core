import {
  getCodexProviderConfig,
  listCodexModels,
  readCodexQuota,
  refreshCodexTokens,
  startCodexCallbackLogin,
  startCodexDeviceLogin,
} from "./codex";
import {
  getCopilotProviderConfig,
  listCopilotModels,
  readCopilotQuota,
  refreshCopilotTokens,
  startCopilotDeviceLogin,
} from "./copilot";
import { defaultRandomBytes, randomToken } from "./crypto";
import { scrubSecretText } from "./http";
import { AccountError } from "./types";
import type {
  AccountLogin,
  AccountLoginSnapshot,
  AccountLoginStartOptions,
  AccountModel,
  AccountPlatform,
  AccountProviderConfig,
  AccountQuota,
  AccountRequestOptions,
  AccountServiceOptions,
  AccountTokens,
  CopilotSessionToken,
  LoginCompletion,
  SaveLoginInput,
} from "./types";

const DEFAULT_LOGIN_TTL_MS = 10 * 60_000;
const DEFAULT_QUOTA_TTL_MS = 60_000;
const DEFAULT_POLL_FLOOR_MS = 1000;
const SETTLED_FLOW_TTL_MS = 30 * 60_000;

interface Flow {
  id: string;
  platform: AccountPlatform;
  sourceId: string;
  label?: string;
  mode: "device" | "callback";
  status: AccountLoginSnapshot["status"];
  expiresAt: number;
  createdAt: number;
  finishedAt?: number;
  verificationUrl?: string;
  userCode?: string;
  account?: AccountLoginSnapshot["account"];
  credentialId?: string;
  error?: string;
  errorCode?: AccountLoginSnapshot["errorCode"];
  nextPollAt: number;
  intervalMs: number;
  busy: boolean;
  finishing: boolean;
  login?: AccountLogin;
  controller: AbortController;
}

interface QuotaCacheEntry {
  at: number;
  quota: AccountQuota;
}

function errorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : "The sign-in failed; start it again.";
  return scrubSecretText(raw) || "The sign-in failed; start it again.";
}

function errorCode(error: unknown): AccountLoginSnapshot["errorCode"] {
  return error instanceof AccountError ? error.code : undefined;
}

function cancelLogin(login: AccountLogin | undefined): void {
  if (login?.mode === "device") login.cancel();
}

/**
 * Login flows live only in this host process. Public snapshots carry the
 * verification URL, user code and account profile; device ids, PKCE
 * verifiers, authorization codes and tokens stay in closures here.
 */
export class AccountService {
  private readonly flows = new Map<string, Flow>();
  private readonly quotaCache = new Map<string, QuotaCacheEntry>();
  private readonly sessionCache = new Map<string, CopilotSessionToken>();
  /** Polls and saves still running; dispose waits for them before clearing. */
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly now: () => number;
  private readonly random: (length: number) => Uint8Array;
  private readonly fetch: AccountServiceOptions["fetch"];
  private readonly loginTtlMs: number;
  private readonly quotaTtlMs: number;
  private readonly pollFloorMs: number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: AccountServiceOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.randomBytes ?? defaultRandomBytes;
    this.fetch = options.fetch;
    this.loginTtlMs = options.loginTtlMs ?? DEFAULT_LOGIN_TTL_MS;
    this.quotaTtlMs = options.quotaTtlMs ?? DEFAULT_QUOTA_TTL_MS;
    this.pollFloorMs = options.devicePollFloorMs ?? DEFAULT_POLL_FLOOR_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async startLogin(
    input: AccountLoginStartOptions,
  ): Promise<AccountLoginSnapshot> {
    this.prune();
    if (input.signal?.aborted) {
      throw new AccountError(
        "canceled",
        "The sign-in was canceled before it started.",
      );
    }
    const now = this.now();
    const mode = input.mode ?? "device";
    if (input.platform === "copilot" && mode !== "device") {
      throw new AccountError(
        "unsupported",
        "GitHub Copilot signs in with a device code.",
      );
    }
    for (const flow of this.flows.values()) {
      if (
        flow.status === "waiting" &&
        flow.platform === input.platform &&
        flow.sourceId === input.sourceId
      ) {
        this.settle(flow, "canceled");
      }
    }
    const id = randomToken(9, input.randomBytes ?? this.random);
    const flow: Flow = {
      id,
      platform: input.platform,
      sourceId: input.sourceId,
      ...(input.label ? { label: input.label } : {}),
      mode,
      status: "waiting",
      expiresAt: now + this.loginTtlMs,
      createdAt: now,
      nextPollAt: now,
      intervalMs: this.pollFloorMs,
      busy: false,
      finishing: false,
      controller: new AbortController(),
    };
    this.flows.set(id, flow);
    // The RPC request's signal only covers the handshake; polling has its own
    // cancel path. Aborting it settles the flow instead of failing it.
    const external = input.signal;
    const onExternalAbort = () => {
      if (flow.status === "waiting") this.settle(flow, "canceled");
    };
    if (external) {
      if (external.aborted) onExternalAbort();
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }
    const requestFetch = input.fetch ?? this.fetch;
    const request: AccountRequestOptions = {
      signal: flow.controller.signal,
      now: this.now,
      requestTimeoutMs: input.requestTimeoutMs ?? this.requestTimeoutMs,
      ...(requestFetch ? { fetch: requestFetch } : {}),
    };
    try {
      if (flow.status !== "waiting") return this.snapshot(flow);
      const login =
        input.platform === "codex"
          ? mode === "callback"
            ? await startCodexCallbackLogin({
                ...request,
                ...(input.redirectUri
                  ? { redirectUri: input.redirectUri }
                  : {}),
                randomBytes: input.randomBytes ?? this.random,
              })
            : await startCodexDeviceLogin(request)
          : await startCopilotDeviceLogin(request);
      if (flow.status !== "waiting") {
        cancelLogin(login);
        return this.snapshot(flow);
      }
      flow.login = login;
      if (login.mode === "device") {
        flow.verificationUrl = login.verificationUrl;
        flow.userCode = login.userCode;
        flow.intervalMs = Math.max(this.pollFloorMs, login.intervalMs);
        flow.nextPollAt = this.now() + flow.intervalMs;
        if (login.expiresAt !== undefined)
          flow.expiresAt = Math.min(flow.expiresAt, login.expiresAt);
      } else {
        flow.verificationUrl = login.url;
      }
    } catch (error) {
      if (flow.status === "waiting") this.fail(flow, error);
    } finally {
      external?.removeEventListener("abort", onExternalAbort);
    }
    return this.snapshot(flow);
  }

  /** Poll one device step and answer with the resulting public state. */
  async pollLogin(loginId: string): Promise<AccountLoginSnapshot> {
    const flow = this.flow(loginId);
    if (this.expire(flow)) return this.snapshot(flow);
    if (
      flow.status !== "waiting" ||
      flow.mode !== "device" ||
      flow.busy ||
      flow.finishing
    ) {
      return this.snapshot(flow);
    }
    if (this.now() < flow.nextPollAt) return this.snapshot(flow);
    await this.track(this.advance(flow));
    return this.snapshot(flow);
  }
  cancelLogin(loginId: string): AccountLoginSnapshot {
    const flow = this.flow(loginId);
    if (flow.status === "waiting") this.settle(flow, "canceled");
    return this.snapshot(flow);
  }

  async completeLogin(
    loginId: string,
    callbackUrl: string,
  ): Promise<AccountLoginSnapshot> {
    const flow = this.flow(loginId);
    if (this.expire(flow)) return this.snapshot(flow);
    if (flow.status !== "waiting") return this.snapshot(flow);
    if (flow.mode !== "callback" || flow.login?.mode !== "callback") {
      throw new AccountError(
        "unsupported",
        "This sign-in doesn't take a callback address.",
      );
    }
    if (flow.busy || flow.finishing) return this.snapshot(flow);
    flow.busy = true;
    try {
      const completion = await this.track(
        flow.login.complete(callbackUrl, flow.controller.signal),
      );
      await this.complete(flow, completion);
    } catch (error) {
      if (
        error instanceof AccountError &&
        (error.code === "state-mismatch" || error.code === "invalid-callback")
      ) {
        throw error;
      }
      if (flow.status === "waiting") this.fail(flow, error);
    } finally {
      flow.busy = false;
    }
    return this.snapshot(flow);
  }

  async listModels(
    tokens: AccountTokens,
    options: AccountRequestOptions = {},
  ): Promise<AccountModel[]> {
    const requestFetch = options.fetch ?? this.fetch;
    const request: AccountRequestOptions = {
      ...options,
      ...(requestFetch ? { fetch: requestFetch } : {}),
      now: options.now ?? this.now,
      requestTimeoutMs: options.requestTimeoutMs ?? this.requestTimeoutMs,
    };
    if (tokens.platform === "codex") return listCodexModels(tokens, request);
    return listCopilotModels(tokens, {
      ...request,
      sessionCache: this.sessionCache,
    });
  }

  /**
   * Quota for a stored credential. Tokens are loaded and checked on every
   * call, so a signed-out or newly refreshed credential can't serve a stale
   * answer; the cache key includes the credential and access-token identity.
   */
  async readQuota(
    sourceId: string,
    credentialId: string,
    signal?: AbortSignal,
  ): Promise<AccountQuota> {
    if (!this.options.loadTokens) {
      throw new AccountError(
        "unsupported",
        "This host doesn't expose account credentials to the quota reader.",
      );
    }
    const tokens = await this.options.loadTokens(sourceId, credentialId);
    if (!tokens)
      throw new AccountError(
        "reauthentication-required",
        "The account is signed out.",
      );
    const now = this.now();
    if (tokens.expiresAt !== undefined && tokens.expiresAt <= now) {
      throw new AccountError(
        "reauthentication-required",
        "The account sign-in expired; sign in again.",
      );
    }
    const key = `${sourceId}\u0000${credentialId}\u0000${tokens.platform}\u0000${tokens.accessToken}`;
    const cached = this.quotaCache.get(key);
    if (cached && now - cached.at < this.quotaTtlMs) return cached.quota;
    const options: AccountRequestOptions = {
      now: this.now,
      requestTimeoutMs: this.requestTimeoutMs,
      ...(this.fetch ? { fetch: this.fetch } : {}),
      ...(signal ? { signal } : {}),
    };
    const quota =
      tokens.platform === "codex"
        ? await readCodexQuota(tokens, options)
        : await readCopilotQuota(tokens, options);
    this.quotaCache.set(key, { at: this.now(), quota });
    if (this.quotaCache.size > 64) {
      const oldest = this.quotaCache.keys().next().value;
      if (oldest !== undefined) this.quotaCache.delete(oldest);
    }
    return quota;
  }

  providerConfig(
    tokens: AccountTokens,
    model?: string,
    signal?: AbortSignal,
  ): Promise<AccountProviderConfig> {
    const options = {
      now: this.now,
      requestTimeoutMs: this.requestTimeoutMs,
      sessionCache: this.sessionCache,
      ...(this.fetch ? { fetch: this.fetch } : {}),
      ...(signal ? { signal } : {}),
    };
    return tokens.platform === "codex"
      ? getCodexProviderConfig(tokens, model, options)
      : getCopilotProviderConfig(tokens, model, options);
  }

  refresh(tokens: AccountTokens, signal?: AbortSignal): Promise<AccountTokens> {
    const options: AccountRequestOptions = {
      now: this.now,
      requestTimeoutMs: this.requestTimeoutMs,
      ...(this.fetch ? { fetch: this.fetch } : {}),
      ...(signal ? { signal } : {}),
    };
    return tokens.platform === "codex"
      ? refreshCodexTokens(tokens, options)
      : refreshCopilotTokens(tokens, options);
  }

  /**
   * Cancels every login and waits for in-flight polls and saves to settle, so
   * a sign-in can't write tokens after the host has forgotten the service.
   */
  async dispose(): Promise<void> {
    for (const flow of this.flows.values()) {
      if (flow.status === "waiting") this.settle(flow, "canceled");
    }
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
    this.flows.clear();
    this.quotaCache.clear();
    this.sessionCache.clear();
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise)).catch(() => {});
    return promise;
  }

  private flow(loginId: string): Flow {
    const flow = this.flows.get(loginId);
    if (!flow)
      throw new AccountError(
        "login-not-found",
        "That sign-in is no longer running.",
      );
    return flow;
  }

  private async advance(flow: Flow): Promise<void> {
    const login = flow.login;
    if (!login || login.mode !== "device") return;
    flow.busy = true;
    try {
      const result = await login.poll(flow.controller.signal);
      if (flow.status !== "waiting") return;
      if (this.expire(flow)) return;
      if (result.status === "pending") {
        const interval = Math.max(
          this.pollFloorMs,
          result.intervalMs ?? flow.intervalMs,
        );
        flow.intervalMs = interval;
        flow.nextPollAt = this.now() + interval;
        return;
      }
      await this.complete(flow, result);
    } catch (error) {
      if (flow.status === "waiting") this.fail(flow, error);
    } finally {
      flow.busy = false;
    }
  }

  private async complete(
    flow: Flow,
    completion: LoginCompletion,
  ): Promise<void> {
    if (flow.status !== "waiting" || this.expire(flow)) return;
    flow.finishing = true;
    try {
      const input: SaveLoginInput = {
        platform: flow.platform,
        sourceId: flow.sourceId,
        label:
          flow.label ??
          completion.profile.user ??
          (flow.platform === "codex" ? "ChatGPT" : "GitHub"),
        tokens: completion.tokens,
        profile: completion.profile,
      };
      const saved = await this.options.saveLogin(input);
      if (flow.status !== "waiting" || this.expire(flow)) return;
      flow.account = completion.profile;
      if (saved?.credentialId) flow.credentialId = saved.credentialId;
      this.settle(flow, "done");
    } catch (error) {
      if (flow.status === "waiting") this.fail(flow, error);
    } finally {
      flow.finishing = false;
    }
  }

  private fail(flow: Flow, error: unknown): void {
    const code = errorCode(error);
    this.settle(flow, "failed", errorMessage(error), code);
  }

  private expire(flow: Flow): boolean {
    if (flow.status === "waiting" && this.now() >= flow.expiresAt) {
      this.settle(
        flow,
        "expired",
        "The sign-in expired; start it again.",
        "login-expired",
      );
      return true;
    }
    return false;
  }

  private settle(
    flow: Flow,
    status: Exclude<AccountLoginSnapshot["status"], "waiting">,
    error?: string,
    code?: AccountLoginSnapshot["errorCode"],
  ): void {
    if (flow.status !== "waiting") return;
    flow.status = status;
    flow.finishedAt = this.now();
    cancelLogin(flow.login);
    flow.controller.abort();
    if (error) flow.error = error;
    if (code) flow.errorCode = code;
  }

  private snapshot(flow: Flow): AccountLoginSnapshot {
    return {
      loginId: flow.id,
      platform: flow.platform,
      mode: flow.mode,
      status: flow.status,
      expiresAt: flow.expiresAt,
      ...(flow.verificationUrl
        ? { verificationUrl: flow.verificationUrl }
        : {}),
      ...(flow.userCode ? { userCode: flow.userCode } : {}),
      ...(flow.account ? { account: flow.account } : {}),
      ...(flow.credentialId ? { credentialId: flow.credentialId } : {}),
      ...(flow.error ? { error: flow.error } : {}),
      ...(flow.errorCode ? { errorCode: flow.errorCode } : {}),
    };
  }

  private prune(): void {
    const now = this.now();
    for (const [id, flow] of this.flows) {
      if (
        flow.finishedAt !== undefined &&
        now - flow.finishedAt > SETTLED_FLOW_TTL_MS
      ) {
        this.flows.delete(id);
      }
    }
    if (this.flows.size < 64) return;
    const settled = [...this.flows.values()]
      .filter((flow) => flow.status !== "waiting")
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const flow of settled.slice(0, this.flows.size - 63))
      this.flows.delete(flow.id);
  }
}

export function createAccountService(
  options: AccountServiceOptions,
): AccountService {
  return new AccountService(options);
}
