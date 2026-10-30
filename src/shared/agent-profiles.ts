import { z } from "zod";

export const agentProfileIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const agentToolGroupSchema = z.enum([
  "read",
  "edit",
  "command",
  "web",
  "browser",
  "mcp",
  "memory",
]);
export type AgentToolGroup = z.infer<typeof agentToolGroupSchema>;
export const agentToolGroups: readonly {
  id: AgentToolGroup;
  label: string;
  description: string;
}[] = [
  {
    id: "read",
    label: "读取与检索",
    description: "读取文件、搜索代码、Git 只读检查与项目上下文",
  },
  {
    id: "edit",
    label: "文件编辑",
    description: "创建、修改文件和目录；职责路径不是安全沙箱",
  },
  {
    id: "command",
    label: "命令执行",
    description: "构建、测试及进程管理，仍遵守宿主权限与审批",
  },
  {
    id: "web",
    label: "网络检索",
    description: "网页读取及 Provider 支持的原生搜索",
  },
  { id: "browser", label: "浏览器", description: "使用宿主已启用的隔离浏览器" },
  {
    id: "mcp",
    label: "MCP",
    description: "仅使用下方明确列出的、已启用的 MCP 服务器",
  },
  {
    id: "memory",
    label: "长期记忆",
    description: "检索和维护记忆，写入仍须遵守任务授权",
  },
];
export const agentToolPolicySchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("inherit") }).strict(),
    z
      .object({
        mode: z.literal("restricted"),
        groups: z
          .array(agentToolGroupSchema)
          .max(7)
          .refine(
            (items) => new Set(items).size === items.length,
            "工具组不能重复",
          ),
        mcpServers: z
          .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/))
          .max(32)
          .default([]),
      })
      .strict(),
  ])
  .readonly();
export type AgentToolPolicy = z.infer<typeof agentToolPolicySchema>;
export const agentModelSelectionSchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("inherit") }).strict(),
    z
      .object({
        mode: z.literal("fixed"),
        providerSourceId: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
        model: z.string().trim().min(1).max(256),
      })
      .strict(),
  ])
  .readonly();
export const agentProfileInputSchema = z
  .object({
    id: agentProfileIdSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(512),
    whenToUse: z.string().trim().min(1).max(1024),
    instructions: z.string().trim().min(1).max(16384),
    enabled: z.boolean(),
    model: agentModelSelectionSchema,
    permission: z.enum(["readonly", "workspace", "unrestricted"]),
    tools: agentToolPolicySchema,
    isolation: z.enum(["shared", "worktree"]),
  })
  .strict()
  .readonly();
export type AgentProfileInput = z.infer<typeof agentProfileInputSchema>;
export const agentProfileSchema = agentProfileInputSchema
  .unwrap()
  .extend({
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .readonly();
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export const agentProfilesSchema = z
  .array(agentProfileSchema)
  .max(64)
  .refine(
    (profiles) =>
      new Set(profiles.map((profile) => profile.id)).size === profiles.length,
    "智能体 ID 不能重复",
  )
  .readonly();
export const agentProfileOperationSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("save"),
        profile: agentProfileInputSchema,
        expectedRevision: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    z
      .object({
        type: z.literal("remove"),
        id: agentProfileIdSchema,
        expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  ])
  .readonly();
export type AgentProfileOperation = z.infer<typeof agentProfileOperationSchema>;

/** Templates are explicit user-created settings, not silently installed agents or model grants. */
export const agentProfileTemplates: readonly AgentProfileInput[] = [
  {
    id: "explorer",
    name: "探索",
    description: "定位代码、调用链、依赖和改动影响范围。",
    whenToUse: "不熟悉项目结构，或实现前需要调查现有机制、风险和相关测试时。",
    instructions:
      "先读适用的项目约定，聚焦检索相关实现与测试，不修改文件。交付文件位置、当前行为、约束、风险及建议。遇到影响结论的歧义，通过 advisor 向主代理提问，不猜测需求。",
    enabled: true,
    model: { mode: "inherit" },
    permission: "readonly",
    tools: { mode: "restricted", groups: ["read"], mcpServers: [] },
    isolation: "shared",
  },
  {
    id: "frontend",
    name: "前端设计与实现",
    description: "实现交互、页面、组件和样式，并验证实际渲染。",
    whenToUse: "需要界面设计、交互实现、响应式布局或前端缺陷修复时。",
    instructions:
      "先读项目界面规范与现有组件，复用设计语言，遵守分配的写入范围。先明确接口和状态，再实现及做真实渲染交互验证。接口或需求不明确时用 advisor 提问。交付改动、实际检查及未覆盖项，不将编译成功当作界面验收。",
    enabled: true,
    model: { mode: "inherit" },
    permission: "workspace",
    tools: {
      mode: "restricted",
      groups: ["read", "edit", "command", "browser"],
      mcpServers: [],
    },
    isolation: "shared",
  },
  {
    id: "backend",
    name: "后端实现",
    description: "实现接口、业务逻辑、存储与相关测试。",
    whenToUse: "接口约定已明确，需要独立实现后端功能或修复核心逻辑时。",
    instructions:
      "先检查相关调用方、存储边界和测试，在职责范围内实现最小完整变更。接口语义、兼容性或任务范围有关键歧义时用 advisor 提问。保留并发修改，交付实现位置、具体验证及阻塞项，不自动重放不确定的副作用。",
    enabled: true,
    model: { mode: "inherit" },
    permission: "workspace",
    tools: {
      mode: "restricted",
      groups: ["read", "edit", "command"],
      mcpServers: [],
    },
    isolation: "shared",
  },
  {
    id: "reviewer",
    name: "代码审查",
    description: "检查正确性、回归风险与遗漏，不直接改代码。",
    whenToUse: "实现完成后需要独立审阅，或需要评估一组变更风险时。",
    instructions:
      "阅读完整相关 diff、调用方和测试，按严重程度报告有证据的问题、位置和影响；区分事实与推断。默认不修改、不运行命令。不明确的需求可用 advisor 提问。没有发现问题也说明审查范围和未验证部分。",
    enabled: true,
    model: { mode: "inherit" },
    permission: "readonly",
    tools: { mode: "restricted", groups: ["read"], mcpServers: [] },
    isolation: "shared",
  },
];
