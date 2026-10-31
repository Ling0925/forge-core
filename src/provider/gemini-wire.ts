import { z } from "zod";
import { toolCallSchema } from "../shared/schemas";
import type { Usage } from "../shared/schemas";
import { ProviderError, httpError } from "./errors";

export const MAX_TEXT = 2_000_000;
const MAX_SIGNATURE = 1_000_000;
const MAX_IMAGE_WIRE = 16_000_000;

const functionCallWire = z
  .object({
    id: z.string().max(256).optional(),
    name: toolCallSchema.unwrap().shape.function.unwrap().shape.name,
    args: z.unknown().optional(),
  })
  .strict();
// A content part. Unknown additive fields are tolerated (Gemini adds
// metadata over time) but every part that could carry output is read here;
// unrepresentable kinds are rejected rather than silently dropped.
const partWire = z
  .object({
    text: z.string().max(MAX_TEXT).optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().max(MAX_SIGNATURE).optional(),
    functionCall: functionCallWire.optional(),
    inlineData: z
      .object({
        mimeType: z.string().min(1).max(255),
        data: z.string().max(MAX_IMAGE_WIRE),
      })
      .strict()
      .optional(),
    fileData: z
      .object({
        mimeType: z.string().min(1).max(255),
        fileUri: z.string().min(1).max(4096),
      })
      .strict()
      .optional(),
    executableCode: z.unknown().optional(),
    codeExecutionResult: z.unknown().optional(),
  })
  .passthrough();
export type Part = z.infer<typeof partWire>;

const usageWire = z
  .object({
    promptTokenCount: z.number().int().nonnegative().optional(),
    candidatesTokenCount: z.number().int().nonnegative().optional(),
    totalTokenCount: z.number().int().nonnegative().optional(),
    cachedContentTokenCount: z.number().int().nonnegative().optional(),
    thoughtsTokenCount: z.number().int().nonnegative().optional(),
    toolUsePromptTokenCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type UsageWire = z.infer<typeof usageWire>;

const candidateWire = z
  .object({
    content: z
      .object({
        role: z.string().max(32).optional(),
        // A repeated field may be omitted when empty; treat that as no parts.
        parts: z.array(partWire).max(256).optional(),
      })
      .passthrough()
      .optional(),
    finishReason: z.string().max(64).optional(),
    finishMessage: z.string().max(8192).optional(),
    index: z.number().int().min(0).max(7).optional(),
    safetyRatings: z.array(z.unknown()).max(64).optional(),
    citationMetadata: z.unknown().optional(),
    groundingMetadata: z.unknown().optional(),
    avgLogprobs: z.number().optional(),
    logprobsResult: z.unknown().optional(),
  })
  .passthrough();
export const chunkWire = z
  .object({
    candidates: z.array(candidateWire).max(8).optional(),
    usageMetadata: usageWire.optional(),
    promptFeedback: z
      .object({
        blockReason: z.string().max(64).optional(),
        blockReasonMessage: z.string().max(8192).optional(),
      })
      .passthrough()
      .optional(),
    modelVersion: z.string().max(256).optional(),
    responseId: z.string().max(256).optional(),
  })
  .passthrough();
export const failureWire = z
  .object({
    error: z
      .object({
        code: z.unknown().optional(),
        status: z.unknown().optional(),
        message: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const modelsPageWire = z
  .object({
    models: z
      .array(z.object({ name: z.string().min(1).max(512) }).passthrough())
      .max(1000)
      .optional(),
    nextPageToken: z.string().min(1).max(4096).optional(),
  })
  .passthrough();
export const statePartsWire = z.array(partWire).max(256);

// Upstream gRPC status names seen in error frames, mapped to HTTP-class
// failures so Forge's existing retry budget applies.
const STATUS_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGUMENT: 400,
  FAILED_PRECONDITION: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  RESOURCE_EXHAUSTED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
};

export const failureOf = (error: {
  code?: unknown;
  status?: unknown;
}): ProviderError => {
  const code =
    typeof error.code === "number"
      ? error.code
      : typeof error.status === "string"
        ? STATUS_CODE[error.status]
        : undefined;
  if (code !== undefined && code >= 400 && code <= 599) return httpError(code);
  return new ProviderError(
    "upstream",
    "The provider reported a generation failure.",
    false,
    undefined,
    "provider_error_event",
  );
};

const normalizeUsage = (raw: UsageWire | undefined): Usage | undefined => {
  if (
    !raw ||
    raw.promptTokenCount === undefined ||
    raw.candidatesTokenCount === undefined
  )
    return undefined;
  // Gemini counts thoughts apart from the answer; Forge's completionTokens is
  // all generated tokens, so both are included (Usage.gemini in the reference
  // does the reverse split). totalTokenCount is used when the provider sent it.
  const completion = raw.candidatesTokenCount + (raw.thoughtsTokenCount ?? 0);
  return {
    promptTokens: raw.promptTokenCount,
    completionTokens: completion,
    totalTokens: raw.totalTokenCount ?? raw.promptTokenCount + completion,
    ...(raw.cachedContentTokenCount === undefined
      ? {}
      : { cachedPromptTokens: raw.cachedContentTokenCount }),
  };
};

export { normalizeUsage };
