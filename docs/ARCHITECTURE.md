# Forge Core architecture

Core owns the TypeScript agent runtime, providers, tools, persistence, project context and host transports. CLI, Web UI and Android are separate clients. The Forge assembly repository pins their versions; it does not contain another runtime. Package usage and build commands are in the [README](../README.md).

## Module ownership

| Module | Responsibility |
| --- | --- |
| [core/harness.ts](../src/core/harness.ts) | Service assembly, run-boundary configuration and disposal. Its parts live in `core/harness-{tools,memory-tools,provider-selection,run,input-queue,sessions,titles,compaction,checkpoints,published-files}.ts` |
| [core/runtime.ts](../src/core/runtime.ts) | Session lock, provider scheduling, durable tool intent/results and terminal state. `run()` drives the step loop over shared `RunState`; its steps live in `core/runtime-{state,events,permission,usage,steering,step-context,provider-request,tool-calls,reconciliation,recovery,harness-preflight,finish,retry}.ts` |
| [provider/](../src/provider) | Protocol adapters, catalogs, explicit routing, accounts and cloud authentication |
| [store/](../src/store) | Settings transactions, sessions, checkpoints and private state |
| [tools/](../src/tools) | Local, browser and external tool adapters |
| [plugins/](../src/plugins) | Host-registered capability modules, configuration, scoped resources and official browser |
| [context/](../src/context) | AGENTS.md and skill discovery |
| [mcp/](../src/mcp) | Registered MCP servers and connection lifecycle |
| [host/](../src/host) | Client-neutral controller, runtime hub and local transport |
| [web/](../src/web) | HTTP/WebSocket API, static host and gateway |
| [shared/](../src/shared) | Browser-safe schemas, ports and transport contracts |

Clients import `@forge/core/...` exports, not copied source. Shared contracts cannot import Node, Core implementations or client code. Parse unknown persisted data, requests and tool arguments at the receiving boundary; types alone do not validate input. See [contract boundaries](CONTRACT_BOUNDARIES.md) and [test ownership](TEST_OWNERSHIP.md).

`ForgeError` carries an authored safe public message. Use `toErrorInfo` for unknown errors; never expose arbitrary exceptions, HTTP bodies, headers, private config or credentials through logs and transport.

## Model access and routing

[Model access](MODEL_ACCESS_PORT_STATUS.md) describes implemented adapters, migration and remaining platform validation. The protocols are OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and native Gemini. OpenAI and Anthropic adapters use their official SDKs; generation SDK retries are disabled so the runtime owns the retry budget.

The model-access service owns presets, discovery, explicit tests/imports, account login and quota operations. Settings v2 commits sources, credentials, private connection parameters and explicit route groups under one lock. Public projections exclude secrets. Browsing settings is not authorization for inference or account login.

Sessions retain their source and model. Changing the global active source does not reroute existing sessions; missing pinned sources fail rather than silently falling back. Legacy sessions without source identity bind on their next run. Explicit model selection clears inherited route groups.

One rule (`selectSessionSource` in `core/harness-provider-selection.ts`) picks the source for runs, queue admission and bindings, and manual compaction: explicit selection, then the session's pinned source, then the source that alone publishes the requested model, then the fallback. The fallback is the stored active source unless `FORGE_BASE_URL`/`FORGE_MODEL`/`FORGE_API_KEY` are set; then it is the environment configuration, as in the settings store and `listModels`. New and legacy sessions created or run under an override therefore stay unpinned and follow the environment instead of binding to the stored active source; sessions already pinned to a source keep it.

A session's background model requests (auto-title and manual compaction) use the same route as its steps: an explicit route group, or credential rotation for a direct source with several enabled credentials. They go through the routed provider's `auxiliary(sessionId)` view, which applies member selection, resting/failover, quota and usage accounting and the session's sticky member, but keeps its own retry chain and never moves the sticky pin, so it cannot alter a concurrent run step's retry decision. This supersedes 6a43589, which sent titles (and compaction used the same shortcut) straight to the group's base member.

