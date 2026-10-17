# Authorship and evidence limits

Forge is original work developed with API models; it is not a copy of another harness. The user explicitly authorized the coordinator (root) to implement *minimum runtime bootstrap repairs* (event typing/streaming/cancellation, CLI schema/arguments/budget, local async tool errors, credential-redaction wiring, bounded snapshot reads and focused tests). Beyond that, root performed only the minimum authorized bootstrap plus manual QA and review of proposals and check results; root did not author post-bootstrap product source. Native agents provided read-only reviews.

## Model work streams

**These API model declarations describe areas of work (workstreams), not cryptographic line-by-line attribution.** A model name against an area states which stream was assigned/credited for that area in the coordination record; it is not a per-line authorship signature, and it does not assert that every request in that area succeeded or was verified end-to-end.

- **Runtime/bootstrap and later provider repairs:** cx/gpt-6.1-sol, with cx/gpt-6-sol quality passes.
- **Desktop UI (renderer/workbench):** initially ag/gemini-3.8-flash; after the user requested **STOP GEMINI** (02:55 UTC, quota), ownership moved to cbcn/glm-5.3, then cx/gpt-6.1-sol (final workbench), then cbcn/glm-5.3 state fixes, then cx/gpt-6-luna bounded React audit. After the user reauthorized Gemini at 05:10 UTC, ag/gemini-3.8-flash resumed active work on the CLI terminal-reader queue; after a gateway connection interruption (recorded at approximately 05:32:39 UTC) and the user's stated provider preference, that CLI terminal-reader workstream continued under clinepass/cline-pass/deepseek-v4.1-flash.
- **Browser:** started with cx/gpt-6-luna, then cx/gpt-6-astra; redirect rejection fix: cx/gpt-6.1-sol; quality passes by cbcn/glm-5.3.
- **Store:** cx/gpt-6-sol, cx/gpt-6-luna, cx/gpt-6.1-sol; quality passes by cbcn/kimi-k3-1.
- **Browser/cache integration:** cbcn/kimi-k3-1.
- **Release tooling:** cx/gpt-6-sol, cbcn/kimi-k3-1, cx/gpt-6.1-sol.
- **This documentation:** Forge API assistant, continued under clinepass/cline-pass/deepseek-v4.1-flash after the same gateway connection interruption.

## Phase2 attribution (extended subsystems)

- **Sol6.1 foundation/workbench:** the Sol6.1 workstream established the extended foundation and workbench surfaces.
- **Sol6 checkpoint, host and provider review fixes:** the Sol6 workstream authored the checkpoint, host-bridge and provider review corrections.
- **DeepSeek-v4.1-flash context and MCP repair:** the DeepSeek-v4.1-flash workstream authored the project-context and MCP repairs.
- **Previous authored starts by Kimi and GLM:** earlier starting work on these areas was authored by the Kimi and GLM workstreams before ownership moved.
- **Phase2 multi-model development in the supplied Forge runtime:** subsequent Phase2 work (including the runtime-controls and tool-hardening fixes and the live Responses-gateway QA) was authored by supplied API models running inside the Forge runtime itself, coordinated by root. Two model IDs were used in sequence for the live Responses gateway QA: `cx/gpt-6-sol`, then `cx/gpt-6-luna`. (Recorded for provenance only; this is not a per-line attribution and does not assert a success count.)
- **Gemini and the CLI terminal reader:** the Gemini workstream was **stopped at 02:55 UTC** (quota) and no Gemini calls were authorized until the user **reauthorized Gemini at 05:10 UTC**. From that point ag/gemini-3.8-flash resumed authorship of the CLI terminal reader. After a gateway connection interruption (recorded at approximately 05:32:39 UTC) and the user's stated preference for the clinepass/cline-pass provider, the same CLI terminal-reader workstream continued under **clinepass/cline-pass/deepseek-v4.1-flash** (`deepseek-v4.1-flash`). This document records workstreams as assigned/credited, not as a per-line signature or a success count.

## Final workstreams

These entries record which workstream authored which area; they are **not** a per-line signature and
do not assert that every request in an area succeeded.

- **MiMo (`clinepass/cline-pass/mimo-v2.5-pro`):** authored the modal shortcuts helper, `App`,
  `CommandPalette` and reducer, plus the mounted regression. Its checks are recorded as passed but
  are **not** claimed as final.
- **Grok (`gcli/grok-4.7`):** authored the persistent MCP labels, field validation and checkpoint
  danger handling, **and** the `Button` normal/reduced-motion busy feedback with its mounted test.
