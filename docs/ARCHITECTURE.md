# Forge architecture and implementation contract

Forge is an original single-package Electron + React + TypeScript desktop application and Node 22 CLI. Provenance and authorship boundaries are recorded in [AUTHORSHIP.md](AUTHORSHIP.md).

## Shared boundaries

`src/shared/schemas.ts` defines JSON-facing schemas and inferred readonly types for settings, provider config, sessions, messages, tools, inputs and events. `contracts.ts` defines the shared service, runtime, provider, tools and stores plus dependency-injection factories. `ipc.ts` defines validated RPC/worker transport and the narrow `ForgeBridge`. `errors.ts` exports `ForgeError` and `toErrorInfo`. Shared modules import no Node or Electron APIs and do not write files.

Use relative imports, named exports, `import type`, strict TypeScript, readonly values and exhaustive discriminated-union switches. No explicit untyped escape annotations, non-null assertions, type suppressions or ignored failures. `assertNever` throws a typed internal invariant failure without exposing its argument.

Parse unknown persisted, HTTP, IPC and tool-argument data at the receiving boundary. Strict objects reject unknown fields. Owners enforce semantic relationships: session/event identity, tool IDs, timestamps, role/tool sequence and absolute workspace paths. Bound hostile JSON byte size and depth before recursive parsing. Types do not replace runtime validation.

`ForgeError` accepts an ErrorInfo code, an authored safe public message and a retryable boolean. Domain subclasses are permitted. Never construct it from arbitrary exception messages, HTTP bodies, headers, private configuration or user secrets. `toErrorInfo` preserves expected typed failures, reduces Zod errors to a safe validation message, and returns a fixed internal fallback for other values. It does not serialize exceptions or arbitrary objects. Logs and transport must use safe conversion, never unknown Error.message, stack, cause or request/response dumps.

## Mandatory future integration points

| Module | Named export / responsibility |
| --- | --- |
| `src/core/harness.ts` | `createHarness(options?: HarnessOptions): Promise<HarnessService>`; orchestration/defaults |
| `src/core/runtime.ts` | `createAgentRuntime(dependencies: AgentRuntimeDependencies): AgentRuntime`; original bounded loop |
| `src/provider/openai.ts` | `createModelProvider(config: ProviderConfig): ModelProvider`; ky transport |
| `src/tools/local.ts` | `createLocalToolRegistry(workspace: string): Promise<LocalToolRegistry>`; original read/list/search/write/edit/exec adapters |
| `src/tools/browser.ts` | `createBrowserTools(options: BrowserToolOptions): Promise<LocalToolRegistry>`; optional original Playwright adapters |
| `src/store/sessions.ts` | `openSessionStore(directory: string): Promise<SessionStore>` |
| `src/store/settings.ts` | `openSettingsStore(directory: string): Promise<SettingsStore>` |
| `src/cli/cli.ts` | `runCli(argv: readonly string[], service: HarnessService): Promise<number>`; injected test entry |
| `src/cli/index.ts` | bootstrap/service disposal/exit code |
| `src/desktop/main.ts` | privileged window/chooser and validated worker routing |
| `src/desktop/preload.ts` | sandbox-compatible contextBridge implementing ForgeBridge |
| `src/desktop/worker.ts` | utilityProcess, one HarnessService, cancellation/approval maps |
| `src/renderer/index.html` | Vite HTML referencing `./main.tsx` |
| `src/renderer/main.tsx` | React bootstrap, fonts/styles, optional development diagnostics |
| `src/renderer/App.tsx` | named `App`; privileged operations only through window.forge |

Core interface signatures remain stable. Domain tests belong in `tests/shared`, `tests/core`, `tests/provider`, `tests/tools`, `tests/store`, `tests/cli` and `tests/desktop` using Vitest `*.test.ts`. Shared colocated contract regression tests are also supplied here. Real Electron/browser QA is separate.

## Extended subsystems (current source)

