# 通用异步工具与主会话唤醒

## 使用方式

当前首先接入 `forge_memory`。已有的 `run_command(background:true)` / `command_task` 保持原有的**本轮内收尾、必须 join**语义，没有被悄悄改成跨轮任务。

```json
{"query":"整理 Forge 已确认的长期开发约定","keywords":["Forge","约定"],"scope":"workspace","max_memories":2,"background":true}
```

`forge_memory` 仍先校验输入和权限；workspace 模式先完成本次审批，之后才接受后台任务。返回 `id`、`status`、`sessionId`、`wakeSessionId` 等任务回执，不再等待模型合成。**拿到任务 ID 不代表记忆已经写入。**省略 `background` 仍同步执行，保持兼容；提示词建议在有独立工作可做时显式使用后台模式。`dry_run:true` 同样支持后台执行，但仍会调用模型。

管理与通用唤醒共用 `async_task`：

```json
{"action":"list"}
{"action":"read","id":"任务 UUID","offset":0,"limit":6000}
{"action":"wait","id":"任务 UUID","timeout_ms":30000}
{"action":"stop","id":"任务 UUID"}
{"action":"wake","id":"任务 UUID"}
```

- `list/read/wait` 可以在 readonly 下使用；`stop/wake` 在 readonly 下拒绝。控制已批准任务不再次申请执行原工具的审批。
- `list` 最多返回 50 条；`read/wait/stop/wake` 的输出按 UTF-16 code units 分页，跟随 `nextOffset` 读取。默认 6,000、最多 12,000 字符。
- `wait` 最多等待 120 秒，超时仅返回当前状态，不取消任务；不要循环忙轮询。
- `stop` 发出取消并等待实际执行函数退出。取消不能回滚已经提交的结果，若提交成功与停止发生竞争，成功结果仍保持 `completed`。
- `wake` 是**通用的幂等完成通知工具**：仅限已经结束且属于当前会话的任务，重试投递同一个通知 ID，不重新执行原工具，也不能指定任意会话或伪造通知内容。
- 只有发起会话及其主会话可以读取/控制任务。子代理发起的任务由 host 接管，完成后唤醒主会话，不另起一个无人管理的子代理回合。

## 通知、权限与串行执行

执行结果先写入私有任务回执，再调用 `InputQueueHost.notify`。通知 ID 固定为任务 ID；重试或重启后的投递不能产生第二份同 ID 输入。通知只包含受控工具名、ID、状态和读取说明，原始结果由 `async_task` 分页返回。

主会话忙时，通知保留在持久输入队列；当前运行结束后串行启动新一轮。不打断正在进行的 Provider 请求，也不插入尚未闭合的 tool exchange。会话空闲时，由已连接的 host queue consumer 自动启动后续一轮；客户端断线不影响 host 持有的工作。

通知的 `origin=background_task` 只可由 host 设置，公开 `enqueueInput` / `RunInput` 不接受该标记。进入模型上下文时使用既有 `agent_reconciliation` origin，表示内部结果而非新用户请求。结果本身仍是不可信数据，不提升权限，也不能指示自动重放副作用。

唤醒沿用启动时的主会话模型/来源选择；输入入队后仍由原有 provider binding 检查防止来源静默漂移。权限额外受主会话最近实际权限限制，缺少依据或从失败/取消/中断状态显式恢复时降为 readonly。运行收尾会在冻结 host 权限切换后保存最终实际权限；正常运行中降低的权限不会因为通知而恢复。异步记忆写入前也会再次检查发起时权限与主会话后续权限。

队列已暂停，或前序失败/取消/中断时，完成通知**不会隐式恢复**。需要用户检查后显式 resume 队列。`wake` 不是绕过暂停的工具；它返回的 `notification:"queued"` 只表示已投递到队列，不保证通知已经被模型处理。停止任务或读取结果均不会撤回已经投递的通知；需要通过输入队列取消/暂停尚未绑定的输入，已启动的通知回合按普通运行取消。

## 生命周期与恢复边界

