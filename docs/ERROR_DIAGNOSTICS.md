# 模型、客户端与工具错误诊断

这些诊断用于定位错误，不改变权限、校验强度或副作用重放边界。不要把所有 `isError` 都算作运行时缺陷：参数越界、保护性拒绝、取消、测试命令非零退出与上游故障应分别处理。

## 模型响应

Provider 的公开错误只包含固定分类与有界计数，不包含响应正文、工具参数、端点或凭据。

- `invalid_json` 配合 `stage=sse_event` / `json_response` 表示响应帧或完整 JSON 解析失败。
- Chat / Responses 工具参数 JSON 解析失败使用 `invalid_tool_call; stage=tool_arguments`，不会执行部分参数。
- 主要输出大小保护附带 `stage`、`observed`、`limit`、`unit`，区分传输累计正文、SSE 单帧、累计输出文字和工具参数。JavaScript 字符串计数明确为 `utf16_code_units`，传输计数为 `bytes`，JSON 嵌套计数为 `nesting_depth`，不能混作 token 数。
- `output_limit` 不代表工具次数耗尽、模型 token 额度耗尽或一定需要扩容。先按阶段检查网关是否合并超大帧、模型是否输出巨型工具参数，或是否需要分块生成。
- 不放宽既有正文/单帧/参数上限，不改成宽松 JSON，不把无终止信号的输出当成功。

最终模型错误消息包含本轮实际决策，例如：

```text
[automatic_retry=stopped; reason=hosted_search_may_have_executed; retries=0/5]
```

`retryable` 仍描述底层错误是否可能是暂态；它不是“自动重试已经执行”的证明。`retries` 是当前生成请求实际增加的尝试次数，不是累计任务次数。

停止原因包括不可重试错误、托管搜索可能已执行/计费、路由无法证明请求未执行，以及有界重试次数耗尽。即使没有任何输出，也不能断言托管工具未执行。普通允许重试的暂态请求保持有界退避；已完成的本地工具不重跑，不自动切换指定模型。

## Core / Web 版本与 RPC

`shared/build-info` 暴露编译时内嵌的 Core ID/时间。构建成功后 `dist/build-info.json` 保存同一个标识；运行中进程不会自动加载磁盘新版本。源码运行、缺失或损坏的 manifest 明确记为未知。

Core 的只读 `GET /api/version` 返回 `running`、`disk` 与 `restartRequired`（`"true"` / `"false"` / `"unknown"`）。沿用 Host、可选 Origin 和认证边界，不返回本机路径或配置。连接/重连 HTTP 头也提供相同标识，现有 RPC body 不增加字段。

Web 检测到磁盘新而运行旧时提示在活动任务结束后重启 Core；Web 打包契约与 Core 不同只作为提示，不一概判定不兼容，不自动重启或重发请求。构建 ID 比较不是功能可用性证明。

`HostResponseError` 包含本地请求方法及 `schema_mismatch`、`id_mismatch`、`method_mismatch`。仍严格校验响应与关联，不暴露完整 Zod issues 或上游字段。排查缓存/版本问题不要删除会话、密钥或历史数据。

## Git 与本地分页工具

- 非 Git 工作树/无工作树返回普通结构化结果 `repository:false` 和安全 `note`，不是需要重复重试的工具故障。
- 非仓库根、Git 无法启动、真实超时、输出超限及其他退出码分别提示，不透传 stderr 中的路径或凭据。没有提交的仓库返回空日志并说明原因。
- `read_file.limit` 为 1–200；`search_files.limit` 为 1–100，`context_lines` 为 0–3。字段 schema、工具说明与参数错误都给出相同范围及分页/补读方法，越界仍拒绝，不静默截断或放大上限。
- 重复失败防循环、文件版本授权与敏感路径保护保持原样。相同失败必须先看具体原因，不能靠改无关参数继续循环。

跨供应商派发和歧义处理见 [智能体协作](AGENT_COLLABORATION.md#不带角色的跨供应商模型选择)。
