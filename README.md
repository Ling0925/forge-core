# Forge Core

独立 Git 仓库与 Node 包 `@forge/core`。从原 `desktop-harness` 的已提交基线
`e089acbcf1c3fe10a71a9ce0fce5f9309305db3b` 提取相关路径历史，保留作者与提交记录；
路径过滤会产生新的提交 ID。没有配置远端，也没有推送或更改原库。

## 边界

本仓拥有 `src/core`、`provider`、`store`、`tools`、`context`、`mcp`、`host`、
`shared` 及服务端 `web`。不包含 CLI、React renderer、Electron 或 Android 应用。
HTTP/WebSocket 由 Core 提供；Web UI 是独立构建的静态资源，不是构建前提。

这是仓库和包边界拆分，**仍是原 TypeScript/Node 核心**。没有实现 Rust 移植、
Android 本地核心、默认单实例 daemon 或跨设备同步。普通 CLI/Web 的进程所有权
保留旧行为；共享运行状态必须显式连接同一个已有 host，不能仅共享数据目录。

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
默认仅监听回环地址；显式 LAN 地址仍沿用原有可信网络直连行为，HTTP 无加密，
不要直接暴露到不可信网络。停止服务会停止它持有的任务，本次没有改变这一语义。

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
