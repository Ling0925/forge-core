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
| forge-board 后端适配器：HTTP `WorkItemStore`、SSE 同步审批/收回/取消、事件流指数退避重连（1 秒起，最多 1 分钟）；共用一个 board 身份，旧工作项留在本地 | [#11](https://github.com/Ling0925/forge-core/pull/11)；forge-board [#1](https://github.com/Ling0925/forge-board/pull/1)、[#3](https://github.com/Ling0925/forge-board/pull/3) |

## 进行中

- **forge-cli 和 forge-web-ui 只通过模块入口引用 core**：#8 改成显式导出表后，两个客户端仍在引用 `@forge/core/*` 的深层路径（forge-cli 约 30 处，forge-web-ui 的 `scripts/serve.mjs` 1 处，另有前端拷到 `core-compat/` 的符号）。修法是改客户端，改用各模块的公开入口；core 不把深层路径加回导出表。确实缺的符号再按需补进对应模块的入口。

## 下一步（按顺序）

1. **Super-agent 第 2 阶段：可靠性**
   - 内容：
     - 持久化的最小调度器（定时器）；
     - 确定性巡检，检查源健康、Worker 卡住、队列阻塞、发送队列持续失败；
     - 只有发现问题时才唤醒 Watchdog 会话；
     - 源的自动重启；
     - 数据保留与清理；
     - `superAgent` 设置热重载（目前 host 层的启用开关、login/repos、webhook 配置只在启动时读取）。
   - 需要的设置（附理由）：`watchdog.interval`（巡检需要一个周期）、`watchdog.stallAfter`（判断卡住需要阈值）、保留期（删除需要明确的策略）。默认值由你决定。
   - 规模：约 2.4–3.8k 行，其中热重载约 0.5–0.8k。
2. **forge-board 网页写操作和审批收件箱**（在 forge-board 仓）
   - 目前页面只读，审批、收回、取消只能走 API/CLI/MCP。
3. **CI（两个仓）**
   - 草稿在本机 `/workspace/forge-core-ci.yml` 和 `/workspace/forge-board-ci.yml`。
   - 依赖：一个带 `workflow` 权限的凭据。目前暂缓。

## 之后

- **Worker 的 MCP 白名单**：Worker 的 profile 已经可以用 `tools.mode: "restricted"` 加 `mcpServers` 白名单限制它能用哪些 MCP 服务（`src/core/agent-profiles.ts`），并且对 Worker 会话生效。剩下要做的是：在 README 里给出推荐的 Worker profile 配置，再补一个测试证明白名单对 Worker 有效。远程 MCP 服务配置的请求头属于你的显式配置，进程环境隔离覆盖不到。
- 拆分 `provider/responses-stream.ts`：文件共 718 行，主体是一个大工厂函数，拆分基本是搬代码。
- 已有上限的去留：插件作用域、异步任务容量、事件回放、controller 预览和插话，见 #8 的“保留的上限”一节。逐项决定是删除，还是保留为附带理由的设置。
- 中英文错误信息统一：先定策略（统一一种语言，还是做本地化）。
- 计算、状态、环境分离（远程 Worker、BYOM）：需要单独设计。

## 已撤下

- `tools/memory → core/memory-retrieval` 的分层问题：现在 tools 只依赖 shared，合成能力由 core 通过回调注入（`src/tools/memory.ts`、`src/core/harness-memory-tools.ts`），#8 里“暂缓”的说明已经过时。

## 待你决定

1. **Watchdog**：哪些情况可以自动重启或恢复，哪些只通知你；`interval`、`stallAfter` 和保留期的默认值。
2. **两套审批**：board 的审批管的是任务状态转换，Super-agent 的发送队列审批管的是 GitHub 写操作。是否需要统一入口？
3. **CI 凭据**：给 gh token 加 `workflow` 权限，还是由你手动添加工作流文件。

