import { expect, it } from "vitest";
import { providerConfigSchema, type ProviderConfig } from "../../src/shared/schemas";
import {
  applyExtraBody,
  createRequestOptions,
  requestHeaders,
} from "../../src/provider/request-options";

const config = (overrides: Record<string, unknown> = {}): ProviderConfig =>
  providerConfigSchema.parse({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test-secret",
    apiMode: "chat-completions",
    requestTimeoutMs: 60000,
    ...overrides,
  });

// Builders below intentionally bypass the schema to exercise the transport's
// own defence in depth against a hand-written or migrated settings file.
const raw = (overrides: Record<string, unknown>): ProviderConfig =>
  ({ ...config(), ...overrides }) as ProviderConfig;

it("derives the auth header from the protocol and never demands a key from a local server", () => {
  const chat = requestHeaders(config());
  expect(chat.Authorization).toBe("Bearer sk-test-secret");
  expect(chat["x-api-key"]).toBeUndefined();

  const anthropic = requestHeaders(config({ apiMode: "anthropic" }));
  expect(anthropic["x-api-key"]).toBe("sk-test-secret");
  expect(anthropic.Authorization).toBeNull();

  const gemini = requestHeaders(config({ apiMode: "gemini" }));
  expect(gemini["x-goog-api-key"]).toBe("sk-test-secret");

  const local = requestHeaders(config({ apiKey: "" }));
  expect(local.Authorization).toBeNull();
  expect(Object.keys(local)).toEqual(["Authorization"]);
});

it("honours every explicit auth mode, including an empty prefix", () => {
  expect(
    requestHeaders(config({ auth: { type: "bearer", prefix: "Token " } }))
      .Authorization,
  ).toBe("Token sk-test-secret");
  expect(
    requestHeaders(config({ auth: { type: "api-key" } }))["api-key"],
  ).toBe("sk-test-secret");
  expect(
    requestHeaders(
      config({ auth: { type: "header", header: "X-Custom", prefix: "" } }),
    )["X-Custom"],
  ).toBe("sk-test-secret");
  expect(
    requestHeaders(config({ auth: { type: "none" } })).Authorization,
  ).toBeNull();
  expect(() =>
    requestHeaders(raw({ auth: { type: "bearer" }, apiKey: "" })),
  ).toThrow(/needs a credential/);
});

it("lets an explicit header replace the generated credential header, case-insensitively", () => {
  const headers = requestHeaders(
    config({
      auth: { type: "bearer" },
      headers: { authorization: "Token explicit", "x-tenant": "a" },
    }),
  );
  expect(
    Object.entries(headers).find(
      ([name]) => name.toLowerCase() === "authorization",
    )?.[1],
  ).toBe("Token explicit");
  expect(headers["x-tenant"]).toBe("a");
});

it("refuses transport headers, malformed names and line breaks without echoing secrets", () => {
  expect(() => requestHeaders(raw({ headers: { host: "evil" } }))).toThrow(
    /reserved transport header/i,
  );
  expect(() =>
    requestHeaders(raw({ auth: { type: "header", header: "bad name" } })),
  ).toThrow(/header name is invalid/i);
  expect(() =>
    requestHeaders(raw({ headers: { "x-bad": "line\nbreak" } })),
  ).toThrow(/line break/i);

  let message = "";
  try {
    requestHeaders(
      raw({
        apiKey: "sk-never-echo-this",
        auth: { type: "header", header: "bad name" },
      }),
    );
  } catch (error) {
    message = String(error);
  }
  expect(message).not.toContain("sk-never-echo-this");
});

it("fills missing body fields, keeps the body's own, and only forces with !", () => {
  const body = { model: "m", temperature: 0.2, messages: [] };
  const filled = applyExtraBody(
    body,
    { temperature: 0.9, top_p: 0.5, metadata: { session: "${sessionId}" } },
    "session-1",
  ) as Record<string, unknown>;
  expect(filled.temperature).toBe(0.2);
  expect(filled.top_p).toBe(0.5);
  expect(filled.metadata).toEqual({ session: "session-1" });
  expect(body).toEqual({ model: "m", temperature: 0.2, messages: [] });

  const forced = applyExtraBody(body, { "!temperature": 1.1 });
  expect(forced.temperature).toBe(1.1);
});

it("validates extraBody once: a forced reserved field is refused, a plain one is left out", () => {
  expect(() =>
    createRequestOptions(config({ extraBody: { "!model": "other" } })),
  ).toThrow(/cannot force/);
  const options = createRequestOptions(
    config({ extraBody: { model: "other", stream: false, top_p: 0.5 } }),
  );
  expect(options.applyBody({ model: "m", stream: true })).toEqual({
    model: "m",
    stream: true,
    top_p: 0.5,
  });
});

it("resolves the proxy transport up front and names unsupported schemes", () => {
  const options = createRequestOptions(
    config({ proxyUrl: "http://127.0.0.1:7890" }),
  );
  expect(typeof options.fetch).toBe("function");
  expect(
    createRequestOptions(config({ proxyUrl: "" })).fetch,
  ).toBeUndefined();
  expect(() =>
    createRequestOptions(config({ proxyUrl: "socks5://127.0.0.1:1080" })),
  ).toThrow(/Only HTTP\(S\) proxies/);
});

it("merges extraBody before turning a Codex account's body into the Codex CLI shape", () => {
  const options = createRequestOptions(
    config({
      apiMode: "responses",
      account: { platform: "codex", accessToken: "account-token" },
      extraBody: {
        store: false,
        stream: true,
        tool_choice: "auto",
        text: { verbosity: "medium" },
      },
    }),
  );
  const body = options.applyBody(
    {
      model: "gpt-5-codex",
      input: "hi",
      max_output_tokens: 128,
      temperature: 0.3,
    },
    "session-1",
  ) as Record<string, unknown>;
  expect(body.stream).toBe(true);
  expect(body.store).toBe(false);
  expect(body.tool_choice).toBe("auto");
  expect(body.input).toEqual([
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    },
  ]);
  expect(body.max_output_tokens).toBeUndefined();
  expect(body.temperature).toBeUndefined();
  expect(body.text).toEqual({ verbosity: "medium" });
  expect(body.include).toContain("reasoning.encrypted_content");

  // A plain API-key source keeps the body it built.
  const direct = createRequestOptions(config({ apiMode: "responses" }));
  expect(direct.applyBody({ input: "hi", max_output_tokens: 128 })).toEqual({
    input: "hi",
    max_output_tokens: 128,
  });
});

it("derives no per-request headers outside a signed-in account", () => {
  expect(
    createRequestOptions(config()).headersFor({ messages: [] }),
  ).toEqual({});
});

const copilot = (await import("../../src/provider/accounts/copilot")) as {
  prepareCopilotHeaders?:
    | ((body: Record<string, unknown>) => Record<string, string>)
    | undefined;
};

it.skipIf(!copilot.prepareCopilotHeaders)(
  "derives Copilot's initiator and vision headers from the exact body sent",
  () => {
    const options = createRequestOptions(
      config({
        account: { platform: "copilot", accessToken: "copilot-token" },
      }),
    );
    expect(
      options.headersFor({ messages: [{ role: "user", content: "hi" }] })[
        "X-Initiator"
      ],
    ).toBe("user");
    expect(
      options.headersFor({ messages: [{ role: "tool", content: "out" }] })[
        "X-Initiator"
      ],
    ).toBe("agent");
    expect(
      options.headersFor({
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "data:x" } }],
          },
        ],
      })["Copilot-Vision-Request"],
    ).toBe("true");
  },
);
