# OpenAI Codex Alignment And Canvas Plan

Date: 2026-07-09  
Scope: `anvil-app` desktop, Codex integration, model/reasoning controls, computer-use/Sites/voice capability mapping, and Anvil canvas improvements.

## Executive Summary

Anvil should treat Codex as the primary agent runtime and align its controls with the current Codex product surface:

- Add a real Codex model picker matching current Codex models: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, and preview/special models where available.
- Align reasoning controls with Codex/API reasoning effort values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, plus newer Codex execution modes such as `max` and `ultra` where the CLI/app-server supports them.
- Stop treating OpenAI model selection as a stale free-text setting. That field is currently one refactor away from becoming haunted.
- Make feature support explicit:
  - Computer use: partially supported through Anvil’s embedded browser MCP bridge, but not yet a first-class Codex capability surface.
  - Sites: not currently supported as a native Anvil publishing/management surface.
  - Voice: Anvil has browser speech-to-text dictation, not GPT-Live/realtime voice agent support.
- Improve canvas as Anvil’s local artifact/work-product layer, especially for plans, specs, review packs, diagrams, dashboards, and generated prototypes.

## Official OpenAI Signals Checked

Sources:

- Codex model docs: https://developers.openai.com/codex/models
- Codex CLI docs: https://developers.openai.com/codex/cli
- Codex config basics: https://developers.openai.com/codex/config-basic
- Codex config reference: https://developers.openai.com/codex/config-reference
- GPT-5.6 announcement: https://openai.com/index/gpt-5-6/
- ChatGPT Work announcement: https://openai.com/index/chatgpt-for-your-most-ambitious-work/
- GPT-Live announcement: https://openai.com/index/introducing-gpt-live/
- Sites docs: https://developers.openai.com/codex/sites
- Codex app announcement: https://openai.com/index/introducing-the-codex-app/
- Codex GA / SDK announcement: https://openai.com/index/codex-now-generally-available/
- Agents SDK docs: https://developers.openai.com/api/docs/guides/agents

Key facts from the docs:

- Codex docs currently show `gpt-5.6-sol` as the default/power model with medium reasoning.
- Current recommended Codex models include:
  - `gpt-5.6-sol`
  - `gpt-5.6-terra`
  - `gpt-5.6-luna`
  - `gpt-5.5`
  - `gpt-5.3-codex-spark`
- Codex CLI advertises `/model` for choosing model and reasoning effort.
- Codex supports web search configuration via `web_search = "cached" | "indexed" | "live" | "disabled"`.
- GPT-5.6 introduces Sol/Terra/Luna, `max`, and `ultra` in Codex/ChatGPT Work contexts.
- Sites is managed through ChatGPT web/desktop, not a standalone Codex CLI management surface.
- GPT-Live is a new voice model family powering ChatGPT Voice; API support is planned/rolling out, but Anvil does not currently integrate it.

## Current Anvil Findings

### Model And Reasoning State

Relevant files:

- `/Users/anthonyhumphreys/Code/anvil/anvil-app/src/shared/types.ts:324`
- `/Users/anthonyhumphreys/Code/anvil/anvil-app/src/shared/types.ts:1311`
- `/Users/anthonyhumphreys/Code/anvil/anvil-app/src/main/services/settings.service.ts:107`
- `/Users/anthonyhumphreys/Code/anvil/anvil-app/src/main/services/codex-session.service.ts:92`
- `/Users/anthonyhumphreys/Code/anvil/anvil-app/src/main/services/codex-session.service.ts:242`
- `/Users/anthonyhumphreys/Code/anvil/anvil-app/src/main/services/llm.service.ts:434`
- `/Users/anthonyhumphreys/Code/anvil/anvil-app/src/renderer/components/settings/SettingsView.tsx:793`
- `/Users/anthonyhumphreys/Code/anvil/anvil-app/src/renderer/components/chat/ChatInput.tsx:1424`

Current state:

