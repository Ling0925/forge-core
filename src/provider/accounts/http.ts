import { AccountError } from "./types";
import type { AccountFetch } from "./types";

export const defaultFetch: AccountFetch = (input, init) =>
  globalThis.fetch(input, init);

const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 30_000;

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new AccountError("canceled", "The account request was canceled.");
}

/**
 * Longest error text kept from an upstream. Provider refusal details help the
 * user, but response bodies can echo credentials and must never be stored.
 */
export function scrubSecretText(value: string): string {
  return (
    value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
      .replace(/\btoken\s+[A-Za-z0-9._~+/=-]{8,}/gi, "token [redacted]")
      .replace(
        /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
        "[redacted-jwt]",
      )
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted-key]")
      .replace(
        /\b(access_token|refresh_token|id_token|device_code|device_auth_id|code_verifier|authorization|token)\b(\s*[:=]\s*)["']?[^\s"',;}]+/gi,
        "$1$2[redacted]",
      )
      // biome-ignore lint/suspicious/noControlCharactersInRegex: provider text is stripped of control bytes before display.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300)
  );
}

function objectMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["error_description", "message", "detail", "description"]) {
    const text = record[key];
    if (typeof text === "string" && text.trim()) return text;
  }
  const nested = record.error;
  if (typeof nested === "string" && nested.trim()) return nested;
  if (nested && typeof nested === "object") {
    const message = (nested as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return undefined;
}

/** A bounded, secret-free description of an upstream refusal. */
export function serverMessage(body: unknown, fallback: string): string {
  const raw = typeof body === "string" ? body : objectMessage(body);
  const clean = raw ? scrubSecretText(raw) : "";
  return clean || fallback;
}

export interface JsonRequest {
  url: string;
  fetch?: AccountFetch | undefined;
  method?: "GET" | "POST" | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

function linkedSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function boundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AccountError(
      "invalid-response",
      "The account service's answer is too large.",
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AccountError(
          "invalid-response",
          "The account service's answer is too large.",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** JSON request with bounded reads, a timeout and no redirects carrying bodies. */
export async function requestJson(request: JsonRequest): Promise<JsonResponse> {
  const doFetch = request.fetch ?? defaultFetch;
  const caller = request.signal;
  assertNotAborted(caller);
  const linked = linkedSignal(caller, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(request.url, {
      method: request.method ?? "GET",
      ...(request.headers !== undefined ? { headers: request.headers } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: linked.signal,
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
    });
  } catch (error) {
    if (linked.timedOut()) {
      throw new AccountError(
        "network",
        "The account service did not answer in time.",
      );
    }
    if (caller?.aborted) {
      throw new AccountError("canceled", "The account request was canceled.");
    }
    const detail = error instanceof Error ? scrubSecretText(error.message) : "";
    throw new AccountError(
      "network",
      detail
        ? `The account service couldn't be reached: ${detail}`
        : "The account service couldn't be reached.",
    );
  } finally {
    linked.cleanup();
  }
  const text = await boundedText(
    response,
    request.maxBytes ?? DEFAULT_MAX_BYTES,
  );
  let body: unknown = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new AccountError(
        "invalid-response",
        `The account service answered with invalid JSON (${response.status}).`,
        response.status,
      );
    }
  }
  return { status: response.status, body };
}
