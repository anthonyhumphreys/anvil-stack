# Agent UI intents

Agent UI intents let an agent request a semantic, native Anvil surface instead of encoding an
interaction in prose. Version 1 implements plans, questions and inline surfaces (`kind: 'surface'`).
Everything renders inline in the thread; there is no side pane renderer. The full surface model is
specified in [`plans/inline-artifacts-and-canvas-tools.md`](./plans/inline-artifacts-and-canvas-tools.md).

## Decision

Anvil owns a provider-neutral intent envelope and persists it independently of provider transport and
React presentation. Provider adapters translate native events into the envelope and translate
structured user responses back into provider-native messages.

This keeps three boundaries explicit:

1. `src/shared/agent-ui-intents.ts` defines semantic state and patch operations.
2. Main-process services validate, persist, resolve, and route intents.
3. Renderer components choose where and how to present each intent.

The trade-off is a small adapter per provider. In return, providers do not learn React component
names, presentation concepts, or Anvil persistence details, and Anvil does not infer UI requests from
model prose.

## Flow

```text
Provider event or tool call
        |
        v
Provider adapter
        |
        v
AgentUIIntent validation and persistence
        |
        v
Chat event + intent router
        |
        +----> Plan renderer in chat and the sticky Plan chip above the composer
        |
        +----> Question renderer in chat and above the composer
        |
        +----> Surface host in the reply (inline, stage, window)
        |
        v
Structured user patch or answer
        |
        v
Provider adapter -> waiting provider request or active turn
```

## Protocol

Every intent has:

- `protocolVersion`, stable `id`, `kind`, and monotonic `revision`
- workspace/thread/run/provider-thread scope
- `pending`, `presented`, `resolved`, `dismissed`, or `expired` lifecycle
- presentation preferences (`collapsed` and `hidden`) kept separate from semantic payload
- creation, update, and optional resolution timestamps

`plan`, `question` and `surface` are accepted in protocol version 1. Unsupported versions, kinds,
malformed timestamps, duplicate IDs, invalid dependencies, empty questions, invalid defaults, and
surface data that fails its kind's schema are rejected at the main-process trust boundary.

Intents update in place by `id`. The renderer keeps the copy with the highest `revision` (ties go to
the later `updatedAt`), both in thread state and in the transcript entry, so a replayed or late event
never rolls a surface back.

### Plans

Plans contain stable phase and step IDs. Step status is `todo`, `in_progress`, `blocked`, or `done`.
Steps may include dependencies, an owner, notes, and typed artifact/file/diff references.

Changes use validated domain operations rather than whole-object replacement or arbitrary JSON Patch.
Each patch carries a `baseRevision` and `operationId`; stale revisions produce a conflict. Agent updates
merge with locally stored presentation state, so an update does not forcibly reopen a hidden plan.

Plans render inline with their turn. The active plan is also pinned above the composer as a compact
"Plan x/y" chip (in the slot pending questions use) that expands in place for editing, completing steps
and asking about a step. All plans can collapse or hide. Completed plans collapse by default and can be
archived; hidden and archived plans can be restored. The legacy `active_plan_json` snapshot is maintained as a compatibility
projection for existing prompt shaping, and existing snapshots are lazily migrated when a thread is
opened.

### Questions

Version 1 supports:

- single choice
- multiple choice
- yes/no
- free text
- decision approval/rejection

Options have stable semantic values independent of their labels, plus optional descriptions,
consequences, and recommendation state. Required questions keep the provider request paused. Pending
questions render with their turn and remain pinned immediately above the composer, so they always
stay reachable. Answers return as typed strings, string arrays, or booleans.

A decision approval is not a substitute for command, filesystem, or permission approval. Existing
runtime approvals retain their stricter execution and audit semantics.

Sensitive text values are held only in renderer state, sent directly to the waiting provider request,
and redacted in the intent response/event tables. A future credential surface should return a secure
credential handle rather than persisting raw credentials in this protocol.

## Persistence

`agent_ui_intents` stores the current materialized intent. `agent_ui_intent_events` is a compact audit
trail, and `agent_ui_intent_responses` stores one redacted resolution per question. Intent, plan, step,
question, and answer IDs are stable. Intent state survives renderer reloads, provider reconnects, and
ordinary chat turns.

