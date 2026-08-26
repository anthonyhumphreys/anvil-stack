# Agent UI Intent Architecture Review

## Verdict

Proceed, with revisions.

Anvil already implements a useful vertical slice of this proposal:

- Codex plan updates are normalised into plan events.
- The latest plan is persisted against the chat thread.
- Plans render in chat and Canvas.
- Codex user-input and approval requests pause execution.
- Structured answers are returned to the Codex app server.
- Threads expose working, input, and approval attention states.

The implementation should therefore be framed as:

> Extract and extend Anvil's existing provider-specific plan, question, and approval machinery into a provider-agnostic Agent UI Intent protocol.

This is a substantial feature and should be delivered in several coherent milestones or commits, even if kept on one feature branch.

## Current repository truth

The existing plan model is deliberately small: three statuses, text-only steps, no stable step IDs, and whole-plan snapshots in [types.ts](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/shared/types.ts:702).

Codex requests are already mapped into blocking input and approval events in [codex-protocol.service.ts](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/main/services/codex-protocol.service.ts:354). Structured responses are sent back to the waiting provider request by [codex-session.service.ts](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/main/services/codex-session.service.ts:514).

Plan state currently lives as `active_plan_json` on the thread and is overwritten as a complete snapshot by [chat-persistence.service.ts](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/main/services/chat-persistence.service.ts:613).

Canvas already has sidebar, expanded, and detached modes, but its plan section has no lifecycle controls. The plan is rendered whenever `activePlan` exists, including underneath a selected artifact, in [ChatView.tsx](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/renderer/components/chat/ChatView.tsx:1893). The actual plan panel is always expanded and exposes no collapse, hide, dismiss, archive, or clear action in [ChatView.tsx](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/renderer/components/chat/ChatView.tsx:1926).

The current structured-question UI is a good starting point, but it:

- Uses option labels as answer values.
- Encodes “recommended” by parsing text from the label.
- Presents one selected string per question.
- Does not provide native multi-select.
- Does not model required, optional, skipped, cancelled, or expired states fully.
- Handles MCP form elicitation as raw JSON rather than a schema-rendered form.

## Required architectural correction

Do not make `CodexEvent` the new protocol.

Introduce provider-neutral domain types, then adapt Codex and future providers into them:

~~~ts
type AgentUIIntent = PlanIntent | QuestionIntent;

interface AgentUIIntentEnvelope<TKind, TPayload> {
  protocolVersion: 1;
  id: string;
  kind: TKind;
  revision: number;
  scope: {
    workspaceId: string;
    threadId: string;
    runId?: string;
    providerThreadId?: string;
  };
  lifecycle: 'pending' | 'presented' | 'resolved' | 'dismissed' | 'expired';
  payload: TPayload;
  createdAt: string;
  updatedAt: string;
}
~~~

Keep three concerns separate:

1. **Semantic state** — plan contents, question contents, answers, lifecycle.
2. **Provider transport** — Codex JSON-RPC, ACP, or another provider protocol.
3. **Presentation state** — expanded, collapsed, hidden, selected Canvas item.

React component names and Canvas concepts must not appear in provider-facing schemas.

## Plan protocol

Use the requested domain statuses:

- `todo`
- `in_progress`
- `blocked`
- `done`

Provider adapters should translate native statuses such as Codex `pending` and `completed` at the boundary.

Each plan, phase, and step needs a stable ID. References to files, artifacts, and diffs should be typed rather than embedded in notes.

~~~ts
interface PlanStep {
  id: string;
  phaseId?: string;
  title: string;
  status: 'todo' | 'in_progress' | 'blocked' | 'done';
  dependsOn?: string[];
  owner?: AgentReference;
  notes?: string;
  links?: AgentUIReference[];
}

interface PlanIntentPayload {
  planId: string;
  title: string;
  description?: string;
  lifecycle: 'active' | 'completed' | 'archived';
  phases: PlanPhase[];
  steps: PlanStep[];
}
~~~

### Incremental updates

Do not use arbitrary JSON Patch as the public agent contract. Use a small set of validated domain operations:

- `set_plan_metadata`
- `add_phase`
- `update_phase`
- `remove_phase`
- `add_step`
- `update_step`
- `move_step`
- `remove_step`
- `set_step_status`
- `archive_plan`

