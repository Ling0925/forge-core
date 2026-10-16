import { toolResultSchema, type Message } from "../shared/schemas";

/** Cache-friendly request projection: each result has the same representation
 * from its first send onward. Appending messages cannot rewrite an old prefix.
 * Persisted transcripts, events, checkpoints and provider continuation stay intact. */
export function projectToolContext(messages: readonly Message[]): readonly Message[] {
  const names = new Map<string, string>();
  return messages.map((message): Message => {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
      // Persisted display-only reasoning is never sent to the provider.
      if (message.reasoning === undefined) return message;
      const { reasoning: _reasoning, ...rest } = message;
      return rest;
    }
    if (message.role !== "tool") return message;
    const nativeEdit = ["write_file", "edit_file"].includes(names.get(message.tool_call_id) ?? "");
    if (!nativeEdit) return message;
    let raw: unknown;
    try { raw = JSON.parse(message.content); }
    catch { return message; }
    const parsed = toolResultSchema.safeParse(raw);
    if (!parsed.success) return message;
    const result = parsed.data;
    if (result.isError || !result.changes?.length) return message;
    return {
      ...message,
      content: JSON.stringify({
        content: result.content,
        isError: result.isError,
        changes: result.changes.map((change) => ({
          path: change.path,
          kind: change.kind,
        })),
        contextNote:
          "File diff details omitted from model context (not backups). Full tool event and configured checkpoints are retained; read the file if current content is needed.",
      }),
    };
  });
}