- Chat composer already supports `ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'`.
- App settings still restrict `reasoningLevel` to `'low' | 'medium' | 'high'`.
- Settings default `openaiModel` is `gpt-5.5`.
- Settings UI still describes GPT-5.5-specific reasoning.
- Codex app-server sessions start with `codex app-server` and do not pass the selected model.
- Per-turn messages pass `effort`, but not model.
- Direct OpenAI API helper uses Chat Completions and only sends `reasoning_effort` when model starts with `gpt-5.5`.

Risk:

The chat composer is closer to modern Codex than the persisted settings model. The result is split-brain configuration: Anvil can display/send richer reasoning effort per turn, while global settings remain stuck in an older OpenAI model shape.

### Computer Use

Relevant files:

- `/Users/anthonyhumphreys/Code/anvil/anvil-app/scripts/chrome-mcp-server.mjs:4`
- `/Users/anthonyhumphreys/Code/anvil/anvil-app/scripts/chrome-mcp-server.mjs:78`
- `/Users/anthonyhumphreys/Code/anvil/anvil-app/src/main/ipc/browser.ipc.ts`
- `/Users/anthonyhumphreys/Code/anvil/anvil-app/src/main/services/browser.service.ts`

Current state:

- Anvil has an embedded browser panel.
- Anvil has a Chrome MCP bridge exposing tools like navigate, screenshot, evaluate, get HTML/text, click, type, and status.
- Local `codex features list` reports `computer_use`, `browser_use`, `browser_use_external`, and `browser_use_full_cdp_access` as stable in the installed CLI.

Answer:

Anvil partially supports computer use for browser/web tasks through MCP. It does not yet present computer use as a first-class Anvil capability with clear controls, permissions, task affordances, or session status. It also should not claim full desktop-app computer use unless we wire and verify that path explicitly.

### Sites

Current state:

- No obvious Anvil-native Sites integration.
- OpenAI docs say Sites can be created/managed in ChatGPT web or desktop, and Codex CLI can edit/test a local project before publishing.

Answer:

Anvil does not currently support Sites as a first-class surface. The honest near-term support is: “Anvil can help create/edit/test a local site project; publishing to OpenAI Sites is external until OpenAI exposes a suitable CLI/API management path or we integrate the ChatGPT/Codex surface intentionally.”

### Voice

Relevant files:

- `/Users/anthonyhumphreys/Code/anvil/anvil-app/src/renderer/hooks/useVoiceInput.ts:66`
- `/Users/anthonyhumphreys/Code/anvil/anvil-app/src/main/ipc/voice.ipc.ts`
- `/Users/anthonyhumphreys/Code/anvil/anvil-app/src/preload/index.ts:799`

Current state:

- Anvil has speech-to-text dictation through browser `SpeechRecognition`.
- It pipes captured text into UI workflows.
- It is not GPT-Live.
- It is not full-duplex realtime voice.
- It does not provide spoken agent replies or realtime interruption.

Answer:

Anvil supports voice input/dictation, not OpenAI’s new GPT-Live-style voice agent experience.

## Proposed Product Shape

### 1. Codex Model Picker

Replace the free-text “OpenAI model” field with a structured model picker for Codex-backed chat.

Recommended first version:

- Power: `gpt-5.6-sol`
- Balanced: `gpt-5.6-terra`
- Fast: `gpt-5.6-luna`
- Previous: `gpt-5.5`
- Preview: `gpt-5.3-codex-spark`, gated behind “show preview models” or availability detection

Each option should show:

- Label: “5.6 Sol”
- Model id: `gpt-5.6-sol`
- Best for: complex coding, computer use, research, cybersecurity
- Availability hints: ChatGPT plan/API/CLI if detectable
- Cost/speed hint, not hardcoded marketing fluff

Implementation notes:

- Add shared model metadata, probably in `src/shared/codex-models.ts`.
- Avoid scattering model arrays across settings, chat, onboarding, and mobile.
- Keep a custom model escape hatch behind “Advanced” for API users and temporary rollouts.

### 2. Reasoning And Execution Effort Alignment

Use one shared effort taxonomy:

- `none`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

Then add Codex-specific execution profiles separately:

