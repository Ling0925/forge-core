# Durable accepted inputs

The shared host owns accepted inputs. Unsubmitted renderer drafts and the older
page-local draft queue are unchanged; this service does not silently import them.
Clients opt into durable acceptance through the existing RPC/bridge protocol.
No new UI is required.

## API

`ForgeBridge.inputQueue` exposes `enqueue({ inputId, input })`, `list(sessionId)`,
`cancel(sessionId, inputId)`, `pause(sessionId)` and `resume(sessionId)`.
The corresponding existing-protocol RPC methods are `enqueueInput`, `listInputs`,
`cancelInput`, `pauseInputs`, and `resumeInputs`. `enqueueInput.input` contains
`{ inputId, input: RunInput }`. The client generates a stable UUID for `inputId`;
transport request IDs are still unique for each attempt. Only retry acceptance
with the **same input ID and same original RunInput** after an uncertain response.
Changing content or session under an accepted ID is rejected.

The atomic, fsynced ledger is written before acceptance returns. A retry returns
the existing record even if configuration has changed. A monotonic sequence
orders accepted inputs, with one consumer per state directory and serial starts
per session. The existing runtime's session lock still guards execution against
other processes. Multiple clients of one host see the same durable records.
Submission and scheduling do not depend on a browser event connection or lease.

## States and recovery

- `queued`: accepted and eligible to start unless its session is paused.
- `blocked`: the accepted provider/model binding is missing or changed; paused.
- `bound`: a run ID has been committed **before** any runtime code starts.
- `consumed`: that attempt finished, with a terminal outcome and associated run
  ID. It is never scheduled again. Successful input bodies are released because
  the transcript owns them. Failed/cancelled/interrupted bodies are retained for
  inspection, including rejected starts that may not have created a transcript.
- `cancelled`: explicitly removed before binding; no run was started.
- `uncertain`: recovery found a bound attempt. The input and run ID are retained,
  the session is paused, and the attempt is **never automatically replayed**.

A normal completion advances the queue. Failure, cancellation, or interruption
pauses subsequent inputs, including when an ordinary `startRun` preceded them.
`resume` explicitly permits remaining unbound items; it does not replay uncertain
or consumed attempts. Inspect the associated session/run before choosing whether
to submit a replacement with a new ID. Crashing between binding and actual start
is intentionally conservative: recovery cannot safely prove no side effect ran.

`pause` does not cancel an active run. `cancelInput` only cancels queued or blocked
items; use the existing `cancelRun` API for active work. Shutdown stops scheduling,
awaits active work cancellation, and releases consumer ownership. A persistence
failure stops all queue scheduling; inspect records and restart to recover.

## Selection, permissions and limits

Acceptance pins model, provider source, explicit or inherited route group,
build/plan mode and the requested effective permission, clipped by the session
ceiling. The stored fingerprint binds the configured endpoint/protocol/model
(including aliases), or the route strategy and member selections, but **never
stores API keys**. Global default changes do not redirect an accepted input.
Changing the bound selection blocks it with an explicit explanation. Route
normalization preserves the group instead of accidentally selecting its first
member directly; temporarily unavailable members still follow the group's policy.
The binding is checked again under the session lock and against the provider's
atomic settings snapshot before construction. A changed source cannot receive the
accepted request. Credential rotation and cloud URL normalization for the same
configured selection remain possible.

Execution still applies the current session permission ceiling, plan restrictions,
normal tool approval, cancellation, and session locks. Enqueueing grants no tool
approval. Images use the existing RunInput image/count/size validation.

Bounds, checked before accepting any new input:

- 100 pending inputs per session and 500 globally, including bound/blocked/uncertain
- 16 MiB retained input data per session and 32 MiB globally, including retained
  failed outcomes and inline images
- 4,096 deduplication receipts and 4,096 explicit session pause states
- 48 MiB atomic ledger write limit

Cancellation and successful consumption release input bodies, but receipts are
not silently evicted: doing so could make a very late retry execute twice. At the
receipt limit the service rejects new input without acknowledging it. There is
currently no automatic receipt compaction/expiry or public destructive reset API;
operators must archive a completed queue offline only after retiring its clients
and input IDs. This explicit capacity limit favors deduplication safety.

## Validation

Core tests cover simultaneous/retried acceptance, persisted acknowledgement loss,
ordering, consumer ownership transfer, interrupted bindings, failure pauses,
configuration changes, cancellation and count/byte/receipt limits. Host tests use
real Harness and runtime RPC to cover two clients, disconnects, pinned defaults,
permission ceilings and ordinary-run cancellation. Web tests cover operation
without event leases and workspace checks on nested enqueue requests.

## Ordinary predecessor recovery and admission

Recovery also inspects the durable predecessor of an unbound queued input. A
running/awaiting-approval, failed/cancelled/interrupted, or uncertain pending-tool
predecessor pauses the queue until explicit review/resume, even if the ordinary
`startRun` was never a queue item or crashed before queue pause was persisted.
An existing bound item still becomes uncertain and is never automatically replayed.

Resume acknowledges the current predecessor under the session lock and refuses a
live owner. The private acknowledgment is tied to status, pending intent, and the
latest run start/finish, not titles or unrelated metadata. A new explicit input
after an old terminal failure may acknowledge that predecessor; old queued work
does not silently inherit that new intent. A pending/uncertain effect cannot be
implicitly acknowledged this way.

Admission is checked again under the actual execution lock before provider/tool
construction. If a newer predecessor or competing owner invalidates admission,
the item returns to blocked with its input intact and no run binding, rather than
being consumed. This specific pre-effect refusal is distinct from an uncertain
bound attempt after execution might have begun; the latter is never auto-replayed.
No acknowledgment grants tool permission or answers an approval request.
