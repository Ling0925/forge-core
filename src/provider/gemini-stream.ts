import { randomUUID } from "node:crypto";
import type { ModelProvider } from "../shared/contracts";
import { providerResponseSchema } from "../shared/schemas";
import type {
  ProviderResponse,
  ToolCall,
  ToolCallPreview,
} from "../shared/schemas";
import { estimateToolCallLines } from "../shared/tool-preview-lines";
import { parseProviderJson } from "./bounded-json";
import { ProviderError, protocol } from "./errors";
import { argumentsObject } from "./gemini-request";
import {
  MAX_TEXT,
  type Part,
  type UsageWire,
  chunkWire,
  failureOf,
  failureWire,
  normalizeUsage,
} from "./gemini-wire";

const MAX_REASONING = 131_072;

const finishOf = (reason: string | undefined): void => {
  if (!reason) throw protocol("missing_finish");
  switch (reason) {
    case "STOP":
      return;
    case "MAX_TOKENS":
      throw protocol("output_truncated");
    case "SAFETY":
    case "RECITATION":
    case "LANGUAGE":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
    case "IMAGE_PROHIBITED_CONTENT":
    case "IMAGE_RECITATION":
      throw new ProviderError(
        "upstream",
        "The provider stopped the response because of content filtering.",
        false,
        undefined,
        "content_filter",
      );
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
    case "TOO_MANY_TOOL_CALLS":
    case "MISSING_THOUGHT_SIGNATURE":
    case "MALFORMED_RESPONSE":
      throw protocol("invalid_tool_call");
    case "IMAGE_OTHER":
    case "NO_IMAGE":
    case "OTHER":
      throw new ProviderError(
        "upstream",
        "The provider stopped the response before completing it.",
        false,
        undefined,
        "response_incomplete",
      );
    default:
      throw protocol("invalid_finish");
  }
};

type CompleteOptions = Parameters<ModelProvider["complete"]>[2];

