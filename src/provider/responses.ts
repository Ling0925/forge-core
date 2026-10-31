import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses";
import { z } from "zod";
import type {
  Message,
  ProviderResponse,
  ToolCallPreview,
  ToolDefinition,
} from "../shared/schemas";
import type { WebSearchMode, WebSearchProgress } from "../shared/web-search";
import type { Helpers } from "./responses-events";
import { body } from "./responses-input";
import { createResponsesStream } from "./responses-stream";

export function createResponsesAdapter(h: Helpers, baseUrl: string) {
  return {
    body(
      messages: readonly Message[],
      tools: readonly ToolDefinition[],
      model: string,
      webSearch: WebSearchMode = "disabled",
    ): ResponseCreateParamsStreaming {
      return body(h, baseUrl, messages, tools, model, webSearch);
    },
    async read(
      response: Response,
      observer: (text: string) => void,
      model: string,
      onReasoning: (text: string) => void = () => {},
      onToolCall: (preview: ToolCallPreview) => void = () => {},
      webSearch: WebSearchMode = "disabled",
      onWebSearch: (search: WebSearchProgress) => void = () => {},
    ): Promise<ProviderResponse> {
      const stream = createResponsesStream({
        h,
        baseUrl,
        observer,
        model,
        onReasoning,
        onToolCall,
        webSearch,
        onWebSearch,
      });
      const contentType = response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      if (contentType === "application/json") {
        // Some gateways honor the request but buffer the reply as JSON. Consume
        // that same response; never retry the generation or switch protocols.
        const body = z
          .object({ status: z.string() })
          .passthrough()
          .parse(h.parseJson(await response.text()));
        const type =
          body.status === "failed"
            ? "response.failed"
            : body.status === "incomplete"
              ? "response.incomplete"
              : "response.completed";
        stream.dispatch({ type, response: body }, null);
      } else {
        for await (const event of h.events(response)) {
          stream.accept(event);
        }
      }
      return stream.finish();
    },
  };
}
