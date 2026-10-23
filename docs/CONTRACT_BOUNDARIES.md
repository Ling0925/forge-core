# Shared contract ownership

Public contracts are browser-safe and independent of concrete service factories.
The independent `@forge/core` package keeps domain-sized modules instead of a
second copy of every implementation type in each client repository:

- `shared/project-context.ts`: sanitized catalog DTO/schema, internal catalog
  with instruction bodies, fingerprints and the project-context service port.
- `shared/mcp.ts`: protocol/config validation, sanitized transport DTOs and the
  service port. Private env/header values remain distinct from public records.
  Internal health uses `undefined`; transport health still maps it to `null`.
- `shared/checkpoints.ts`: one metadata schema, readonly transport view and the
  public list/diff/restore port. Only the store adds byte payloads and `begin`.
- `shared/agent-worktrees.ts`: worktree creation input/result and service port.
- `shared/runtime-host.ts`: the host-neutral runtime interface.
- `shared/ipc.ts`: request/response envelopes and compatibility reexports of the
  same domain schema objects. Existing import paths remain available.

Factories explicitly return these ports. Shared service signatures do not use
`ReturnType`/`Parameters` of implementation modules. No domain contract imports
core, store, MCP, context, desktop, Node builtins or Electron.

The common controller and runtime hub live in `host/`. CLI and Web hosts use that
implementation; Android connects through HTTP/WebSocket. Client UI and lifecycle
adapters belong to their own repositories. Core does not ship the archived
Electron runtime/controller paths.

`tests/shared/contract-boundaries.test.ts` checks type-only as well as runtime
imports, browser bundling, host independence, schema object identity and the
existing DTO shapes. Run these checks when moving public contracts; clients and
persisted records must remain compatible with the declared change.