These modules build on the foundation without copying any existing harness. They are the implementation behind the workflows in [WORKFLOWS.md](WORKFLOWS.md). Reference/design provenance is recorded in [REFERENCE_DESIGN.md](REFERENCE_DESIGN.md).

### Project context and skills (`src/context/**`, `src/tools/skills.ts`)

- `createProjectContext(workspace, options?) => Promise<ProjectContextService>` with `refresh()`, `getSystemContext()`, `getCatalog()`, `getFingerprint()`, `dispose()`.
- AGENTS precedence: workspace-root `AGENTS.md` always applies (we never scan parent/home); nested `AGENTS.md` apply only for the accessed subtree, loaded by the native `project_context` tool with a workspace-relative `path`. Rejections: symlink escapes, binary/NUL, >2 MiB, secret-shaped text, >64 KiB per body (refusal is explicit, never silent).
- Skills discovery roots: `<workspace>/.forge/skills`, `<workspace>/.agents/skills`, plus explicit absolute user dirs. **Catalog injects metadata only**; bodies load lazily via `load_skill`, which is read-only data and grants no permissions. Duplicate skill IDs: first root wins, duplicates listed as warnings with provenance.
- Integration: at run boundary the harness prepends `getSystemContext()` to the system message, registers `project_context`/`load_skill`, and surfaces `getFingerprint()` to UI for cache visibility. Additive; no shared-package edits.

### Plan, child agents, semantic summary and forks (`src/core/agents.ts`, `src/core/context.ts`, `src/core/runtime.ts`)

- Native tools: `list_models(query?, offset?, limit?)`, `update_plan(explanation, steps)`, `spawn_agent(task, ownership?, model?)`, `list_agents()`, `wait_agents(ids?)`, `cancel_agent(id)`.
- `list_models` is read-only discovery of exact configured provider-catalog IDs (also available in readonly/plan mode), with a substring `query` (≤256), `offset` (≥0, default 0, relative to the filtered order) and `limit` (1–100, default 50). Its result is `{ ids, total, offset, returned, nextOffset, truncated }`, preserving provider order and exact IDs, capped at 32768 UTF-8 bytes with no partial JSON or sliced IDs; errors are sanitized and never expose provider exception text, endpoint or credentials. Catalog membership is not proof of live quota or availability.
- Children are distinct sessions: depth **one**, at most **four** per run, independent context/session/model and tool registry; `permissionCeiling` is inherited so permission never exceeds the parent's. `plan` mode inherits readonly. Parent finish joins children. Only **parent-scoped** `agent_update` envelopes are emitted; raw child events are not forwarded. Child approval envelopes use the **root** sessionId + original child toolCallId + request UUID, serialized through a queue.
- Semantic summary is provider-generated (max 8192), keeps a stable system prefix, and never mutates the persisted transcript; the explicit excerpt-only fallback is marked `contextSummary.fallback`. Fork copies history only and never executes copied calls; `assertBoundary` requires complete native call pairs, and fork **preserves the source `contextSummary`** when its boundary is at or before the requested fork end and is a complete native-call boundary in the copied transcript (earlier forks omit it to avoid importing future history; the persisted `ProviderState` continuation is capped at 256 output items / 256 KiB). RunInput `mode?: 'build'|'plan'` clamps requested permission to `readonly` for plan. Semantic compaction, fork, and manual cancellation are available to hosts; `cancel_agent` cancels a child.
- Child-failure convergence is implemented: parent finish joins children and, if any joined child was **rejected** or did not reach `completed`, the parent's requested `completed` terminal status becomes `failed`; failed child outcomes enter the parent's closing turn for model reconciliation rather than the parent silently reporting `completed`. A child construction failure persists the child session as `failed` and emits the matching `agent_update`. MCP disable/remove actively revokes the live connections owned by this harness process (see below).
- Parent-generated child-reconciliation input is tagged with `origin: "agent_reconciliation"` on a `user` message. This is **local metadata**, not a new API role: only `user` accepts the field, providers strip it on the wire, and human-turn boundaries and the renderer's collapsed internal record both exclude/annotate it accordingly.

