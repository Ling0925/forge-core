import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { _iterSSEMessages, type ServerSentEvent } from "openai/core/streaming";
import { z } from "zod";
import { ForgeError } from "../shared/errors";
import type { ProviderConfig } from "../shared/schemas";
import { ProviderError, httpError, protocol } from "./errors";

type Request = {
  readonly signal: AbortSignal;
  readonly fetch: typeof globalThis.fetch;
  /** Let SDK adapters preserve transport/byte/UTF-8 failures during assembly. */
  readonly hasBodyFailure: () => boolean;
};

// Track only framing, not payloads. Control fields and comments at EOF do not
// constitute a truncated data event. Keep just a field prefix so an unfinished
// line cannot grow this guard's memory; SDKs still own actual SSE decoding.
class SseFraming {
  private prefix = "";
  private data = false;
  private cr = false;

  write(text: string): void {
    for (const char of text) {
      if (this.cr && char === "\n") {
        this.cr = false;
        continue;
      }
      this.cr = char === "\r";
      if (char === "\n" || char === "\r") {
        if (!this.prefix) this.data = false;
        else if (this.prefix === "data" || this.prefix === "data:") this.data = true;
        this.prefix = "";
      } else if (this.prefix.length < 5) this.prefix += char;
    }
  }

  finish(): void {
    if (this.data || this.prefix === "data" || this.prefix === "data:")
      throw protocol("unterminated_event");
  }
}

// SDKs own HTTP and SSE decoding. This wrapper only enforces Forge's byte,
// UTF-8 and idle-time limits, including comments and partial streamed frames.
export async function withSdkRequest<T>(
  config: ProviderConfig,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly idle: boolean;
    /** Proxy-aware transport; bounds and abort handling still wrap it. */
    readonly fetch?: typeof globalThis.fetch | undefined;
  },
  operation: (request: Request) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, config.requestTimeoutMs);
  const touch = () => {
    if (options.idle && !controller.signal.aborted) timer.refresh();
  };
  let bodyFailure: unknown;
  const baseFetch = options.fetch ?? globalThis.fetch;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = await baseFetch(input, {
      ...init,
      signal: controller.signal,
    });
    touch();
    if (!response.body) return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const sse = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream"
      ? new SseFraming() : undefined;
    let bytes = 0;
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    const body = new ReadableStream<Uint8Array>({
      async pull(target) {
        try {
          controller.signal.throwIfAborted();
          const chunk = await reader.read();
          controller.signal.throwIfAborted();
          if (chunk.done) {
            decoder.decode();
            sse?.finish();
            controller.signal.removeEventListener("abort", cancel);
            reader.releaseLock();
            target.close();
            return;
          }
          if (chunk.value.byteLength) touch();
          bytes += chunk.value.byteLength;
          if (bytes > 8_000_000) throw protocol("output_limit", { stage: "transport_body", observed: bytes, limit: 8_000_000, unit: "bytes" });
          const text = decoder.decode(chunk.value, { stream: true });
          sse?.write(text);
          target.enqueue(chunk.value);
        } catch (error) {
          bodyFailure = error;
          controller.signal.removeEventListener("abort", cancel);
          cancel();
          target.error(error);
        }
      },
      async cancel() {
        controller.signal.removeEventListener("abort", cancel);
        await reader.cancel();
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  try {
    controller.signal.throwIfAborted();
    const result = await operation({ signal: controller.signal, fetch, hasBodyFailure: () => bodyFailure !== undefined });
    controller.signal.throwIfAborted();
    return result;
  } catch (caught) {
    if (options.signal?.aborted)
      throw new ProviderError("aborted", "The provider request was cancelled.");
    if (timedOut)
      throw new ProviderError(
        "timeout",
        options.idle
          ? `The provider sent no data for ${config.requestTimeoutMs} ms (idle timeout).`
          : "The provider request timed out.",
        true,
      );
    const error =
      caught instanceof ForgeError ? caught : (bodyFailure ?? caught);
    if (error instanceof ForgeError) throw error;
    if (
      error instanceof OpenAI.APIError ||
      error instanceof Anthropic.APIError
    ) {
      if (error.status !== undefined) throw httpError(error.status);
      if (
        error instanceof OpenAI.APIConnectionError ||
        error instanceof Anthropic.APIConnectionError
      )
        throw new ProviderError(
          "network",
          "The provider connection failed.",
          true,
        );
      throw protocol("provider_error_event");
    }
    if (
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      error instanceof TypeError
    )
      throw protocol();
    if (
      error instanceof Anthropic.AnthropicError ||
      error instanceof OpenAI.OpenAIError
    )
      throw protocol();
    throw new ProviderError("network", "The provider connection failed.", true);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    abort();
  }
}

// Use the SDK decoder's event-preserving entry point because compatible gateways
// need terminal-marker and event-identity checks before exposing tool calls.
export async function* sdkEvents(
  response: Response,
): AsyncIterable<ServerSentEvent> {
  const controller = new AbortController();
  try {
    for await (const event of _iterSSEMessages(response, controller)) {
      const chars = event.raw.reduce((maximum, line) => Math.max(maximum, line.length), event.data.length);
      if (chars > 1_200_000)
        throw protocol("output_limit", { stage: "sse_event", observed: chars, limit: 1_200_000, unit: "utf16_code_units" });
      // The SDK exposes named, data-free records, while SSE dispatch discards
      // them. Do not JSON.parse an empty heartbeat; real empty/malformed data
      // remains a protocol error, and adapters still require native completion.
      if (!event.data && !event.raw.some(line => /^data(?::|$)/.test(line))) {
        // A broken failure frame must not be mistaken for a heartbeat and then
        // superseded by successful output from a relay.
        if (["error", "response.failed", "response.incomplete"].includes(event.event ?? ""))
          throw protocol("provider_error_event");
        continue;
      }
      yield event;
    }
  } finally {
    controller.abort();
  }
}
