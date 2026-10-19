import { z } from "zod";
import { ForgeError, formatValidationError } from "./errors";
import type { ToolResult } from "./schemas";

// A declared optional field prevents gateways from inventing a required placeholder.
export const noArgumentFields = { reason: z.string().max(512).optional() };
export const noArgumentProperties = {
  reason: { type: "string", maxLength: 512, description: "Optional brief context; does not change the operation." },
} as const;

/** Strings must be authored public messages, never raw exception text or input. */
export function invalidToolInput(error: z.ZodError | SyntaxError | string): ToolResult {
  const message = typeof error === "string" ? error
    : error instanceof z.ZodError ? formatValidationError(error)
      : "Tool arguments must be valid JSON. Fix the JSON syntax before retrying.";
  return { content: JSON.stringify({ code: "invalid_input", error: message }), isError: true };
}

export function recoverToolInputError(error: unknown): ToolResult | undefined {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return invalidToolInput(error);
  if (error instanceof ForgeError && error.code === "invalid_input") return invalidToolInput(error.message);
  return undefined;
}