- `standard`
- `max`
- `ultra`

Do not pretend `max` and `ultra` are just bigger reasoning strings unless the app-server protocol confirms that. They likely belong to a “mode/profile” concept because `ultra` coordinates multiple agents.

Implementation notes:

- Change `AppSettings.reasoningLevel` to reuse `ReasoningEffort`.
- Migrate persisted values safely; existing `low|medium|high` remain valid.
- Add `codexExecutionProfile?: 'standard' | 'max' | 'ultra'`.
- Add protocol probing before passing new params into `app-server`.
- Surface unavailable profile states cleanly rather than letting users select a button that does decorative nothing.

### 3. Pass Model Into Codex Sessions

Current code starts `codex app-server` without a model override.

Plan:

1. Verify current app-server JSON-RPC schema for model selection.
2. If supported on `thread/start`, pass model when creating/resuming/forking sessions.
3. If only supported per-turn, pass model in `turn/start`.
4. If only CLI config supports it, create a temporary profile/config override per session or spawn with `-c model="..."`, if app-server honors it.
5. Record selected model and effort in the Anvil session metadata so thread history explains what actually ran.

Acceptance:

- Starting a new chat with “5.6 Terra / low” actually runs that model/effort.
- Resuming a thread preserves or clearly shows the selected model behavior.
- Settings and chat controls cannot drift silently.

### 4. Codex Feature Detection

Add a `CodexCapabilities` service that reads:

- `codex --version`
- `codex features list`
- `codex --help`
- `codex app-server --help`, if useful
- `codex mcp list`
- `~/.codex/config.toml` values relevant to model/provider/web search

Expose in settings/diagnostics:

- CLI installed/version
- App-server available
- Models known by Anvil
- Features detected:
  - computer use
  - browser use
  - web search
  - multi-agent
  - plugins
  - apps
  - artifacts
  - realtime conversation
- MCP servers installed/available
- Web search mode
- Auth method if detectable without leaking secrets

This gives Anvil a reality panel instead of “trust me bro” configuration.

### 5. Web Search Support

Codex docs now make web search a first-class local task setting.

Plan:

- Add a setting for `web_search`: `cached`, `indexed`, `live`, `disabled`.
- Default to Codex default, not Anvil invention.
- Show a safety note for live search and full-access modes.
- Pass through via app-server params or config override only after verifying supported path.

### 6. Computer Use Support

Near-term:

- Keep the embedded browser MCP bridge.
- Make it discoverable from chat:
  - “Browser tools available”
  - “Open Browser panel”
  - “Register Anvil browser MCP”
  - current attached URL/status
- Allow a chat task to request browser access and link to the permission surface.

Medium-term:

- Add a “Computer Use” capability panel:
  - Browser automation status
  - Desktop/app control status, if supported
  - Active permissions
  - Screenshot visibility
  - Current target app/browser
- Keep dangerous controls explicit. Browser automation with logged-in sites is production-risk-adjacent; no casual YOLO toggle wearing a party hat.

Acceptance:

- A Codex turn can navigate, inspect, screenshot, click, and type in Anvil’s browser when the bridge is registered.
- The user can see when that bridge is active.
- Sensitive-site usage is opt-in.

### 7. Sites Support

Near-term honest support:

- Add “Prepare for Sites” workflow:
  - Detect compatible local web app.
  - Generate a Sites-ready handover prompt.
  - Run local build/test.
  - Open ChatGPT Sites docs or `chatgpt.com/sites`.

Medium-term, only if OpenAI exposes suitable integration:

- Add Sites project import/export.
- Track Sites URL in Anvil canvas/thread metadata.
- Pull deployment status where API permits.
- Push generated static/prototype artifacts to the appropriate external flow.

Acceptance:

- Anvil does not claim native Sites publishing until it genuinely does it.
- Canvas artifacts can become local source for a future Sites deployment.

### 8. Voice Support

Near-term:

- Rename current voice UI conceptually to “Dictation” where appropriate.
- Keep existing speech-to-text.
- Add capability status: “Local/browser speech recognition; not GPT-Live.”