Every patch should carry:

- `planId`
- `baseRevision`
- `operationId`
- One or more operations

The service applies the patch transactionally and increments the revision. A stale `baseRevision` returns a structured conflict containing the current revision.

User edits should use the same operation model, with `actor: "user"`, and be returned to the provider as structured state changes.

## Canvas lifecycle and cleanup

This is a required first-class part of the feature.

### Behaviour

- Every plan can be expanded or collapsed, including an in-progress plan.
- A collapsed plan remains as a compact summary: title, status, progress, and current step.
- An active plan can be hidden from Canvas without cancelling or deleting it.
- A completed plan can be dismissed or archived.
- Dismissal is presentation-only and must not imply that the agent should stop.
- Archiving is a semantic plan action and may be returned to the agent.
- The user can restore hidden or archived plans from plan history.
- A newly updated hidden plan may show an unread/update badge but must not forcibly reopen.
- A completed plan should collapse to its summary by default unless the user is actively editing it.
- Canvas should not remain open solely because a dismissed plan still exists.
- Clearing or archiving a plan must be supported by persistence; the current save API only accepts a non-null snapshot.
- Plan presentation state should survive renderer reconnects.

### Canvas information architecture

Plans should become first-class Canvas items alongside artifacts rather than always appearing below whichever artifact is selected.

Suggested Canvas navigation:

- Current plan
- Artifacts
- Archived plans

Avoid nested cards. Use compact rows, disclosure controls, and a single expanded working surface.

### Plan actions

Initially implement only actions with real execution semantics:

- Mark complete
- Skip
- Ask agent
- Run step, when the provider supplies an executable step capability
- Retry, when the step is tied to a failed execution

Do not render decorative Run or Retry buttons when Anvil cannot fulfil them.

## Question protocol

Questions need semantic values separate from labels:

~~~ts
interface QuestionOption {
  id: string;
  label: string;
  value: string;
  description?: string;
  consequences?: string;
  recommended?: boolean;
}

type QuestionKind =
  | 'single_choice'
  | 'multiple_choice'
  | 'yes_no'
  | 'free_text'
  | 'approval';

interface QuestionIntentPayload {
  questionId: string;
  kind: QuestionKind;
  question: string;
  context?: string;
  required: boolean;
  options?: QuestionOption[];
  defaultValue?: unknown;
  allowCancel: boolean;
}
~~~

Answers should distinguish submission from cancellation:

~~~ts
interface QuestionResolution {
  intentId: string;
  questionId: string;
  action: 'submit' | 'skip' | 'cancel';
  value?: string | string[] | boolean;
  answeredAt: string;
}
~~~

The renderer should use standard controls:

- Radio group for single choice.
- Checkboxes for multiple choice.
- Two explicit choices for yes/no.
- Text area or input for free text.
- Approve/reject controls for approval.

Questions should normally render inline with the affected turn. Required unresolved questions must also remain visible through thread attention and the Work inbox.

### Secrets

Do not treat credentials as ordinary free-text answers.

Until a credential broker exists:

- Secret fields must be ephemeral.
- Values must never be persisted in intent JSON, chat history, logs, analytics, notifications, or error payloads.
- Resolved UI should say only that a value was supplied.
- Provider capabilities must explicitly declare whether secure responses are supported.

A future credential intent should reference a stored credential handle, not return raw secrets through the normal question protocol.

## Approval boundary

Sensitive command, filesystem, and permission approvals already have execution-specific semantics. Preserve them.

A generic `approval` question means “approve this proposed decision.” It must not silently substitute for runtime permission approval.

Later, existing execution approvals can be presented through the shared surface router while retaining their stricter provider-response and audit contracts.

## Persistence

Use a lightweight dedicated intent store rather than further expanding `active_plan_json`.

A practical first version is:

- `agent_ui_intents`
  - ID
  - protocol version
  - kind
  - workspace/thread/run scope
  - provider/provider request ID
  - current revision
  - lifecycle
  - validated JSON payload
  - created/updated/resolved timestamps

- `agent_ui_intent_responses`
  - response ID
  - intent ID
  - revision
  - actor
  - action
  - non-secret response JSON
  - timestamp

