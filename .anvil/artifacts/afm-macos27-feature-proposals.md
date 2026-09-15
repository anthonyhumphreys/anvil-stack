# macOS 27 Foundation Models — Integration Expansion & Feature Proposals

## What shipped in `feature/afm-macos27-expansion`

| Area | Change |
| --- | --- |
| Backends | `fm` CLI preferred on macOS 27 (license-gate detected, `sudo fm license` hinted); compiled Swift helpers as fallback; per-request `xcrun swift` JIT as last resort |
| Helper protocol | NDJSON v2: `respond`/`capabilities` commands, instructions, generation options, streaming deltas, use cases |
| macOS 26.4+/27 helper | `tokenCount`, `contextSize`, use-case/guardrails pass-through |
| Vision | Image prompts isolated in `apple-foundation-models-helper-vision.swift`; probed independently so runtimes missing `Attachment` symbols never advertise `images: true` |
| Chat | Local replies stream via existing session events with a 48-char holdback (refusal fallback preserved); image attachments eligible when backend supports them |
| Settings | AFM status card: backend, availability reason, feature badges, context size, license hint |
| Tests/docs | Service + local-llm tests; website docs updated |

**Verified locally (macOS 27.0, build 26A428):** helpers compile and run; streaming deltas confirmed; `contextSize: 8192`; token counting works. `fm` is installed but license-gated on this machine.

**Caveat found during verification:** this build's `FoundationModels` dylib lacks the `Attachment(imageURL:)` symbols the SDK headers expose — the vision helper crashes at launch. The probe-isolation design handles exactly this; image support self-enables on builds where the symbol exists.

## Proposed features (from macOS 27 documentation)

### 1. `fm serve` — AFM as an OpenAI-compatible provider — *recommended next*

`fm serve` hosts a Chat Completions API server on-device. `local-llm.service.ts` already speaks OpenAI-compatible HTTP for Ollama/LM Studio, so `fm serve` becomes a nearly free fourth provider: spawn on demand (or let the user run it), point the existing HTTP client at `http://localhost:<port>`, and streaming/tools come through a proven code path instead of bespoke NDJSON.

- Effort: small. Reuses `callOpenAiCompatible` + adds a managed-process lifecycle.
- Unlocks: streaming without helper binaries; a single code path for all local providers.

### 2. Structured output via `fm schema` / `@Generable` — *high value, small*

The local/cloud classifier currently regex-parses "local"/"cloud" from free text. `fm respond --schema` (or `Generable` in the helper) returns typed JSON — eliminates parse failures and lets the classifier return `{route, confidence, reason}` for diagnostics.

### 3. Private Cloud Compute model tier

`PrivateCloudComputeLanguageModel` is a larger Apple-hosted model (documented ~32K context, reasoning support, entitlement-gated). Proposal: a third Settings tier between "off" and "prefer-simple" — e.g. `prefer-simple` uses on-device only, a new mode allows PCC for prompts that exceed the 8K on-device window but shouldn't leave the Apple trust boundary. Requires entitlement + eligibility probing; show as unavailable until then.

### 4. Multi-turn local threads via `fm chat --resume`

`fm chat` sessions can be resumed; `fm respond --resume/--save-transcript` carries state. Would let repeated helper prompts share context (e.g. an ongoing "quick questions" thread) instead of cold single-shot calls.

### 5. Pluggable local models via the `LanguageModel` protocol

macOS 27 lets third parties vend models (CoreAI adapters, MLX Swift language models) that `LanguageModelSession` can use. Anvil could enumerate registered providers and offer "on-device: MLX <model>" alongside `apple`, reusing the same routing layer.

### 6. Dynamic Profiles per persona

`DynamicProfile` adapts a session's model behavior to the task over time. Natural fit for Anvil's personas — a Docs persona and a Security persona could carry different local profiles rather than one generic session.

### 7. Vision pipeline beyond images: `OCRTool`, `BarcodeReaderTool`

System tools that read text/barcodes from images. Follow-on to vision support: OCR attachments *before* classification so a screenshot of an error message routes on extracted text; barcode/QR reading for companion-app pairing flows.

### 8. Evaluations framework + Instruments telemetry

Apple added an evaluations framework and Instruments signposts for prompts, latency, tool calls, and token usage. Proposal: a `scripts/eval-local-router.mjs` harness replaying labeled prompts through the classifier (target: route accuracy), plus a Diagnostics row showing token counts/latency from the already-plumbed `inputTokens`.

### 9. Guardrails and use-case policy per surface

`fm respond --use-case`/`--guardrails` and helper equivalents are already wired through `AppleModelCallOptions`. Next step: per-persona/per-surface policy (e.g. `contentTagging` for the classifier, stricter guardrails for user-facing summaries).

### 10. On-device thread titles — *cheap, high-visibility*

Thread titles today are static (`defaultThreadTitle`, work-item names) or manual renames. A first-message → title generation pass is a textbook local-model task: short input, self-contained, runs once per thread, and keeps early conversation content off any cloud route. Route: after the first completed turn, ask the on-device model for a ≤8-word title; fall back to the current default when unavailable.

### 11. Token-aware routing

`count-tokens` + `contextSize` are exposed; use them to (a) skip classification for prompts that can't fit, (b) chunk summarization of pasted content, (c) display "fits on-device" hints in the composer.

## Priority sketch

| Priority | Item | Why |
| --- | --- | --- |
| P1 | `fm serve` provider | Biggest simplification; reuses HTTP path; streaming for free |
| P1 | Structured classifier output | Removes the flakiest part of local routing |
| P2 | Thread titles | One-line change per thread, instantly visible, zero cost |
| P2 | Token-aware routing | APIs already plumbed; prevents silent truncation |
| P2 | PCC tier | Bridges the 8K gap without third-party cloud |
| P3 | Multi-turn threads, Dynamic Profiles, MLX providers | Valuable but dependent on usage proving out P1/P2 |
| P3 | OCR/barcode tools, eval harness | Nice-to-have; evaluate after vision ships broadly |

## Known limitations to carry forward

- Vision helper requires a runtime whose `FoundationModels` exports `Attachment` symbols — absent on build 26A428 despite SDK support. Probe handles this; do not advertise `images` without a successful probe.
- `fm` requires one-time `sudo fm license`; Anvil must never attempt privileged acceptance — only surface the hint.
- The on-device model is ~8K context. Repo-aware, tool-using, or long prompts stay on the configured backend by design.
