import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createModelProvider } from "../../src/provider/openai";
import type { ProviderConfig } from "../../src/shared/schemas";
import { openSettingsStore } from "../../src/store/settings";

it("persists effort and supplies provider configuration after reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-effort-"));
  try {
    const store = await openSettingsStore(directory);
    expect((await store.getPublic()).reasoningEffort).toBeUndefined();
    await store.update({
      settings: { baseUrl: "http://localhost/v1", reasoningEffort: "max" },
    });
    const reopened = await openSettingsStore(directory);
    expect((await reopened.getPublic()).reasoningEffort).toBe("max");
    expect((await reopened.getProviderConfig()).reasoningEffort).toBe("max");
    await reopened.update({ settings: { reasoningEffort: "default" } });
    expect((await store.getProviderConfig()).reasoningEffort).toBe("default");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const apiMode of ["chat-completions", "responses"] as const) {
  for (const effort of [
    undefined,
    "default",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ] as const) {
    it(`${apiMode} sends the correct reasoning field for ${effort}`, async () => {
      const bodies: Record<string, unknown>[] = [];
      const server = createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        bodies.push(JSON.parse(raw));
        if (apiMode === "responses") {
          const message = {
            type: "message",
            id: "msg_fixture",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "ok" }],
          };
          const event = (type: string, fields: object) =>
            `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
          response.setHeader("content-type", "text/event-stream");
          response.end(
            event("response.created", {
              response: { id: "resp_fixture", status: "in_progress" },
            }) +
              event("response.output_item.added", {
                output_index: 0,
                item: { ...message, status: "in_progress", content: [] },
              }) +
              event("response.output_text.delta", {
                output_index: 0,
                content_index: 0,
                item_id: "msg_fixture",
                delta: "ok",
              }) +
              event("response.output_text.done", {
                output_index: 0,
                content_index: 0,
                item_id: "msg_fixture",
                text: "ok",
              }) +
              event("response.output_item.done", {
                output_index: 0,
                item: message,
              }) +
              event("response.completed", {
                response: {
                  id: "resp_fixture",
                  status: "completed",
                  output: [message],
                },
              }),
          );
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
          }),
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Missing fixture address");
        const config: ProviderConfig = {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "",
          requestTimeoutMs: 3000,
          apiMode,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        };
        const provider = createModelProvider(config);
        const result = await provider.complete(
          [{ role: "user", content: "test" }],
          [],
          {
            model: "fixture-model",
            signal: new AbortController().signal,
            onText: () => {},
          },
        );
        expect(result.message.content).toBe("ok");
        expect(bodies).toHaveLength(1);
        const body = bodies[0];
        expect(body).toBeDefined();
        if (effort === undefined || effort === "default") {
          expect(body).not.toHaveProperty("reasoning");
          expect(body).not.toHaveProperty("reasoning_effort");
        } else if (apiMode === "responses") {
          expect(body).toHaveProperty("reasoning", { effort });
          expect(body).not.toHaveProperty("reasoning_effort");
        } else {
          expect(body).toHaveProperty("reasoning_effort", effort);
          expect(body).not.toHaveProperty("reasoning");
        }
      } finally {
        const closed = new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
        server.closeAllConnections();
        await closed;
      }
    });
  }
}
