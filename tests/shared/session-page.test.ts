import { describe, expect, it } from "vitest";
import { createDiffPatch } from "../../src/shared/diff";
import { ForgeError } from "../../src/shared/errors";
import {
  type AgentEvent,
  type FileChange,
  type Message,
  type SessionSnapshot,
  agentEventSchema,
  sessionSnapshotSchema,
} from "../../src/shared/schemas";
import {
  paginateSession,
  sessionPageRequestSchema,
  sessionPageSchema,
} from "../../src/shared/session-page";
import { image } from "../fixtures/image";

const sessionId = "11111111-1111-4111-8111-111111111111";
const timestamp = "2026-01-01T00:00:00.000Z";

const event = (value: Record<string, unknown>): AgentEvent =>
  agentEventSchema.parse({ sessionId, timestamp, ...value });

interface TurnSpec {
  readonly prompt: string;
  readonly reply: string;
  readonly image?: boolean;
  readonly legacy?: boolean;
  readonly steps?: number;
  readonly steering?: readonly string[];
  readonly tool?: {
    readonly result: string;
    readonly change?: { readonly path: string; readonly patchSecret?: string };
  };
}

function buildTurns(specs: readonly TurnSpec[]): SessionSnapshot {
  const messages: Message[] = [];
  const events: AgentEvent[] = [];
  const changes: FileChange[] = [];
  specs.forEach((spec, index) => {
    const turn = index + 1;
    const userIndex = messages.length;
    messages.push({
      role: "user",
      content: spec.prompt,
      ...(spec.image ? { images: [image] } : {}),
    });
    events.push(
      event({
        type: "run_started",
        ...(spec.legacy ? {} : { turn, messageIndex: userIndex }),
        model: "test-model",
        permission: "unrestricted",
      }),
    );
    const steps = spec.steps ?? 1;
    let toolCalls = 0;
    for (let step = 1; step <= steps; step++) {
      if (!spec.legacy) {
        events.push(
          event({
            type: "step_started",
            turn,
            step,
            messageIndex: messages.length,
          }),
        );
      }
      if (step === 1 && spec.tool) {
        const callId = `call-${turn}-1`;
        const call = {
          id: callId,
          type: "function",
          function: { name: "write_file", arguments: "{}" },
        };
        events.push(event({ type: "tool_started", turn, call }));
        const fileChanges: FileChange[] = spec.tool.change
          ? [
              {
                path: spec.tool.change.path,
                kind: "created",
                ...(spec.tool.change.patchSecret
                  ? {
                      patch: createDiffPatch(
                        "",
                        `${spec.tool.change.patchSecret}${" old-patch-body".repeat(200)}`,
                      ),
                    }
                  : {}),
              },
            ]
          : [];
        changes.push(...fileChanges);
        events.push(
          event({
            type: "tool_finished",
            turn,
            toolCallId: callId,
            result: {
              content: spec.tool.result,
              isError: false,
              ...(fileChanges.length ? { changes: fileChanges } : {}),
            },
          }),
        );
        toolCalls += 1;
      }
      messages.push({
        role: "assistant",
        content: step === steps ? spec.reply : `${spec.reply} step ${step}`,
      });
      if (!spec.legacy) {
        events.push(
          event({
            type: "step_finished",
            turn,
            step,
            status: "completed",
            messageIndex: messages.length,
          }),
        );
      }
      if (step < steps) {
        for (const steering of spec.steering ?? []) {
          messages.push({ role: "user", content: steering });
        }
      }
    }
    events.push(
      event({
        type: "run_finished",
        ...(spec.legacy ? {} : { turn, messageIndex: messages.length }),
        status: "completed",
        turns: steps,
        steps,
        toolCalls,
      }),
    );
  });
  return sessionSnapshotSchema.parse({
    version: 1,
    id: sessionId,
    title: "paged session",
    workspace: "/tmp/paged-session",
    model: "test-model",
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "idle",
    messages,
    events,
    changes,
  });
}

const contents = (snapshot: SessionSnapshot): string[] =>
  snapshot.messages.map((message) => message.content ?? "");

