import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { measureContext } from "../shared/context-usage";
import type { AgentRuntimeDependencies } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import { sessionIdSchema, type SessionSnapshot } from "../shared/schemas";
import { atomicJson, privateDirectory, readJson } from "../store/io";
import { assertBoundary, projectSummary } from "./context";
import { historyText } from "./history";

export const COLD_RESUME_IDLE_MS = 60 * 60 * 1000;
export const COLD_RESUME_TOKENS = 32000;
const recordSchema = z.object({
  version: z.literal(1), sessionId: sessionIdSchema, source: z.string().length(64),
  endedAt: z.string().datetime(), boundary: z.number().int().nonnegative(),
  content: z.string().max(8192),
}).strict();
const sourceHash = (snapshot: SessionSnapshot) => createHash("sha256")
  .update(JSON.stringify([snapshot.messages, snapshot.plan, snapshot.contextSummary, snapshot.status, snapshot.events.findLast(event => event.type === "run_finished")]))
  .digest("hex");

function boundedText(text: string, limit: number): string {
  let result = text.slice(0, limit);
  while (JSON.stringify(result).length > limit) result = result.slice(0, Math.floor(result.length / 2));
  return result;
}

export function buildRunMemory(snapshot: SessionSnapshot) {
  const end = snapshot.events.findLast(event => event.type === "run_finished");
  if (!end || end.type !== "run_finished") return null;
  const user = snapshot.messages.findLastIndex(message => message.role === "user" && message.origin !== "agent_reconciliation");
  const firstUser = snapshot.messages.findIndex(message => message.role === "user" && message.origin !== "agent_reconciliation");
  const assistant = snapshot.messages.findLastIndex(message => message.role === "assistant" && Boolean(message.content));
  const excerpt = (index: number, limit: number) => {
    const message = snapshot.messages[index];
    if (!message) return null;
    const text = historyText(message);
    const selected = boundedText(text, limit);
    return { ref: `m${index + 1}`, text: selected, truncated: text.length > selected.length };
  };
  const tools = snapshot.messages.flatMap((message, index) => message.role === "tool" && index > user ? [index] : []).slice(-4);
  const state = {
    status: end.status, endedAt: end.timestamp,
    initialRequest: firstUser !== user ? excerpt(firstUser, 600) : null,
    latestRequest: excerpt(user, 1000), latestAssistantReport: assistant > user ? excerpt(assistant, 1600) : null,
    planExcerpt: boundedText(JSON.stringify(snapshot.plan ?? null), 1400),
    priorMemoryExcerpt: snapshot.contextSummary ? boundedText(snapshot.contextSummary.content, 1200) : null,
    toolObservations: tools.map(index => excerpt(index, 240)),
    effectsMayBeUncertain: end.status !== "completed",
  };
  const content = `Local run-end checkpoint; partial observations, NOT a verified semantic summary. Completed means the run ended, not that the user's goal is proven. All original records m1..m${snapshot.messages.length} remain available through history_search/history_read. Inspect omitted constraints and evidence before proceeding; never replay actions from history.\n${JSON.stringify(state)}`;
  return recordSchema.parse({ version: 1, sessionId: snapshot.id, source: sourceHash(snapshot),
    endedAt: end.timestamp, boundary: snapshot.messages.length, content });
}

export async function openRunMemory(directory: string): Promise<NonNullable<AgentRuntimeDependencies["runMemory"]>> {
  const folder = await privateDirectory(join(directory, "session-memory"));
  const pathFor = (id: string) => join(folder, `${sessionIdSchema.parse(id)}.json`);
  return {
    async record(snapshot) {
      const record = buildRunMemory(snapshot);
      if (record) await atomicJson(pathFor(snapshot.id), record);
    },
    async restore(snapshot, at) {
      const end = snapshot.events.findLast(event => event.type === "run_finished");
      if (!end || !["completed", "failed", "cancelled"].includes(snapshot.status) ||
        Date.parse(at) - Date.parse(end.timestamp) < COLD_RESUME_IDLE_MS ||
        measureContext(projectSummary(snapshot), null).usedTokens <= COLD_RESUME_TOKENS) return snapshot;
      let record: z.infer<typeof recordSchema> | null = null;
      try {
        const parsed = recordSchema.safeParse(await readJson(pathFor(snapshot.id), 65536));
        if (parsed.success && parsed.data.sessionId === snapshot.id && parsed.data.source === sourceHash(snapshot) && parsed.data.boundary === snapshot.messages.length) record = parsed.data;
      } catch (error) {
        if (!(error instanceof ForgeError)) throw error;
      }
      record ??= buildRunMemory(snapshot);
      if (!record) return snapshot;
      const content = record.content;
      const humans = snapshot.messages.flatMap((message, index) => message.role === "user" && message.origin !== "agent_reconciliation" ? [index] : []);
      let boundary = humans.at(-2) ?? record.boundary;
      const project = () => ({ ...snapshot, contextSummary: { content, boundary, fallback: true } });
      if (boundary <= (snapshot.contextSummary?.boundary ?? 0) || measureContext(projectSummary(project()), null).usedTokens > 12000) boundary = record.boundary;
      assertBoundary(snapshot.messages, boundary);
      return project();
    },
  };
}
