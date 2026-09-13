# LLMGateway provider integration plan

Status: proposed  
Scope: `anvil-app`  
Prepared: 2026-09-03

## Decision

Add LLMGateway as one Anvil provider with two billing modes:

| Anvil mode | Browser-login organisation | models.dev provider | Model IDs |
|---|---|---|---|
| DevPass | `devpass` | `llmgateway` | Canonical, such as `claude-sonnet-4-6` |
| Pay as you go | `default` | `llmgateway-providers` | Provider-pinned IDs are available, such as `anthropic/claude-sonnet-4-6` |

Do not require `devpass-code` as an Anvil dependency.

Use:

- Native browser login in Anvil.
- Electron `safeStorage` plus SQLite for the minted gateway key.
- LLMGateway's OpenAI-compatible API for app-level AI calls.
- The existing Codex app-server for repository-aware agent sessions, configured per process to use LLMGateway's Responses API.
- `models.dev/api.json` for picker metadata, pricing, capabilities, and reasoning options.

This covers both kinds of work currently routed through the primary provider:

1. Agent sessions, including tools, approvals, files, plans, and resumable threads.
2. One-shot app utilities, including summaries, code review, security analysis, and generated content.

An ACP-only DevPass Code adapter would cover the first category but leave the second needing another implementation. Native integration is therefore the smaller complete product design.

## External contracts

LLMGateway currently documents:

- Browser login through `https://llmgateway.io/connect/cli`, using a temporary loopback callback.
- The hosted API at `https://api.llmgateway.io/v1`.
- Both Chat Completions and Responses API support.
- Canonical model IDs for DevPass and provider-pinned IDs for pay-as-you-go accounts.
- Source attribution through an `x-source` request header.
- Models through two entries in the models.dev catalog.

Relevant references:

- [DevPass Code browser-login guide](https://docs.llmgateway.io/guides/devpass-code)
- [Empryo browser-login and attribution guide](https://docs.llmgateway.io/guides/empryo)
- [LLMGateway Codex CLI guide](https://docs.llmgateway.io/guides/codex-cli)
- [LLMGateway model endpoint](https://docs.llmgateway.io/v1_models)
- [LLMGateway Responses and reasoning behaviour](https://docs.llmgateway.io/features/reasoning)
- [models.dev API contract](https://github.com/anomalyco/models.dev/blob/dev/README.md)
- [Codex custom provider implementation](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs)

Before release, confirm with LLMGateway:

- The approved source identifier is `anvil`.
- The requested login name should be `Anvil`.
- The `/connect/cli` query contract is supported for third-party desktop integrations.
- Whether disconnecting can revoke the minted key or only remove Anvil's local copy.
- Whether they want any additional attribution or partner metadata.

## Proposed architecture