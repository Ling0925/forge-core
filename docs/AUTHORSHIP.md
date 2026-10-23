# Authorship and source provenance

Forge's runtime, storage, tools and host contracts began as original TypeScript work developed with API-model assistance. The later native model-access work includes adaptations from Magpie; its MIT license and affected modules are preserved in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Workstream credits

- Runtime/bootstrap and provider repairs: GPT-6.1 Sol and GPT-6 Sol.
- Storage: GPT-6 Sol, GPT-6 Luna and GPT-6.1 Sol, with Kimi quality passes.
- Browser tools: GPT-6 Luna, GPT-6 Astra and GPT-6.1 Sol, with GLM quality passes; Kimi contributed browser/cache integration.
- Extended context and MCP repairs: DeepSeek V4.1 Flash, following earlier Kimi and GLM work.
- Checkpoints and host/provider corrections: GPT-6 Sol.
- Local source binding, incremental storage, stream persistence and image protocol corrections (2026-10-17): the main agent under the authorized takeover exception.
- Native model access (2026-10-20): the main agent owned contracts, migration/host integration, isolation fixes and regressions; DeepSeek V4.1 Flash workstreams owned provider/catalog, routing, account and cloud adaptations. The corrected child model ID was `cn:deepseek-v4.1-flash`.

These are workstream credits. Current development ownership and model requirements live in [AGENTS.md](../AGENTS.md), not in historical assignment records.

## History and evidence

The detailed chronology remains in this file's Git history. Client-specific credits are maintained in the CLI and Web UI repositories. One-off author invocation scripts, local log paths, quota interruptions and old test counts are omitted from active guidance.

The [model-access record](MODEL_ACCESS_PORT_STATUS.md) distinguishes local fixture evidence from outstanding live account/cloud validation. Authorship records do not establish acceptance of the current build. Private prompts, credentials and raw run transcripts must not be distributed with source documentation.
