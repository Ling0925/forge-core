import { expect, it } from "vitest";
import type { Message } from "../../src/shared/schemas";
import { projectToolContext } from "../../src/core/tool-context";
import { assertBoundary, projectSummary } from "../../src/core/context";
import { sessionSnapshotSchema } from "../../src/shared/schemas";
import { measureContext } from "../../src/shared/context-usage";

it("applies the same projection after saved semantic memory without touching the snapshot", () => {
  const snapshot = sessionSnapshotSchema.parse({ version: 1, id: "12345678-1234-4234-8234-123456789abc", title: "test", workspace: "/workspace", model: "test", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", status: "idle", events: [], changes: [], messages: [{role:"user",content:"old"},{role:"assistant",content:"done"},{role:"user",content:"current"},...exchange("new")], contextSummary: {content:"memory",boundary:2,fallback:false} });
  const original = JSON.stringify(snapshot);
  const projected = projectSummary(snapshot);
  expect(projected[0]?.content).toContain("memory");
  expect(projected.filter(message => message.role === "tool")).toHaveLength(1);
  expectProjectedEdit(projected, "new");
  expect(JSON.stringify(snapshot)).toBe(original);
  expect(projectToolContext(projected)).toEqual(projected);
});


function expectProjectedEdit(messages: readonly Message[], id: string) {
  const results = messages.filter(message => message.role === "tool" && message.tool_call_id === id);
  expect(results).toHaveLength(1);
  const result = results[0]; if (!result || result.role !== "tool") throw new Error("Missing tool result");
  const parsed = JSON.parse(result.content);
  expect(parsed).toMatchObject({ content: '{"edited":true}', isError: false, changes: [{ path: "file.ts", kind: "modified" }], contextNote: expect.stringMatching(/\S/) });
  expect(parsed.changes).toHaveLength(1);
  for (const key of ["patch", "before", "after"]) expect(parsed.changes[0]).not.toHaveProperty(key);
  expect(messages.filter(message => message.role === "assistant" && message.tool_calls?.some(call => call.id === id))).toHaveLength(1);
}

function exchange(id: string, name = "edit_file", error = false): Message[] {
  return [{role:"assistant",content:null,tool_calls:[{id,type:"function",function:{name,arguments:'{"path":"file.ts","old_text":"a","new_text":"b"}'}}]},
    {role:"tool",tool_call_id:id,content:JSON.stringify({content:JSON.stringify({edited:true}),isError:error,changes:[{path:"file.ts",kind:"modified",patch:{version:1,status:"complete",added:1,removed:1,omittedLines:0,omittedHunks:0,hunks:[{oldStart:1,oldLines:1,newStart:1,newLines:1,lines:[{op:"delete",text:"a".repeat(8000)},{op:"insert",text:"b".repeat(8000)}]}]}}]})}];
}
it("omits repeated edit patches only in requests, retaining calls and persisted evidence", () => {
  const messages: Message[] = [{role:"system",content:"rules"},{role:"user",content:"fix files"},...Array.from({length:60},(_,i)=>exchange(String(i))).flat()];
  const original = JSON.stringify(messages);
  const projected = projectToolContext(messages);
  expect(JSON.stringify(messages)).toBe(original);
  expect(projected).toHaveLength(messages.length);
  expect(projected[0]).toBe(messages[0]); expect(projected[2]).toBe(messages[2]);
  expect(()=>assertBoundary(projected,projected.length)).not.toThrow();
  expect(JSON.stringify(projected)).not.toContain("a".repeat(8000));
  expect(JSON.stringify(projected)).not.toContain("b".repeat(8000));
  expect(JSON.stringify(projected)).not.toContain('"patch"');
  expect(projected.filter(message => message.role === "tool")).toHaveLength(60);
  for (let i = 0; i < 60; i++) expectProjectedEdit(projected, String(i));
  const before = measureContext(messages,872000).usedTokens;
  const after = measureContext(projected,872000).usedTokens;
  expect(after).toBeLessThan(before * 0.1);
  console.info(`Synthetic 60 edits: estimated context ${before} -> ${after} tokens`);
});
it("preserves long results regardless of age and keeps every appended prefix byte-stable", () => {
  const messages: Message[] = [{role:"system",content:"stable rules"},{role:"user",content:"task"}];
  for (let i = 0; i < 24; i++) {
    const before = JSON.stringify(projectToolContext(messages));
    messages.push(...exchange(`edit-${i}`));
    messages.push({role:"tool",tool_call_id:`read-${i}`,content:JSON.stringify({content:"HEAD"+"x".repeat(20000)+"TAIL",isError:i===0})});
    const after = projectToolContext(messages);
    expect(JSON.stringify(after.slice(0, -3))).toBe(before);
    expect(after.at(-1)).toBe(messages.at(-1));
  }
  const projected = projectToolContext(messages);
  messages.forEach((message,index) => {
    if (message.role === "tool" && message.tool_call_id.startsWith("read-")) expect(projected[index]).toBe(message);
  });
  expect(projectToolContext(projected)).toEqual(projected);
});
it("leaves unknown envelopes, failed edits and non-edit change payloads untouched", () => {
  const messages: Message[] = [...exchange("bad","edit_file",true),...exchange("other","custom_tool"),{role:"tool",tool_call_id:"legacy",content:"raw legacy"}];
  const projected = projectToolContext(messages);
  expect(projected).toHaveLength(messages.length);
  projected.forEach((m,i)=>expect(m).toBe(messages[i]));
});

it("projects append diffs without altering persisted results", () => {
  const messages = exchange("append", "append_file");
  const original = JSON.stringify(messages);
  const projected = projectToolContext(messages);
  expectProjectedEdit(projected, "append");
  expect(JSON.stringify(projected)).not.toContain("a".repeat(8000));
  expect(JSON.stringify(projected)).not.toContain("b".repeat(8000));
  expect(JSON.stringify(messages)).toBe(original);
});
