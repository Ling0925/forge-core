import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import {
  DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES,
  type Delivery,
  jsonValueSchema,
} from "../shared";
import type { SuperAgentStore } from "../store";

export async function createGithubWebhook(options: {
  host?: string | undefined;
  port: number;
  maxBodyBytes?: number | undefined;
  secret: string;
  store: Pick<SuperAgentStore, "recordDelivery">;
  processDelivery(delivery: Delivery): Promise<unknown>;
  onError(error: unknown): void;
}) {
  const maxBodyBytes =
    options.maxBodyBytes ?? DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES;
  const operations = new Set<Promise<void>>();
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const reply = (status: number) => {
      response.writeHead(status);
      response.end();
    };
    if (request.method !== "POST") {
      reply(405);
      return;
    }
    const tooLarge = () => {
      request.pause();
      response.writeHead(413, { Connection: "close" });
      response.end(() => request.destroy());
    };
    if (Number(request.headers["content-length"]) > maxBodyBytes) {
      tooLarge();
      return;
    }
    const signature = request.headers["x-hub-signature-256"];
    if (
      typeof signature !== "string" ||
      !/^sha256=[\da-f]{64}$/i.test(signature)
    ) {
      reply(401);
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      length += chunk.length;
      if (length > maxBodyBytes) {
        tooLarge();
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks);
    const expected = createHmac("sha256", options.secret).update(raw).digest();
    if (
      !timingSafeEqual(
        expected,
        Buffer.from(signature.slice("sha256=".length), "hex"),
      )
    ) {
      reply(401);
      return;
    }
    const id = request.headers["x-github-delivery"];
    const event = request.headers["x-github-event"];
    if (typeof id !== "string" || !id || typeof event !== "string" || !event) {
      reply(400);
      return;
    }
    let payload: Delivery["payload"];
    try {
      payload = jsonValueSchema.parse(JSON.parse(raw.toString("utf8")));
    } catch {
      reply(400);
      return;
    }
    const delivery: Delivery = {
      id,
      event,
      payload,
      receivedAt: new Date().toISOString(),
      processedAt: null,
    };
    if (!(await options.store.recordDelivery(delivery))) {
      reply(409);
      return;
    }
    reply(202);
    await options.processDelivery(delivery);
  };
  const server = createServer((request, response) => {
    const operation = handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500);
        response.end();
      }
      options.onError(error);
    });
    operations.add(operation);
    void operation.finally(() => operations.delete(operation));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    server,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.all(operations);
    },
  };
}