// State machine for one streamGenerateContent reply (SSE frames or one JSON
// body). Only a complete, validated result is returned; previews carry
// counters, never partial arguments.
export const responseReader = (
  options: CompleteOptions,
  model: string,
  baseUrl: string,
  credentialId: string | undefined,
) => {
  let text = "";
  let reasoning = "";
  let finish: string | undefined;
  let usage: UsageWire | undefined;
  let done = false;
  const parts: Part[] = [];
  const notify = (callback: () => void) => {
    try {
      callback();
    } catch {
      throw new ProviderError("observer", "A provider observer failed.");
    }
  };
  const emit = (
    callback: ((value: string) => void) | undefined,
    value: string,
  ) => {
    if (!callback || !value) return;
    for (let start = 0; start < value.length; start += 65536)
      notify(() => callback(value.slice(start, start + 65536)));
  };
  const preview = (index: number, name: string, argumentsText: string) => {
    if (!options.onToolCall) return;
    const lines = estimateToolCallLines(name, argumentsText);
    const value: ToolCallPreview = {
      index,
      name,
      argumentsChars: argumentsText.length,
      ...lines,
    };
    notify(() => options.onToolCall?.(value));
  };
  const addPart = (part: Part) => {
    if (
      part.executableCode !== undefined ||
      part.codeExecutionResult !== undefined
    )
      throw protocol();
    if (part.inlineData !== undefined || part.fileData !== undefined)
      throw protocol();
    if (part.functionCall) {
      // A functionCall carries its arguments whole; text in the same part
      // cannot be placed on the wire without guessing which one wins.
      if (part.text || part.thought) throw protocol("invalid_chunk");
      const args = argumentsObject(part.functionCall.args);
      const functionCall = {
        // id is optional; a relay that serializes the empty default still
        // needs a local identity for history replay and its functionResponse.
        id: part.functionCall.id || `call_${randomUUID()}`,
        name: part.functionCall.name,
        args,
      };
      parts.push({ ...part, functionCall });
      preview(
        parts.filter((value) => value.functionCall).length - 1,
        functionCall.name,
        JSON.stringify(args),
      );
      return;
    }
    const value = part.text ?? "";
    if (part.thought === true) {
      if (reasoning.length < MAX_REASONING)
        reasoning += value.slice(0, MAX_REASONING - reasoning.length);
      emit(options.onReasoning, value);
    } else if (value) {
      text += value;
      if (text.length > MAX_TEXT)
        throw protocol("output_limit", {
          stage: "output_text",
          observed: text.length,
          limit: MAX_TEXT,
          unit: "utf16_code_units",
        });
      emit(options.onText, value);
    }
    if (value || part.thoughtSignature)
      parts.push({ ...part, ...(value ? { text: value } : {}) });
  };
  const acceptChunk = (value: unknown) => {
    if (done) throw protocol("unexpected_frame");
    const failure = failureWire.safeParse(value);
    if (failure.success) throw failureOf(failure.data.error);
    const parsed = chunkWire.safeParse(value);
    if (!parsed.success) throw protocol("invalid_chunk");
    const chunk = parsed.data;
    const blockReason = chunk.promptFeedback?.blockReason;
    // A relay that serializes the enum's default value has not blocked
    // anything; only a real reason stops the reply.
    if (blockReason && !/^(?:BLOCK_REASON_)?UNSPECIFIED$/i.test(blockReason))
      throw new ProviderError(
        "upstream",
        "The provider stopped the response because of content filtering.",
        false,
        undefined,
        "content_filter",
      );
    if (chunk.usageMetadata) usage = { ...usage, ...chunk.usageMetadata };
    if (!chunk.candidates) return;
    // This adapter never asks for candidateCount > 1; a second candidate
    // cannot be represented without guessing, so it is a protocol failure.
    if (chunk.candidates.length > 1) throw protocol("invalid_chunk");
    const candidate = chunk.candidates[0];
    if (!candidate) return;
    const content = candidate.content;
    const contentParts = content?.parts ?? [];
    if (finish !== undefined && contentParts.length)
      throw protocol("unexpected_frame");
    // An explicitly serialized default enum is not a finish signal. In
    // particular it must not make the next normal chunk look like extra output.
    const finishReason = candidate.finishReason;
    if (finishReason && finishReason !== "FINISH_REASON_UNSPECIFIED") {
      if (finish !== undefined && finish !== finishReason)
        throw protocol("unexpected_frame");
      finish = finishReason;
    }
    if (!content) return;
    // A single-turn Content may leave the role blank as well as unset.
    if (
      content.role !== undefined &&
      content.role !== "" &&
      content.role !== "model" &&
      content.role !== "assistant"
    )
      throw protocol("invalid_chunk");
    for (const part of contentParts) addPart(part);
  };
  // A complete streamGenerateContent body may be one JSON array of
  // GenerateContentResponse messages (the REST form when alt=sse is not
  // honored), and a relay may buffer that array into one SSE data payload.
  // Each element is a chunk; every one is validated in order, so a cut-off
  // array still fails JSON parsing and an empty array still fails the finish
  // checks.
  const accept = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) acceptChunk(item);
      return;
    }
    acceptChunk(value);
  };
  const dispatch = (payload: string) => {
    if (payload === "[DONE]") {
      if (!finish || done) throw protocol("missing_finish");
      done = true;
      return;
    }
    accept(parseProviderJson(payload, "sse_event"));
  };
  const response = (): ProviderResponse => {
    finishOf(finish);
    const calls: ToolCall[] = [];
    const ids = new Set<string>();
    for (const part of parts) {
      if (!part.functionCall) continue;
      const id = part.functionCall.id;
      if (!id || ids.has(id)) throw protocol("invalid_tool_call");
      ids.add(id);
      calls.push({
        id,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(argumentsObject(part.functionCall.args)),
        },
      });
    }
    // A STOP with nothing said is an error in the reference (empty reply),
    // retried by the runtime rather than ending the run as a successful turn.
    if (!text && !calls.length) throw protocol("missing_completion");
    const signed = parts.some(
      (part) => part.thought === true || Boolean(part.thoughtSignature),
    );
    const normalizedUsage = normalizeUsage(usage);
    return providerResponseSchema.parse({
      message: {
        role: "assistant",
        content: text || null,
        ...(reasoning ? { reasoning } : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(signed
          ? {
              providerState: {
                version: 1,
                apiMode: "gemini",
                ...(credentialId ? { credentialId } : {}),
                baseUrl,
                model,
                output: parts,
              },
            }
          : {}),
      },
      ...(normalizedUsage ? { usage: normalizedUsage } : {}),
    });
  };
  return { accept, dispatch, response };
};
