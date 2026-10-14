import { ZodError } from "zod";
import { errorInfoSchema } from "./schemas";
import type { ErrorInfo } from "./schemas";

export class ForgeError extends Error {
  readonly code: ErrorInfo["code"];
  readonly retryable: boolean;

  // Messages must be authored safe public text, never upstream exception text or bodies.
  constructor(code: ErrorInfo["code"], message: string, retryable = false) {
    const info = errorInfoSchema.parse({ code, message, retryable });
    super(info.message);
    this.name = "ForgeError";
    this.code = info.code;
    this.retryable = info.retryable;
  }
}

export const toErrorInfo = (error: unknown): ErrorInfo => {
  if (error instanceof ForgeError) {
    return errorInfoSchema.parse({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    });
  }
  if (error instanceof ZodError) {
    return errorInfoSchema.parse({
      code: "invalid_input",
      message: "Input failed validation.",
      retryable: false,
    });
  }
  return errorInfoSchema.parse({
    code: "internal",
    message: "An unexpected failure occurred.",
    retryable: false,
  });
};