describe("server-side execution-turn pagination", () => {
  it("defaults to only the latest turn without old text, tool results or images", () => {
    const snapshot = buildTurns([
      {
        prompt: "OLD_PRIVATE_PROMPT",
        reply: "OLD_PRIVATE_REPLY",
        image: true,
        tool: {
          result: "OLD_TOOL_RESULT_SECRET",
          change: { path: "old.txt", patchSecret: "OLD_PATCH_SECRET" },
        },
      },
      { prompt: "middle prompt", reply: "middle reply" },
      {
        prompt: "latest prompt",
        reply: "latest reply",
        tool: {
          result: "latest tool result",
          change: { path: "latest.txt", patchSecret: "LATEST_PATCH" },
        },
      },
    ]);

    const page = paginateSession(snapshot);
    sessionPageSchema.parse(page);
    expect(contents(page.snapshot)).toEqual(["latest prompt", "latest reply"]);
    const serialized = JSON.stringify(page.snapshot);
    expect(serialized).not.toContain("OLD_PRIVATE");
    expect(serialized).not.toContain("OLD_TOOL_RESULT");
    expect(serialized).not.toContain("OLD_PATCH_SECRET");
    expect(serialized).not.toContain(image.dataUrl);
    expect(page.snapshot.changes.map((change) => change.path)).toEqual([
      "latest.txt",
    ]);
    expect(page.snapshot.events).toEqual(
      snapshot.events.slice(page.page.eventOffset, page.page.eventEnd),
    );
    expect(page.snapshot.events.every((item) => item.turn === 3)).toBe(true);
    expect(page.page).toMatchObject({
      messageOffset: 4,
      messageEnd: 6,
      totalMessages: 6,
      firstTurn: 3,
      hasMore: true,
    });
    expect(page.page.eventOffset).toBeGreaterThan(0);
    expect(page.page.eventEnd).toBe(snapshot.events.length);
    expect(page.page.usageBefore).toBeDefined();
  });

  it("walks before cursors backwards one complete turn at a time without gaps or repeats", () => {
    const snapshot = buildTurns([
      { prompt: "one", reply: "one answer" },
      { prompt: "two", reply: "two answer" },
      { prompt: "three", reply: "three answer" },
    ]);
    const latest = paginateSession(snapshot);
    const second = paginateSession(snapshot, {
      before: latest.page.messageOffset,
    });
    const first = paginateSession(snapshot, {
      before: second.page.messageOffset,
    });

    expect(contents(first.snapshot)).toEqual(["one", "one answer"]);
    expect(contents(second.snapshot)).toEqual(["two", "two answer"]);
    expect(contents(latest.snapshot)).toEqual(["three", "three answer"]);
    expect([first, second, latest].map((page) => page.page.firstTurn)).toEqual([
      1, 2, 3,
    ]);
    expect([first, second, latest].map((page) => page.page.hasMore)).toEqual([
      false,
      true,
      true,
    ]);
    expect([
      ...first.snapshot.messages,
      ...second.snapshot.messages,
      ...latest.snapshot.messages,
    ]).toEqual(snapshot.messages);
    expect([
      ...first.snapshot.events,
      ...second.snapshot.events,
      ...latest.snapshot.events,
    ]).toEqual(snapshot.events);
    expect(second.page.messageEnd).toBe(latest.page.messageOffset);
    expect(first.page.messageEnd).toBe(second.page.messageOffset);
    expect(second.page.eventEnd).toBe(latest.page.eventOffset);
    expect(first.page.eventEnd).toBe(second.page.eventOffset);
    expect(() => paginateSession(snapshot, { before: 0 })).toThrow(ForgeError);
  });

  it("from refreshes the loaded window through the tail, including later turns", () => {
    const snapshot = buildTurns([
      { prompt: "one", reply: "one answer" },
      { prompt: "two", reply: "two answer" },
      { prompt: "three", reply: "three answer" },
    ]);
    const latest = paginateSession(snapshot);
    const second = paginateSession(snapshot, {
      before: latest.page.messageOffset,
    });
    const refreshed = paginateSession(snapshot, {
      from: second.page.messageOffset,
    });

    expect(contents(refreshed.snapshot)).toEqual([
      "two",
      "two answer",
      "three",
      "three answer",
    ]);
    expect(refreshed.snapshot.messages).toEqual(
      snapshot.messages.slice(second.page.messageOffset),
    );
    expect(refreshed.snapshot.events).toEqual(
      snapshot.events.slice(second.page.eventOffset),
    );
    expect(refreshed.page).toMatchObject({
      messageOffset: second.page.messageOffset,
      eventOffset: second.page.eventOffset,
      messageEnd: snapshot.messages.length,
      eventEnd: snapshot.events.length,
      firstTurn: 2,
      hasMore: true,
    });
    expect(refreshed.page.usageBefore).toBeDefined();

    const whole = paginateSession(snapshot, { from: 0 });
    expect(whole.snapshot.messages).toEqual(snapshot.messages);
    expect(whole.snapshot.events).toEqual(snapshot.events);
    expect(whole.page).toMatchObject({
      messageOffset: 0,
      firstTurn: 1,
      hasMore: false,
    });
    expect(whole.page.usageBefore).toBeUndefined();
  });

  it("keeps multi-step tool exchanges and steering user messages in one turn", () => {
    const snapshot = buildTurns([
      {
        prompt: "build it",
        reply: "final answer",
        steps: 2,
        steering: ["please also verify"],
        tool: { result: "tool output" },
      },
    ]);
    const page = paginateSession(snapshot);
    expect(contents(page.snapshot)).toEqual([
      "build it",
      "final answer step 1",
      "please also verify",
      "final answer",
    ]);
    expect(page.page).toMatchObject({
      messageOffset: 0,
      messageEnd: 4,
      firstTurn: 1,
      hasMore: false,
    });
    expect(
      page.snapshot.events.filter((item) => item.type === "run_started"),
    ).toHaveLength(1);
    expect(page.snapshot.events).toEqual(snapshot.events);
  });

  it("numbers legacy turns stably when run_started has no messageIndex", () => {
    const snapshot = buildTurns([
      { prompt: "legacy one", reply: "legacy answer one", legacy: true },
      { prompt: "legacy two", reply: "legacy answer two", legacy: true },
    ]);
    const latest = paginateSession(snapshot);
    const previous = paginateSession(snapshot, {
      before: latest.page.messageOffset,
    });
    expect(contents(previous.snapshot)).toEqual([
      "legacy one",
      "legacy answer one",
    ]);
    expect(contents(latest.snapshot)).toEqual([
      "legacy two",
      "legacy answer two",
    ]);
    expect(previous.page.firstTurn).toBe(1);
    expect(latest.page.firstTurn).toBe(2);
    expect(previous.page.eventEnd).toBe(latest.page.eventOffset);
    expect(latest.page.eventEnd).toBe(snapshot.events.length);
    expect(paginateSession(snapshot).page.firstTurn).toBe(2);
  });

  it("returns empty and partial sessions without losing arrived records", () => {
    const empty = sessionSnapshotSchema.parse({
      version: 1,
      id: sessionId,
      title: "empty",
      workspace: "/tmp/paged-session",
      model: "test-model",
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "idle",
      messages: [],
      events: [],
      changes: [],
    });
    expect(paginateSession(empty)).toMatchObject({
      snapshot: { messages: [], events: [], changes: [] },
      page: {
        messageOffset: 0,
        eventOffset: 0,
        messageEnd: 0,
        eventEnd: 0,
        totalMessages: 0,
        firstTurn: 1,
        hasMore: false,
      },
    });
    expect(paginateSession(empty, { from: 0 }).snapshot.messages).toEqual([]);

    const ahead = sessionSnapshotSchema.parse({
      ...buildTurns([
        { prompt: "persisted prompt", reply: "persisted reply" },
        { prompt: "placeholder", reply: "placeholder" },
      ]),
      messages: [
        { role: "user", content: "persisted prompt" },
        { role: "assistant", content: "persisted reply" },
      ],
    });
    const secondStart = ahead.events.findLastIndex(
      (item) => item.type === "run_started" && item.turn === 2,
    );
    const partial = sessionSnapshotSchema.parse({
      ...ahead,
      messages: [
        { role: "user", content: "persisted prompt" },
        { role: "assistant", content: "persisted reply" },
      ],
      events: ahead.events.slice(0, secondStart + 2),
    });
    const page = paginateSession(partial);
    // run_started (and possibly a step event) arrived before the user message
    // was persisted. The future marker is merged into the last durable turn so
    // the default page still shows the conversation instead of an empty tail.
    expect(page.snapshot.messages).toEqual([
      { role: "user", content: "persisted prompt" },
      { role: "assistant", content: "persisted reply" },
    ]);
    expect(page.snapshot.events).toEqual(partial.events);
    expect(page.page).toMatchObject({
      messageOffset: 0,
      messageEnd: 2,
      totalMessages: 2,
      eventOffset: 0,
      eventEnd: partial.events.length,
      firstTurn: 1,
      hasMore: false,
    });
    expect(page.page.usageBefore).toBeUndefined();

    // A stale client whose cursor still points at the future message boundary
    // gets the durable preceding turn instead of an empty page or a stall.
    const fromFuture = paginateSession(partial, { from: 2 });
    expect(fromFuture.page.messageOffset).toBe(0);
    expect(fromFuture.snapshot.messages).toEqual(page.snapshot.messages);
    expect(fromFuture.snapshot.events).toEqual(page.snapshot.events);
    const beforeFuture = paginateSession(partial, { before: 2 });
    expect(beforeFuture.page.messageOffset).toBe(0);
    expect(beforeFuture.snapshot.messages).toEqual(page.snapshot.messages);
    expect(beforeFuture.page.eventEnd).toBe(secondStart);

    // Once the user message lands the marker becomes the latest normal turn and
    // can be prepended one turn at a time without losing the prior turn.
    const landed = sessionSnapshotSchema.parse({
      ...partial,
      messages: [
        ...partial.messages,
        { role: "user", content: "landed prompt" },
      ],
    });
    const latest = paginateSession(landed);
    expect(latest.snapshot.messages).toEqual([
      { role: "user", content: "landed prompt" },
    ]);
    expect(latest.page).toMatchObject({
      messageOffset: 2,
      messageEnd: 3,
      firstTurn: 2,
      hasMore: true,
    });
    expect(latest.page.eventOffset).toBe(secondStart);
    expect(latest.page.usageBefore).toBeDefined();
    const previous = paginateSession(landed, {
      before: latest.page.messageOffset,
    });
    expect(previous.snapshot.messages).toEqual(page.snapshot.messages);
    expect(previous.page.messageOffset).toBe(0);
    expect(previous.page.messageEnd).toBe(latest.page.messageOffset);
    expect(previous.page.eventEnd).toBe(latest.page.eventOffset);
    expect(previous.page.firstTurn).toBe(1);
  });

  it("keeps the prior turn when a future run marker precedes its user message", () => {
    const ahead = buildTurns([
      { prompt: "one", reply: "one answer" },
      { prompt: "two", reply: "two answer" },
      { prompt: "three", reply: "three answer" },
    ]);
    const secondStart = ahead.events.findLastIndex(
      (item) => item.type === "run_started" && item.turn === 2,
    );
    const thirdStart = ahead.events.findLastIndex(
      (item) => item.type === "run_started" && item.turn === 3,
    );
    const partial = sessionSnapshotSchema.parse({
      ...ahead,
      messages: ahead.messages.slice(0, 4),
      events: ahead.events.slice(0, thirdStart + 1),
    });

    const page = paginateSession(partial);
    expect(contents(page.snapshot)).toEqual(["two", "two answer"]);
    expect(page.page).toMatchObject({
      messageOffset: 2,
      messageEnd: 4,
      totalMessages: 4,
      eventOffset: secondStart,
      eventEnd: partial.events.length,
      firstTurn: 2,
      hasMore: true,
    });
    expect(page.page.eventOffset).toBeGreaterThan(0);
    expect(page.snapshot.events.at(-1)?.type).toBe("run_started");
    expect(page.page.usageBefore).toBeDefined();

    const previous = paginateSession(partial, {
      before: page.page.messageOffset,
    });
    expect(contents(previous.snapshot)).toEqual(["one", "one answer"]);
    expect(previous.page.messageOffset).toBe(0);
    expect(previous.page.eventEnd).toBe(page.page.eventOffset);
    expect(page.page.messageOffset).not.toBe(previous.page.messageOffset);
    expect([...previous.snapshot.messages, ...page.snapshot.messages]).toEqual(
      partial.messages,
    );
    expect([...previous.snapshot.events, ...page.snapshot.events]).toEqual(
      partial.events,
    );

    const refreshed = paginateSession(partial, { from: 4 });
    expect(refreshed.page.messageOffset).toBe(page.page.messageOffset);
    expect(contents(refreshed.snapshot)).toEqual(contents(page.snapshot));
  });

  it("does not drop user messages that precede the first run_started", () => {
    const snapshot = sessionSnapshotSchema.parse({
      version: 1,
      id: sessionId,
      title: "legacy preamble",
      workspace: "/tmp/paged-session",
      model: "test-model",
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "idle",
      messages: [
        { role: "user", content: "preamble user message" },
        { role: "assistant", content: "preamble answer" },
        { role: "user", content: "next prompt" },
        { role: "assistant", content: "next answer" },
      ],
      events: [
        event({
          type: "run_started",
          turn: 2,
          messageIndex: 2,
          model: "test-model",
          permission: "unrestricted",
        }),
        event({
          type: "run_finished",
          turn: 2,
          status: "completed",
          turns: 1,
          toolCalls: 0,
        }),
      ],
      changes: [],
    });
    const whole = paginateSession(snapshot, { from: 0 });
    expect(whole.snapshot.messages).toEqual(snapshot.messages);
    expect(whole.snapshot.events).toEqual(snapshot.events);
    const latest = paginateSession(snapshot);
    expect(latest.page.firstTurn).toBe(2);
    expect(contents(latest.snapshot)).toEqual(["next prompt", "next answer"]);
  });

  it.each([
    [{ before: 1 }, "inside an earlier turn"],
    [{ from: 3 }, "inside a later turn"],
    [{ from: 999 }, "past the durable log"],
    [{ before: 999 }, "an unknown boundary"],
  ])("rejects invalid cursors %j (%s)", (cursor, _description) => {
    const snapshot = buildTurns([
      { prompt: "one", reply: "one answer" },
      { prompt: "two", reply: "two answer" },
      { prompt: "three", reply: "three answer" },
    ]);
    expect(() => paginateSession(snapshot, cursor)).toThrow(ForgeError);
    expect(() => paginateSession(snapshot, cursor)).toThrow(/cursor|boundary/i);
  });

  it("validates request shape, mutual exclusion and nonnegative integers", () => {
    expect(sessionPageRequestSchema.safeParse({}).success).toBe(true);
    expect(sessionPageRequestSchema.safeParse({ before: 0 }).success).toBe(
      true,
    );
    expect(sessionPageRequestSchema.safeParse({ from: 0 }).success).toBe(true);
    expect(
      sessionPageRequestSchema.safeParse({ before: 1, from: 1 }).success,
    ).toBe(false);
    expect(sessionPageRequestSchema.safeParse({ before: -1 }).success).toBe(
      false,
    );
    expect(sessionPageRequestSchema.safeParse({ from: 1.5 }).success).toBe(
      false,
    );
    const snapshot = buildTurns([{ prompt: "one", reply: "one answer" }]);
    expect(() => paginateSession(snapshot, { before: 0, from: 0 })).toThrow(
      ForgeError,
    );
    expect(() => paginateSession(snapshot, { from: -1 })).toThrow(ForgeError);
    expect(() => paginateSession(snapshot, { before: 0.5 })).toThrow(
      ForgeError,
    );
  });
});
