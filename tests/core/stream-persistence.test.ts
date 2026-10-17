import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentRuntime } from "../../src/core/runtime";
import { ForgeError } from "../../src/shared/errors";
import {
  type AgentEvent,
  defaultPublicSettings,
} from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";

for (const fails of [false, true])
  it(`keeps live text with one durable representation (fails=${fails})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-stream-storage-"));
    try {
      const store = await openSessionStore(directory);
      const session = await store.create({
        workspace: directory,
        title: "stream",
        model: "fixture",
      });
      const events: AgentEvent[] = [];
      const text = "visible output ".repeat(1000);
      const runtime = createAgentRuntime({
        store,
        settings: defaultPublicSettings,
        tools: {
          definitions: [],
          execute: async () => ({ content: "unused", isError: true }),
          dispose: async () => {},
        },
        provider: {
          listModels: async () => [],
          complete: async (_messages, _tools, options) => {
            options.onText(text.slice(0, 9000));
            options.onText(text.slice(9000));
            if (fails)
              throw new ForgeError("provider", "Fixture interrupted stream");
            return { message: { role: "assistant", content: text } };
          },
        },
      });
      const result = await runtime.run(
        { sessionId: session.id, prompt: "stream this" },
        (event) => events.push(event),
        async () => false,
        new AbortController().signal,
      );
      expect(
        events
          .filter((event) => event.type === "text_delta")
          .map((event) => event.text)
          .join(""),
      ).toBe(text);
      const reopened = await (await openSessionStore(directory)).get(
        session.id,
      );
      expect(reopened).toEqual(result);
      expect(
        reopened.events.filter((event) => event.type === "text_delta"),
      ).toHaveLength(fails ? 1 : 0);
      expect(
        reopened.messages.filter(
          (message) => message.role === "assistant" && message.content === text,
        ),
      ).toHaveLength(fails ? 0 : 1);
      expect(result.status).toBe(fails ? "failed" : "completed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
