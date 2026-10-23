# Core 测试归属

本仓从原库 `e089acb` 过滤历史拆分而来，只保留 `src/{core,host,web,provider,store,tools,shared,context,mcp}`。
Core 测试不得导入 `src/cli`、`src/renderer`、`src/desktop`、Electron、Android 或客户端 UI 实现，也不得引用已不在本仓的
`tests/cli` 路径。CLI、Web UI、Android 的入口测试在各自仓库维护；旧单体完整测试留在主仓历史归档中。

## 拆分时的覆盖映射

下表记录拆分取舍，方便定位回归；“未迁移到 Core”不代表对应客户端已经通过检查。

| Core 测试 | 处理 | 保留的 Core 覆盖 | 未迁移到 Core 的覆盖 |
| --- | --- | --- | --- |
| `tests/core/manual-compact.test.ts` | 用 `shared/session-usage` 的 `sessionUsage()` 替代 renderer 的 `persistent-usage-cache` | 手动压缩刷新持久化 context 统计、保留累计 token/latest cache、重复压缩幂等、旧请求计费修复 | 浏览器 `localStorage` 会话用量摘要缓存本身 |
| `tests/core/model-catalog-cache.test.ts` | 删除 CLI `models --refresh` 用例，改为直接验证 `HarnessService.listModels(..., refresh=true)` | 各协议持久化模型目录、源隔离、仅刷新选中源、刷新失败保留 last-good 目录 | CLI `models` 参数解析、JSON/stdout 输出、退出码、stderr 凭据脱敏 |
| `tests/core/model-protocol-queue.test.ts` | `desktop/runtime` 兼容别名改为 `host/runtime` | 队列绑定的模型协议/端点及暂停阻塞 | 无 |
| `tests/core/provider-sources.test.ts` | `desktop/controller` 兼容别名改为 `host/controller` | 各源独立 `/models` 请求、缓存、bridge → controller 路由 | 无 |
| `tests/host/local-host-cases.ts` | 删除对 CLI `runAttach` 与 `tests/cli/service-fixture` 的依赖；改用公共 `LocalHostClient` 发 RPC，中立 service fixture 移到 `tests/host/service-fixture.ts` | 协议握手、事件重放/边界、steer/cancel 延迟响应、审批竞争、取消清理、持锁 socket 与重复请求保护 | CLI attach 命令拼装、JSONL 输出、Ctrl+C `watch` 退出码 130、CLI 参数错误 |
| `tests/host/local-host.test.ts` | 保持不变，只注册真实 Unix socket 用例 | 真实本地 socket 协议路径 | 无 |
| `tests/host/local-protocol.test.ts` | 保持不变，只注册内存 duplex 用例 | 确定性协议/控制路径 | 无 |
| `tests/host/service-fixture.ts` | 新增中立 host 测试 fixture | host controller 需要的 project-context/MCP/checkpoint 默认实现 | 不依赖也不复制 CLI 包 |
| `tests/images.test.ts` | 删除 renderer `RunInputQueue` 用例 | 图片输入 schema/安全检查、vision token 估算、初始与 steering 图片持久化 | renderer 输入队列的序列化/暂停/恢复/回滚 |
| `tests/published-files.test.ts` | 删除 CLI `toolPresentation` 与 `files save` 断言；Web host 显式 `trustedLan: false` 以覆盖设备鉴权 | 工具发布/不可变存储、路径与密钥防护、runtime/RPC/fork/reopen、Web 下载鉴权 | CLI 工具卡片文案、`files list/save` 参数、JSON 输出与覆盖保护 |
| `tests/shared/web-search-display.test.ts` | 缩减为 shared 纯函数测试 | `webSearchDetails` 的来源投影、转义、危险 URL 抑制、去重与上限；`webSearchStatus` | CLI `historyLines`/`createEventRenderer`、renderer timeline/workbench reducer、React 组件与刷新策略 |
| `tests/store/devices.test.ts` | 删除 CLI `runDevices` 命令用例 | 邀请一次性交换、哈希持久化、过期/容量、撤销、损坏状态 fail-closed | CLI `devices pair/list/revoke` 输出与进程入口 |

`tests/shared/contract-boundaries.test.ts` 检查 Core 不反向依赖应用层、共享契约可在浏览器构建，以及 schema 身份和既有数据形状。
`tests/package.test.mjs` 另外检查实际构建包的子路径导出、浏览器依赖边界、离线回合持久化及不带 UI 文件的 API 启动。

## 约束

- Core 的这些测试只通过 `src/host/*`、`src/shared/*`、`src/core/*`、`src/store/*` 等本仓路径验证行为；客户端发现、渲染和命令入口由各客户端仓库负责。
- 没有为了通过测试而在 Core 中复制 CLI 命令实现或 renderer 状态机。
- 历史用例可从主仓归档恢复取证，不把删除或未迁移的用例视为通过。
