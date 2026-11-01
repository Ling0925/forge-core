import { z } from "zod";
import { ForgeError, type WorkItemStore } from "../shared";
import {
  type SuperAgentStore,
  boardApprovalSchema,
  type createBoardClient,
} from "../store";

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 60000;

const eventSchema = z.object({
  taskId: z.string().nullable(),
  type: z.string(),
  actor: z.string(),
  data: z.object({ approvalId: z.string().optional() }),
});

export function subscribeBoardEvents({
  client,
  url,
  projectId,
  store,
  workItems,
  engine,
}: {
  client: ReturnType<typeof createBoardClient>;
  url: string;
  projectId: string;
  store: Pick<SuperAgentStore, "getCursor" | "setCursor">;
  workItems: Pick<WorkItemStore, "get">;
  engine: {
    workChanged(id: string): Promise<void>;
    workClaimApproved(id: string): Promise<void>;
    reportBoardEventsFailure(error: unknown): void;
  };
}) {
  const controller = new AbortController();
  const { signal } = controller;
  const cursorKey = `superagent:board:${JSON.stringify([url, projectId])}`;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const run = async () => {
    let principal: string | undefined;
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    while (!signal.aborted) {
      try {
        if (!principal)
          principal = z
            .object({ principal: z.object({ id: z.string() }) })
            .parse(await client.json("/v1/me", { signal })).principal.id;
        const cursor = await store.getCursor(cursorKey);
        const response = await client.request(
          `/v1/events?${new URLSearchParams({ project: projectId })}`,
          {
            signal,
            headers: {
              Accept: "text/event-stream",
              ...(cursor ? { "Last-Event-ID": cursor } : {}),
            },
          },
        );
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        if (response.body) {
          const reader = response.body
            .pipeThrough(new TextDecoderStream())
            .getReader();
          let buffer = "";
          let id = "";
          let data: string[] = [];
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              buffer += chunk.value;
              for (;;) {
                const newline = buffer.indexOf("\n");
                if (newline === -1) break;
                const line = buffer.slice(0, newline).replace(/\r$/, "");
                buffer = buffer.slice(newline + 1);
                if (line === "") {
                  if (data.length) {
                    const event = eventSchema.parse(
                      JSON.parse(data.join("\n")),
                    );
                    if (
                      event.actor !== principal &&
                      event.taskId &&
                      (await workItems.get(event.taskId))
                    ) {
                      let claim = false;
                      if (event.type === "approval_approved") {
                        const approvals = await client.pages(
                          `/v1/approvals?${new URLSearchParams({
                            project: projectId,
                            task: event.taskId,
                            state: "approved",
                          })}`,
                          boardApprovalSchema,
                          { signal },
                        );
                        claim = approvals.some(
                          (approval) =>
                            approval.id === event.data.approvalId &&
                            approval.action === "claim",
                        );
                      }
                      if (claim) await engine.workClaimApproved(event.taskId);
                      else await engine.workChanged(event.taskId);
                    }
                    await store.setCursor(cursorKey, id);
                  }
                  data = [];
                } else if (line.startsWith("id:"))
                  id = line.slice(3).replace(/^ /, "");
                else if (line.startsWith("data:"))
                  data.push(line.slice(5).replace(/^ /, ""));
              }
            }
          } finally {
            await reader.cancel();
          }
        }
        if (!signal.aborted)
          throw new ForgeError("storage", "Board event stream ended.");
      } catch (error) {
        if (!signal.aborted) engine.reportBoardEventsFailure(error);
      }
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          reconnect = setTimeout(resolve, reconnectDelay);
        });
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      }
    }
  };
  const operation = run();
  return {
    async close() {
      controller.abort();
      clearTimeout(reconnect);
      wake?.();
      await operation;
    },
  };
}
