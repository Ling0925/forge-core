# Forge Core 开发约定

- 本仓库是独立的 `@forge/core` Git 仓库，保留原仓相关路径历史。只在本仓提交，不操作兄弟仓库或原库的索引；默认不 push。
- 子代理固定使用 `cn:deepseek-v4.1-flash`，除非用户明确指定其他模型；失败先检查已产生的改动，不自动换模型或重放任务，主代理可接手。
- Core 拥有运行时、Provider、存储、工具、上下文、MCP、host 及 HTTP/WebSocket 服务；不得导入 CLI、renderer、Electron 或 Android 实现。
- `src/shared` 是浏览器可用的公共契约。客户端通过 `@forge/core/shared/*` 使用它，不复制契约，不让它反向依赖 Node 或核心实现。
- 构建：`pnpm build`。聚焦验证：`pnpm test:package` 与本次涉及的 Vitest 文件。不要默认全量测试、桌面打包或发布安装。
- 启动和集成检查必须使用临时 `FORGE_HOME` 与临时工作区，结束后清理；不读取用户真实配置/密钥，不调用真实 Provider。
- 在 Forge 主仓内修改 Core 后，本机 CLI 用主仓 `node scripts/build-core.mjs` 构建并重开 `forge`；独立克隆按 README 构建包。不要静默改写启动器或重启用户服务。
- 架构入口见 `docs/ARCHITECTURE.md`，技能发现规则见 `docs/PROJECT_CONTEXT.md`。文档区分当前用法与有日期的历史证据，不保留一次性任务分工作为长期规则。
- 修改既有文件前读取当前内容。用原生文件工具编辑源码，命令用于 git、构建、测试和包管理。每轮自己的修改必须本地提交，不夹带他人修改或构建产物。
