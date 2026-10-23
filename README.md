# Forge Core

独立 Git 仓库与 Node 包 `@forge/core`。从原 `desktop-harness` 的已提交基线
`e089acbcf1c3fe10a71a9ce0fce5f9309305db3b` 提取相关路径历史，保留作者与提交记录；
路径过滤会产生新的提交 ID，原仓历史没有重写。

公开仓库为 `Ling0925/forge-core`，`origin` 指向该仓库。既可单独克隆，也作为主仓
`Ling0925/forge` 的 `repos/forge-core` 子模块使用；子模块关联不合并各仓历史。
同步主仓版本时，先提交并推送本仓，再由主仓维护者提交子模块指针。

## 边界

本仓拥有 `src/core`、`provider`、`store`、`tools`、`context`、`mcp`、`host`、
`shared` 及服务端 `web`。不包含 CLI、React renderer、Electron 或 Android 应用。
HTTP/WebSocket 由 Core 提供；Web UI 是独立构建的静态资源，不是构建前提。

**仍是 TypeScript/Node 核心**，没有实现 Rust 移植、Android 本地核心或跨设备同步。
Web 生产入口现在通过独立网关连接本进程，重启 Web 不会停止 Core 中的任务。
这不是全局单实例 daemon：CLI 或其他入口仍须显式连接同一个 host 才能共享运行状态，
不能仅靠共享数据目录，也不要同时启动多个持有同一数据目录的 Core。

## 安装、构建与验证

