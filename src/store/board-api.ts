import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ForgeError, type SettingsStore, toErrorInfo } from "../shared";

const boardStatusSchema = z.enum([
  "todo",
  "in_progress",
  "input_required",
  "in_review",
  "blocked",
  "failed",
  "canceled",
  "done",
]);
export const boardTaskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string(),
  status: boardStatusSchema,
  progress: z.string(),
  metadata: z.record(z.unknown()),
  lease: z.object({ holder: z.string(), token: z.string() }).nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BoardTask = z.infer<typeof boardTaskSchema>;
export const boardApprovalSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  action: z.enum(["claim", "transition"]),
  to: boardStatusSchema,
});
const failureSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown(),
  }),
});

export class BoardRequestError extends ForgeError {
  constructor(
    readonly status: number,
    readonly boardCode: string,
    message: string,
    readonly currentTask?: BoardTask,
  ) {
    super(
      status === 404
        ? "not_found"
        : (status === 409 || status === 412) &&
            [
              "claim_conflict",
              "version_mismatch",
              "lease_lost",
              "conflict",
            ].includes(boardCode)
          ? "busy"
          : status >= 400 && status < 500
            ? "invalid_input"
            : "storage",
      message,
    );
  }
}

export function createBoardClient({
  url,
  settings,
}: {
  url: string;
  settings: Pick<SettingsStore, "getBoardToken">;
}) {
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await settings.getBoardToken()}`);
    const mutation = init.method !== undefined && init.method !== "GET";
    if (mutation) {
      headers.set("Content-Type", "application/json");
      headers.set("Idempotency-Key", randomUUID());
    }
    const input = new URL(path, url);
    const options = { ...init, headers };
    let response: Response;
    try {
      response = await fetch(input, options).catch((error) => {
        if (!mutation) throw error;
        return fetch(input, options);
      });
    } catch (error) {
      throw new ForgeError(
        "storage",
        error instanceof Error ? error.message : toErrorInfo(error).message,
        true,
      );
    }
    if (!response.ok) {
      const { error } = failureSchema.parse(await response.json());
      const currentTask =
        error.code === "version_mismatch" || error.code === "lease_lost"
          ? z.object({ currentTask: boardTaskSchema }).parse(error.details)
              .currentTask
          : undefined;
      throw new BoardRequestError(
        response.status,
        error.code,
        error.message,
        currentTask,
      );
    }
    return response;
  };
  const json = async (path: string, init?: RequestInit): Promise<unknown> =>
    (await request(path, init)).json();
  const pages = async <T>(
    path: string,
    schema: z.ZodType<T>,
    init?: RequestInit,
  ) => {
    const endpoint = new URL(path, url);
    const items: T[] = [];
    const pageSchema = z.object({
      items: z.array(schema),
      nextCursor: z.string().nullable(),
    });
    for (;;) {
      const page = pageSchema.parse(await json(endpoint.href, init));
      items.push(...page.items);
      if (page.nextCursor === null) return items;
      endpoint.searchParams.set("cursor", page.nextCursor);
    }
  };
  return { request, json, pages };
}