### Checkpoints and git inspection (`src/store/checkpoints.ts`, `src/tools/git.ts`)

- `createCheckpointStore(workspace, directory)` persists **private** backups outside the workspace (owner-only) via `begin`/`complete`/`release`, holds a Linux `flock` through completion, verifies actual post-mutation bytes, and exposes `list`, `getDiff` (unified diff, bounded; the RPC `getCheckpointDiff` cap is 256 KiB), `restore`. Restore is scoped to a **single** checkpoint/file, requires `completed` state, requires the session to be inactive, and refuses when current bytes/mode differ from the recorded after-hash. **It is never a git reset.**
- `FileChange` previews are **not** backups; `run_command` effects are **not** checkpoints; git state and checkpoints are labeled separately. Production must pass the store to the default local registry or edits are not reversible. Session IDs come from `ToolContext.sessionId`; call IDs from `ToolCall.id`.
- `git_status`, `git_diff`, `git_log` are **registered native read-only tools** in `src/tools/local.ts` (backed by `src/tools/git.ts`), available in every mode including readonly (64 KiB ceiling; no git init/commit; sensitive paths omitted, known values redacted). They are among the ten local tools (`git_status`, `git_diff`, `git_log`, `list_files`, `read_file`, `write_file`, `edit_file`, `make_directory`, `run_command`, `search_files`), but are **not** checkpoints. Git output may contain secrets, so the host must filter/redact before model/renderer exposure.

### MCP stdio client (`src/mcp/**`, `src/tools/mcp.ts`)

- Real stdio MCP: JSON-RPC 2.0 newline framing, `initialize`→`initialized`, `tools/list` (bounded cursor pagination), `tools/call` (sanitized, truncated); advertises protocol `2025-11-25`. **stdio only** — no remote HTTP/SSE/OAuth.
- `createMcpService({ home })` persists user-supplied servers at `<home>/mcp/servers.json` (dir 0700, file 0600, atomic). `register` performs **no launch** and defaults a new server to **disabled**; register, an explicit `enable`, and then actual launch (discovery/call, or a user-requested health probe of an enabled server) are the only ways a server becomes active. Namespaced names `mcp__<server>__<tool>` (<=64 chars, collision-free).
- Tools `mcp_list_tools`/`mcp_call_tool`: `readonly` denies both; `workspace` requires fresh per-call approval showing the exact registered `command` argv (never env values); `unrestricted` still only reaches user-registered+enabled servers. Children get a minimal environment; key-like host names are rejected; the development API key is never forwarded.
- `setEnabled(false)` and `remove` actively **revoke** the live connections owned by this harness process (closing their child process groups); a revoked server never proceeds on stale state and other instances self-correct against the authoritative catalog before their next effect. This is a **same-process** proactive revoke, not a cross-process kill guarantee.

### Provider API modes (`src/provider/**`)

- Explicit `apiMode?: 'chat-completions'|'responses'` (default `chat-completions`). The provider **never** auto-detects, falls back, or replays across modes/models. Responses uses native `function_call`/`function_call_output`, strict terminal checks, and reported cached-input usage; opaque reasoning items are persisted on the exact assistant message as versioned `providerState` and replayed only against a matching origin, with old absent-state readable. No native Anthropic or Gemini adapters. Details in [PROVIDERS.md](PROVIDERS.md).

### Host bridge, CLI and desktop surfaces

The desktop renderer entrypoint `window.forge` implements `ForgeBridge` in `src/shared/ipc.ts`; `RunInput.mode` and `updateSettings({settings:{apiMode}})` are live, omitting `apiMode` uses chat-completions. The workbench Inspector exposes three tabs — **overview/runtime**, **changes/checkpoints**, and **resources** — alongside live plans and agents. CLI and interactive routes (`forge context|skills|checkpoints|mcp|export`, `/context /skills /checkpoints /mcp`) consume the same typed service APIs. CLI flags, slash commands, and desktop↔CLI session continuity are documented in [WORKFLOWS.md](WORKFLOWS.md) and [CLI.md](CLI.md). `dist/` contains build outputs produced by `scripts/build.mjs`; source and `--help` are authoritative for behavior.