- 回执存放于 `FORGE_HOME/async-tasks/<id>.json`，沿用私有目录、原子写入和文件锁；一个状态目录只允许一个后台任务 owner。
- 先持久化 `running` 意图，再执行一次；原工具不自动重试、不自动换模型、不重新审批后重放。
- 成功/失败结果跨运行保留。进程重新打开服务时，未完成的 `running` 回执变为 `interrupted`，明确提示副作用可能不确定；**不恢复执行，不自动唤醒中断任务**。
- 已完成但尚未完成投递的 `pending` 通知可恢复投递；`failed` 投递需显式 `async_task(wake)`。输入队列已经 `bound` 的不确定运行不会重放。
- 取消运行会传递给该运行发起的后台工作；主会话结束后仍可通过 `async_task(stop)` 或 host 的 `cancelSession` 停止。停止 Core 会取消并 join 工作，再关闭模型服务与共享记忆库。
- 单主会话最多 **4 个活动任务**，每 host 最多 **16 个活动任务**，最多保留 **256 个回执**；达到容量时明确拒绝新任务，不挤掉未读结果。当前不提供自动清理/淘汰或模型侧删除回执接口。
- 每份结果捕获最多 **128 KiB**；分页截断与永久捕获截断分别由 `truncated`、`outputTruncated` 标记。脱敏在分页和持久化前完成；超出已捕获部分不能靠翻页恢复。
- 辅助推理用量保存在任务的 `usage` / `usageComplete`。任务不再向已经结束的 run 迟到回调，也不改写旧 run 的用量；**现有 run 用量汇总不会自动合并这些跨轮任务用量**。通知回合本身照常计入自己的 run。

自动唤醒要求存活的 host 和已 attach 的输入队列 consumer。单独调用嵌入式 `createHarness().run()` 而不连接 consumer 时，只会保存通知；不能把它描述成自动唤醒。自定义 consumer 必须传递 `InputQueueRunner.start` 第五参数 `origin` 到 `RunControl.inputOrigin`，并遵守 `onFinalizing` 的权限冻结约定。HTTP/WebSocket 与本地 host 的共享 controller 已完成接线。这里没有实现全局单实例 daemon、跨进程恢复执行或任务列表 UI。

## 后续工具如何接入

公共、浏览器可用契约位于 `src/shared/async-tasks.ts`；Node 服务是 `openAsyncTaskService`；模型管理入口是 `createAsyncTaskToolRegistry`。本次没有提供“传入任意工具名并强制后台执行”的绕过入口。

接入另一个慢工具时：

1. 在该工具原有入口完成参数校验、权限检查及本次审批；保留原有 beforeTool 审查。对不支持的 host 明确拒绝，不偷偷降级重做。
2. 向 host 持有的 `AsyncTaskService.start` 交付已经批准的 `execute(signal, onUsage)`，传入可信 owner/main session、固定主会话模型选择、原始调用取消信号和脱敏函数；不要保存凭据或可执行闭包到回执。
3. 执行函数必须遵守取消、报告辅助用量（未知时传 `undefined`），并在副作用提交点重查实时权限。它必须自行持有跨轮所需资源；不能依赖已 dispose 的本轮工具、写入授权、审批队列、事件 writer 或 run budget。
4. `execute` 返回合法 `ToolResult`；service 负责有界安全捕获、持久化、通知、管理与恢复，不再次调用原工具。
5. 任务级释放放入执行函数自己的 `finally`。工具 facade 的 dispose 不能取消已经转交 host 的任务；只有任务 stop、原调用取消、会话取消或 host dispose 执行取消/join。

原有 afterTool/toolError hooks观察的是提交任务的工具调用回执，不是后续任务完成；不要据此宣称后台副作用已经成功。若新工具需要执行期 hook，必须在它的 host-owned 执行上下文中显式实现，不能复用已经销毁的本轮 hook 实例。

## 离线验证

`tests/core/async-tasks.test.ts` 覆盖提前返回、并发容量、所有权、分页/脱敏、用量、wait/stop、存储失败、投递去重与重启中断。`tests/core/async-memory.test.ts` 使用真实 harness + host controller + 持久输入队列和模拟慢 Provider，覆盖主会话忙/空闲唤醒、后续及运行中权限降低、取消、子代理转交。队列和通知权限细节分别在 `tests/core/input-queue.test.ts`、`tests/core/runtime-background-notification.test.ts` 验证。测试全部使用临时状态和工作区，不调用真实 Provider。
