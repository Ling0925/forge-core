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
};

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
    const sse = response.headers
      .get("content-type")
      ?.includes("text/event-stream");
    let bytes = 0;
    let tail = "";
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
            if (sse && tail && !tail.replace(/\r\n/g, "\n").replace(/\r/g, "\n").endsWith("\n\n"))
              throw protocol("unterminated_event");
            controller.signal.removeEventListener("abort", cancel);
            reader.releaseLock();
            target.close();
            return;
          }
          if (chunk.value.byteLength) touch();
          bytes += chunk.value.byteLength;
          if (bytes > 8_000_000) throw protocol("output_limit");
          const text = decoder.decode(chunk.value, { stream: true });
          tail = (tail + text).slice(-4);
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
    const result = await operation({ signal: controller.signal, fetch });
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
      if (
        event.data.length > 1_200_000 ||
        event.raw.some((line) => line.length > 1_200_000)
      )
        throw protocol("output_limit");
      yield event;
    }
  } finally {
    controller.abort();
  }
}
