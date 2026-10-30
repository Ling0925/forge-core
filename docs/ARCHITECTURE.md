# Forge Core architecture

Core owns the TypeScript agent runtime, providers, tools, persistence, project context and host transports. CLI, Web UI and Android are separate clients. The Forge assembly repository pins their versions; it does not contain another runtime. Package usage and build commands are in the [README](../README.md).

## Module ownership

| Module | Responsibility |
| --- | --- |
| [core/harness.ts](../src/core/harness.ts) | Service assembly, run-boundary configuration and disposal |
| [core/runtime.ts](../src/core/runtime.ts) | Session lock, provider scheduling, durable tool intent/results and terminal state |
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

[Authorship](AUTHORSHIP.md) records provenance; [third-party notices](../THIRD_PARTY_NOTICES.md) preserve license attribution.
