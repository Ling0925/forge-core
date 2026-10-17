import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentRuntime } from "../src/core/runtime";
import { measureContext } from "../src/shared/context-usage";
import { MAX_IMAGE_BYTES, imageAttachmentSchema } from "../src/shared/images";
import { defaultPublicSettings, messageSchema, parseSessionId, runInputSchema, type Message } from "../src/shared/schemas";
import { RunInputQueue } from "../src/renderer/state/run-input-queue";
import { openSessionStore } from "../src/store/sessions";

import { image } from "./fixtures/image";
const sessionId = parseSessionId("11111111-1111-4111-8111-111111111111");

it("accepts image-only inputs and old text messages, rejecting empty or unsafe attachments", () => {
  expect(runInputSchema.parse({ sessionId, prompt: "", images: [image] }).prompt).toBe("");
  expect(messageSchema.parse({ role: "user", content: "old" })).toEqual({ role: "user", content: "old" });
  for (const input of [{ sessionId, prompt: " " }, { sessionId, prompt: "", images: [] }, { sessionId, prompt: "x", images: Array(5).fill(image) }])
    expect(runInputSchema.safeParse(input).success).toBe(false);
  for (const dataUrl of ["https://example.test/image.png", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", image.dataUrl.replace("/png", "/jpeg"), `${image.dataUrl}=`, "data:image/png;base64,!!!!", `data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64")}`])
    expect(imageAttachmentSchema.safeParse({ ...image, dataUrl }).success).toBe(false);
});

it("retains image bytes through queue serialization, pause, resume and failed persistence rollback", () => {
  const queue = new RunInputQueue();
  queue.add({ sessionId, prompt: "first", images: [image] });
  const restored = RunInputQueue.restore(JSON.parse(JSON.stringify(queue.snapshot())));
  expect(restored.peek(sessionId)).toBeUndefined();
  restored.resume(sessionId);
  expect(restored.peek(sessionId)?.images).toEqual([image]);
  const rejected = restored.add({ sessionId, prompt: "", images: [image] });
  restored.remove(rejected);
  expect(restored.items(sessionId)).toHaveLength(1);
  expect(restored.peek(sessionId)?.prompt).toBe("first");
});

it("estimates vision context without counting base64 characters as text tokens", () => {
  const small = measureContext([{ role: "user", content: "", images: [image] }], 128000);
  const large = measureContext([{ role: "user", content: "", images: [{ ...image, dataUrl: image.dataUrl.repeat(1000) }] }], 128000);
  expect(small.usedTokens).toBe(large.usedTokens);
  expect(small.parts.conversation).toBe(2052);
});

it("persists images in initial and steering messages without copying them into later text steering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-image-store-"));
  try {
    const store = await openSessionStore(directory);
    const session = await store.create({ workspace: directory, title: "images", model: "vision" });
    let sent: readonly Message[] = [];
    const runtime = createAgentRuntime({ store, settings: defaultPublicSettings,
      provider: { listModels: async () => [], complete: async messages => {
        sent = messages;
        return { message: { role: "assistant", content: "image received" } };
      } },
      tools: { definitions: [], execute: async () => ({ content: "", isError: false }), dispose: async () => {} },
    });
    let drained = false;
    await runtime.run({ sessionId: session.id, prompt: "", images: [image] }, () => {}, async () => false, new AbortController().signal, {
      drainSteering: () => {
        if (drained) return [];
        drained = true;
        return [{ prompt: "look", images: [image] }, "text only"];
      },
    });
    const users = sent.filter(message => message.role === "user");
    expect(users).toEqual([
      { role: "user", content: "", images: [image] },
      { role: "user", content: "look", images: [image] },
      { role: "user", content: "text only" },
    ]);
    const reopened = await openSessionStore(directory);
    expect((await reopened.get(session.id)).messages.filter(message => message.role === "user")).toEqual(users);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
