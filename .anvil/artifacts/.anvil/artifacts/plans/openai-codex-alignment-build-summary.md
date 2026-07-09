# OpenAI Codex Alignment Build Summary

## Docs Answers

Sources checked:
- OpenAI Codex models: https://developers.openai.com/codex/models
- OpenAI Codex CLI: https://developers.openai.com/codex/cli
- OpenAI Codex config: https://developers.openai.com/codex/config-basic
- Codex app-server README: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md

### Model Picker

Codex now exposes model selection through both CLI config and app-server calls.

Confirmed support:
- `thread/start`, `thread/resume`, and `thread/fork` can accept a model.
- `turn/start` can accept a model and reasoning effort.
- CLI exposes model switching through `/model`.
- Local CLI exposes a model catalog through `codex debug models`.

Anvil now has:
- A static docs-backed fallback catalog.
- Live CLI model detection in Settings.
- Model selection persisted in app settings.
- Selected model sent to Codex app-server thread and turn calls.

### Recommended Models

Docs-backed Anvil catalog now includes:

- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`
- `gpt-5.5`
- `gpt-5.3-codex-spark`

Default:
- `gpt-5.6-sol`

### Reasoning Levels

Anvil now supports:

- `none`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`
- `max`
- `ultra`

Docs interpretation:
- `max` means deeper single-task reasoning.
- `ultra` replaces older multi-agent style configuration and uses subagents for splittable work.

Direct OpenAI API calls still avoid passing Codex-only `max` and `ultra` as standard API `reasoning_effort`.

### ChatGPT Preference

Decision implemented:
- Prefer Codex CLI / ChatGPT sign-in as the default app provider.
- Preserve explicit OpenAI API-key setups.
- Migrate only API-keyless `openai` provider rows to `codex`.

This avoids silently breaking users who intentionally configured direct API access. A rare outbreak of restraint.

### Computer Use

Docs and CLI feature detection support computer-use/browser-use capability discovery.

Anvil now:
- Detects Codex CLI feature flags.
- Surfaces computer use, browser use, multi-agent, voice, and web search as capability chips in Settings.

Product status:
- Detection exists.
- Full first-class Anvil computer-use UX remains a follow-up.
- Existing browser/MCP surfaces remain separate.

### Sites

Docs indicate Sites management is primarily through ChatGPT web/desktop surfaces, not something Anvil should claim as native Codex CLI support yet.

Recommendation:
- Do not add a Sites product surface until OpenAI exposes a stable local/API integration contract.
- Track as a roadmap item, not a half-button in Settings.

### Voice

Docs and app-server types point toward realtime/voice-related surfaces, but Anvil does not yet have a first-class GPT-Live voice loop.

Recommendation:
- Keep current speech support separate.
- Add voice only after defining capture, permissioning, interruption, transcript persistence, and model routing.
- Settings detection can show voice capability when the CLI advertises it, but that is not the same as shipping voice.

## Implemented Files

Core model/reasoning:
- `anvil-app/src/shared/codex-models.ts`
- `anvil-app/src/shared/types.ts`
- `anvil-app/src/main/services/settings.service.ts`
- `anvil-app/src/main/services/codex-session.service.ts`
- `anvil-app/src/main/services/llm.service.ts`
- `anvil-app/mobile/components/reasoning-picker.tsx`
- `anvil-app/src/renderer/components/chat/ChatInput.tsx`

Codex status/model detection:
- `anvil-app/src/main/services/codex-bridge.service.ts`
- `anvil-app/src/main/ipc/settings.ipc.ts`
- `anvil-app/src/preload/index.ts`
- `anvil-app/src/shared/ipc-api.d.ts`
- `anvil-app/src/renderer/components/settings/SettingsView.tsx`

Canvas artifacts:
- `anvil-app/src/main/db/schema.ts`
- `anvil-app/src/main/services/chat-artifact.service.ts`
- `anvil-app/src/main/services/__tests__/chat-persistence.service.test.ts`
- `anvil-app/src/renderer/contexts/ChatContext.tsx`
- `anvil-app/src/renderer/components/chat/ChatView.tsx`

## Canvas Improvements Implemented

Artifact records now carry:
- `status`
- `visibility`
- `source`
- `model`
- `reasoningEffort`

A new `chat_artifact_revisions` table stores artifact revisions with the same metadata.

Default artifact state:
- `status`: `draft`
- `visibility`: `local`
- `source`: `assistant`

## Recommended Next Canvas Work

1. Add a revision history viewer in the canvas UI.
2. Add status transitions: draft, reviewed, approved, superseded, archived.
3. Add visibility workflows: local, shareable, public-ready.
4. Add artifact diffing between revisions.
5. Add export/share controls that respect visibility.
6. Add filters by model, reasoning effort, status, and artifact kind.
7. Add artifact provenance display in the side panel, including source message and generating model.

## Verification

Passed:
- `pnpm exec tsc --noEmit`
- `pnpm test -- src/main/services/__tests__/chat-persistence.service.test.ts src/main/services/__tests__/llm.service.test.ts`
- `pnpm lint`
- `pnpm build`

Notes:
- Build emitted existing Vite dynamic import warnings.
- Existing untracked `.anvil/artifacts` files were left untouched.