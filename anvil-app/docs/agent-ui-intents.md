# Agent UI intents

Agent UI intents let an agent request a semantic, native Anvil surface instead of encoding an
interaction in prose. Version 1 implements plans and questions. Canvas is the initial plan renderer;
it is not part of the protocol.

## Decision

Anvil owns a provider-neutral intent envelope and persists it independently of provider transport and
React presentation. Provider adapters translate native events into the envelope and translate
structured user responses back into provider-native messages.

This keeps three boundaries explicit:

1. `src/shared/agent-ui-intents.ts` defines semantic state and patch operations.
2. Main-process services validate, persist, resolve, and route intents.
3. Renderer components choose where and how to present each intent.

The trade-off is a small adapter per provider. In return, providers do not learn React component
names, Canvas concepts, or Anvil persistence details, and Anvil does not infer UI requests from model
prose.

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
        +----> Plan renderer in Canvas and chat
        |
        +----> Question renderer in chat and above the composer
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

Only `plan` and `question` are accepted in protocol version 1. Unsupported versions, kinds, malformed
timestamps, duplicate IDs, invalid dependencies, empty questions, and invalid defaults are rejected at
the main-process trust boundary.

### Plans

Plans contain stable phase and step IDs. Step status is `todo`, `in_progress`, `blocked`, or `done`.
Steps may include dependencies, an owner, notes, and typed artifact/file/diff references.

Changes use validated domain operations rather than whole-object replacement or arbitrary JSON Patch.
Each patch carries a `baseRevision` and `operationId`; stale revisions produce a conflict. Agent updates
merge with locally stored presentation state, so an update does not forcibly reopen a hidden plan.

Canvas treats plans as first-class items alongside artifacts. All plans can collapse or hide. Completed
plans collapse by default and can be archived; hidden and archived plans remain available in plan
history and can be restored. The legacy `active_plan_json` snapshot is maintained as a compatibility
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
questions render with their turn and remain pinned immediately above the composer, so Canvas state
cannot hide them. Answers return as typed strings, string arrays, or booleans.

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

Artifact annotations are stored separately in `chat_artifact_annotations` and cascade with their
artifact. Canvas users can attach a note to an artifact, optionally capture the current text selection,
resolve/reopen or delete the note, and prefill chat with the artifact and annotation context.

## Codex adapter

`codex-agent-ui.adapter.ts` translates Codex `plan_update` and `input_request` events into core intents.
It also maps supported MCP JSON Schema fields into native questions and converts structured resolutions
back into Codex user-input or MCP elicitation responses. Unsupported MCP schemas continue through the
existing fallback instead of being guessed at in React.

Codex plan snapshots do not supply stable step IDs, so the adapter reuses IDs by prior title and index.
The UI never parses Codex prose or Codex-specific labels.

## Adding another surface

1. Add a semantic payload and intent union member in `src/shared/agent-ui-intents.ts`.
2. Extend runtime validation in `agent-ui-intent.service.ts`.
3. Define lifecycle and structured response or patch operations before adding UI.
4. Add a renderer to `AgentUIIntentSurface` and route it by `kind`.
5. Add persistence, invalid-payload, reconnect, and renderer tests.

`ApprovalSurface`, `DiffSurface`, `ArtifactSurface`, and `TestResultsSurface` can follow this path. Do
not add placeholder buttons whose actions have no execution semantics.

## Adding another provider

1. Translate explicit provider tool/schema events into `AgentUIIntentRecord`; do not infer from prose.
2. Store only provider request/session identifiers in `AgentUIIntentBinding`.
3. Translate structured answers and plan patches at the adapter boundary.
4. Expire required questions when their provider session can no longer resume.
5. Test ID stability, status/value mappings, invalid payloads, pause/resume, and reconnect behavior.

Provider code must not import renderer components or encode Canvas presentation details.