## Settings and provider semantics

First-launch getSettings/getPublic must succeed without endpoint, model or credential. `defaultPublicSettings` supplies empty baseUrl/model, system theme, readonly permission, 20 turns, 100 tool calls, 60000 ms request timeout and 100000 context characters. Persisted partial settings are merged with defaults and validated; malformed persisted data must not be silently ignored. No network default is invented.

Public and configurable settings permit empty baseUrl/model. Every nonempty endpoint must be HTTP(S) without credentials, query or fragment; every nonempty model is trimmed and bounded. `isConfigured` is derived, not editable: true exactly when both endpoint and model are nonempty and valid. `hasApiKey` is only the credential-presence indicator. ConfigureInput settings are partial; empty endpoint or model explicitly clears configuration. Omitted apiKey preserves the credential, empty apiKey clears it, CR/LF are rejected. Empty keys are valid for user-configured unauthenticated providers.

Private ProviderConfig requires a valid nonempty endpoint and validated key and timeout; it retains its existing shape without a model field. It is never returned through RPC or persisted in sessions. Settings/credential writes require owner-only permissions and separation from session records. Never log ConfigureInput or private config. Public schema does not make private config a renderer payload.

Before listModels, provider creation or run network use, reject unconfigured settings with an actionable typed invalid_input failure asking the user to configure endpoint and model. An explicit run model override does not bypass this guard. Validate ProviderConfig before transport and validate the completion model before a request; invalid boundaries must not initiate network calls.

Transport uses ky with explicit timeout=requestTimeoutMs and explicit retry policy. Completion POST uses retry.limit=0 to prevent duplicate generations; listModels GET may use a small bounded retry policy. Normalize responses/stream chunks through schemas, honor cancellation and test malformed bodies, timeout and streamed tool-call assembly. Tool arguments remain strings until tool dispatch. No provider engine dependency.

## Runtime and persistence

CLI and desktop share the identical HarnessService, AgentRuntime, session store, provider and tools; CLI does not use IPC or a second loop. Harness captures public settings and private provider config at each run boundary. Settings changes cannot affect an active run. A session's persisted model is authoritative: createSession uses settings.model unless explicitly overridden; settings.model changes affect only new sessions, not resumed sessions.

RunInput optionally supplies a trimmed nonempty model override. Runtime applies it only after acquiring the per-session lock, loading/recovering state and determining that a settled run can start. Update and checkpoint session.model before run_started/provider execution. Provider calls and run_started events use that selected model, and subsequent resumes retain it. Lock failure or rejection before a settled start must not mutate the session model. The harness must not wrap runtime.run in a second store lock.

Runtime holds the cross-process per-session lock through final checkpoint and releases in finally. Concurrent acquisition fails busy, not silent interleaving; cancellation cannot leak a lock. Store.create generates IDs/timestamps and atomically commits idle empty history. Save validates schema/version and atomically checkpoints a complete snapshot under the caller's lock. Events remain logically append-only; an internal journal is permitted. list returns summaries without large fields; missing get rejects not_found; unknown versions fail explicitly. Store owner tests file modes, fsync/rename durability, stale-lock recovery and crashes.

Orphaned running/awaiting_approval snapshots recover to interrupted under lock, preserving pending tool uncertainty. Never replay uncertain effects automatically. Explicit resume requires settled history after reporting uncertainty and safely clearing pending state. Checkpoint each tool call before execution, then result/changes after it; serialize side effects. Tool messages reference exact call IDs. Unknown/malformed calls yield bounded isError results. Assistant content may be null for tool-only messages. Streaming deltas update UI; only normalized final assistant messages enter history.

