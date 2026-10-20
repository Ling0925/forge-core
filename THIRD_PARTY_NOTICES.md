# Third-party notices

## Magpie

Parts of Forge's native model-access implementation are adapted from or based on
[Magpie](https://github.com/yetone/magpie), by yetone and its contributors, pinned
for this port to commit `2374ffe161439b02a8e7f23b793461b39a635bf8`.

The reference checkout under `references/magpie` is development material, not a
runtime dependency. Forge does not start Magpie, embed its Go gateway, or copy
its application UI. Protocol data and algorithms have been translated into
TypeScript and integrated with Forge's own store, runtime, approval and host
interfaces. Adaptations do not imply endorsement by the original authors.

| Forge area | Magpie source used for comparison/adaptation |
| --- | --- |
| `src/shared/model-access.ts`, `src/store/settings.ts` | `internal/provider/provider.go`, provider persistence and credential/selection concepts |
| `src/provider/presets.ts`, `import-magpie.ts` | `internal/provider/presets.go`, `importurl.go`, provider import/export and `models` selection semantics |
| `src/provider/catalog.ts`, model catalog metadata | provider model discovery and `internal/catalog` metadata/provenance concepts |
| `src/provider/request-options.ts` | `internal/provider/authheader.go`, `extrabody.go`, `proxy.go` |
| `src/provider/routing.ts` | gateway `routing.go`, `fallback.go`, `affinity.go`; Forge retains its own retry budget and stricter unknown-outcome handling |
| `src/provider/accounts/` | provider Codex, Copilot, account sign-in, token refresh, request preparation and allowance implementations |
| `src/provider/gemini.ts` | native Gemini request/response, list, tool results, reasoning and thought-signature handling |
| `src/provider/cloud.ts` | `internal/provider/vertex.go`, `azure.go`; explicit credential JSON replaces ambient credential discovery |

Implementation differences and the distinction between fixtures and real-account
verification are tracked in `docs/MODEL_ACCESS_TS_PLAN.md` and
`docs/MODEL_ACCESS_PORT_STATUS.md`. The applicable upstream license follows in
full.

```text
MIT License

Copyright (c) 2026 yetone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
