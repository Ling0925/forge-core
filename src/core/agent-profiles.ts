import type { AgentProfile, AgentToolGroup } from "../shared/agent-profiles";
import type { RunInput } from "../shared/schemas";
import { ForgeError } from "../shared/errors";

export function assertAgentModel(profile: AgentProfile | undefined, input: Pick<RunInput, "model" | "providerSourceId" | "routeGroupId">): void {
  if (profile?.model.mode === "fixed" &&
    ((input.model !== undefined && input.model !== profile.model.model) ||
      (input.providerSourceId !== undefined && input.providerSourceId !== profile.model.providerSourceId) ||
      input.routeGroupId !== undefined))
    throw new ForgeError("invalid_input", "This child has a fixed agent model. Create a new task to change its model selection.");
}

const intrinsic = new Set(["history_search", "history_read", "list_models", "create_plan", "update_plan", "advisor", "render_chart"]);
const groups: Readonly<Record<AgentToolGroup, ReadonlySet<string>>> = {
  read: new Set(["list_files", "read_file", "search_files", "project_context", "load_skill", "git_status", "git_diff", "git_log", "read_command_output"]),
  edit: new Set(["write_file", "edit_file", "append_file", "make_directory", "publish_file"]),
  command: new Set(["run_command", "command_task", "lsp"]),
  web: new Set(["web_fetch"]),
  browser: new Set(["browser_navigate", "browser_snapshot", "browser_read", "browser_click", "browser_fill", "browser_press", "browser_scroll", "browser_screenshot", "browser_close"]),
  mcp: new Set(["mcp_list_servers", "mcp_list_tools", "mcp_call_tool"]),
  memory: new Set(["search_memory", "get_memory", "update_memory", "del_memory", "forge_memory", "async_task"]),
};

/** Undefined args means model advertisement; execution always supplies parsed args. */
export function isAgentToolAllowed(profile: AgentProfile | undefined, name: string, args?: unknown): boolean {
  if (!profile || profile.tools.mode === "inherit") return true;
  if (intrinsic.has(name)) return true;
  const policy = profile.tools;
  const object = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  if (groups.mcp.has(name) || name.startsWith("mcp__")) {
    if (!policy.groups.includes("mcp") || !policy.mcpServers.length) return false;
    if (args === undefined || name === "mcp_list_servers") return true;
    if (name === "mcp_list_tools") return typeof object.server === "string" && policy.mcpServers.includes(object.server);
    const alias = name === "mcp_call_tool" ? object.toolName : name;
    if (typeof alias !== "string") return false;
    return policy.mcpServers.some(server => alias.startsWith(`mcp__${server}__`));
  }
  return policy.groups.some(group => groups[group].has(name));
}

export function agentAllowsWebSearch(profile: AgentProfile | undefined): boolean {
  return !profile || profile.tools.mode === "inherit" || profile.tools.groups.includes("web");
}

export function agentProfileSummary(profile: AgentProfile) {
  return { id: profile.id, revision: profile.revision, name: profile.name, description: profile.description,
    whenToUse: profile.whenToUse, model: profile.model, permission: profile.permission,
    tools: profile.tools, isolation: profile.isolation };
}
