import type { ModelProvider } from "../shared/contracts";
import type { AgentEvent } from "../shared/schemas";
import { createToolPreviewStream } from "./tool-preview";

type GenerationPreview = {
  [K in "tool_call_preview" | "text_delta" | "reasoning_delta" | "web_search"]:
    Omit<Extract<AgentEvent, { type: K }>, "sessionId" | "timestamp">;
}["tool_call_preview" | "text_delta" | "reasoning_delta" | "web_search"];

type ProviderCallbacks = Pick<Parameters<ModelProvider["complete"]>[2],
  "onText" | "onReasoning" | "onToolCall" | "onWebSearch">;

/** Owns one attempt's bounded drafts, preview identities and flush timers. */
export function createGenerationStream(
  identity: Readonly<{ generationId: string; previewPrefix: string }>,
  observer: Readonly<{
    emit: (event: GenerationPreview) => void;
    retainText: (text: string) => void;
  }>,
) {
  const { generationId } = identity;
  let partial = "";
  let emittedChars = 0;
  let reasoningPartial = "";
  let reasoningChars = 0;
  let streaming = true;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let reasoningTimer: ReturnType<typeof setTimeout> | undefined;
  const previews = createToolPreviewStream(identity.previewPrefix, (previewId, preview) => {
    observer.emit({
      type: "tool_call_preview", generationId,
      previewId,
      name: preview.name,
      argumentsChars: preview.argumentsChars,
      ...(preview.linesAdded !== undefined ? { linesAdded: preview.linesAdded } : {}),
      ...(preview.linesRemoved !== undefined ? { linesRemoved: preview.linesRemoved } : {}),
    });
  });
  const flushReasoning = (): void => {
    clearTimeout(reasoningTimer);
    reasoningTimer = undefined;
    if (reasoningPartial !== "") {
      observer.emit({ type: "reasoning_delta", generationId, text: reasoningPartial });
      reasoningChars += reasoningPartial.length;
      reasoningPartial = "";
    }
  };
  const flush = (): void => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    if (partial !== "") {
      observer.emit({ type: "text_delta", generationId, text: partial });
      emittedChars += partial.length;
      partial = "";
    }
  };
  const callbacks: ProviderCallbacks = {
    onWebSearch(search) {
      if (streaming) observer.emit({ type: "web_search", search });
    },
    onText(text) {
      if (!streaming || typeof text !== "string") return;
      const accepted = text.slice(0, Math.max(0, 131072 - emittedChars - partial.length));
      if (accepted) flushReasoning();
      partial += accepted;
      observer.retainText(accepted);
      if (partial.length >= 8192) flush();
      else if (partial && flushTimer === undefined) flushTimer = setTimeout(flush, 80);
    },
    onToolCall(preview) {
      if (streaming) {
        flushReasoning();
        flush();
        previews.push(preview);
      }
    },
    onReasoning(text) {
      if (!streaming || typeof text !== "string") return;
      reasoningPartial += text.slice(0, Math.max(0, 131072 - reasoningChars - reasoningPartial.length));
      if (reasoningPartial.length >= 256) flushReasoning();
      else if (reasoningPartial && reasoningTimer === undefined) reasoningTimer = setTimeout(flushReasoning, 22);
    },
  };
  return {
    callbacks,
    previews,
    close(): void {
      streaming = false;
      flushReasoning();
      flush();
      previews.close();
    },
  };
}
