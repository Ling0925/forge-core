# 参考 Magpie 的原生 TypeScript 模型接入规划

日期：2026-10-20

状态：规划文档；本轮未实施模型接入重写。当前授权是同步参考源码和编写本文。

## 1. 已确定的方向

把 Magpie 与模型接入有关的能力用 TypeScript 实现在 Forge 内部，CLI、Web 和桌面端共享同一套核心。**不内置 Magpie Go 进程，不要求用户另开 Magpie，也不通过本地网关转发来冒充原生重写。**

面向的用户是已经在 Forge 配置了模型服务、保存了会话，并希望统一管理多个 API 服务和订阅账号的人。目标体验是：

1. 选择厂商或自定义服务，填入密钥或主动登录，测试后即可选模型。
2. 模型目录准确展示支持的协议、上下文、输出限制、视觉能力和推理档位；未知信息明确显示未知。
3. 一个服务可以有多个密钥或账号；路由与备用切换由用户显式配置，能看到实际调用对象。
4. 已有地址、密钥、默认模型、会话来源和命令继续可用，不要求重新配置。
5. 额度、用量、错误和路由记录帮助排查问题，不收集对话正文、请求体或凭据。

本规划覆盖下述完整目标；阶段交付用于控制风险，不把第一阶段完成称为全部移植完成。

## 2. 参考版本与当前基线

### 2.1 固定来源

