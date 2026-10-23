# Harness² 风格的策略预检

Forge Core 将 Harness² 的 **Propose → Probe → Compose** 和有证据的经验复用接到现有运行时。这里是独立的 TypeScript 实现，不是启动上游 Python/OpenCode/Codex，也不移植上游的八类任意可编辑组件。

**默认关闭。** 每轮显式传入 `RunInput.harness` 才启动预检；省略该字段时，原有 Provider、工具、审批、会话和子代理路径不变。预检增加模型调用、延迟及费用，不保证任务质量提高。

## 开启

已经配置好 Provider 的 `HarnessService` 可以这样运行：

```ts
const result = await service.run(
  {
    sessionId,
    prompt: "检查这个模块的问题，修复并运行对应测试。",
    permission: "workspace",
    harness: {
      candidates: 2,
      domain: "typescript-maintenance",
      experience: "read", // 读取同范围经验，不写经验库
    },
  },
  event => {
    if (event.type === "harness_adaptation") {
      console.log(event.progress.phase, event.progress.report?.status);
    }
  },
  approve, // 沿用宿主原有审批策略；不要无条件批准
  signal,
);
```

`harness: {}` 使用默认值。允许经验写入时显式设置 `experience: "read-write"`；临时比较、不接触经验库时使用 `"off"`。设置只影响这一轮，不自动写回全局配置或以后轮次。

公共契约通过 `@forge/core/shared/harness-adaptation` 导入。现有 RPC `startRun` 与持久输入队列复用 `RunInput`，无需另开接口。当前只提供 Core API，没有新增 CLI 开关或 UI 控件；客户端不得把适配报告当作助手最终答复。

| 字段 | 默认 | 范围 / 语义 |
| --- | --- | --- |
| `candidates` | `2` | `1..3`，候选策略数 |
| `maxProbeTurns` | `3` | `1..6`，每个预检的模型轮数 |
| `maxProbeToolCalls` | `6` | `1..16`，每个预检的本地读工具调用数 |
| `timeoutMs` | `60000` | `1000..120000`，整次预检的截止时间，不是正式任务的期限 |
| `domain` | `general` | 非空、至多 80 字符，由调用方明确指定经验范围 |
| `experience` | `read` | `off` / `read` / `read-write` |

所有字段严格校验；没有自由文本 system prompt、权限、插件、命令、模型切换等输入字段。各阶段使用本轮直接选择的同一个模型与 Provider。路由组可能混用模型，因此启用预检时拒绝路由组；请显式选择模型/来源。不改变 Provider 原有协议和账号选择规则。

## 一轮中实际发生什么

1. **baseline**：从空附加策略开始，用本轮任务与只读工具取得基线观察，不应用旧经验策略。
2. **propose**：模型基于基线和至多四条同范围经验提出候选，严格 JSON 解析。这个请求不能调用工具。
3. **probe**：逐个用全新的本地工具 registry 执行候选只读预检，记录真实工具结果、失败和截断状态。
4. **compose**：对比基线、候选及其证据，产生组合策略，而不是简单挑选某份答案。这个请求也不能调用工具。
5. **verify**：组合策略再做一次独立只读预检。
6. **select**：模型比较行为证据；没有足够可核对证据或明确选择不采用时，保留基线。该判断不是客观评分，也不是测试通过证明。
7. **formal run**：只将获选策略作为低信任的参考消息投影进当前 Provider 上下文，然后走原有正式运行时。策略不成为 system 指令、不写入用户历史、不改变工具权限。新用户 steering 使已采用策略失效，后续保留基线，不重跑预检。
8. **experience**：仅在明确 `read-write`、正式任务成功持久化、没有取消、且最终不是 plan/readonly 时，记录获选策略、采用理由和被引用的观察证据。

预检不是反复执行正式任务：**不会为比较候选而执行写文件、shell、MCP、浏览器或部署操作。** 正式任务仍由既有工具循环执行，预检不会重复其副作用。读工具得到的文件编辑授权不会转移到正式 registry；正式修改仍需在正式运行中读取文件。

默认预检最多 `15` 次 Provider 请求、`24` 次读工具调用；公式分别为 `(candidates + 2) × maxProbeTurns + 3` 和 `(candidates + 2) × maxProbeToolCalls`。配置上限为 `33` 次请求、`80` 次读工具调用。达到某个 probe 的轮数/工具限额会标记 `limited`，不能冒充完整结果。这些限额不约束正式任务，也不更改现有 root budget 的观察账本语义。

每次预检请求的序列化上下文上限为 `131072` 字符，响应上限为 `65536` 字符；过大时明确失败，可先压缩会话或关闭预检，不会静默截掉任务。上述预算是调用/字符限额，不是精确 token 或金额上限。截止/取消后不再启动后续阶段；资源清理仍需等待已拥有的本地工具及 registry 完成释放。

