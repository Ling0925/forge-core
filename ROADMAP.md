# forge-core 路线图

只写顺序，不写日期。跨仓依赖明确标出；forge-board 指 [Ling0925/forge-board](https://github.com/Ling0925/forge-board)。

## 已完成

| 内容 | PR |
|---|---|
| typecheck/lint 修复、测试临时目录、代码清理 | [#1](https://github.com/Ling0925/forge-core/pull/1) |
| 放宽硬编码限制（POSIX socket/进程组、IPv6、上下文窗口、子 Agent 上限等） | [#2](https://github.com/Ling0925/forge-core/pull/2) |
| 修复全量 vitest（会话日志时间戳竞态等） | [#3](https://github.com/Ling0925/forge-core/pull/3) |
| 拆分 harness.ts 与 runtime.ts | [#4](https://github.com/Ling0925/forge-core/pull/4) |
| 拆分时发现的正确性问题，收敛重复逻辑 | [#5](https://github.com/Ling0925/forge-core/pull/5) |
| 按职责拆分 6 个大文件 | [#6](https://github.com/Ling0925/forge-core/pull/6) |
| 会话启动 CPU/内存优化（flock addon、MCP/LSP 跨轮复用、延迟加载 SDK） | [#7](https://github.com/Ling0925/forge-core/pull/7) |
| core 与各模块的边界、生命周期、host 传输层；每个模块有 index.ts 和显式导出 | [#8](https://github.com/Ling0925/forge-core/pull/8) |
| Super-agent 第 1 阶段：GitHub Webhook、Router/Worker、审批发送队列、Worker 的 gh 凭据隔离 | [#9](https://github.com/Ling0925/forge-core/pull/9) |

## 下一步（按顺序）

1. **forge-board 后端适配器（HTTP `WorkItemStore`）**
   - 依赖：forge-board 的 REST API（P1 已完成），以及 forge-board 侧一组小的 API 补充（见 forge-board 路线图“下一步 1”）。
   - 内容：
     - 实现窄接口的 8 个方法和状态映射；
     - 设置项可以在本地 SQLite 和远程 forge-board 之间切换；
     - 把“Work → Router”映射从本地 cursors 表移到 WorkItem 上（`routerSessionId`），需要改 schema、store 和 engine；
     - 保存租约 token；用幂等键处理丢失的响应和重试；
     - 区分“认领冲突”和“等待审批”；
     - 订阅 forge-board 的 SSE，把人在 board 上做的审批、收回、取消同步回 Worker（唤醒或停止）。
   - 验收：真实的 Super-agent engine 对接 forge-board，同时加一个外部 MCP agent，覆盖抢认领、等待审批、停止和恢复、重启、丢失响应等场景。
   - 规模：forge-core 约 1.6–2.5k 行（含测试）。
2. **Super-agent 第 2 阶段：可靠性**
   - 依赖：第 1 项完成后，WorkItem 的生命周期才确定。
   - 内容：
     - 持久化的最小调度器；
     - 确定性巡检，检查源健康、Worker 卡住、队列阻塞、发送队列持续失败；
     - 只有发现问题时才唤醒 Watchdog 会话；
     - 源的自动重启；
     - 数据保留与清理；
     - `superAgent` 设置热重载（目前 host 层的启用开关、login/repos、webhook 配置只在启动时读取）。
   - 需要的设置（附理由）：`watchdog.interval`（巡检需要一个周期）、`watchdog.stallAfter`（判断卡住需要阈值）、保留期（删除需要明确的策略）。默认值由你决定。
   - 规模：约 2.4–3.8k 行，其中热重载约 0.5–0.8k。
3. **CI**
   - 草稿在本机 `/workspace/forge-core-ci.yml`，里面的 `timeout-minutes: 20` 要删掉。
   - 依赖：一个带 `workflow` 权限的凭据。

## 之后

- **Worker 的 MCP 访问**：Worker 的 profile 已经可以用 `tools.mode: "restricted"` 加 `mcpServers` 白名单限制它能用哪些 MCP 服务（`src/core/agent-profiles.ts`），并且对 Worker 会话生效。剩下要做的是：在 README 里给出推荐的 Worker profile，再补一个测试证明白名单对 Worker 有效。远程 MCP 服务配置的请求头属于你的显式配置，进程环境隔离覆盖不到。
- 拆分 `provider/responses-stream.ts`：一个约 718 行的工厂函数，基本是搬代码。
- 已有上限的去留：插件作用域、异步任务容量、事件回放、controller 预览和插话，见 #8 的“保留的上限”一节。逐项决定是删除，还是保留为附带理由的设置。
- 中英文错误信息统一：先定策略（统一一种语言，还是做本地化）。
- 计算、状态、环境分离（远程 Worker、BYOM）：需要单独设计。

## 已撤下

- `tools/memory → core/memory-retrieval` 的分层问题：现在 tools 只依赖 shared，合成能力由 core 通过回调注入（`src/tools/memory.ts`、`src/core/harness-memory-tools.ts`），#8 里“暂缓”的说明已经过时。

## 待你决定

1. **任务生命周期**：forge-board 要求 `in_progress → in_review → done`，取消也必须由人来做；Super-agent 目前允许 `running → done`。是让 Super-agent 对齐 board 的规则（并显式表示“等待审批”），还是放宽 board？
2. **对接身份**：用哪个 board project、哪位人类负责人；Forge 用一个 board 身份，还是每个 Worker 一个；切换后端时，现有本地 WorkItem 是迁移过去还是保留。
3. **Watchdog**：哪些情况可以自动重启或恢复，哪些只通知你；`interval`、`stallAfter` 和保留期的默认值。
4. **两套审批**：board 的审批管的是任务状态转换，Super-agent 的发送队列审批管的是 GitHub 写操作。是否需要统一入口？
5. **CI 凭据**：给 gh token 加 `workflow` 权限，还是由你手动添加工作流文件。