Plan steps do not need their own relational tables initially. The service can validate and transactionally patch the JSON document.

Persist presentation state separately from semantic intent state. A hidden plan is still an active plan.

### Reconnect contract

Be explicit about two reconnect levels:

- Renderer reconnect: restore pending intents from SQLite and continue against the live main-process provider request.
- Full application restart: plans restore normally, but an unresolved question can resume only if the provider supports request/session resumption. Otherwise mark it expired and explain why.

Responses must be idempotent so a double click or reconnect cannot answer a provider request twice.

## Recommended delivery order

### Milestone 0 — Fix Canvas plan lifecycle

- Collapse/expand plans.
- Hide active plans.
- Dismiss/archive completed plans.
- Clear stale active-plan state.
- Stop dismissed plans from keeping Canvas open.
- Restore hidden or archived plans.
- Add focused Canvas lifecycle tests.

This can ship independently and directly fixes the reported problem.

### Milestone 1 — Core intent protocol

- Add versioned provider-neutral domain types.
- Add runtime parsing and validation at IPC and provider boundaries.
- Add the intent service and persistence migration.
- Add revisioned patch operations.
- Keep compatibility adapters for existing `ChatPlanSnapshot` and `CodexInputRequest`.

### Milestone 2 — Codex adapter

- Translate Codex plan updates into plan intents and patches.
- Translate `requestUserInput` into question intents.
- Translate structured responses back to Codex JSON-RPC.
- Preserve existing command/file/permission approval behaviour.
- Make resolution idempotent.

### Milestone 3 — Native Plan surface

- Add title, description, phases, blocked state, dependencies, owners, notes, and references.
- Add user editing through the patch service.
- Add visible progress and phase disclosure.
- Add only executable step actions.
- Use Canvas as the initial renderer.

### Milestone 4 — Native Question surface

- Implement all five initial question kinds.
- Add required, optional, skip, cancel, default, recommendation, and trade-off semantics.
- Preserve blocking thread attention.
- Replace raw JSON MCP forms where their schema maps safely to supported fields.

### Milestone 5 — Hardening and documentation

- Add provider conformance tests.
- Test reconnect and stale-revision behaviour.
- Document the protocol, adapters, renderer registration, persistence, and extension process.
- Add `docs/plans/agent-ui-intents.md`.

The repository has a `docs/plans` convention but no clear numbered ADR convention. The architecture document should include a concise “Decision and consequences” section rather than introducing a new ADR system solely for this feature.

## Additional tests

In addition to the proposed test list, cover:

- Active plan collapse and expansion.
- Completed plan dismissal and restoration.
- Hidden plan updates do not forcibly reopen Canvas.
- Dismissed plans do not keep Canvas visible.
- Plan clear/archive persistence.
- Stable IDs across provider updates.
- Out-of-order and stale-revision patches.
- Duplicate response submission.
- Renderer reconnect with a pending question.
- Full restart with a non-resumable pending question.
- Cancelled and expired questions.
- Option values differing from labels.
- Recommended options without label parsing.
- Secret answers never entering persistence or logs.
- Unknown protocol versions and unsupported intent kinds.
- Existing Codex approval behaviour remains unchanged.

## Definition of done

The feature is complete when:

- A Codex plan becomes a versioned provider-neutral plan intent.
- The plan renders in Canvas and can be edited incrementally.
- Active and completed plans can be collapsed or removed from the working Canvas without losing history.
- A Codex structured question pauses the turn and renders natively.
- Every initial question kind returns a typed answer.
- The provider resumes exactly once after resolution.
- Plans survive application restarts.
- Pending questions survive renderer reconnects.
- Invalid payloads fail safely at trust boundaries.
- Provider-specific logic does not leak into React components.
- Adding a new provider requires an adapter, not changes to the core surfaces.
- Adding a new surface requires a new intent type, validator, renderer registration, and tests rather than changes throughout the Codex path.

## Final recommendation

Approve the direction, but replace the current greenfield framing with an extraction-and-upgrade plan.

The first move should be the Canvas lifecycle fix. It is independently valuable, validates the semantic-versus-presentation distinction, and prevents the richer plan implementation from cementing the existing “permanent plan panel” behaviour.