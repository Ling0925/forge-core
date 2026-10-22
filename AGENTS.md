# Forge Core 开发约定

- 本仓库是独立的 `@forge/core` Git 仓库，保留原仓相关路径历史。只在本仓提交，不操作兄弟仓库或原库的索引；默认不 push。
- 子代理固定使用 `cn:deepseek-v4.1-flash`，除非用户明确指定其他模型。
- Core 拥有运行时、Provider、存储、工具、上下文、MCP、host 及 HTTP/WebSocket 服务；不得导入 CLI、renderer、Electron 或 Android 实现。
- `src/shared` 是浏览器可用的公共契约。客户端通过 `@forge/core/shared/*` 使用它，不复制契约，不让它反向依赖 Node 或核心实现。
- 构建：`pnpm build`。聚焦验证：`pnpm test:package` 与本次涉及的 Vitest 文件。不要默认全量测试、桌面打包或发布安装。
- 启动和集成检查必须使用临时 `FORGE_HOME` 与临时工作区，结束后清理；不读取用户真实配置/密钥，不调用真实 Provider。
- 本轮只是仓库拆分，未移植 Rust，也未实现默认单实例 daemon；不要宣称已经完成运行时解耦。
- 原本机 `forge` 启动器仍指向旧 desktop-harness 产物。不得静默更改启动器；本仓产物通过显式命令使用。
- 修改既有文件前读取当前内容。用原生文件工具编辑源码，命令用于 git、构建、测试和包管理。每轮自己的修改必须本地提交，不夹带他人修改或构建产物。