Routing chooses at most one candidate per generation attempt. Explicit capacity rejection can permit another candidate; timeouts, disconnects, 5xx or partial output do not prove that work was unexecuted. Uncertain routed attempts are not replayed. Opaque protocol continuation is scoped to endpoint, model, protocol, source, credential and authentication identity. Changing a key invalidates that state; refreshing a short-lived token for the same account preserves identity.

First launch works without endpoint, model or key. Network operations require valid configuration; an empty key remains valid for explicitly configured unauthenticated providers. Omitted credentials preserve stored values, while explicit empty values clear them. Never put private provider configuration in session records or public RPC responses.

## Permission, run mode and CLI approval

These are three separate controls:

- **Permission**: `readonly < workspace < unrestricted`. Fresh settings default to `workspace`. Runtime resolves the live/requested/default permission and clamps it to the session's inherited ceiling at execution boundaries.
- **Run mode**: `build` or `plan`. Plan clamps tools to readonly; switching an approval policy cannot bypass it.
- **Approval policy**: a host decides how to answer permitted approval requests. This does not raise permissions or provide an OS sandbox.

The CLI's interactive `full-access`, `auto` and `manual` policies, and the separate noninteractive `--permission unrestricted --yes` requirement, belong to the [CLI guide](https://github.com/Ling0925/forge-cli/blob/master/docs/CLI.md#交互按键).

Local tools validate paths, symlinks, argv, environment, time and output limits. MCP and external tools retain their own admission checks. Project instructions and skills cannot grant permission.

## Runtime and persistence

A run holds the cross-process session lock through its final durable checkpoint. A busy session fails explicitly; cancellation must join started work before releasing the lock. Save assistant tool calls and pending intent before effects, then commit results and file-change evidence in call order. Recovery records interrupted/uncertain work and never automatically repeats it.

One accepted user request is one conversation turn. A model generation plus its tools is a step; retries remain within that step, and steering remains in that turn. Old records without step/retry metadata remain readable without fabricated counts.

Deprecated `maxTurns`, `maxToolCalls`, `maxRootToolCalls` and `rootTimeoutMs` fields remain accepted (all optional, no defaults; older saved settings round-trip them) but do not terminate runs. Per-request/tool bounds, cancellation, context budgets and child concurrency/depth limits (`maxActiveAgents`, `maxAgentDepth`) still apply. Usage counters are observations, not execution limits.

Raw history remains retrievable. Context projection and semantic compaction change what is sent to a provider, not the transcript. Cold resume can use a local run-end checkpoint without an additional summary-model call. Forking copies settled history and never executes copied calls.

See [runtime lifecycle](RUNTIME_LIFECYCLE.md), [session storage](SESSION_STORAGE.md), [input queue](INPUT_QUEUE.md), [memory](MEMORY.md), [async tools](ASYNC_TOOLS.md) and [optional Harness² preflight](HARNESS_ADAPTATION.md) for their owned contracts.

### Board 通知与取消契约

