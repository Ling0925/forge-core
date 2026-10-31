import { describe, expect, it, vi } from "vitest";
import { estimateTokens, measureContext } from "../../src/shared/context-usage";
import type {
  ContextUsage,
  Message,
  ToolDefinition,
} from "../../src/shared/schemas";

function codePointEstimate(text: string): number {
  let weight = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    weight += code < 128 ? 0.25 : (code < 2048 ? 2 : code < 65536 ? 3 : 4) / 3;
  }
  return Math.ceil(weight);
}

function uncachedContext(
  messages: readonly Message[],
  windowTokens: number | null,
  tools: readonly ToolDefinition[] = [],
): ContextUsage {
  const parts = { instructions: 0, memory: 0, conversation: 0, tools: 0 };
  for (const message of messages) {
    const memory =
      message.role === "assistant" &&
      /^(Context memory \(|Earlier actions \()/.test(message.content ?? "");
    const category =
      message.role === "system"
        ? "instructions"
        : memory
          ? "memory"
          : message.role === "tool"
            ? "tools"
            : "conversation";
    parts[category] += 4 + codePointEstimate(message.content ?? "");
    if (message.role === "user")
      parts[category] += (message.images?.length ?? 0) * 2048;
    if (message.role === "assistant") {
      if (message.tool_calls?.length)
        parts.tools += codePointEstimate(JSON.stringify(message.tool_calls));
      if (message.providerState)
        parts.tools += codePointEstimate(
          JSON.stringify(message.providerState.output),
        );
    }
  }
  if (tools.length) parts.tools += codePointEstimate(JSON.stringify(tools));
  if (messages.length) parts.instructions += 3;
  return {
    windowTokens,
    usedTokens: Object.values(parts).reduce((a, b) => a + b, 0),
    parts,
    estimated: true,
    basis: "projected",
  };
}

function fixture() {
  const assistant: Extract<Message, { role: "assistant" }> = {
    role: "assistant",
    content: "Checking 中文 😀 \ud800",
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: { name: "inspect", arguments: '{"path":"中文.txt"}' },
      },
    ],
    providerState: {
      version: 1,
      apiMode: "responses",
      baseUrl: "http://localhost/v1",
      model: "fixture",
      output: [{ type: "reasoning", encrypted_content: "opaque 😀" }],
    },
  };
  const tools: ToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "inspect",
        description: "Inspect 中文 😀",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    },
  ];
  const messages: Message[] = [
    { role: "system", content: "Instructions" },
    { role: "assistant", content: "Context memory (earlier 中文)" },
    { role: "assistant", content: "Earlier actions (previous 😀)" },
    {
      role: "user",
      content: "Context memory (user text)",
      images: [{ name: "image.png", dataUrl: "data:image/png;base64,AAAA" }],
    },
    { role: "user", content: "" },
    assistant,
    { role: "tool", tool_call_id: "call-1", content: "Found \udfff" },
    { role: "assistant", content: null },
    { role: "assistant", content: "", tool_calls: [] },
    { role: "assistant", content: "ordinary conversation" },
  ];
  return { assistant, messages, tools };
}

describe("estimateTokens", () => {
  it.each([
    ["empty", ""],
    ["ASCII", "Hello, world!\n\t\0\u007f"],
    ["CJK", "中文、日本語、한국어"],
    ["two-byte boundaries", "\u0080\u07ff"],
    ["three-byte boundaries", "\u0800\uffff"],
    ["emoji", "😀🧑🏽‍💻🚀"],
    ["surrogate pair boundaries", "\ud800\udc00\udbff\udfff"],
    ["lone high surrogates", "\ud800a\udbff\ud800"],
    ["lone low surrogates", "\udc00a\udfff\udc00"],
    ["adjacent pairs and lone surrogates", "\ud800😀\udfff\udc00\udbff"],
    ["fractional summation", "ééé😀a中".repeat(1001)],
  ])("matches code-point iteration for %s", (_name, text) => {
    expect(estimateTokens(text)).toBe(codePointEstimate(text));
  });

  it("matches code-point iteration across every UTF-16 code unit", () => {
    const text = Array.from({ length: 65536 }, (_, code) =>
      String.fromCharCode(code),
    ).join("");
    expect(estimateTokens(text)).toBe(codePointEstimate(text));
  });
});