Medium-term:

- Add OpenAI realtime voice integration when API/docs are stable:
  - Push-to-talk
  - Full-duplex session
  - Interruptions
  - Agent replies via speech
  - Text transcript synchronized with chat thread
  - Voice model picker: GPT-Live / mini where available
- Keep voice agent permissions separate from text chat. Voice should not accidentally run shell commands because someone coughed near a microphone.

Acceptance:

- Users can distinguish dictation from realtime voice agent mode.
- Voice transcript is persisted or intentionally ephemeral by setting.

## Canvas Improvements Plan

Anvil’s canvas should become the durable local work-product layer for agent output. The artifact fence contract is already a good primitive; the app should make it feel native.

### Canvas Goals

Canvas should handle:

- Plans
- Review packs
- Specs
- Migration notes
- Diagrams
- HTML prototypes
- Dashboards
- Data snapshots
- Handover docs
- Sites-ready project briefs

### 1. Artifact Inbox

Add a canvas inbox that captures artifact fences from chat output.

Behavior:

- Detect artifact fences with path, kind, and title.
- Preview before persisting.
- Allow accept, rename, change kind, or discard.
- Show conflicts if path already exists.
- Preserve source thread/message metadata.

Kinds:

- `markdown`
- `code`
- `html`
- `diagram`
- `data`
- `text`

### 2. Artifact Library

Add a browsable canvas library per workspace/repo/thread.

Views:

- Recent
- By kind
- By thread
- By repo
- By work item
- By status: draft, accepted, superseded, archived

Each artifact should show:

- Title
- Kind
- Path
- Created/updated time
- Source thread
- Linked repo/work item
- Last generating model/effort, if available

### 3. Artifact Diff And Versioning

Canvas artifacts need history.

Plan:

- Store artifact revisions.
- Show markdown/code diffs.
- For HTML, show source diff plus rendered preview.
- Allow “restore this revision”.
- Mark AI-generated updates separately from user edits.

This avoids the classic “the agent improved it into a crater” problem.

### 4. Rendered Previews

Per kind:

- Markdown: rendered preview plus source.
- Code: syntax-highlighted source.
- HTML: sandboxed preview.
- Diagram: render Mermaid/diagram format if supported.
- Data: table preview for JSON/CSV.
- Text: plain preview.

Security:

- HTML previews must be sandboxed.
- No automatic network access unless explicitly allowed.
- Make external links visible.

### 5. Canvas-To-Chat Loop

Artifacts should be reusable inputs.

Actions:

- “Use as context”
- “Ask Codex to revise”
- “Generate implementation prompt”
- “Turn into checklist”
- “Create follow-up issue”
- “Export to file”
- “Open in editor”

For plans:

- Extract checklist items.
- Let the user mark accepted scope.
- Start implementation from accepted sections only.

### 6. Canvas-To-Sites Path

Since Sites is not native in Anvil yet, canvas can bridge the workflow:

- “Prepare as Site”
- Convert markdown/data/spec into a Sites prompt bundle.
- Include assets and constraints.
- Generate a local HTML prototype when useful.
- Provide an external handoff prompt for ChatGPT Sites.

Future:

- If Sites gains API/CLI support, replace handoff with direct publishing.

### 7. Canvas Governance

Add lightweight metadata:

- `status`: draft, reviewed, approved, superseded
- `visibility`: local, shareable, public-ready
- `source`: user, assistant, imported
- `linkedWorkItem`
- `linkedRepoIds`
- `model`
- `reasoningEffort`
- `createdFromThreadId`

Useful guardrail:

- Public-ready docs should require an explicit review flag. Anvil has already had enough “website copy outran implementation truth” energy.

### 8. Canvas Search

Index:

- Title
- Path
- Kind
- Content
- Linked repo/work item
- Source thread
- Tags

Add filters:

- Kind
- Status
- Date
- Repo
- Work item
- Model
- Public-ready

### 9. Canvas Templates

Add reusable artifact templates:

