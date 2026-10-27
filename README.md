# Forge Core

Forge 的任务运行时。负责模型调用、工具执行、权限审批、会话存储和实时事件，为终端、浏览器与 Android 客户端提供同一套执行能力。

Core 可以作为独立 HTTP/WebSocket 服务运行，也可以作为 TypeScript/Node 包嵌入应用。运行任务不需要 Web UI；客户端断开连接也不等于取消任务。

[Forge 主仓](https://github.com/Ling0925/forge) · [CLI](https://github.com/Ling0925/forge-cli) · [Web](https://github.com/Ling0925/forge-web-ui) · [Android](https://github.com/Ling0925/forge-android)

## Core 提供什么

- **任务执行**：流式输出、工具调用、子代理、排队与插话、取消和审批；支持跨轮后台工具任务与主会话完成唤醒。
- **模型接入**：OpenAI Chat Completions / Responses、Anthropic Messages、Gemini，以及来源、凭据与路由管理。
- **本地工作区**：文件搜索与编辑、命令执行、检查点和改动记录；浏览器、LSP 与 MCP 按配置启用。
- **官方插件**：统一清单、配置、启停和诊断；首个 `browser` 插件接入 agent-browser，支持同会话截图预览与人工接管，默认禁用。见[插件与浏览器](docs/PLUGINS.md)。
- **持久化上下文**：会话历史、分页读取、上下文压缩、工作记忆与长期记忆。
- **客户端连接**：HTTP RPC、WebSocket 事件与恢复游标，以及 Linux 本地 Unix socket。

本仓是 TypeScript/Node 实现，不包含 CLI、React 界面、Electron 或 Android 应用。

## 快速开始

需要 **Node.js `>=22.23.1 <23`** 和 **pnpm `11.18.0`**，版本约束见 [package.json](package.json)。

```sh
git clone https://github.com/Ling0925/forge-core.git
cd forge-core
pnpm install --frozen-lockfile
pnpm build
```

将下面的工作区替换成实际存在的绝对路径，再启动 API 服务：

```sh
node dist/web/serve.js \
  --host 127.0.0.1 \
  --port 5175 \
  --workspace /absolute/path/to/project
```

此时 `http://127.0.0.1:5175` 是 **API 地址**，根路径没有工作台页面。需要界面时连接 [Forge Web](https://github.com/Ling0925/forge-web-ui#readme)；需要手机原生客户端时连接 [Forge Android](https://github.com/Ling0925/forge-android#readme)。首次运行还需通过客户端配置模型来源和凭据，启动服务本身不会完成模型配置。

### 启动选项

- `--workspace PATH`：必填，默认把客户端限制在该工作区。
- `--multi-workspace`：允许个人工作台切换工作区。
- `--host IPv4` / `--port PORT`：默认 `127.0.0.1:5173`；只接受具体 IPv4 和 `1024–65535` 端口，不接受 `0.0.0.0`。
- `--socket PATH`：给同一个运行时增加本地 attach 入口；使用当前用户拥有的私有目录和绝对 socket 路径。
- `--renderer PATH`：可选，同时提供已构建的 Web UI；省略时只提供 API。

完整帮助：`node dist/web/serve.js --help`。

## 与 Web 独立运行

推荐让 Core 持有任务，Web 只提供页面与同源转发。两个仓库放在同一级，并先按各自说明完成构建：

```sh
# 终端 A，在 forge-core 中运行
node dist/web/serve.js --host 127.0.0.1 --port 5175 \
  --workspace /absolute/path/to/project --multi-workspace
```

```sh
# 终端 B，在 forge-web-ui 中运行
pnpm serve -- --host 127.0.0.1 --port 5173 \
  --core-url http://127.0.0.1:5175
```

浏览器打开 `http://127.0.0.1:5173`。Web 重启期间，Core 中已接受的任务继续执行；页面重连后补发保留窗口内的事件，必要时重新读取持久化状态。**停止 Core 会停止它持有的任务**，因此只更新界面时不要联动停止 Core。

这不是全局单实例服务：普通 CLI 会创建自己的运行时。要控制同一批活动任务，需显式连接同一个 host，例如在 Core 启动时传入 `--socket`，再使用 CLI 的 `attach`。共享数据目录不能替代连接，也不要启动多个服务同时持有同一份状态。

## 数据、权限与网络

默认数据目录是 `~/.local/share/forge`，可用 `FORGE_HOME` 指定另一份独立状态：

```sh
FORGE_HOME=/absolute/path/to/private-state \
  node dist/web/serve.js --workspace /absolute/path/to/project --port 5175
```

模型凭据、会话与配置由 Core 管理。测试和实验使用临时状态目录，不复用日常会话。

- `readonly`、`workspace`、`unrestricted` 与 plan/build 模式共同约束工具能力；审批策略不提升权限。命令和外部工具不是操作系统沙箱。
- 当前命令行 HTTP 入口采用可信局域网直连：**能够访问监听地址的人就能使用工作台能力，不需要配对**。默认回环监听；HTTP 没有加密，不应无保护地暴露到公网。
- 服务校验 Host / Origin；客户端应使用实际监听地址。反向代理需要正确处理这些头与 WebSocket，而不是绕过校验。
- 发布附件单文件上限为 **50 MiB（52,428,800 字节）**，每会话最多 **128 个、合计 64 MiB**。文本编辑和图片输入使用各自的限制。

## 模型与 MCP

模型协议由来源或逐模型配置明确选择，不会在协议失败后自动切换到 Chat Completions。适配器支持各协议的流式结果和受支持的完整响应形式；截断响应、冲突工具调用和缺少完成信号仍作为错误处理。用量缺失时保留未知状态，不记成零消耗。兼容性回归位于 [tests/provider](tests/provider)。错误阶段、重试决策和运行构建识别见 [错误诊断](docs/ERROR_DIAGNOSTICS.md)；子代理可独立选择其他供应商，规则见 [跨供应商派发](docs/AGENT_COLLABORATION.md#不带角色的跨供应商模型选择)。

MCP 支持 **stdio、Streamable HTTP、Legacy SSE**。注册不会连接；启用后才允许发现和调用，连接测试会握手并发送 ping。模型通过 `mcp_list_servers` → `mcp_list_tools` → `mcp_call_tool` 发现并使用工具，大目录按 `nextOffset` 分页。

私密环境变量和请求头由注册接口显式传入，保存在 `FORGE_HOME/mcp/servers.json` 的私有权限文件中；公共列表不返回凭据，也不允许用 `envNames` 任意读取宿主环境。API key 应放入私密请求头或环境变量，不放在 URL、命令参数或仓库文件里。

只读模式可查询服务器目录，但不能连接或调用；workspace 模式每次发现与调用均需审批。服务器 annotations 不授予权限。调用支持文本、结构化结果、图片、音频与资源块；结果递归脱敏且有大小限制，不自动重发工具调用。

无需外部服务的示例：[examples/mcp/echo-server.mjs](examples/mcp/echo-server.mjs)。

## 作为包使用

包名为 `@forge/core`，当前标记为 `private`，本地客户端通过 `file:../forge-core` 依赖它：

```text
workspace/
├── forge-core/
├── forge-cli/
└── forge-web-ui/
```

先构建 Core，再安装消费者依赖。Core 重新构建后，在消费者仓执行 `pnpm install --no-frozen-lockfile` 刷新文件包；由 Forge 主仓装配时使用主仓提供的构建与链接脚本。

```ts
import { createHarness } from "@forge/core";

const service = await createHarness({ stateDir: "/absolute/path/to/private-state" });
try {
  const sessions = await service.listSessions();
  console.log(sessions);
} finally {
  await service.dispose();
}
```

运行时使用构建后的 `dist`，类型来自 `src`。客户端只通过公开包路径导入，不跨仓引用源码；浏览器使用 `@forge/core/shared/*` 契约，不能导入 Node 运行时根入口。HTTP/RPC 契约仍随项目演进，升级客户端与 Core 时应一起验证。

## Harness² 策略预检（可选）

在 `service.run` / RPC `startRun` 的输入中显式传入 `harness: {}`，可在正式执行前运行有界的 **基线 → 提案 → 只读试跑 → 组合 → 复测 → 选择**。获选内容只作为本轮规划、工具指导与验证策略的参考；不会改写权限、工具实现或全局 system prompt。

```ts
// 其余参数沿用原有 onEvent、approve、signal。
const input = {
  sessionId,
  prompt: "修复问题并验证",
  permission: "workspace" as const,
  harness: { domain: "coding", candidates: 2, experience: "read-write" as const },
};
```

默认不启用。启用会增加模型调用及费用；预检不执行写文件、命令或网络操作，正式任务只走一次原有执行流程。只有明确允许、正式任务成功且非 readonly/plan 时才记录经验，按工作区、模型、领域隔离。完整用法、限制与证据说明见 [Harness² 策略预检](docs/HARNESS_ADAPTATION.md)。

## 开发与检查

```sh
pnpm build
pnpm test:package
pnpm exec vitest run tests/shared/contract-boundaries.test.ts \
  tests/core/integration.test.ts tests/web-host.test.ts tests/web-static.test.ts
```

包测试覆盖浏览器安全导出、离线模型回合、持久化和 API-only HTTP/RPC 启动，使用临时状态，不需要真实 Provider 密钥。修改特定模块时追加对应测试；`pnpm test`、`pnpm typecheck`、`pnpm lint` 是更大范围的检查入口。

```text
src/core/       运行协调、子代理、输入队列与记忆
src/provider/   模型协议、来源与路由
src/store/      配置、会话和持久化
src/tools/      工作区与外部工具
src/context/    项目指令与技能
src/mcp/        MCP 连接与调用
src/plugins/    插件宿主与官方浏览器适配
src/host/       共享 controller、运行时与本地传输
src/web/        HTTP/WebSocket host、静态资源与网关
src/shared/     公共类型、schema 与客户端契约
```

## 深入阅读

- [架构与模块职责](docs/ARCHITECTURE.md)
- [项目指令与技能](docs/PROJECT_CONTEXT.md)
- [模型接入、迁移与支持范围](docs/MODEL_ACCESS_PORT_STATUS.md)
- [契约归属与浏览器边界](docs/CONTRACT_BOUNDARIES.md)
- [运行生命周期与取消](docs/RUNTIME_LIFECYCLE.md)
- [会话存储](docs/SESSION_STORAGE.md) · [持久输入队列](docs/INPUT_QUEUE.md)
- [长期记忆与聚焦整理](docs/MEMORY.md) · [通用异步工具与主会话唤醒](docs/ASYNC_TOOLS.md)
- [测试归属](docs/TEST_OWNERSHIP.md)
- [作者说明](docs/AUTHORSHIP.md) · [第三方声明](THIRD_PARTY_NOTICES.md)

本仓保留从原 `desktop-harness` 提取的路径历史，在 Forge 主仓中位于 `repos/forge-core` 子模块。代码在本仓独立提交，主仓单独记录所使用的提交版本。