使用 `package.json` 中指定的 Node 22 与 pnpm 版本：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:package
pnpm exec vitest run tests/shared/contract-boundaries.test.ts tests/core/integration.test.ts tests/web-host.test.ts tests/web-static.test.ts
```

构建生成独立 ESM 模块与共享 chunks，保留 schema 对象身份。编译产物不提交。
`test:package` 验证浏览器契约、离线模型回合及无 UI 的 HTTP/RPC 启动，测试使用
临时状态目录并清理；不读取真实模型配置。其余历史测试的归属见
`docs/TEST_OWNERSHIP.md`。全量测试/类型检查不是本次拆分已完成的验收声明。

## Provider 协议兼容

协议由来源或逐模型配置显式选择，不会在失败后偷偷切换为 Chat。非 Chat 适配器的
兼容边界包括：

- SSE 忽略没有 `data` 的普通控制帧，允许尾部注释；显式失败事件、UTF-8 分片、
  空闲超时、响应大小和未闭合数据帧检查仍保留。
- Responses 接受完整 `response.completed` 快照（可省略冗余中间完成帧），也可读取
  同一次请求返回的完整 JSON 响应。已收到的正文、工具参数、调用身份和完成快照必须一致；
  快照补全不能倒序插入或改写已经流出的正文。
- Anthropic 的工具参数只在内容块结束后完整校验，空参数增量不覆盖已有的 input 对象；
  缺失用量不再中断已完成的回答，未上报完整计数时用量保持未知，不冒充零消耗。
- Gemini 可读取完整 JSON 数组形式的流结果；切换模型/协议后重建工具历史时保留调用 ID 配对。

这些兼容不等于把失败当成功：缺少原生完成信号、截断/非法 JSON、冲突工具调用仍失败，
兼容处理本身不补写工具参数，也不重发生成请求。回归使用 `tests/provider` 中的模拟 HTTP/SSE 响应，
不需要真实 Provider 或密钥。

## MCP 工具

Core 支持 stdio、Streamable HTTP 和 Legacy SSE。注册不启动进程或连接远端，
服务器启用后才允许发现与调用；“测试连接”会完成握手并发送 ping 检查当前响应能力。

模型按下面的顺序使用 MCP：

1. `mcp_list_servers` 查询当前服务器 ID、名称、传输方式和启用状态，不连接服务器。
2. `mcp_list_tools` 按服务器 ID 查询工具，保留输入/输出 schema、标题和 annotations。
   大目录分页返回，出现 `nextOffset` 时以该值作为下一次请求的 `offset`；每页保留完整 schema。
3. `mcp_call_tool` 使用发现结果中的工具名调用，以 `arguments_json` 传递 JSON 对象。
   每次新任务重新发现工具，含特殊字符或长名称的别名映射不跨任务保留。

运行中的工具注册表会重新读取服务器配置。只读模式允许查询服务器目录，但不允许
连接或调用；workspace 模式每次发现工具或调用都单独审批。服务器 annotations
只作为提示，不授予权限；审批期间可见配置变化会中止当前操作，需重新发现和审批。

调用结果保留兼容的 `text`、`isError`、`truncated`，并支持 `structuredContent`、
图片、音频、资源链接和嵌入资源。非文本内容保留为类型化数据块，模型侧仍接收 JSON
工具结果。结果递归脱敏，调用结果封装上限为 64 KiB；超限或含私密数据的二进制块整块
省略并标记截断，不截取 Base64。工具目录单页上限为 128 KiB。

一次发现期间收到工具列表变化通知时，会拒绝返回跨版本混合的分页目录；重新查询可获取当前工具。
取消、超时、禁用和删除保留连接清理行为，不自动重发工具调用。
`examples/mcp/echo-server.mjs` 提供无需外部服务或密钥的本地示例。

## 服务入口

```sh
node dist/web/serve.js --help
FORGE_HOME=/path/to/isolated-state node dist/web/serve.js --workspace /absolute/project --port 5173
```

默认只提供 API，不需要 renderer 文件。需要同时提供 Web UI 时，明确传入独立
Web UI 仓构建后的目录：

```sh
FORGE_HOME=/path/to/isolated-state node dist/web/serve.js --workspace /absolute/project --renderer /absolute/forge-web-ui/dist/renderer
```

可传 `--socket /private/directory/core.sock` 复用现有本地 attach 传输。
默认限制为启动工作区；`--multi-workspace` 保留个人 Web 工作台跨工作区的行为。
默认仅监听回环地址；显式 LAN 地址仍沿用可信网络直连行为，HTTP 无加密，
不要直接暴露到不可信网络。**停止 Core 仍会停止它持有的任务**；日常更新 UI 只重启 Web。

### 独立 Core + Web

```sh
# 终端/服务 A：Core 仅监听本机，独立持有任务、审批、会话和事件补发记录
node dist/web/serve.js --host 127.0.0.1 --port 5175 --workspace /absolute/project --multi-workspace
# 终端/服务 B：Web UI 仓，先构建其 renderer
node ../forge-web-ui/scripts/serve.mjs --core-url http://127.0.0.1:5175 --host 127.0.0.1 --port 5173
```

`@forge/core/web/gateway` 只提供静态 UI 与流式 HTTP/WebSocket 转发，不创建 Harness、
读写会话或重试任务请求；停止网关只关闭连接。浏览器重连到原 Core，按原 cursor
补发事件；超出事件保留窗口时重新读取持久化状态。网关只允许明确的本机 IPv4 Core，
先验证外部 Host/Origin，再改写内部地址；不开放通用代理或跨站 API。
首次从旧单进程切换时无法搬迁内存中的运行态，必须先等旧任务结束再停止旧服务。
两个服务不得配置会在 Web 重启时联动停止 Core 的 `PartOf`/`BindsTo` 关系。

发送附件单文件上限为 **50 MiB（52,428,800 字节）**；每会话仍为 128 个、合计 64 MiB。
此上限不改变文本编辑工具和图片输入各自的限制。

## 客户端包依赖

本地开发把三个独立仓库放在同一级：

```text
forge-core/
forge-cli/
forge-web-ui/
```

先构建 Core，再在 CLI/Web 仓安装它们声明的 `file:../forge-core` 包依赖。客户端
只通过 `@forge/core/...` 子路径引用，不访问原库或兄弟仓的 `src`。Core 改动后要
重新构建，并在消费者仓重新执行 `pnpm install --no-frozen-lockfile` 更新本地文件包。
共享契约使用 `@forge/core/shared/*`，浏览器不得导入 Node 核心根入口。

目前公开的模块子路径保留原结构，便于渐进迁移；这不是未来 Rust RPC 协议已经
冻结的承诺。后续可改为内部 registry 版本或 `pnpm pack` 的 tarball 依赖，不要求
三个仓库合并成 pnpm workspace。源码 TS 类型随包提供，运行入口是构建后的 JS。

## 原库与本机入口

原库仍保留完整历史、桌面/Android 工程和未提交的 UI 改动。已有本机 `forge`
启动器仍指向原库，本次没有改动或重装它。要使用本仓必须明确运行本仓产物。
`docs/ARCHITECTURE.md` 等保留为迁移前设计记录，其中其他应用路径属于原库历史。
作者与第三方许可说明见 `docs/AUTHORSHIP.md` 和 `THIRD_PARTY_NOTICES.md`。
