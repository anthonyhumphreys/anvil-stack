# Session view + handoff UX surface (spec §18)

Status: implemented (settings hub); chat-session handoff control is a thin
follow-up that mounts the same IPC surface.

## Problem

The mesh execution stack is headless: `job.create`/`job.cancel`,
`approval.get`/`decide`, `observeAttempt`, and `initiateHandoff` exist as
tested service code but no IPC or renderer surface reaches them. Spec §18
requires a session view showing target, freshness, approvals, activity, and
stop controls — without conflating lost connection with cancellation — and
a handoff UX that names the current owner and the continuation mode, never
implying live-process migration.

## Surfaces

### 1. "Remote executions" panel — Sync & Mesh settings

Visible when signed in. Lists account jobs via `job.list`; expanding a row
runs `job.get` (attempts) + `approval.get(jobId)`:

- **Target**: `requestedTarget`/`targetEnrollmentId` resolved against
  `device.list` display names.
- **Freshness**: job `state`, `stateReason`, attempt `leaseExpiresAt`, and
  the live-channel state already surfaced in this panel. State labels are
  honest: `cancel-requested` renders "Stopping…", `unknown-outcome` renders
  "Lost contact — outcome unknown", never "cancelled".
- **Approvals**: pending `ApprovalRecord`s with approve/deny buttons
  (`approval.decide`). Approver rules stay server-side; the UI just
  surfaces decisions.
- **Activity**: per-attempt "Watch" toggles `observeAttempt` over a pushed
  IPC channel; stdout/stderr/status lines stream into a bounded tail,
  `gapBefore` rows render as explicit "gap in stream" markers.
- **Stop**: `job.cancel` on non-terminal jobs.
- **Handoffs**: local `mesh_handoff_journal` rows refreshed live via
  `handoff.get` — state, source→target device names, and (when a checkpoint
  exists) the provider continuation mode. Copy states explicitly that the
  target resumes from a checkpoint; no live process migrates.

### 2. Session-level ops (service + IPC; chat wiring deferred)

- `getSessionMeshState(sessionId)` — local `mesh_session_ownership` row +
  live `handoff.get` for every journaled handoff on the session.
- `initiateSessionHandoff(sessionId, targetEnrollmentId)` — delegates to
  `mesh-handoff.initiateHandoff` (readiness gate → durable reject →
  quiesce → checkpoint → ownership CAS), returning blockers when the
  session can't move yet.

The chat-side mount (owner chip + "Move to device…" on the active session)
is one component once these exist; ChatView's 2.7k-line layout surgery is
deliberately out of this change's blast radius.

## Layer plan

- `shared/sync-runtime.ts`: view types — `MeshJobView`/`MeshAttemptView`/
  `MeshApprovalView`/`MeshHandoffView` are contract re-exports (the
  `sync-mesh.ts` precedent); `SyncAttemptActivity` mirrors
  `AttemptActivity`; `SessionMeshState` is local.
- `sync-runtime.service.ts`: thin `accountRpc` wrappers —
  `listMeshJobs`, `getMeshJob`, `cancelMeshJob`, `getMeshApprovals`,
  `decideMeshApproval`, `getSessionMeshState`, `initiateSessionHandoff`,
  `observeAttemptActivity` (delegates to mesh-observe).
- `sync-runtime.ipc.ts`: matching handlers plus an attempt-activity push
  channel (`sync-runtime:attempt-observe`/`attempt-unobserve`,
  `webContents.send('sync-runtime:attempt-activity', …)`), cleaned up on
  sender destroy.
- Renderer: `RemoteExecutionsPanel` component mounted inside
  `SyncMeshSettingsPanel` when `auth.state === 'signed-in'`.

## Non-goals

- No dispatch authoring UI (`job.create` surfaces) — placement/execution
  entry points are a separate feature.
- No chat-view changes in this packet.
- No new schema — all reads join existing tables + live RPC.