## 权限、失败和证据边界

- 预检只允许 `list_files`、`read_file`、`search_files`、`project_context`、`load_skill`、`git_status`、`git_diff`、`git_log`。既过滤定义，也检查实际分派；绕过定义直接请求其他工具也不能执行。
- 每个 probe 强制 `readonly`，复用原有工具执行器和本地路径保护；审批 handler 始终拒绝。没有 native 子代理工具、命令、MCP、网络工具、hosted search 或可执行 hooks。宿主原有整轮生命周期（例如自动标题、结束 hook）仍按既有规则运行，不会为每个 probe 单独触发。
- 正式任务继续遵守用户选择的权限、permission ceiling、动态降权及审批；策略不能授予任何权限。
- 候选仅包含三段有限长度的建议：`planning`、`toolGuidance`、`verification`。禁止在 schema 里夹带可执行配置。建议仍是不可信模型输出，不是对正文注入的通用检测器。
- 取消、超时、Provider 异常、非法元响应或经验库读取损坏都会可见地停止这一轮，不悄悄重发预检或接着运行正式任务。正常的“证据不足 / 不采用”才保留基线。
- 预检使用同一个工作区的只读视图，而不是冻结快照；若外部程序同时改动文件，比较不能视为严格可重复实验。它也不能证明测试可运行、写入无误或性能提高，正式阶段仍要实际验证。
- 工具证据与候选文本在反馈/持久化前经过宿主脱敏，并设置字符上限及截断标志。默认宿主复用已知凭据与常见 secret 格式脱敏；这不是任意秘密识别。任务及工作区内容仍可能发送给已经选中的模型 Provider。
- `toolFactory` / `HarnessAdaptationHost` 是受信宿主扩展，不是安全沙箱。自定义宿主必须提供每次独立、遵守只读含义、可取消及可释放的 registry；不能把有副作用的工具伪装为 `read_file`。

每个阶段通过持久化的 `harness_adaptation` 事件报告。`completed` 含结构化报告：策略、采用理由、各 probe 的结果与证据、使用过的经验 ID 和调用次数。没有独立的助手“预检答案”落入正式消息历史。用量合并到运行统计；缺失用量保持未知，而不是记为免费。

正式任务已经成功后，经验保存失败会报告 storage 错误，但不把已完成任务自动重跑，也不假称已经保存。

## 经验库

位置为私有状态目录 `FORGE_HOME/harness-experiences/<scope-hash>.json`（显式 `stateDir` 覆盖 `FORGE_HOME` 时使用该目录）。范围由 **工作区绝对路径 + 精确模型 ID + domain** 组成。仅匹配的范围可读，不跨工作区/模型/领域检索，不使用跨会话 `forge_memory` 合成。

每个范围最多保留 64 条，单文件最多 2 MiB，读时只返回最近四条；超出时淘汰最旧条目。采用原有私有目录、原子写和文件锁。内容严格校验，拒绝符号链接/损坏数据，不静默清空损坏库。相同 `reportId` 的保存是幂等的。

经验是下一轮 **propose** 的参考，而不是自动安装的策略。新轮次必须仍从基线开始，重新取证、组合和选择。只有正式状态为 `completed` 不代表所有测试通过；保存的 lesson 也不提升为事实或权限。

## 验证与范围

针对算法、真实本地工具隔离、持久化和浏览器契约运行离线 fixture 测试：

```sh
pnpm exec vitest run tests/core/harness-adaptation.test.ts \
  tests/core/harness-adaptation-integration.test.ts \
  tests/store/harness-experiences.test.ts tests/shared/harness-adaptation.test.ts
pnpm build
pnpm test:package
```

测试使用临时状态/工作区与假的模型响应，不调用真实 Provider，不读取用户配置。通过这些测试只证明接线与安全语义，不证明复现论文质量收益。

当前不支持完整写操作 rollout、并行/多层递归、自动修改 system/guardrails/scripts/plugins、自动跨任务继承整套 Harness，或基准评分。没有引入新运行时依赖、Rust 或默认单实例 daemon，没有改动本机 `forge` 启动器。

## 上游出处

2026-10-23 核对上游 README 与核心模块，参考其双层改进思路；未复制其执行器或提示词模板。

```text
https://github.com/google-research/harness2
https://raw.githubusercontent.com/google-research/harness2/main/README.md
https://github.com/google-research/harness2/tree/main/harness2/core
```

上游声明 Apache-2.0，且不是官方支持的 Google 产品。本实现与上游没有产品支持或效果背书关系。