maxTurns counts completions; maxToolCalls counts attempted executions including denied calls. Apply contextBudgetChars before each provider request: retain system instructions/current prompt and remove only whole settled turns with their tool exchanges; emit context_compacted. If minimum context cannot fit, fail budget rather than truncate tool JSON. Publish bounded tool duration/output/browser-resource policies in descriptions. Budget exhaustion emits error(code=budget) and run_finished(failed).

Caller AbortSignal propagates through provider/tools/approvals, terminates children, checkpoints cancelled and emits exactly one terminal run_finished. Other failures checkpoint failed. Hosts own AbortControllers; no service cancel method is added. Harness disposal aborts/awaits runs and releases resources. Run-scoped tools dispose in finally; providers have no lifecycle method. Injection factories enable deterministic tests.

Events are ordered, session-tagged, ISO-timestamped: run_started, state/tool/approval notifications, then one run_finished. EventSink is synchronous notification, not backpressure; hosts bound buffering. Observer failures are handled safely and cannot corrupt committed state. Approval false means denial; cancellation rejects and signal is checked before effects. readonly permits confined reads, workspace permits confined changes with approval for destructive writes/exec, unrestricted deliberately expands policy but is not an OS sandbox. No execution through model-supplied code. Exec uses validated argv, not implicit shell interpolation. Test symlink/cwd/environment/time/output confinement.

FileChange previews are bounded, not backups or rollback guarantees; null means absent and truncated means omitted bytes. Confined paths are normalized workspace-relative; authorized unrestricted absolute paths are explicitly labeled.

## Desktop protocol and security

Main forks the absolute `dist/desktop/worker.cjs` through utilityProcess and waits for ready. Worker receives validated WorkerRequest; chooseWorkspace remains main-only. Main/preload validate both directions, match UUID request IDs and methods, and validate result variants. A method check is required to narrow WorkerRequest after schema refinement. Renderer receives only ForgeBridge, never ipcRenderer, executable paths, raw channels or generic RPC.

Main handles directory selection and null cancellation. Worker reserves UUID RunId and active session slot, replies with RunHandle before starting asynchronous events; conflicts reject busy. cancelRun aborts its controller and acknowledges null without claiming settlement. answerApproval matches runId and approvalId, resolves once, acknowledges null; stale/foreign IDs reject not_found. Approval requests use approval_requested events. Main binds requests/runs/approvals to trusted originating webContents. Event subscriptions filter correctly and return idempotent unsubscribers. After terminal run_finished fetch getSession for final checkpoint. Pre-start rejection is an RPC error, not a run event.

On worker death, main rejects pending RPC and reports interrupted terminal notifications for known runs; store recovery determines uncertain effects. Clean maps and deny pending approvals on cancellation, disconnect and shutdown. Use contextIsolation=true, sandbox=true, nodeIntegration=false, restrictive CSP, no remote navigation/new windows and packaged local renderer files. Validate origin/frame for every IPC call. Only worker executes tools.

## Build, dependencies and distribution

Use Node 22.23.1 and pnpm 11.18.0; common execution source targets Node 22 even if Electron 44.7.0 embeds a newer runtime. Versions use the freshly verified Electron, Vite, React plugin, fonts and diagnostic releases. Generate/review the real pnpm lockfile; none is fabricated. Run typecheck, Biome, Vitest and build. Build fails until declared entrypoints exist. Reviewer may apply formatting after acceptance.

esbuild emits executable `dist/cli.mjs` and separate CommonJS main/preload/worker bundles; Vite emits local renderer assets. Node built-ins remain built-ins; electron, playwright and playwright-core are external. The CLI ESM banner supplies createRequire for bundled CommonJS dependencies. Playwright loads resource files dynamically and must not be flattened into a single-file bundle. Preload bundles only shared schemas/IPC and their static Zod dependency, with electron external; the build checks its dependency graph to reject host imports or dynamic-resource dependencies.

