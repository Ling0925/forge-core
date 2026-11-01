import { expect, it } from "vitest";
import { requestTimeout } from "../../src/host/request-timeout";

it.each([
  "compactSession",
  "listModels",
  "modelAccess",
  "browser",
  "startRun",
  "steerRun",
  "enqueueInput",
  "resumeInputs",
  "cancelSession",
  "getMcpHealth",
  "setMcpEnabled",
  "removeMcpServer",
  "checkPlugin",
  "configurePlugin",
  "getUsageStats",
] as const)("leaves %s to its operation lifetime", (method) => {
  expect(requestTimeout({ method })).toBeUndefined();
  expect(requestTimeout({ method }, 1)).toBeUndefined();
});

it("bounds only the acknowledgement when cancelling a run", () => {
  expect(requestTimeout({ method: "cancelRun", wait: true })).toBeUndefined();
  expect(requestTimeout({ method: "cancelRun" })).toBe(120000);
  expect(requestTimeout({ method: "cancelRun", wait: false }, 1)).toBe(1);
});

it.each([
  "getHostState",
  "getSettings",
  "updateSettings",
  "listSessions",
  "createSession",
  "getSession",
  "getSessionPage",
  "getPublishedFile",
  "getProjectContext",
  "listMcpServers",
  "registerMcpServer",
  "listPlugins",
  "listCheckpoints",
  "getCheckpointDiff",
  "restoreCheckpoint",
  "listWorkspaceEntries",
  "readWorkspaceFile",
  "forkSession",
  "renameSession",
  "archiveSession",
  "getDiagnostics",
  "listInputs",
  "cancelInput",
  "pauseInputs",
  "setRunPermission",
  "answerApproval",
] as const)("uses the configured short RPC deadline for %s", (method) => {
  expect(requestTimeout({ method })).toBe(120000);
  expect(requestTimeout({ method }, 1)).toBe(1);
});