Comments on surfaces (anchored to the whole surface, a text selection, a sketch region, a finding, a
diff range and so on) are stored as surface comments and can be sent to the agent as structured
feedback. Legacy artifact annotations remain in `chat_artifact_annotations`.

## Provider adapters

`codex-agent-ui.adapter.ts` is the adapter boundary for normalized events emitted by the current Codex
and Cursor transports. It translates `plan_update` and `input_request` events into core intents, maps
supported JSON Schema fields into native questions, and converts structured resolutions back into the
provider response shape. Provider identity is carried in the binding rather than assumed by the UI.

Codex plan snapshots do not supply stable step IDs, so the adapter reuses IDs by prior title and index.
The UI never parses Codex prose or Codex-specific labels.

Cursor uses Agent Client Protocol (ACP) v1. Anvil advertises form elicitation support, translates
`elicitation/create` requests into Question intents, and returns the structured accept, decline, or
cancel response to the waiting JSON-RPC request. Cursor `session/update` plan entries become Plan
intents through the same provider-neutral path. Permission requests remain on the dedicated runtime
approval surface.

ACP does not provide Codex's active-turn steering method. If a user edits a plan while a Cursor prompt
is running, Anvil queues the patch and sends it as the next `session/prompt` after the current prompt
returns its stop reason. Ready Cursor sessions receive plan feedback immediately. This preserves edits
without issuing overlapping ACP prompts.

## Surfaces

A surface intent carries `payload: { surfaceKind, title, key?, streaming, digest, data, supersededBy? }`.
`data` is validated by the kind's shared definition in `src/shared/surfaces/kinds/<kind>.ts`, registered
in `src/shared/surfaces/registry.ts`. Main publishes, patches (by `baseRevision`) and supersedes
surfaces; when a later surface publishes the same `key`, earlier ones get `supersededBy` and collapse to
one line that scrolls to the newer one.

Rendering (`src/renderer/components/surfaces/`):

- `composeChatTurns` lifts surface intents out of the turn's activity log; the transcript renders them
  in the reply column where they were produced (wide kinds break out to the full transcript width).
- `SurfaceHost` draws the shared chrome: kind icon, title, meta line, and Expand (stage), Open in window
  and an overflow menu (Copy digest, Comment on surface, Share…). It owns the streaming skeleton,
  updated chip, superseded line and error state, viewport-mounts heavy bodies with reserved height, and
  confirms `mutation` actions before calling `window.anvil.surfaces.runAction`.
- Per-kind views come from `getSurfaceView(kind)` (`Inline`, optional `Stage`). The stage overlays the
  chat column, lives in the `?surface=<id>` search param (back closes, reload restores), closes on Esc
  and returns focus to the surface handle, and has a comments rail. Windows are keyed by surface id
  (`anvil-surface-<id>`), titled with the workspace name, and never re-bind on thread switch.
- Artifacts show the version their turn produced; the stage adds Preview/Source, a version switcher and
  a diff against earlier versions. Sketches run in an opaque-origin `sandbox="allow-scripts"` frame built
  by `buildSketchDocument` (CSP, live `--anvil-*` tokens, the JSON-RPC bridge and `anvil-kit`).

Fallback fences (`artifact` and `sketch` fence languages) never render as code blocks: an artifact fence
becomes a placeholder card linked to the artifact persisted after the turn, and a sketch fence renders a
throwaway sketch frame from the fence body.

## Adding another surface

1. Add the kind definition (schema, actions with semantics, anchors, `digest`) under
   `src/shared/surfaces/kinds/` and register it.
2. Add main-side hydration, actions and patch operations under `src/main/surfaces/kinds/`.
3. Add `Inline` (and optionally `Stage`) views under `src/renderer/components/surfaces/kinds/<kind>/`
   and register them in `src/renderer/components/surfaces/registry.ts`.
4. Add schema, digest, patch/conflict, action and renderer tests.

Do not add placeholder buttons whose actions have no execution semantics.

## Adding another provider

1. Translate explicit provider tool/schema events into `AgentUIIntentRecord`; do not infer from prose.
2. Store only provider request/session identifiers in `AgentUIIntentBinding`.
3. Translate structured answers and plan patches at the adapter boundary.
4. Expire required questions when their provider session can no longer resume.
5. Test ID stability, status/value mappings, invalid payloads, pause/resume, and reconnect behavior.

Provider code must not import renderer components or encode presentation details.