- **DeepSeek (`clinepass/cline-pass/deepseek-v4.1-flash`):** authored the latest CLI work, resource
  wrap and private QA. Its attempted busy-feedback lane was cancelled before any edit, so this
  workstream is credited with no busy-feedback work.
- **Sol6 (`cx/gpt-6-sol`):** 98 tests passed in provider review, plus the real CSS wrap regression.
- **Gemini (`ag/gemini-3.8-flash-high`):** completed a readonly runtime review returning CLEAR with
  8 focused existing tests.

The core author boundary is unchanged: the user authorized root for **review and minimum
runtime bootstrap repair only**; root did not author post-bootstrap product source.

## Visual redesign workstreams (product UI redesign)

The entries below credit workstreams for areas of the latest product UI redesign; they are not
per-line signatures. **No final approval, verification or success is claimed for any run that
did not finish**, and behavior descriptions cite current code only.

- **Gemini (`ag/gemini-3.8-flash-high`):** authored the redesign design contract and currently
  owns the visual/motion workstream.
- **MiMo (`clinepass/cline-pass/mimo-v2.5-pro`):** authored the shell, sidebar and inspector
  surfaces of the redesign.
- **Grok (`gcli/grok-4.7`):** authored the conversation and composer surfaces; the
  consent/configuration guards were then handled by the GPT-6.1 workstream.
- **GPT-6.1 (`cx/gpt-6.1-sol`):** authored the consent/configuration guards and the CSS
  reconciliation pass.
- **DeepSeek (`clinepass/cline-pass/deepseek-v4.1-flash`):** mounted-test adaptation and
  private QA.
- **Gemini (`ag/gemini-3.1-pro-high`):** one attempt returned **503** before any product code
  work; it holds **no code authorship**, here or in any earlier area.

The root boundary is unchanged for this redesign: root covers minimum runtime bootstrap repair
and review only, and did not author redesign product code. No test counts, release completion
or installation results are asserted for these workstreams.

Some requests failed, were interrupted or were superseded; not every listed model's output was verified end-to-end, and this document does not claim that all models were verified. No completion counts are asserted here, and no final release or installation is claimed. User-provided API keys are never included in any artifact.

## Evidence and honest limits

### Local design corrections (2026-10-17)

The repository's current `AGENTS.md` explicitly permits the main agent to take
over when the required child model cannot be called. The native child tool
rejected `cbcn/deepseek-v4.1-flash`; three proposal-only API requests then failed
at transport without returning product code. No substitute child model or
automatic replay was used. The main agent authored the session-source binding,
incremental storage, stream persistence, worker/bridge changes and regression
checks under that exception. Earlier statements that root authored no product
source describe the earlier workstreams, not these local corrections.

The user subsequently requested UI authorship through `forge` using Gemini 3.8
Flash. The catalogue-confirmed route was `ag/gemini-3.8-flash`, with an isolated
`FORGE_HOME`. The first run failed at the provider protocol without any edits.
After explicit same-model retry authorization, the second run completed with
exit code 0. Its manifest and sanitized transcript are retained locally under
`.build/gemini-design-fixes-ui/authorized-retry/`.

The interface draft existed before that request. Gemini then authored the live
input controls' placement in `Composer.tsx`, the new `composer-live-input.css`,
and the final composer source argument. The main agent retained ownership of
the earlier queue/state/bridge draft and regression tests; the record does not
attribute those earlier changes to Gemini.

The main agent independently observed 14 passing focused tests across six
files, including real Chromium interaction with the production composer and
state provider, a controlled bridge fixture, and worker/harness steering tests.
The checks cover durable steering acknowledgement, retained drafts, queue
pause/resume and reload, session isolation, explicit source selection, keyboard
behavior and stable stop-button coordinates. Fresh 390/1440 light/dark component
captures are under `.build/design-fixes-ui/`; these are component evidence, not
installed Electron or physical-device acceptance. Earlier focused core/store/
CLI verification passed 109 tests across ten files. The CLI was compiled with
`node scripts/build-core.mjs` and its real launcher passed isolated-home startup
checks; no desktop package or installation was produced.

Full typechecking still reports the same 27 diagnostics as the unchanged base,
with no new diagnostic locations/codes. Two existing core tests also failed on
both the base and worktree (`module-wiring` write-before-read and `agent-runtime`
guidance timing); they were not changed or reported as passing. Their comparison
logs remain under `.build/design-fixes-checks/`.

### Composer correction and live storage migration (2026-10-17)

