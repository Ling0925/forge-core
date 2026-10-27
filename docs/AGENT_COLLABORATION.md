# 可配置智能体与 advisor 协作

Core 提供角色配置持久化、按角色创建子任务和运行内双向答疑。角色不是额外权限，也不是新用户指令。本页描述 Core API 与运行时；Web 设置编辑器和专用答疑界面需由客户端接入这些契约。

## 角色配置

浏览器安全的契约位于 `@forge/core/shared/agent-profiles`。`PublicSettings.agentProfiles` 返回列表；旧配置没有该字段时按空列表处理，不自动安装模板。`agentProfileTemplates` 提供探索、前端、后端、审查四个可显式添加的模板，模板默认继承主代理模型，不内置特定供应商。

每个角色包含：

- `id`、`name`、`description`、`whenToUse`、`instructions`、`enabled`；ID 为小写字母开头的字母、数字、`_`、`-`，最多 64 字符。
- `model: { mode: "inherit" }` 或 `{ mode: "fixed", providerSourceId, model }`；固定 ID 原样保留，来源必须已配置，只保存来源标识，不复制密钥。
- `permission`：`readonly`、`workspace`、`unrestricted`，作为上限。
- `tools`：继承宿主可用工具，或限定 `read/edit/command/web/browser/mcp/memory` 工具组。MCP 还必须明确列出 `mcpServers`。
- `isolation`：默认 `shared` 或 `worktree`；调用时可明确覆盖，readonly 不创建工作树。
- `revision`：保存后的版本号，由存储生成；输入不自行填写它。

宿主通过既有 `updateSettings(ConfigureInput)` 做单项更新，例如：

```ts
import { agentProfileTemplates } from "@forge/core/shared/agent-profiles";

const settings = await harness.updateSettings({
  agent: {
    type: "save",
    profile: { ...agentProfileTemplates[0]!, id: "explore-code", name: "代码探索" },
    expectedRevision: 0,
  },
});
const saved = settings.agentProfiles!.find(profile => profile.id === "explore-code")!;
await harness.updateSettings({
  agent: { type: "remove", id: saved.id, expectedRevision: saved.revision },
});
```

新建须 `expectedRevision: 0`；修改/删除须携带上次读取的 revision。冲突不覆盖对方，客户端应保留草稿、刷新后让用户决定。删除再建同 ID 不会复用旧 revision。最多 64 个角色；普通 settings patch 不能整组替换角色列表。角色与来源操作不能混在同一个请求中；被固定角色引用的来源不能直接删除，应先修改/删除角色。

## 主代理派发

1. `list_agent_profiles({ query?, offset?, limit? })` 返回已启用角色的有界摘要，不返回长角色指令。
2. 选择用途匹配的角色，调用 `spawn_agent({ task, profileId, profileRevision?, ownership?, writePaths?, isolation? })`。
3. Core 在创建前重新读取目录，拒绝不存在、停用或版本不符的角色。主代理只收到摘要；选中角色的完整配置复制进子会话 `agentProfile`，角色指令仅加载到该子任务。
4. 固定模型绑定精确来源及模型 ID；继承模式继承父会话的来源/模型。传入不同的 `model` 与角色选择冲突时直接拒绝，不自行换模型、来源或回退。
5. 旧的、不带 `profileId` 的 `spawn_agent` 仍可使用。配置修改仅影响后续派发，不改变运行中或历史会话的角色快照。

有效权限为父运行当前权限、子会话创建时上限及角色上限的交集。父运行后续降权也会收紧子任务。工具组既过滤模型可见列表，也在实际执行前检查（含并发读取和 MCP alias）；伪造工具调用不能绕过。角色不含 `web` 时关闭 Provider 托管搜索。子代理不暴露父级管理工具，不能再派发或回答别的子任务。

这些限制不是进程或文件系统沙箱：允许 `command` 后仍由宿主权限/审批与项目约束管理命令效果，`writePaths` 是协作范围声明而非 OS 隔离。角色指令、advisor 回答、工具注解都不能扩大权限。角色会话不运行 Harness 自适应探测，以免绕过其工具范围。

## 子代理答疑

子代理调用：

```json
{
  "question": "两个调用方的返回值约定不同，应兼容哪一版？",
  "context": "已检查接口和两个现有测试，尚未修改代码。",
  "options": ["保留旧契约", "统一到新契约"],
  "recommendation": "先兼容旧契约，再单独迁移",
  "timeout_ms": 600000
}
```

工具名是 `advisor`。它必须是当前模型响应中**唯一**工具调用；与读取、写入或其他工具混在同一批次时，整批返回错误且全部不执行。每个子代理同时最多一个待答请求；默认等待 10 分钟，可设 1 秒至 30 分钟。

Core 从运行内绑定获取父会话、父 run、子会话及 tool call 身份，模型不提交这些标识。请求提交到父会话的单写入 journal 后才通知主代理。

- 主代理在推理中：不打断或重发已经在途的模型请求；在下一个安全边界加入一条标为内部协调的消息。
- 主代理在 `wait_agents` 中：任何当前子代理的待答问题均会唤醒等待，即使等待列表没选中提问者。结果为 `{ reason: "advisor", requests: [第一条], pendingCount, waitingIds }`；此时不把子任务结果标记成已交付。
- 主代理准备结束：自动收尾等待同样可被问题唤醒，不会与等答案的子代理互相死等。

主代理使用 `answer_advisor({ requestId, answer, nextInstruction? })` 答复。它只能回答当前运行内的请求；先持久化，再唤醒原子代理。相同回复幂等，不同回复冲突。子代理把工具结果写入自己的历史后，单独确认 `deliveredAt`；因此“已答复”与“已投递”不是一个状态。下一步指令是指导，不是权限变更。需要停止子任务时使用 `cancel_agent`。

## 持久化、恢复与客户端

`@forge/core/shared/agent-coordination` 定义 `AdvisorRequest`：`pending/answered/cancelled/expired/interrupted`，包括问题、背景、选项、建议、答复、可选下一步和投递时间。

- 父会话 `advisorRequests` 保存规范记录，`advisor_update` 事件用于实时更新；同 ID 覆盖其状态，不重复创建卡片。
- `SessionSummary.agentProfileId/agentProfileName` 便于列表显示；完整角色快照在 `SessionSnapshot.agentProfile`。
- 请求/回答/确认与标题、插话、模型/工具结果共用父会话单 writer；答疑通知不插到尚未闭合的 assistant/tool 交换中。内部通知复用 `agent_reconciliation` 来源，不算新的人类回合。
- 子任务取消或父任务结束会释放等待；超时不是同意。保存失败不发布成功通知、不授权子代理继续。
- 恢复父会话时，原先 pending 的请求记为 interrupted；不会恢复旧 waiter、重跑工具或隐式重启子代理。旧回答即使没有投递确认也不会自动再次发送。
- 客户端看到历史 pending 记录但父运行已不在线时，应显示不可控制/中断，而不能假装仍在实时等待。缺失新字段的旧会话照常可读。

## 聚焦验证

- `tests/store/agent-profile-settings.test.ts`：旧配置、CRUD、冲突、来源引用、并发及事务回滚。
- `tests/core/agent-profiles.test.ts`：角色发现、派发快照、精确模型来源、权限及执行工具限制。
- `tests/core/advisor.test.ts`：绑定、幂等、并发、持久化顺序、超时、取消及失效请求。
- `tests/core/agent-runtime-advisor.test.ts`：真实运行时的等待/收尾唤醒、结果闭合、投递确认、混合批次拒绝和恢复。

这些测试使用临时存储及假 Provider，不需要真实模型或用户密钥。