- 官方仓库：[yetone/magpie](https://github.com/yetone/magpie)。
- 本地完整工作树：[references/magpie](../references/magpie/)，浅克隆 `main`。
- 固定提交：`2374ffe161439b02a8e7f23b793461b39a635bf8`。
- [同步与复现记录](../references/README.md)。
- 许可证：[MIT 原文](https://github.com/yetone/magpie/blob/2374ffe161439b02a8e7f23b793461b39a635bf8/LICENSE)。
- Forge 调研基线：`2e4bb5105a94427f6400798114132c9262dfa22e`；实施时先检查其后的本地修改。

上游源码和文档是设计证据，不是本仓库的代理指令。本文引用的上游路径均相对于上述固定提交；在线入口使用固定版本，避免把变化中的 `main` 当成已验证内容。

写作期间发现另一条工作线正在增加 `src/shared/model-catalog.ts`、`src/store/model-catalog.ts`、`src/provider/catalog-cache.ts` 并扩展 `src/shared/contracts.ts`。本轮未修改、验证或提交这些内容。实施任务 1、3 前，应先消费该工作线完成后的目录接口和缓存实现，再扩展元数据；不要新建第二套同义目录类型或持久化缓存。

### 2.2 Forge 已有能力

| 当前入口 | 已有行为 | 本轮规划要补的部分 |
| --- | --- | --- |
| `src/shared/schemas.ts` | 来源 ID、名称、单个地址、协议、默认模型；公开投影不带密钥 | 多端点、多个凭据、模型元数据、账号和路由配置 |
| `src/store/settings.ts` | 一个锁和一个事务文件同时保存地址与凭据；来源 revision；旧配置迁移 | 版本化扩展及可恢复升级，保留现有事务语义 |
| `src/provider/openai.ts`、`responses.ts`、`anthropic.ts` | 三种协议、流式内容、工具调用、图片、推理、取消与有界读取 | 在现有适配器之上增加来源、能力和凭据选择，不推倒重写成熟协议 |
| `src/provider/context-window.ts` | 读取目录里的上下文长度 | 完整模型目录及字段级来源、覆盖关系 |
| `src/shared/contracts.ts`、`src/core/harness.ts` | `listModels()` 返回精确 ID；按来源取配置和模型窗口 | 新增结构化目录和管理接口，原接口保持兼容 |
| `src/core/runtime.ts` | 运行时统一拥有生成重试策略 | 将路由候选选择接入同一重试预算，禁止叠加隐式重试 |
| `src/renderer/components/workbench/ProviderSources.tsx` | 手工添加、编辑、刷新、删除来源；并发修改检测 | 预设、导入、测试、账号、模型筛选和路由管理 |
| `src/cli/cli.ts`、`src/cli/interactive.ts` | `config`、`models`、交互选模型与来源绑定 | 对等管理入口，保持现有参数和输出合同 |
| `src/core/usage-stats.ts` | 已有会话用量统计 | 按实际调用来源、凭据和路由聚合，补额度与价格信息 |

重要现状：没有原生 Gemini 适配器；目录中出现模型不代表真实请求、额度或工具调用已验证。来源不存在时当前会话会报错，不会偷偷换来源。

## 3. 功能边界与上游对照

### 3.1 纳入模型接入重写

| 能力 | 上游阅读入口 | Forge 交付内容 |
| --- | --- | --- |
| 厂商预设、兼容端点、本地服务 | `internal/provider/presets.go`、`provider.go` | 预设自动填充协议地址；自定义地址可覆盖；无需密钥的本地服务仍可使用 |
| 模型发现、刷新与筛选 | `internal/provider/models.go`、`autolist.go`；`internal/catalog/live.go` | 保留上游 ID；手工补模型；显式全量/选择/不提供三种状态；失败保留上次目录 |
| 名称、能力和价格补全 | `internal/catalog/`；`docs/integrating.md` | 结构化目录、推理档位、上下文和输入模态；价格注明来源与时间 |
| 连通与模型调用测试 | `internal/provider/test.go` | 区分“目录可读”和“推理可用”；只在用户点击时发出最小推理请求 |
| 多密钥、请求头、额外参数和代理 | `internal/provider/keys.go`、`authheader.go`、`extrabody.go`、`proxy.go` | 独立启停、状态、脱敏；明确参数优先级与保留字段 |
| 配置导入 | `internal/provider/importapps.go`、`import_codex.go`、`importurl.go` | 首先支持 Magpie API-key 配置；其他格式逐个适配；预览、选择、确认后才写入 |
| 模型别名与路由组 | `internal/provider/group.go`；`internal/gateway/routing.go`、`fallback.go`、`affinity.go` | 顺序、轮换、最少使用；额度数据就绪后补 smart/pace；显式会话黏性 |
| 订阅账号与刷新 | `internal/provider/signin.go`、`logins.go`、`account.go` | 主动登录、过期刷新、取消、退出、多账号和失败状态 |
| 额度与用量 | `internal/provider/quotas.go`、`balance.go`；`internal/gateway/usage_api.go` | 独立展示服务余额、订阅额度、本地调用量与费用估算 |
| 原生 Gemini 与特殊鉴权 | `internal/gateway/gemini.go`；`internal/provider/` 中对应厂商实现 | 独立适配器与协议回归；不能仅加预设就声称支持 |

固定版本的系统说明：

- [Providers and accounts](https://github.com/yetone/magpie/blob/2374ffe161439b02a8e7f23b793461b39a635bf8/docs/subsystems/providers-accounts.md)
- [Gateway routing and fallback](https://github.com/yetone/magpie/blob/2374ffe161439b02a8e7f23b793461b39a635bf8/docs/subsystems/gateway-routing.md)
- [应用集成和模型目录字段](https://github.com/yetone/magpie/blob/2374ffe161439b02a8e7f23b793461b39a635bf8/docs/integrating.md)

### 3.2 不随本轮模型接入一起搬入

其他 Agent 的安装和配置改写、托盘应用、WebDAV/S3 同步、局域网公共网关、媒体生成、搜索代理、指令/MCP/技能分发，以及 OpenCode/pi 插件运行时。这些有独立产品和权限边界；未来若要求完整 Magpie 产品对等，应另列扩展阶段，不能算在下面的 4–6 周估算内。

同样不照搬自动读取其他应用账号、自动热身消耗额度、遥测和赞助排序。Forge 的默认行为继续由自身产品需求决定。

## 4. TS 架构与兼容合同

### 4.1 沿用共享核心，不新增网络转发层

```text
CLI / Web / Desktop
        |
HarnessService + 已有 IPC/RPC 校验
        |
来源注册与模型目录 -> 路由选择 -> 凭据解析 -> 现有协议适配器 -> 上游服务
        |                |           |
SettingsStore       运行时 attempt   私有账号状态
        |
公开投影、用量和脱敏诊断
```

建议新增模块如下，均是拟建路径，不是当前已存在 API：

- `src/shared/model-access.ts`：来源、凭据和路由的公开/私有类型及边界 schema，避免继续膨胀主 schema 文件；模型目录条目优先扩展上述并行工作中的 `src/shared/model-catalog.ts`。
- `src/provider/presets.ts`、`catalog.ts`：预设和目录；保留 `context-window.ts` 作为读取辅助。
- `src/provider/credentials.ts`：从已选凭据生成鉴权；不承担再次选模型或重试。
- `src/provider/routing.ts`：候选顺序、健康/冷却、黏性和决策说明；不直接发送请求。
- `src/provider/accounts/`：平台特定登录、刷新、目录和额度适配。
- `src/provider/gemini.ts`：独立原生适配器，后续扩展阶段实现。

存储继续以 `src/store/settings.ts` 为唯一设置写入入口。宿主接口仍通过 `src/shared/contracts.ts`、`src/shared/ipc.ts`、`src/desktop/worker.ts`、`src/web/` 和 `src/renderer/web-host.ts` 贯通，不让 renderer 直接读文件或持有长期凭据。

### 4.2 数据身份不能混用

| 对象 | 规划合同 |
| --- | --- |
| 来源 | 保留现有 `sourceId`；增加按协议区分的端点和默认选择，不用展示名称当身份 |
| 凭据 | 独立稳定 `credentialId`，类型为 API key 或订阅账号；公开信息只含标签、类型、状态 |
| 模型 | 使用 `(sourceId, upstreamModelId)` 作为身份；显示名称、别名与上游 ID 分离 |
| 路由组 | 独立 `groupId`，成员引用准确来源和模型；原始模型 ID 可以包含 `/`，不能按斜线猜来源 |
| 一次尝试 | 记录请求选择、实际来源/模型、协议、凭据引用、原因与结果；不记录密钥或正文 |
| 能力 | 可未知；字段记录来自上游、参考目录还是用户覆盖，不能把缺失值转换成不支持 |

保留 `HarnessService.listModels(signal?, sourceId?)` 的现有参数、`Promise<readonly string[]>` 返回类型及现有 `list_models` 工具的分页和精确 ID 语义。在并行工作完成后的 `listModelCatalog` 合同上扩展结构化条目，旧调用方继续走兼容投影。`getModelContextWindow` 改用同一个目录来源，避免两份缓存得出不同结果。

能力优先级采用“用户显式覆盖 > 当前上游信息 > 固定来源补全 > 未知”。凭据权限可能影响模型列表：缓存键包含来源 revision、协议和凭据身份，不跨账号泄漏目录；切换或删除账号时失效。参考目录访问失败不阻断已有端点调用。

### 4.3 请求参数和凭据边界

- 原有 `FORGE_*` 环境覆盖、`forge config set`、免密钥端点和显式协议选择继续可用；新增账号登录不是旧 API-key 调用的前置条件。
- 请求头拒绝换行和保留传输字段；凭据及含秘密的自定义头只进入私有存储。鉴权模式明确配置，不靠试遍多个密钥或协议猜测。
- 额外参数不能覆盖模型身份、消息、工具、流式状态和本地安全控制字段。模型专有参数由适配器验证，不静默删除用户指定的推理档位。
- 导入先返回脱敏预览；按来源稳定 ID、端点和协议判定冲突，密钥只在宿主内部比较。默认不覆盖已有项，确认后事务提交。
- 登录流程校验 state、PKCE/设备流要求、超时与取消；不得从日志、环境转储或 shell 绕路读取第三方凭据。

### 4.4 路由不能改变工具执行与重试语义

1. 直接选择模型保持精确绑定；只有用户显式选择路由组才允许跨模型切换。指定子代理 `cbcn/deepseek-v4.1-flash` 的规则不得被组策略覆盖。
2. 保留 `src/core/runtime.ts` 作为生成重试的唯一所有者；SDK 重试继续关闭。组内候选共用原有有界尝试预算、总超时和取消信号，不能形成“SDK × 路由 × runtime”的重试乘法。
3. 明确拒绝、限流及可判定未执行的失败按错误类别处理；未确定执行结果的请求、已有流式输出和 provider-hosted search 不自动改路重放。取消立即结束排队、刷新和候选尝试。
4. 已完成工具不重跑；不接受半截工具参数。切换来源或协议时，opaque reasoning/providerState 按真实端点、模型和账号身份隔离，只重建可安全表达的消息与完整工具结果。
5. 不能因“同名模型”自动建立组。模型能力、上下文和工具支持不相容时，候选在发送前排除并解释原因。
6. 会话在下一轮仍能显示实际来源、故障原因和切换记录；用户选的组与实际模型分别展示，统计分别计数。

## 5. 迁移与回退

- 用测试 fixture 覆盖无版本旧配置、当前 version 1 事务、缺失 revision 的来源、空密钥和已有会话。
- 读取旧配置时提供兼容视图；持久化新字段时才执行显式版本迁移。原来源 ID、默认模型、活动来源、环境变量优先级及会话绑定保持不变。
- 扩展事务为 version 2，把来源、凭据引用、凭据值和路由引用放在同一锁和原子提交范围，校验引用完整性，避免地址已换而密钥未换。
- 首次迁移在私有目录保留原版备份及版本标记，权限不宽于原文件。解析失败、未知高版本或磁盘失败时报错，不用空配置覆盖原文件。
- 新旧程序不能同时写同一个状态目录。迁移前识别当前宿主状态；需要停止用户服务时单独取得授权，不在后台擅自重启。
- 回退前停止相关写入并备份最新状态，再恢复旧版本配置及配套程序；会话另行保留。若后续会话新增了旧版 strict schema 不认识的字段，提供兼容导出或配套迁移，不能直接让旧程序覆盖新会话。

## 6. 实施任务与依赖

本轮没有执行以下任务。采用聚焦回归测试先固定旧合同，再按阶段补新测试；新增测试文件在对应任务创建。每阶段保持可单独使用和回退，不把全量检查、打包或发布作为本机 CLI 开发前置步骤。

- [ ] 1. 固定模型接入合同与旧行为
  - 责任：共享模型接入 owner；先读 `schemas.ts`、`contracts.ts`、`ipc.ts` 和 `docs/PROVIDERS.md`。
  - 内容：增加结构化目录和私有/公开身份模型；保留旧 `listModels`、CLI 参数及 `list_models` 工具投影；记录字段兼容规则。
  - 依赖：无。
  - 验收：旧消费者不修改也能列模型；含 `/` 的模型 ID、重名来源、未知能力、非法外部数据均有准确结果；序列化结果无秘密。
  - 聚焦检查：`pnpm exec vitest run tests/core/model-discovery.test.ts tests/core/source-follows-model.test.ts`；新增 `tests/shared/model-access.test.ts` 覆盖新 schema。
  - 提交：`feat: define model access catalog contracts`。

- [ ] 2. 来源和凭据的事务迁移
  - 责任：同一个共享模型接入 owner，避免与任务 1 并发改设置合同。
  - 内容：在 `src/store/settings.ts` 实现 version 2、备份、旧格式兼容投影、revision 冲突、删除引用保护；补密钥启停及导入事务。
  - 依赖：1。
  - 验收：迁移后地址/密钥配对、来源 ID 和会话绑定不变；重复迁移无副作用；损坏文件、并发写和中断不会丢掉旧数据；公开接口、日志和导出均脱敏。
  - 聚焦检查：`pnpm exec vitest run tests/store/provider-sources.test.ts tests/store/provider-revision-migration.test.ts tests/core/session-source-binding.test.ts`；新增 `tests/store/model-access-migration.test.ts` 注入失败与回退场景。
  - 提交：`feat: migrate provider credentials atomically`。

- [ ] 3. 预设、目录、参数与连通测试核心
  - 责任：provider owner；新增模块由其统一维护，不拆成多代理逐文件接力。
  - 内容：预设覆盖 OpenAI、Anthropic、DeepSeek、Moonshot/Kimi、Zhipu、MiniMax、OpenRouter、Ollama、LM Studio 及自定义服务；先沿用已实现三种协议。补目录元数据、筛选、手工模型、刷新、鉴权模式、请求头、额外参数和代理配置。
  - 依赖：1、2；预设中的实际端点实施时对照厂商文档重新确认。
  - 验收：无 key 本地服务可用；目录失败保留旧数据并标注过期；用户排除模型不被刷新恢复；取消测试及时结束；目录成功但推理失败分别显示；机密头不会进入诊断。
  - 聚焦检查：`pnpm exec vitest run tests/provider/openai.test.ts tests/provider/responses.test.ts tests/provider/anthropic.test.ts tests/provider/context-window.test.ts`；新增 `tests/provider/catalog.test.ts`、`connection-test.test.ts`、`presets.test.ts`。
  - 提交：`feat: add provider presets and rich model catalogs`。

- [ ] 4. CLI 与共享设置界面的完整接入路径
  - 责任：界面 owner；核心 owner 先交付稳定服务接口，界面不写存储和协议逻辑。
  - 内容：在现有来源设置中加入预设、自定义、主动导入、测试与模型筛选；按“服务 / 模型 / 账号 / 路由”组织逐阶段可用功能，不展示空壳页。CLI 保留旧命令，新增对应来源管理入口及帮助。
  - 依赖：3。本任务先交付基础接入路径；账号和路由面板分别纳入任务 5、6 的交付，不构成相互等待。
  - 验收：新用户添加到首次调用顺畅；已有用户不需要重填密钥；未保存编辑、revision 冲突、错误和取消都有明确反馈；CLI/Web 对同一来源显示一致。
  - 聚焦检查：`pnpm exec vitest run tests/renderer/provider-sources-mounted.test.ts tests/renderer/model-settings-mounted.test.ts tests/renderer/model-effort-mounted.test.ts tests/renderer/composer-source-model-mounted.test.ts tests/renderer/model-catalog-cache.test.ts tests/web-bridge.test.ts`；新增 `tests/cli/provider-management.test.ts`。
  - 表面验收：隔离配置下真实浏览器操作添加、测试、刷新、切换和恢复；桌面宽度与窄屏、浅色与深色各留截图；CLI 使用临时 `FORGE_HOME` 演练同一路径。
  - 提交：`feat: unify provider setup across cli and workbench`。

- [ ] 5. 多凭据、路由组和实际调用观测
  - 责任：runtime/provider 同一 owner；这是一个状态机，不与其他人并发改重试循环。
  - 内容：先实现 order、rotate、usage 与显式黏性，新增状态/诊断；任务 6 提供可靠额度后补 smart、pace。扩展现有用量服务，不另建平行统计平台。
  - 依赖：2、3、4；smart/pace 还依赖 6。
  - 验收：指定模型不换模；组成员权限和能力正确；失败只消耗共享预算；中途断流、取消和 hosted search 不被自动重放；工具执行次数保持一次；失败费用未知时不记为零。
  - 聚焦检查：`pnpm exec vitest run tests/core/provider-retries.test.ts tests/core/session-source-binding.test.ts tests/provider/web-search.test.ts tests/provider/responses-compat.test.ts tests/provider/tool-preview.test.ts tests/usage-stats.test.ts`；新增 `tests/provider/routing.test.ts` 及 `tests/core/routed-session.test.ts`。
  - 提交：`feat: add explicit model routing and credential selection`。

- [ ] 6. 订阅账号、额度与刷新
  - 责任：账号适配 owner；共享登录状态机和秘密存储由单一 owner 持有，各平台适配在接口稳定后可并行。
  - 内容：先实现 Codex/ChatGPT 和 GitHub Copilot 两条代表性路径，随后根据账号矩阵扩展；主动登录、取消、退出、刷新单飞、跨进程轮换冲突处理和额度缓存必须一起完成。
  - 依赖：2、3、4；与任务 5 通过凭据/额度合同对接。
  - 验收：成功登录后真实列模型及最小工具调用；过期刷新和撤销可观测；多个进程不会互相覆盖 refresh token；不扫描/修改其他应用凭据；账号退出后目录和候选立即失效。
  - 聚焦检查：新增 `tests/provider/accounts.test.ts` 和平台测试；fixture 覆盖伪造回调、超时、取消、刷新竞争、无额度、重新登录及私有数据脱敏。
  - 真实验证：需要用户主动完成第三方登录及授权相应测试调用；未取得账号或授权的平台标记“待验证”，不能用 fixture 结果替代。
  - 提交：按平台分别使用 `feat: add <platform> account support`。

- [ ] 7. 原生 Gemini、云平台鉴权与其余订阅兼容
  - 责任：对应适配器 owner；不修改已验证适配器来强塞不同协议。
  - 内容：实现 Gemini 原生协议；按矩阵补 Azure、Vertex、Bedrock 等专有端点/签名及其余订阅平台。每个平台先确认可用鉴权路径，再完成目录、流、工具、取消、额度和错误映射。
  - 依赖：1–6；平台凭据与特殊依赖见下一节。
  - 验收：四协议不混淆；图片、工具结果与推理状态不丢失；不把普通兼容地址配置成功说成原生云签名支持；不支持的参数明确拒绝。
  - 聚焦检查：新增 `tests/provider/gemini.test.ts`、平台特定鉴权和对话测试；重跑发生合同交集的原有协议测试，并逐个平台留真实调用证据。
  - 提交：每个协议/平台独立 `feat:` 提交；这部分不包含在代表性双账号的时间承诺中。

- [ ] 8. 来源声明、迁移说明和阶段验收收尾
  - 责任：主代理审查并整合各阶段证据；实现 owner 修复自己负责的缺陷。
  - 内容：随首次实际改编就补 `THIRD_PARTY_NOTICES.md`、保留 MIT 文本，并准确更新 `README.md`、`docs/AUTHORSHIP.md`、`docs/REFERENCE_DESIGN.md`、`docs/PROVIDERS.md`、`docs/ARCHITECTURE.md` 与 CLI 用法；不能等全部完成才补归属。
  - 依赖：对每个已交付阶段持续执行；整体结项依赖对应目标任务全部验收。
  - 验收：文档区分已支持、fixture 覆盖、真实验证和待验证；旧配置、旧会话、取消、错误和恢复场景都有可查证据；未交付平台不计为完成。
  - 提交：`docs: document native model access and migration`，或与对应实现原子提交。

共享合同、设置迁移和 runtime 重试分别保持单一修改 owner。子代理必须使用 `cbcn/deepseek-v4.1-flash`，不可用时检查其已产生内容并报告，不自动改模型或重放任务。主代理的实施/审查边界沿用本仓库约定；本规划不是变更授权。

## 7. 账号与扩展能力的决策点

| 对象 | 本规划的安排 | 开始真实验证所需条件 |
| --- | --- | --- |
| API-key 服务与本地模型 | 首批交付，三协议优先；不依赖订阅登录 | 用户授权的测试端点/密钥或本地 fixture |
| Codex/ChatGPT | 首批订阅适配；实现前确认支持的登录及调用路径，不复用本次 Codex 工具的内部凭据 | 用户主动登录测试账号，允许最小调用 |
| GitHub Copilot | 首批订阅适配，设备流及账号权限单独验证 | 用户主动登录并具有对应模型使用资格 |
| Claude 订阅 | 单独可行性任务；上游固定版本通过本机 `claude` 二进制桥接，不是普通 Anthropic API key | 确认可行纯 TS 接入；若只有 CLI 桥接可行，先由用户决定是否接受外部 CLI 依赖，不擅自安装或启用 |
| Gemini/Antigravity 等订阅 | 后续平台适配，逐个确认认证、协议和额度来源 | 可用账号、明确接入方式和测试授权 |
| Azure/Vertex/Bedrock | 后续云鉴权阶段，与普通服务地址配置分开 | 实际租户/区域/权限和可用测试资源 |
| OpenCode/pi 插件兼容 | 扩展阶段，当前模型接入计划不包含第三方代码执行环境 | 单独确定插件信任、权限和依赖管理方案 |

Claude 参考：[订阅桥接说明](https://github.com/yetone/magpie/blob/2374ffe161439b02a8e7f23b793461b39a635bf8/docs/subsystems/claude-subscription-bridge.md)。其上游进程启动和权限行为不能直接带入 Forge；Forge 的工具审批仍由自身运行时控制。

这些条件只阻塞对应平台，不阻塞预设、目录、API-key 管理和其他已具备条件的平台。实际实施时，由主代理记录受影响平台、缺失条件、所需用户动作和恢复点。

## 8. 工作量与交付口径

以下沿用前次讨论的单人有效开发工作日估算，是累计量级，不是代理会话的倒计时。默认不新增专职团队，也不把付费调用预算视为已批准。

| 阶段 | 可用交付物 | 初步累计工作量 |
| --- | --- | --- |
| A：接入主流程 | 三协议预设、丰富目录、测试、旧配置兼容、CLI/Web 可用主路径；任务 1–4 中相应部分 | 3–5 个工作日 |
| B：API 接入平台 | 多密钥、多端点、请求头/代理、导入、别名、显式路由和诊断；任务 1–4 及任务 5 的基础策略，不含依赖订阅额度的策略 | 2–3 周 |
| C：代表性订阅 | 加 Codex/ChatGPT、Copilot 两类账号、刷新及额度；任务 6 的首批平台和任务 5 的额度策略 | 4–6 周 |
| D：扩展兼容 | 原生 Gemini、云签名、其余订阅；任务 7 与未决账号逐项完成 | 完成可行性和凭据确认后单独估算 |
| 完整 Magpie 产品对等 | 还包括第 3.2 节的独立产品能力 | 先前粗估 2–3 个月起，当前源码审阅不足以形成承诺 |

4–6 周覆盖的是代表性账号接入，不是 Magpie 所有厂商、订阅和插件的全面对等。任务 1–2 完成并跑通首条真实调用后，应依据实际差异修正工期；修正要说明影响哪一阶段，不能通过移除目标维持原估算。

## 9. 验收与本机交付方式

- [ ] F1. 旧合同与迁移：用隔离的旧配置/会话 fixture 检查启动、选模型、续聊、压缩、分支和子代理；失败路径确认原文件仍可恢复。
- [ ] F2. 协议与路由：检查真实请求的目标、取消、工具配对和单次执行；HTTP fixture 与真实账号验证分别记录。
- [ ] F3. 使用界面：真实浏览器和 CLI 演练添加、导入、测试、筛选、切换、失效恢复；查看实际渲染而不只检查 mounted tests。
- [ ] F4. 保密与许可：确认 renderer、RPC、错误、事件、用量、导出和截图无密钥/令牌/消息正文泄漏；检查改编文件的来源记录与 MIT 声明。
- [ ] F5. 编译与交付：按每轮实际改动执行最小适用检查、审查 diff 并本地提交；不提交参考仓库、真实配置、测试账号材料或构建产物。

证据放在 `.build/model-access/<阶段>/`，只保留脱敏测试结果、fixture 说明、截图及验收记录。任何未通过或未执行的关键检查要标注受影响功能；不能把“编译成功”提升为“账号/协议全部可用”。

CLI 或共享核心修改后，只需：

```sh
node scripts/build-core.mjs
node --check dist/cli.mjs
(
  forge_check_home=$(mktemp -d) || exit 1
  trap 'rm -rf -- "$forge_check_home"' EXIT
  FORGE_HOME="$forge_check_home" node dist/cli.mjs --help
)
```

然后重开 `forge` 使用新产物。不要默认执行桌面打包、安装脚本、完整发布或重启用户的 Web 服务。纯文档阶段不编译、不运行模型、不触碰真实配置。