describe("measureContext", () => {
  it("matches uncached results for empty contexts and every message category", () => {
    const { messages, tools } = fixture();
    for (const windowTokens of [null, 128000]) {
      for (const definitions of [[], tools]) {
        for (let boundary = 0; boundary <= messages.length; boundary++) {
          const projected = messages.slice(boundary);
          const expected = uncachedContext(
            projected,
            windowTokens,
            definitions,
          );
          expect(measureContext(projected, windowTokens, definitions)).toEqual(
            expected,
          );
          expect(measureContext(projected, windowTokens, definitions)).toEqual(
            expected,
          );
        }
      }
    }
  });

  it("reuses estimates for shared messages and tool arrays without rescanning or serializing", () => {
    const { assistant, messages, tools } = fixture();
    const shared = [assistant, ...messages, assistant];
    const charCodeAt = vi.spyOn(String.prototype, "charCodeAt");
    const stringify = vi.spyOn(JSON, "stringify");
    const first = measureContext(messages, 128000, tools);
    const scans = charCodeAt.mock.calls.length;
    const serialized = stringify.mock.calls.map(([value]) => value);
    const repeated = measureContext([...messages], null, tools);
    const duplicated = measureContext(shared, 64000, tools);
    const repeatedScans = charCodeAt.mock.calls.length;
    const repeatedSerializations = stringify.mock.calls.length;
    charCodeAt.mockRestore();
    stringify.mockRestore();

    expect(scans).toBeGreaterThan(0);
    expect(serialized).toEqual([
      assistant.tool_calls,
      assistant.providerState?.output,
      tools,
    ]);
    expect(repeatedScans).toBe(scans);
    expect(repeatedSerializations).toBe(serialized.length);
    expect(first).toEqual(uncachedContext(messages, 128000, tools));
    expect(repeated).toEqual(uncachedContext(messages, null, tools));
    expect(duplicated).toEqual(uncachedContext(shared, 64000, tools));
  });

  it("recomputes estimates for replacement messages and tool arrays", () => {
    const { assistant, tools } = fixture();
    const original = measureContext([assistant], null, tools);
    const replacement: Message = {
      ...assistant,
      content: "Context memory (replacement 中文 😀)",
      tool_calls: [
        {
          id: "call-2",
          type: "function",
          function: { name: "inspect", arguments: '{"path":"other.txt"}' },
        },
      ],
      providerState: {
        ...assistant.providerState!,
        output: [{ type: "reasoning", encrypted_content: "new opaque state" }],
      },
    };
    const definitions: ToolDefinition[] = [
      {
        ...tools[0]!,
        function: { ...tools[0]!.function, description: "Updated description" },
      },
    ];
    const charCodeAt = vi.spyOn(String.prototype, "charCodeAt");
    const stringify = vi.spyOn(JSON, "stringify");
    const changed = measureContext([replacement], null, definitions);
    const scans = charCodeAt.mock.calls.length;
    const serialized = stringify.mock.calls.map(([value]) => value);
    const repeated = measureContext([replacement], null, definitions);
    const repeatedScans = charCodeAt.mock.calls.length;
    const repeatedSerializations = stringify.mock.calls.length;
    charCodeAt.mockRestore();
    stringify.mockRestore();

    expect(scans).toBeGreaterThan(0);
    expect(serialized).toEqual([
      replacement.tool_calls,
      replacement.providerState?.output,
      definitions,
    ]);
    expect(repeatedScans).toBe(scans);
    expect(repeatedSerializations).toBe(serialized.length);
    expect(changed).toEqual(uncachedContext([replacement], null, definitions));
    expect(changed).not.toEqual(original);
    expect(repeated).toEqual(changed);
    expect(measureContext([assistant], null, tools)).toEqual(original);
    expect(measureContext([replacement], null, tools)).toEqual(
      uncachedContext([replacement], null, tools),
    );
    expect(measureContext([assistant], null, definitions)).toEqual(
      uncachedContext([assistant], null, definitions),
    );
  });
});
