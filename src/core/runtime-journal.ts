import type { SessionStore, SteeringInput } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import {
  type Message,
  type RunInput,
  type SessionSnapshot,
  runInputSchema,
} from "../shared/schemas";
import { createSessionWriter } from "./session-writer";
import { advisorRequestSchema, type AdvisorRequest } from "../shared/agent-coordination";
import { agentEventSchema, type AgentEvent } from "../shared/schemas";

interface RuntimeJournalState {
  readonly current: () => SessionSnapshot | undefined;
  readonly replace: (snapshot: SessionSnapshot) => void;
  readonly now: () => string;
  readonly check: () => void;
}

/** One CAS writer and durable inbox for title, steering and model/tool commits. */
export function createRuntimeJournal(
  store: SessionStore,
  input: RunInput,
  state: RuntimeJournalState,
) {
  const writer = createSessionWriter(store, input.sessionId);
  let writes: Promise<void> = Promise.resolve();
  let acceptingSteering = false;
  let pendingSteering: { message: Message; bytes: number }[] = [];
  let steeringCount = 0;
  let steeringBytes = 0;

  const enqueueWrite = (write: () => Promise<void>): Promise<void> => {
    const work = writes.then(write);
    writes = work.catch(() => undefined);
    return work;
  };
  const checkpoint = async (extra: readonly Message[] = []): Promise<void> => {
    const current = state.current();
    if (!current) throw new ForgeError("internal", "Session has not loaded.");
    const snapshot = { ...current, updatedAt: state.now() };
    state.replace(snapshot);
    const messages = [...pendingSteering.map(entry => entry.message), ...extra];
    try {
      // Accepted input stays outside unresolved assistant/tool exchanges until promotion.
      await writer.save(messages.length ? { ...snapshot, pendingSteering: messages } : snapshot);
    } catch {
      throw new ForgeError("storage", "Could not checkpoint session.", true);
    }
  };
  const message = (entry: SteeringInput): Message => {
    const steering = typeof entry === "string" ? { prompt: entry } : entry;
    const parsed = runInputSchema.safeParse({ ...input, images: undefined, ...steering });
    if (!parsed.success) throw new ForgeError("invalid_input", "Steering prompt failed validation.");
    return { role: "user", content: parsed.data.prompt,
      ...(parsed.data.images?.length ? { images: parsed.data.images } : {}) };
  };

  return {
    async read(): Promise<SessionSnapshot> {
      const { pendingSteering: recovered, ...loaded } = await writer.read();
      pendingSteering = (recovered ?? []).map(message => ({ message, bytes: Buffer.byteLength(JSON.stringify(message)) }));
      steeringCount = pendingSteering.length;
      steeringBytes = pendingSteering.reduce((sum, entry) => sum + entry.bytes, 0);
      return loaded;
    },
    save: (): Promise<void> => enqueueWrite(() => checkpoint()),
    async acceptAdvisor(raw: AdvisorRequest): Promise<AgentEvent> {
      const request = advisorRequestSchema.parse(raw);
      if (request.parentSessionId !== input.sessionId)
        throw new ForgeError("invalid_input", "Advisor record belongs to another parent.");
      let committed!: AgentEvent;
      await enqueueWrite(async () => {
        const current = state.current();
        if (!current) throw new ForgeError("internal", "Session has not loaded.");
        const previous = current.advisorRequests ?? [];
        const index = previous.findIndex(item => item.id === request.id);
        if (index < 0 && previous.length >= 10000)
          throw new ForgeError("budget", "Advisor history is full; start a new parent session.");
        const requests = [...previous];
        if (index < 0) requests.push(request); else requests[index] = request;
        committed = agentEventSchema.parse({ type: "advisor_update", request,
          sessionId: input.sessionId, timestamp: state.now() });
        // Metadata/event only: never insert a message into an open tool exchange.
        state.replace({ ...current, advisorRequests: requests, events: [...current.events, committed] });
        try { await checkpoint(); }
        catch (error) {
          // Do not later claim an unacknowledged transition succeeded. Preserve
          // unrelated model/progress updates made while the writer was awaiting IO.
          const latest = state.current();
          if (latest) state.replace({ ...latest, advisorRequests: previous,
            events: latest.events.filter(event => event !== committed) });
          throw error;
        }
      });
      return committed;
    },
    async settle(): Promise<void> {
      let pending: Promise<void>;
      do { pending = writes; await pending; } while (pending !== writes);
    },
    get pendingWrite(): Promise<void> { return writes; },
    get pendingMessages(): readonly Message[] { return pendingSteering.map(entry => entry.message); },
    message,
    openSteering(): void { acceptingSteering = true; },
    closeSteering(): void { acceptingSteering = false; },
    async acceptSteering(entry: SteeringInput): Promise<void> {
      state.check();
      if (!acceptingSteering) throw new ForgeError("not_found", "当前运行正在收尾，草稿已保留。请手动发送下一轮。");
      const accepted = message(entry);
      const bytes = Buffer.byteLength(JSON.stringify(accepted));
      if (steeringCount >= 1000 || steeringBytes + bytes > 16 * 1024 * 1024)
        throw new ForgeError("invalid_input", "插话队列已满，草稿已保留。");
      steeringCount++;
      steeringBytes += bytes;
      try {
        await enqueueWrite(async () => {
          // Publish only within the serialized commit, never after a failed write.
          await checkpoint([accepted]);
          pendingSteering.push({ message: accepted, bytes });
        });
      } catch (error) {
        steeringCount--;
        steeringBytes -= bytes;
        throw error;
      }
    },
    includeSteering(): boolean {
      const snapshot = state.current();
      if (!snapshot || !pendingSteering.length) return false;
      state.replace({ ...snapshot, messages: [...snapshot.messages, ...pendingSteering.map(entry => entry.message)] });
      steeringCount -= pendingSteering.length;
      steeringBytes -= pendingSteering.reduce((sum, entry) => sum + entry.bytes, 0);
      pendingSteering = [];
      return true;
    },
  };
}