- **持久去重（R4）**：Board Router 的 `work_changed` 通知按来源（URL、projectId）、SSE event ID 和 work ID 持久去重。首次请求在入队或取消 Worker 前保存，重放沿用其 UUID、Router 和通知内容；即使任务数据已变、通知已消费或队列回执已移入 `input-queue/receipts/`，也不重复入队。Worker 处理完成后保存 `handled` 标记，已完成的处理不因重放再次取消或排空 Worker；标记写入失败时，未完成的 Worker 处理仍可能重试。最后在同一 SQLite 事务中提交游标并删除对应的已处理记录，队列项和回执不随之删除。
- **迁移与降级**：现有 v2 数据库通过新增 `board_notifications` 表升级，`user_version` 仍为 2，原有数据和队列格式保留。旧版 v2 兼容程序可忽略新表，但不提供上述去重或记录清理；未完成处理期间降级可能产生重复通知，且无自动清理或破坏性转换。升级前的匿名通知无法可靠关联历史事件，已有重复项不会自动合并或删除。
- **来源与回执边界**：不同 URL/projectId 使用独立的游标和去重空间；停用来源的待处理记录保留至该来源恢复并提交游标。同一 URL/projectId 须保持事件序列身份稳定，原地重置或替换 Board 需显式处理来源代际与游标迁移，Core 不自动猜测或重置。手动删除或恢复队列回执、回退游标均超出此契约；通知入队去重不保证外部副作用恰好一次，也不构成跨存储的 Worker 事务。
- **待审批取消**：取消请求待审批时立即停止 Worker 执行，但不提前将 Board 任务标记为已取消；审批拒绝后不自动恢复 Worker，恢复须显式触发。
- **晚到取消**：终态已选定后到达的取消请求保留既定完成结果；`wait=true` 等待运行清理结束，不保证最终状态为已取消。
- **客户端兼容**：公共 RPC、事件和消息结构不变，Web/CLI 无需迁移。

## Tools and extensions

- Trusted read-only groups may run concurrently, with ordered result commits and joined cancellation. Unknown, native and remote tools remain serial; mutations are barriers.
- Private [file checkpoints](../src/store/checkpoints.ts) are distinct from Git diffs and bounded preview text. Restore targets one completed checkpoint/file, requires an inactive session and refuses changed post-edit bytes/mode. Command effects are not automatically checkpointed.
- [Plugins](PLUGINS.md) are explicitly host-registered modules with API-versioned manifests, private configuration and run-scoped resources. The optional official browser uses agent-browser MCP; it replaces, rather than duplicates, the legacy browser tools when enabled. Human control and preview share the agent's session and Core transport. No workspace code discovery or automatic installation occurs.
- [MCP](../src/mcp) supports stdio, Streamable HTTP and legacy SSE. Registration does not launch a server. Calls require explicit enabled registration and applicable permissions; disabling/removing a server revokes connections owned by this process, not arbitrary other processes.
- [Tool hooks](../src/shared/tool-hooks.ts) are explicitly host-configured. They are not auto-loaded from project instructions or skills. Tool-level hooks serialize execution; run-end-only hooks do not.
- [Agent worktrees](../src/core/agent-worktrees.ts) are opt-in; shared workspace remains the default. Child permissions cannot exceed the parent ceiling, and parent settlement joins child operations.
- [Configured agents and advisor coordination](AGENT_COLLABORATION.md) bind immutable role/model/tool snapshots to new children. Durable child questions interrupt result waits and final reconciliation; answers never widen authority or revive historical tasks.
- [Project context and skills](PROJECT_CONTEXT.md) load bounded instruction data without executing it.

## Hosts and builds

CLI can embed the Harness or attach to a local host. HTTP/WebSocket Core owns tasks independently of the Web page/gateway: disconnecting or restarting Web does not cancel an accepted Core task. Stopping Core affects its owned runs. Reconnection reads recovery state; it must not replay mutations to guess their outcome.

Core builds with `pnpm build` to `dist/`; it does not build React, CLI, Android or Electron. Use the owning repository for client validation. Historical Electron worker, packaging and installation instructions remain in the monolith history, not in the current Core build contract.

On Linux and macOS, the build uses `/usr/bin/cc` to compile the native file-lock addon at `dist/native/forge-flock.node`. If the addon is missing at runtime, Linux falls back to system `flock`, and macOS to `dist/native/forge-flock`. Locks are released when the last descriptor closes or the owning process exits. Embedders can use absolute paths in `FORGE_FLOCK_ADDON` to override the addon and, on macOS, `FORGE_FLOCK_EXECUTABLE` to override the helper.

[Authorship](AUTHORSHIP.md) records provenance; [third-party notices](../THIRD_PARTY_NOTICES.md) preserve license attribution.
