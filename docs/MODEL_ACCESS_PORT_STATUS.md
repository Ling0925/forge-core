# 原生供应商接入：实现、迁移与验证记录

## 基线与交付口径

- 对照 [Magpie `2374ffe161439b02a8e7f23b793461b39a635bf8`](https://github.com/yetone/magpie/tree/2374ffe161439b02a8e7f23b793461b39a635bf8)，不声称固定端点、参考模型或认证流程代表厂商最新线上行为。
- Forge 保留自己的 TypeScript 运行时、工具审批、设置事务与共享宿主；不启动 Go 网关，不读取其他应用凭据，不引入隐藏的外部 CLI。
- CLI、Web/桌面供应商管理调用同一宿主 API。来源、组、凭据和模型各有独立 ID；模型 ID 的 `/` 不解释为来源前缀，直接选择模型不自动换模型。
- 来源与 MIT 全文见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
- **交付的是下列实现及本地验证，不是 Magpie 全平台对等。** 真实登录、付费调用和云资源验收尚未执行；没有读取本机真实密钥。

## 已实现与差异

| 范围 | Forge 实现及与固定 Magpie 的区别 |
| --- | --- |
| 设置 | v2 单事务保存来源、凭据、私有连接参数、路由组；保持旧单 key、来源 ID 和会话绑定；批量修改、revision 冲突、刷新写回均在锁内。公开设置不返回 key、token、header 值或 extraBody |
| 模型目录 | 复用已有磁盘缓存和请求合并；精确 ID、名称、上下文、输出上限、模态、工具/视觉、推理选项、价格来源/日期和字段 provenance。`all`/`selected`/`none` 区分完整、指定与显式空列表；手工模型、显式别名和用户覆盖保留 |
| 目录失败 | 缓存不因失败被清空；界面显示 stale/刷新失败。CLI 显式刷新失败返回非零并告知旧缓存保留，可不带 `--refresh` 读取；不会把旧结果伪装成刷新成功 |
| 预设 | OpenAI、Anthropic、DeepSeek、Moonshot、Zhipu、MiniMax、OpenRouter、Ollama、LM Studio、Google、Vertex、Azure、Bedrock 与 Custom；区域与协议端点可编辑。不是上游所有厂商全集，不复制赞助或说明文案 |
| 请求参数 | 配置鉴权、请求头、extraBody 和 HTTP(S) 代理参与真实目录/推理请求；保留上游数组合并与 `!` 替换语义；不允许改写运行时消息、工具或本地控制。代理专属主机有 CONNECT fixture |
| 测试 | 目录检查与显式最小推理分离；后者使用 64-token 输出上限，支持命名取消；设置/预设浏览不自动推理 |
| 导入 | 用户主动提供 Magpie JSON 或 `magpie://import`；脱敏预览、逐来源选择、一次事务应用。未知格式/跳过项给出原因；不扫描应用目录或自动导入密码 |
| 路由 | 显式组及同来源多凭据的 `order`/`rotate`/`usage`/`smart`/`pace`、冷却、粘性；已知协议/工具/视觉不兼容候选在发送前排除；上下文使用已知候选的保守窗口，未知能力不伪造 |
| 重试 | runtime 是唯一尝试预算；每次 complete 最多一条上游推理。明确 429 拒绝可换候选；超时、断连、5xx、缺失 finish 不能证明未执行，不自动重放。已流出文本、工具预览或 hosted search 同样不重放 |
| 状态隔离 | Responses、Anthropic、Gemini 的不透明状态绑定 endpoint/model/protocol/source/credential 和鉴权摘要。更换 key 不复用旧账号状态；同账号短期 token 刷新保留稳定身份；旧无身份摘要状态降级为通用消息和完整工具结果 |
| 观测 | 用量看板分为「用量统计」「请求记录」；请求记录由持久化 `provider_attempt` 起止事件配对，逐条展示实际来源、精确模型、凭据、结果、tokens、耗时、Token 速度与预估费用（USD），详情含组、原因、尝试序号及会话跳转，支持时间/工作区筛选、刷新和翻页。聊天输入框不再显示调用诊断行；缺失结果或 usage 保持未知，不推断为成功或零成本。旧会话若没有 attempt 事件，不补造请求；不采集请求正文或凭据值，也不承诺所有厂商余额查询或完整货币账单 |
| Gemini | 原生 SSE/JSON、目录分页、图片、完整 functionCall/functionResponse、thoughtSignature、推理、取消/错误处理；工具结果后的用户文本独立成轮；不将 hosted search 替换为本地工具 |
| Vertex | 仅显式 JSON：service_account JWT、authorized_user 刷新、impersonated_service_account 及显式服务账号模拟；不支持 external_account/WIF；惰性铸造、缓存、刷新、取消。静态参考目录不触发 token 网络请求；不自动读 ADC、环境、gcloud 文件或 metadata 服务 |
| Azure | 对照 `azure.go` 的 `/openai/v1`、`api-key`、精确部署名称。用户填写资源地址；不声称 classic `api-version` 或 Entra 自动发现/登录 |
| Bedrock | 对照固定预设的 API-key bearer 与 Chat/Responses/Anthropic 兼容端点、区域和静态参考模型；**不是 IAM SigV4 凭据链**。模型目录不证明该区域/账号有资格使用 |

## 请求速度与费用估算

- 请求表将缓存命中 Token 合并到「输入 / 输出」单元格的第二行，以淡灰色显示；未知缓存为 `缓存 —`，明确零命中为 `缓存 0`。思考等级在列表与详情中展示，新请求的直连/路由起止事件保存当时配置的 `reasoningEffort`（`default` 显示「模型默认」）；未记录的旧请求明确显示「未记录」，不从当前设置倒填。生成请求的 Web/CLI 宿主需要更新并重启；只刷新网页不会让仍运行的旧宿主开始保存该字段，也不能恢复旧事件。该字段表示请求时的配置，不保证供应商实际采用的推理等级或预算。
- Token 速度为 `completionTokens / (durationMs / 1000)`，单位 `tok/s`，包含请求等待时间，不是扣除首 Token 延迟后的纯生成速度。缺失用量、起止事件或有效正耗时时显示 `—`；不补造旧会话事件。
- 价格由共享宿主按需自动获取 [models.dev/api.json](https://models.dev/api.json)，单位是美元 / 百万 Token（[上游格式](https://github.com/sst/models.dev#api)）。只请求公开目录，不发送模型配置、会话内容或凭据。下载截止时间为 60 秒（含完整响应体）；成功后在状态目录的 `model-prices.json` 保存公开目录，进程内及磁盘缓存有效期为 24 小时，重启不清空价格。下一次统计读取时刷新过期价格，失败保留上次价格，自动获取冷却 5 分钟；手动点击「刷新统计数据」立即重试，不受冷却限制。没有可用目录时显示「价格加载失败 / 价格未加载」，与模型确实缺少定价区分；更新失败但仍有缓存时显示「使用缓存价格」，继续估算。缓存读写失败不阻断其他统计与请求记录。
- 两侧模型 ID 都取最后一个 `/` 或 `:` 后的部分并忽略大小写，例如 `cn:vendor/gpt-5`、`vendor/gpt-5` 与 `gpt-5` 使用同一匹配键。只影响费用匹配，不改实际发送/展示的模型 ID，不做名称、日期后缀或近似型号猜测。历史 ID 的 `[1m]` 上下文注记先精确匹配，目录无该条目时才回退到不带注记的基础 ID；不裁掉 `-free`、`-high` 等实际型号变体。同名条目优先 `canonical_model_id` 所属原厂，再选裸模型 ID，最后按供应商/模型 ID 稳定排序。
- 费用为 `((输入 - 缓存命中) × 输入单价 + 缓存命中 × 缓存读单价 + 输出 × 输出单价) / 1,000,000`；无独立缓存读单价时使用输入价。按输入 Token 数应用 models.dev 的上下文阶梯价格，明确的零价仍显示零。需要的用量或单价缺失时不估成免费。
- 这是按当前公开价格回算的参考值，不是历史账单或中转商实际扣款。现有事件未单独记录缓存写入、音频及工具计费项，无法精确核算这些附加费；缓存写入包含在普通输入估算中。不新增界面说明段落或计费设置。
- 模型消耗按实际请求中记录的完整模型 ID 归集 Token 和费用，价格查询仍使用上述截断规则；不把同一短名称下的第一条请求统计复制给其他模型。会话切换模型或路由实际选择其他模型时，不再把历史用量全部归给会话当前模型。请求级 usage、`context_usage` 和 `run_finished.usage` 去重：优先实际请求，只补充运行汇总中未覆盖的剩余用量；没有请求明细的旧运行归给当时 `run_started.model`（事件也缺失时才回退到会话模型）。不改写持久化事件，也不重复叠加父运行的子代理汇总。
- 模型列表保留未匹配价格、失败或进行中请求的模型；未知费用显示「费用未知」，真实零价仍显示 `$0.00`。各模型金额合计逐请求估算和去重后的历史剩余用量估算。历史记录即使没有请求明细也会加载价格，按当前公开基础单价计算输入、缓存读与输出费用，明确显示「汇总估算 / 含历史估算」并在提示中说明无法还原逐请求上下文阶梯价；不将整轮累计 Token 套入请求阶梯、不补造请求记录。真实缺少价格或用量的项仍未知，混合计价时标记「部分」。总费用卡片和每日费用图采用同一费用口径，与模型金额总和一致；请求列表仍只显示真实请求小计。时间筛选对模型、总计、每日和会话 Token 使用同一批记录：请求按请求时间，旧运行的剩余用量按运行时间，避免长会话的历史 Token 混入当前费用区间。
- 聚焦检查：`pnpm exec vitest run tests/core/model-pricing.test.ts tests/core/model-access-service.test.ts tests/usage-request-records.test.ts tests/usage-stats.test.ts tests/usage-model-distribution.test.ts tests/renderer/usage-requests-mounted.test.ts`。覆盖慢响应体、价格刷新重试、跨重启磁盘缓存与失效回退；浏览器检查用合成会话和价格响应经过生产统计服务，覆盖明暗主题、390/1440 宽度、筛选、翻页、详情，以及模型切换、同短名不同完整 ID、部分/未知/零费用、价格失败与恢复。思考等级另通过本地 HTTP fixture → 真实宿主 → 事件落盘 → 统计 → Chromium 列表和详情的链路验证，使用临时状态目录，不读取真实凭据或触发付费推理。

## 账号与未完成平台

| 平台 | 实现和 fixture | 尚需条件 / 不支持范围 |
| --- | --- | --- |
| Codex/ChatGPT | 设备流、取消、刷新、Responses、目录、额度；PKCE/state 校验 helper | 需用户主动登录、有资格订阅、最小调用授权；浏览器回调宿主尚未暴露，helper 不算已支持回调登录 |
| GitHub Copilot | GitHub device flow、订阅检测、短期会话 token、目录/协议选择、initiator/vision headers、额度 | 需主动登录及模型资格；GHE 主机发现未移植 |
| Gemini API | 原生协议本地 HTTP fixture | 需授权的来源/密钥和最小真实请求；不等于 Google 订阅支持 |
| Vertex | 明确凭据与 token/IAM 交互 fixture、宿主惰性接线 | 需 project/location、显式授权凭据、对应 Vertex/IAM 权限；不做隐式本机发现 |
| Azure / Bedrock | 宿主端点、鉴权、静态目录与既有协议 fixture | 需真实资源、区域和访问资格；其他云鉴权方式未实现 |
| Claude 订阅 | **未实现** | 固定上游依赖 `claude` 二进制桥接；纯 TS 可行性未确立。若接受外部 CLI，必须另行明确授权，不擅自安装/调用 |
| Gemini/Antigravity 订阅 | **未实现** | 需单独确认登录、Code Assist project/tier、请求与额度路径以及可用测试账号 |
| OpenCode/pi 插件 | 不在本轮代码执行兼容范围 | 需另定插件信任、权限和依赖边界 |

完整上游预设/参考价格库、所有订阅和云签名模式、跨重启路由健康/衰减计数等不在当前完成声明中。`smart`/`pace` 只用实际查询到的额度；没有额度时明确退回声明顺序，不能编造余额。后续按平台恢复任务，不重复已完成的迁移或登录副作用。

## CLI 用法

```sh
forge providers --help
forge providers list --json
forge providers presets --json
forge providers save --input /path/to/private-source.json
forge providers catalog source-id --refresh --json
forge providers test source-id --kind catalog
# 以下命令才主动发送推理请求，可能收费：
forge providers test source-id --kind inference --model exact-model-id
forge providers import --input /path/to/export.json
# 看过预览后显式选择：
forge providers import --input /path/to/export.json --apply --source selected-source-id
forge providers login source-id codex
forge providers login source-id copilot
forge providers quota source-id --credential account-id
forge routes save --input /path/to/group.json
forge run '任务' --route-group group-id --permission readonly
```

来源 JSON 支持 `{source:{type:"save",source:{id,label,baseUrl,apiMode,model,...},credentials:[...],connection:{...}}}`；批量为 `{sources:[...]}`。密钥、headers、代理认证、Vertex 凭据等从 stdin/文件传入，不放入 argv。`--expected-revision` 保留并发冲突保护。组 JSON 为 `{id,label,strategy,members:[{sourceId,model,credentialId?}]}`。

旧 `config`、`models`、`run`/`resume` 保持使用；精确 `--model` 覆盖清除继承组。命名子代理模型也是精确绑定，不继承父会话的跨模型组。CLI 登录只打印 URL/code 并轮询，不自动打开浏览器或查询额度；Ctrl-C 取消登录。

## 迁移与回退

1. 停止共享同一 `FORGE_HOME` 的旧进程；迁移前由用户在安全位置备份整个私有状态目录，不能将备份上传到仓库或附件。
2. 读取旧单 key / v1 事务仍兼容；首次写入新增接入字段时使用 v2，仅操作旧功能时保留 v1。已有 v1 事务首次升级时保留 `$FORGE_HOME/settings/state.v1.backup.json`，原旧配置文件不删除；备份同样包含秘密，维持私有权限。
3. 未知版本、损坏数据、来源 revision 冲突或批量校验失败会失败，不静默重置。来源、模型选择、凭据与路由在同一次原子提交中更新；秘密不经公开设置回传。
4. 旧会话继续使用已有来源；旧不透明协议状态缺少身份摘要时只丢弃不透明部分，保留通用消息/工具配对。切换源、组、凭据和账号后不会跨身份回放签名状态。
5. 回退时先停新进程并保留升级后目录，再恢复迁移前**完整备份**，用旧程序打开。仅恢复 `state.v1.backup.json` 不能回退升级后的会话或新功能数据。不要混跑新旧进程，也不要在没有完整备份时删除 v2 数据以“修复”启动。未提供自动降级导出。

## 验证证据（2026-10-20）

以下均使用隔离 fixture，不是线上账号调用；各组可能有重复文件，不合计为唯一测试数量。

- 8 个协议文件、193 项通过：OpenAI、Responses/兼容、Anthropic、Gemini、hosted search、工具预览、身份隔离。
- 18 个迁移/宿主/路由/账号/CLI/统计文件、167 项通过：来源绑定和 fork、v1/v2 与旧配置、revision、显式导入、取消、429 切换、未知结果不重放、单次工具执行、账号刷新与额度等。
- 4 个预设/元数据/宿主/Chromium 文件、39 项通过；云鉴权模块另有 26 项通过。
- 真实 Chromium 挂载生产组件进行添加/编辑、预设/区域/协议、目录能力、导入选择、凭据增删、账号登录/额度、路由选择和用量交互；RPC 由 fixture 驱动。Composer、旧来源管理、renderer 缓存和 Web bridge 相关检查通过；不等同于安装版 Electron 或真实 Web 部署验收。
- 390/1440、light/dark 截图保留在 `.build/model-access/browser/`；有横向溢出断言，未宣称人工逐像素评审。测试账号材料均为合成数据。
- 最终 5 文件 / 32 项复验通过，含 CLI 刷新失败非零退出、显式组的可用成员压缩、重复手动压缩幂等性、旧来源绑定；CLI 管理测试现为 13 项。
- 最小编译 `node scripts/build-core.mjs`、`node --check dist/cli.mjs` 已通过。编译后 CLI 使用临时 HOME/FORGE_HOME 和本地 HTTP fixture 完成 help、来源 save、旧 models、catalog、显式 inference、routes save、routed run，退出 0；包括原有自动标题在内共 3 次本地合成生成请求，无外部请求，临时目录已清理。演练脚本为 `.build/model-access/cli-smoke.mjs`，不提交构建目录。
- 核心/CLI 10 根文件的聚焦 TypeScript 检查还报告 `src/cli/render/history.ts:46` 的 `exactOptionalPropertyTypes`/citations 类型问题；不声称全库 typecheck 通过。最终核心/集成测试 3 根文件的聚焦检查为 0 diagnostics；未运行全量 lint/测试/发布。
- CLI 子任务因预算耗尽留下草稿，由主代理检查、修复和验证；未自动换用其他模型。所有后续子代理按用户更正使用 `cn:deepseek-v4.1-flash`。

本机交付仅编译 CLI；重开 `forge` 读取新 `dist/cli.mjs`。当前进程不会热更新；未重装、未打桌面包、未重启用户 Web 服务。文档与代码由本轮本地提交收尾；既有目录缓存和其他并发任务的提交保持独立。
