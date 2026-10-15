import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const mode = process.argv[2] ?? "normal";
let buffer = Buffer.alloc(0);
let document;
let initialized = false;
const rejected = new Set();
let waitingQuery;
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
const send = (value) => {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(header.subarray(0, 8));
  process.stdout.write(Buffer.concat([header.subarray(8), body]));
};
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
function handle(message) {
  if ("error" in message) {
    rejected.add(message.id);
    if (waitingQuery && rejected.has("edit") && rejected.has("exec")) {
      const query = waitingQuery;
      waitingQuery = undefined;
      handle(query);
    }
    return;
  }
  if (message.method === "initialize") {
    if (mode === "oversize") { process.stdout.write("Content-Length: 1048577\r\n\r\n"); return; }
    if (mode === "header") { process.stdout.write("x".repeat(9000)); return; }
    if (mode === "malformed") { process.stdout.write("Content-Length: 2\r\n\r\nxx"); return; }
    if (mode === "hang") return;
    reply(message.id, { capabilities: { textDocumentSync: 1, ...(mode === "encoding" ? { positionEncoding: "utf-8" } : {}) } });
    return;
  }
  if (message.method === "initialized") { initialized = true; return; }
  if (message.method === "textDocument/didOpen") {
    document = message.params.textDocument;
    if (mode === "requests") {
      send({ jsonrpc: "2.0", id: "edit", method: "workspace/applyEdit", params: { edit: { changes: {} } } });
      send({ jsonrpc: "2.0", id: "exec", method: "workspace/executeCommand", params: { command: "unsafe" } });
    }
    return;
  }
  if (!message.method?.startsWith("textDocument/")) return;
  if (mode === "requests" && (!rejected.has("edit") || !rejected.has("exec"))) {
    waitingQuery = message;
    return;
  }
  if (mode === "query-hang") {
    writeFileSync(join(process.cwd(), "server.pid"), String(process.pid));
    return;
  }
  if (!initialized || !document || document.languageId !== "typescript" || document.text !== "const café = 1;\n") {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "real UTF-8 didOpen missing" } });
    return;
  }
  const root = dirname(fileURLToPath(document.uri));
  const locations = [
    { uri: document.uri, range },
    { uri: pathToFileURL(join(root, "..", "outside.ts")).href, range },
    { uri: pathToFileURL(join(root, ".env.ts")).href, range },
    { uri: pathToFileURL(join(root, "linked.ts")).href, range },
    { uri: pathToFileURL(join(root, "private", "hidden.ts")).href, range },
    { uri: "https://example.invalid/secret-token", range },
    { uri: document.uri, range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } } },
  ];
  if (mode === "long" && message.method === "textDocument/hover") {
    reply(message.id, { contents: Array.from({ length: 10 }, () => "\ud800".repeat(9000)) });
    return;
  }
  if (mode === "long" && message.method === "textDocument/documentSymbol") {
    reply(message.id, [{ name: "界".repeat(900), kind: 13, range, selectionRange: range }]);
    return;
  }
  switch (message.method) {
    case "textDocument/documentSymbol":
      reply(message.id, [{ name: "café", kind: 13, range, selectionRange: range,
        children: [{ name: "nested", kind: 13, range, selectionRange: range }] }]); break;
    case "textDocument/definition":
      reply(message.id, [{ targetUri: document.uri, targetRange: range, targetSelectionRange: range }]); break;
    case "textDocument/references": reply(message.id, locations); break;
    case "textDocument/hover":
      reply(message.id, { contents: { kind: "markdown", value: mode === "requests"
        ? `denied=${rejected.has("edit") && rejected.has("exec")};token=${process.env.LSP_TEST_TOKEN ?? "absent"};home=${!!process.env.HOME}`
        : "café secret-token https://example.invalid/secret-token file:///etc/passwd" } }); break;
  }
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length);
    buffer = buffer.subarray(end + 4 + length);
    handle(JSON.parse(body.toString("utf8")));
  }
});
