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

Acceptance pins model, provider source, build/plan mode and the requested effective
permission, clipped by the session ceiling. The stored fingerprint binds the
provider endpoint/protocol/model but **never stores API keys**. Global default
changes do not redirect an accepted input. Removing or editing its source blocks
it with an explicit explanation. The binding is checked again under the session
lock immediately before provider construction; a race fails rather than falling
back. Credential rotation for the same binding remains possible.

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
