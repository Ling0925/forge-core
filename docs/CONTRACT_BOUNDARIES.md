# Shared contract ownership

Public contracts are browser-safe and independent of concrete service factories.
The single package keeps domain-sized modules instead of a second copy of every
implementation type:

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

The common controller and runtime hub live in `host/`. CLI, Web and the desktop
worker use that implementation. Desktop window lifecycle, worker port forwarding
and renderer bridges remain desktop adapters. The old desktop runtime/controller
paths are compatibility reexports, not a second implementation.

`tests/shared/contract-boundaries.test.ts` checks type-only as well as runtime
imports, browser bundling, host independence, schema object identity and the
unchanged moved DTO shapes. A before/after comparison of all 74 preexisting
exported IPC, shared/config, MCP and project-context tool schemas also matched.
No RPC fields, persistence records, tool schemas or frontend behavior are changed
by this ownership refactor.