Playwright remains an actual production dependency; its matching playwright-core is transitive. electron-builder collects production node_modules, including both packages and their resources, and unpacks those directories from asar. Verify the pnpm-resolved production tree in the packaged output rather than assuming development symlinks work. Browser binaries are separate, not shipped inside asar; use a configured installed executable or `pnpm browser:install`. Test built Playwright imports and real browser launch in Node and Electron.

The CLI is not a standalone single file. Running from the project resolves external packages from project node_modules. The **implemented** `scripts/release.mjs --build` produces a standalone `release/<build-id>/cli/` tree containing `dist/cli.mjs` (as `cli.mjs`), `NOTICE.txt`, a complete portable production dependency tree with playwright/playwright-core and their runtime resources, plus an allowlisted copy of `docs/`, `examples/mcp/` and `examples/skills/`. It also copies Electron's `linux-unpacked` output into `desktop/`, writes `SOURCE-SHA256.json` (provenance over `src/`, `scripts/`, `docs/`, `tests/`, `examples/` and root manifests), `PAYLOAD-SHA256.json` (size+hash of every regular file in both loose trees), `SHA256SUMS` and `release.json`, and creates `cli.tar.gz`/`desktop.tar.gz`. It refuses symlinks or unallowlisted entries and requires Linux x64 + Node 22. `scripts/release.mjs --dry-run` only inspects configuration and Playwright resolution; no build, package or install. Never tar only dist or dangling node_modules links, and preserve executable mode.

`scripts/install-local.mjs` installs a checked release: `--dry-run`, `--install RELEASE_DIR`, `--rollback BUILD_ID`. It verifies `release.json`, the exact four checksummed files, archive path inventory against the loose tree, executable modes, `app.asar` and CLI external dependencies before switching the `current` symlink; installs only to `~/.local/share/forge-harness/releases`, `~/.local/bin/forge{,-desktop}` and a user `forge.desktop` entry; retains older releases; no sudo, autostart or uninstall. `scripts/release-selfcheck.mjs` exercises provenance containment and installer payload binding with temporary fixtures only (no real install/build).

`pnpm desktop` launches built files; `pnpm cli -- --help` invokes CLI. `pnpm dev` rebuilds the same file-origin topology without remote dev server/HMR. Only development branches may dynamically import react-grab/react-scan; production build removes those branches. react-doctor is a separate audit command.

Distribution includes built assets, metadata and required production dependencies, never private `.build` artifacts, state, runtime credentials or development dispatcher files. `.build/` is ignored by git and explicitly excluded from packaging. A release is **not** called final packaged or installed from dry-run/selfcheck alone: after a fresh build, `sha256sum -c SHA256SUMS`, install and installed smoke/GUI QA must be run against the actual artifact, with the results recorded by the release process. The dry-run/selfcheck only prove configuration and fixture behavior, not a completed artifact. See [DELIVERY.md](DELIVERY.md) for the install/verify/rollback steps.

### CLI approval policy (2026-10-14 confirmation)

Interactive CLI defaults to `full-access`, which grants tool approval requests within existing permission bounds (including MCP/browser/children). Tools still enforce readonly/plan, path/origin guards, enabled registration and child ceilings. Workspace tools still issue per-call approval requests; the CLI host may now automatically answer them. This is not an OS sandbox or permission escalation. `manual` (`ask` alias) asks per request with `[Y/n]`: only fresh, untainted Enter or y/yes approves; paste, queued/history input, Esc, abort and EOF cannot authorize. `auto` retains eligible root run_command-only behavior. The choice lasts for the CLI process, including /new and /resume; it is not a persisted global setting. Startup and switches warn visibly, automatic answers emit tool/argv audit lines with common credential masking and per-run counts. Unknown arbitrary secrets cannot be perfectly detected. Noninteractive run/resume still require explicit unrestricted + --yes for automatic authorization, and desktop approval buttons are unchanged.
