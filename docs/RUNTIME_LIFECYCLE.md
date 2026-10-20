# Runtime lifecycle boundaries

This refactor preserves runtime behavior, storage evidence, permission/default
budgets and provider routing. The coordinator owns the snapshot and all commits.
The following sequence is the baseline contract, not merely a line-count target.

| Boundary | Durable/ownership rule |
| --- | --- |
| Read session | Acquire the session lock; recover interrupted evidence without replay. |
| Prepare model request | Pure projection/working-memory calculations do not replace raw history. |
| Receive assistant calls | Save the assistant message before any call starts. |
| Serial tool intent | Save `pendingTool` before the tool-start event or any tool effect. |
| Trusted read batch | Only host-classified safe reads, at most four, without hooks/native tools; save all start events before starting the batch. |
| Approval | Save awaiting-approval state before taking the root approval slot; save running state in finally. A tool's approval checkpoint work is joined before execution returns. |
| Tool completion | Join started work, validate/classify its result, then check cancellation. Persist tool evidence and changes in call order before failure-guard advancement or post-result hooks. |
| Child creation | Persist child relationship/ceiling first; reserve its active slot before starting child code. Native agent operations own registration and delivery state. |
| Child execution | A supervisor owns child tool/context construction, runtime invocation, bounded parent progress, approval routing and owned-resource disposal. Borrowed parent tools are not disposed by the child. |
| Child settlement | A child slot is released only after its work and resource cleanup settle. Construction/disposal failures remain visible; no model fallback or retry. |
| Parent reconciliation | Join undelivered children, save their bounded reports, then mark them delivered. Failure resolution remains explicit and persisted. |
| Parent finish | Abort children for non-success, join all owned child operations, and let the coordinator decide final status. Unhandled child/hook failures prevent success. |
| Terminal/release | Save one current-run terminal event, notify after commit, finish hook/title writes, then release the session lock. Recovered old-turn terminal evidence is separate from this run. |

Abort signals stop permission to continue; they are not proof that tools,
approval checkpoint writes or children have converged. Never release the session
lock or advance a call while a started owner can still write. Uncertain prior
tool calls are closed with explicit evidence and are never replayed automatically.

Tests that count provider turns give fixture sessions explicit titles. Automatic
title generation otherwise consumes their mock provider's first scripted answer
and tests a different path than the intended child/construction lifecycle.
