import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../src/shared/schemas";
import { commandActivity, toolActivity } from "../../src/shared/tool-activity";

const call = (name: string, args: unknown): ToolCall => ({
  id: "tool-1",
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

describe("tool activity description", () => {
  it("surfaces a bounded scalar target for common tools", () => {
    expect(
      toolActivity(call("read_file", { path: "src/a.ts", content: "BODY" })),
    ).toEqual({ name: "read_file", target: "src/a.ts" });
    expect(toolActivity(call("search_files", { query: "needle" })).target).toBe(
      "needle",
    );
    expect(
      toolActivity(call("browser_navigate", { url: "https://x.test" })).target,
    ).toBe("https://x.test");
  });

  it("redacts command secrets and never leaks file bodies", () => {
    const activity = toolActivity(
      call("run_command", { argv: ["node", "--password", "SECRET"] }),
    );
    expect(activity.target).toBe("node --password [REDACTED]");
    expect(activity.target).not.toContain("SECRET");
    expect(
      toolActivity(call("write_file", { path: "a.ts", content: "PRIVATE" }))
        .target,
    ).toBe("a.ts");
  });

  it("omits the target rather than dumping JSON when no scalar key exists", () => {
    expect(
      toolActivity(call("update_plan", { steps: [{ step: "x" }] })).target,
    ).toBe("");
    expect(
      toolActivity({
        ...call("read_file", {}),
        function: { name: "read_file", arguments: "not json" },
      }).target,
    ).toBe("");
  });

  it("formats command_task activity targets cleanly with action and short id", () => {
    expect(
      toolActivity(
        call("command_task", {
          action: "wait",
          id: "aa118abe-d428-4184-bd72-c45459a6eb79",
        }),
      ),
    ).toEqual({ name: "command_task", target: "等待完成 · #aa118abe" });

    expect(
      toolActivity(call("command_task", { action: "list" })),
    ).toEqual({ name: "command_task", target: "任务列表" });
  });

  it("returns the redacted command and cwd for command tools only", () => {
    expect(
      commandActivity(
        call("run_command", { argv: ["node", "--token", "x"], cwd: "/w" }),
      ),
    ).toEqual({ command: "node --token [REDACTED]", cwd: "/w" });
    expect(commandActivity(call("read_file", { path: "a.ts" })).command).toBe(
      "",
    );
  });
});