The user requested notices above the input and restoration of the existing long
reasoning-effort slider. The first `forge` Gemini correction run failed at the
provider protocol before editing. After explicit same-model retry authorization,
`ag/gemini-3.8-flash` completed the correction with exit code 0. Its actual changes
are the composer markup, `composer-live-input.css`, optional property forwarding
in `ModelPicker`, the design ordering contract and two mounted regressions.
The main agent reviewed those changes and independently observed all four
focused UI tests passing. Live Chrome checks against the running Web workbench
verified above-input notices, the restored slider, viewport bounds and Escape
focus restoration at 390/1440 widths in light/dark themes, with no page errors.
Fresh local evidence is under `.build/composer-correction-live/`; author evidence
is under `.build/gemini-design-fixes-ui/composer-hints-authorized-retry/`.

The main agent also diagnosed the reported storage error: the still-running old
Web bundle rejected `sources` and `activeSourceId` in the updated settings file.
All 128 existing session snapshots themselves validated. With no active runs,
the old host was quiesced, original sessions and settings were durably backed up,
and 128 sessions were migrated and compared without logical changes. All three
configuration files matched their backup hashes afterward. The same Web service
was restarted with the compatible backend. Real browser checks read settings,
106 workspace-filtered summaries and three historical details successfully;
11 focused migration/store/source tests passed. Migration tooling and its test
were authored by the main agent under the previously recorded takeover exception.
No external model run was sent to a user's historical session. Typechecking
retains 26 baseline diagnostics, with no new locations/codes; the ModelPicker
optional-property diagnostic was resolved by the Gemini change.

- Local raw evidence is retained by the coordinator under `.build/runtime-runs/*.jsonl` (real tool transcripts) and `.build/api-authored` (proposals). Neither those logs nor private prompts or credentials belong in a distributed artifact.
- `scripts/provenance.mjs --output release/<path>.json` creates a public content-hash inventory, with timestamp and safe evidence-location references only. A SHA256 proves file bytes matched a manifest, **not** who wrote each line or whether a request succeeded. Review the local audit evidence separately if stronger attribution is required.
- No earlier package candidate is the final current deliverable, and no release or installation is claimed here. Safe public evidence for the live Responses-gateway QA (no secret values, no raw endpoint or key) is retained by the coordinator under `.build/`. These are development evidence, not shipped user guidance and not proof of packaging or installation.
- Independently verified behaviors (config `--api-mode` persistence, child-failure convergence into a failed parent, and same-process MCP disable/remove revocation of owned live connections) are recorded as fixed in the owned docs, based on bounded review evidence. This document does not claim final packaging or installation results; those are determined by the release process's actual execution.

## 2026-10-17 composer shortcuts and output speed

Gemini `ag/gemini-3.8-flash`, called through the local `forge` CLI, authored the
Composer keyboard changes, removal of queue/steering buttons, touch command
entry and `OutputSpeed` component. The coordinator reviewed proposals, repaired
patch formatting/context, assembled the accepted hunks and wrote the focused
browser regressions. Accepted author evidence is retained locally under
`.build/gemini-design-fixes-ui/{composer-shortcuts-exact,composer-shortcuts-ui-exact,composer-queue-touch,output-speed-reviewed}/`;
the speed styling also comes from the completed `output-speed-exact` proposal.
Rejected or incomplete proposals were not applied as complete implementations.

Four focused browser tests cover queue/steering keys, IME and multiline drafts,
session/source isolation, existing composer geometry, mode switching and speed
sampling/reset. The speed is explicitly estimated from new streamed text and
reasoning, not a live Provider billing counter. This is a renderer hot update;
it does not claim a desktop package release or a physical-phone keyboard test.

See [REFERENCE_DESIGN.md](REFERENCE_DESIGN.md) for the external references studied and the exact design choices they inspired, and [WORKFLOWS.md](WORKFLOWS.md) for what is actually runnable today.

## 2026-10-17 image input protocol

The coordinator implemented the optional image message contract, native Chat
Completions and Responses input mapping, durable initial/steering messages and
queue persistence safeguards. Automatic approval rejected the proposed external
DeepSeek author call before execution, so no DeepSeek authorship is claimed for
these changes. The first Gemini image UI proposal exhausted its tool budget and
produced no accepted UI patch; its local evidence remains under
`.build/gemini-design-fixes-ui/images-ui/`.

Focused checks cover image validation, old text input compatibility, native
provider payloads, queue serialization, durable steering acknowledgement and
Web image RPC above the old request limit. The shared CLI was rebuilt and its
help command was started with an isolated temporary `FORGE_HOME`. This protocol
change alone does not claim a completed image picker or live backend activation.