- Implementation plan
- Code review pack
- Release notes
- Migration plan
- Architecture decision
- Security finding
- Sites handoff
- Feature spec
- QA checklist

Templates should be plain files, not a magic database ceremony.

### 10. Canvas Tests

Add focused tests for:

- Artifact fence parser
- Invalid fence handling
- Path normalization
- Conflict detection
- Revision creation
- Metadata persistence
- HTML sandbox preview URL generation
- Search indexing

## Implementation Sequence

### Phase 1: Codex Truth And Settings Cleanup

1. Add shared Codex model metadata.
2. Replace settings free-text model field with picker plus advanced custom model.
3. Expand persisted reasoning type to full `ReasoningEffort`.
4. Update settings defaults from `gpt-5.5` to `gpt-5.6-sol` where appropriate.
5. Update stale GPT-5.5 copy.

Validation:

- Typecheck.
- Settings tests.
- Manual settings save/reload.

### Phase 2: Runtime Wiring

1. Verify app-server model/effort/profile schema.
2. Pass selected model into Codex sessions.
3. Persist model/effort/profile on session/thread metadata.
4. Add compatibility fallback for older Codex CLI versions.
5. Add diagnostics for “selected but not supported”.

Validation:

- Spawn a Codex session and confirm status/model.
- Regression test `startSession` payload construction.
- Manual chat smoke.

### Phase 3: Capability Panel

1. Add Codex capability detection service.
2. Surface CLI version/features/auth/config in settings or diagnostics.
3. Add web search mode display/control.
4. Add browser/computer-use status.

Validation:

- Mock `codex features list`.
- Test parser.
- Manual with local CLI.

### Phase 4: Computer Use UX

1. Promote embedded browser MCP status into chat/browser surfaces.
2. Add “register browser MCP” affordance where users need it.
3. Add permission/status copy around browser automation.
4. Keep sensitive actions explicit.

Validation:

- Register MCP.
- Open browser.
- Run Codex task using browser tools.
- Verify visible status.

### Phase 5: Voice Clarification

1. Rename current voice support to dictation where needed.
2. Add status text distinguishing dictation from GPT-Live.
3. Plan realtime implementation behind a feature flag.

Validation:

- Existing dictation still works.
- No claims of GPT-Live support.

### Phase 6: Canvas Foundation

1. Implement artifact fence parser.
2. Add artifact inbox.
3. Persist accepted artifacts with metadata.
4. Add artifact library.
5. Add preview for markdown/code/text first.

Validation:

- Parser unit tests.
- Persistence tests.
- Manual artifact creation from chat.

### Phase 7: Canvas Rich Previews And Workflow

1. Add HTML sandbox preview.
2. Add diagram/data previews.
3. Add revisions/diffs.
4. Add canvas-to-chat actions.
5. Add Sites handoff workflow.

Validation:

- HTML security checks.
- Diff tests.
- Manual Sites handoff.

## Open Questions

- Does current `codex app-server` accept model selection in `thread/start`, `turn/start`, or only via process/config?
- Are `max` and `ultra` exposed through local app-server today, or only ChatGPT Work/Codex product surfaces?
- Should model selection be global, per workspace, per thread, or per turn? Recommendation: default global, override per thread, show per-turn advanced override later.
- Should Anvil prefer ChatGPT subscription auth via Codex CLI over OpenAI API key for Codex sessions? Recommendation: yes for Codex runtime, keep API key for direct OpenAI utility calls.
- Should canvas artifacts live in SQLite, repo files, or both? Recommendation: metadata/revisions in SQLite, accepted/exported artifacts as repo/workspace files when the user chooses.

## Done Criteria

- Anvil’s model picker matches current Codex model families and does not contain stale GPT-5.4/GPT-5.5-only assumptions.
- Reasoning controls use the full supported reasoning effort set.
- The selected model and effort actually affect Codex runtime behavior or show an explicit unsupported warning.
- Computer use, Sites, and voice support are represented truthfully in the UI.
- Canvas can capture, preview, persist, version, and reuse artifact-fenced outputs.
- Public/docs/demo claims can be made from implementation truth without requiring a séance.