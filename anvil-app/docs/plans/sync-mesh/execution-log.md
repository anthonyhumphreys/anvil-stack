# Sync & Mesh execution log

## 2026-09-13 — Step 4 real authentication + two-profile acceptance gate PASSED

Branch: `feature/sync-mesh--foundations`.

Implements Step 4 (replace spike authentication with the supported flows) and
closes the workflow-sync half of Step 5 by running the two-profile acceptance
gate against the actual Worker over real HTTP.

### Contract (`cloud/contract/auth.ts`)

- Enrollment-code issue/consume request+response types, `session.describe`
  result, auth failure codes (`refresh-reuse-detected`,
  `enrollment-code-used`, `invalid-proof`, `unauthenticated`) and their HTTP
  401 mapping.
- PKCE S256 helpers and the frozen loopback redirect rules
  (`http://127.0.0.1:{49152–65535}/callback`) already present are now
  exercised end to end.

### Backend (`cloud/backend/`)

- New `SessionCoordinator` Durable Object (`SESSIONS` binding, migration tag
  `v2`): single-use short-lived enrollment codes (sha-256 hashed at rest),
  device sessions bound to account+enrollment+installation, opaque
  `anvil_at_`/`anvil_rt_` tokens stored as hashes only, refresh rotation with
  credential-generation fencing, reuse detection revoking the session, a
  bounded `pending_rotated_session` grace window so a lost refresh response
  replays the same rotated credentials, and revoke.
- Worker routes per the integration contract: `POST /v1/enroll`,
  `/v1/session/refresh`, `/v1/session/revoke`, `/v1/enrollment-codes` (device
  pairing for signed-in sessions; admin issuance gated by
  `ENROLLMENT_ADMIN_TOKEN`). Request bodies are bounded; `AccountCoordinator`
  trusts only worker-verified identity headers (`/internal/meta` exposes the
  dataset epoch for enroll responses). Revocation asks the account object to
  drop live sockets for the enrollment.
- OIDC/PKCE proof verification in `src/oidc.ts`: discovery doc fetch, token
  exchange, RS256 id_token signature check against issuer JWKS, `iss`/`aud`/
  `exp`/`nonce` validation, `code_verifier` passed to the token endpoint.
  Advertised only when `OIDC_ISSUER` + `OIDC_CLIENT_ID` are configured.
- Spike auth now fails closed on the deployable config: `ANVIL_DEV_SPIKE`
  lives only in `env.dev` (`wrangler dev --env dev`) and in the vitest pool's
  `miniflare.bindings`; the top-level env has no spike flag. A dev-only
  `ENROLLMENT_ADMIN_TOKEN` under `env.dev` lets fixtures mint codes without
  an OIDC issuer.

### Desktop

- `sync-auth.service.ts`: the loopback listener now delivers the OAuth
  `code`+`state` to the pending login instead of serving a dead success page;
  `createPkceLogin` returns a `waitForCallback` handle. Session persistence is
  backend-bound and encrypted; refresh is serialized and stale-write fenced.
- `sync-runtime.service.ts`: `signInWithOidc` (system browser via injected
  `openExternal`, issuer/clientId/scopes from the reviewed backend
  descriptor), `enrollWithEnrollmentCode`, `issueEnrollmentCode`,
  `signOutSync` (best-effort remote revoke), automatic refresh scheduling
  before access expiry plus a near-expiry refresh ahead of each sync cycle.
  `devSpikeEnabled` gates `spikeEnroll`; `index.ts` passes `!app.isPackaged`.
- IPC/preload/shared types expose only token-free snapshots and code results.
- Settings panel: browser sign-in button (when `oidc-pkce` advertised),
  enrollment-code redemption, pairing-code issuance, sign-out, dev-only spike
  section, plus the existing backend identity-review affordance.
- Engine fix: queued `runSyncCycle` callers now receive their own cycle's
  outcome — a predecessor's `superseded`/backoff error no longer propagates
  to a waiter, a displaced queue entry resolves as coalesced, and
  fire-and-forget kicks (`enableSync`, conflict resolution) catch rejections
  instead of producing unhandled rejections.

### Two-profile acceptance gate (Step 5 workflow subset)

`src/main/services/__tests__/sync-two-profile.acceptance.test.ts` drives two
isolated profiles — separate `userDataDir`, file-backed SQLite, encrypted
session store — against the real `wrangler dev` worker over real HTTP with
no injected RPC and no spike auth. Passing evidence:

- A enrolls with an admin-minted code, creates a workflow, pushes; A issues
  a real pairing code.
- B redeems the code onto the same account, scans/pulls, materializes A's
  workflow; B's update converges back to A after A's restart (SQLite closed
  and reopened, session rehydrated from disk, no re-enrollment).
- A's delete propagates to B. Duplicate code consumption is rejected by the
  worker. Sign-out revokes the session remotely.
- Skips cleanly (`describe.skipIf`) when no worker is reachable so the
  default suite stays hermetic. Run it with
  `ANVIL_BACKEND_URL=http://127.0.0.1:8787 pnpm vitest run src/main/services/__tests__/sync-two-profile.acceptance.test.ts`.

Remaining Step 5 items beyond the workflow subset: the wider
adoption/conflict UX sweep (the live-channel half landed next — see below).

### Live channel + bounded fallback polling (same session)

- `sync-backend-client.service.ts`: `BackendSocket` gains `onClose`/`onError`
  so callers can drive reconnects; frames remain size-bounded and
  schema-checked, bearer stays in the Authorization header.
- `sync-runtime.service.ts`: `connectLiveChannel` opens the socket after
  enable/init and re-auths it after every credential rotation;
  `sync.invalidate`/`gap` frames trigger fenced `requestSync`,
  `auth.expiring` triggers early refresh, close schedules a full-jitter
  `computeReconnectDelayMs` reconnect. The 5s poll is now the down-state
  fallback; a 60s safety net runs while the socket is live.
  `onSystemResume` (wired to `powerMonitor.on('resume')` in `index.ts`)
  reconnects + kicks catch-up after OS sleep. Status gains
  `connectionState: 'offline' | 'connecting' | 'live'`, surfaced in the
  settings panel.
- Tests: 4 live-channel cases (connect+hello, invalidate→sync, jittered
  reconnect, sign-out teardown) in `sync-runtime.service.test.ts` via an
  injected socket factory. Full desktop suite: 952 passed — includes a stale
  `SCHEMA_VERSION` assertion fix (68→69) missed by the repair wave's focused
  runs.

### Verification this wave

- Desktop sync-focused vitest: 102 tests, 9 files passed (acceptance file
  skipped when no backend env present).
- Acceptance gate vs `wrangler dev --env dev` on 127.0.0.1:8799: 2/2 passed.
- `pnpm --dir cloud/backend test`: 31 passed, 7 files (workerd pool).
- `pnpm --dir cloud/backend typecheck`: clean.
- `tsc -p cloud/tsconfig.json --noEmit`: clean.
- `tsc -p tsconfig.node.json --noEmit`: zero sync/cloud diagnostics.
- `npx eslint` on all touched files: clean.

## 2026-09-12 — Repair wave: review Steps 0–3 implemented (uncommitted)

Branch: `feature/sync-mesh--foundations`, HEAD `51ff4e1` plus the repair working tree.

Implements Steps 0–3 of `implementation-review-next-steps.md` as focused changes
preserving the existing architecture.

### Step 0 — contract/typecheck baseline

- `cloud/tsconfig.json` now compiles the portable contract only; Node-based
  contract tests moved under `tsconfig.node.json` coverage; JSON fixtures
  included correctly.
- `vitest.config.ts` includes `src/**` and `cloud/contract/**` tests; the
  workerd `cloud/backend` suite is excluded from the Node pool (it runs under
  `cloud/backend`'s own vitest config).
- Missing `SyncOperation` import fixed; all sync-specific desktop typecheck
  diagnostics eliminated. Remaining `tsconfig.node.json` errors are
  pre-existing on `main` in unrelated files (chat.ipc, codex-bridge,
  embedded-editor, telemetry, mobile-companion/agent-ui-intent/notification
  tests, mobile-home-summary fixture inclusion).

### Step 1 — durable mutation delivery

- Schema 69: `device_enrollments.next_sequence` allocator, `sync_installation`
  (stable installation identity), `sync_scan_runs` + `sync_scan_staging`
  (durable reset staging), `sync_backends.identity_review_required`.
- `nextBatch` replays outstanding dispatched rows verbatim (same changeId,
  enrollment sequence, operation, base revision, payload, payload_hash) across
  transport failure and process restart; pending rows are normalized and
  re-hashed at dispatch time; per-entity oversize is rejected locally instead
  of poisoning the batch; serialized-request bytes are budgeted.
- `recordLocalChange` keeps an in-flight dispatch immutable and records later
  edits as pending successors.
- `applyPushResults` advances binding base only forward, preserves successor
  payloads, records terminal rejection reasons, dedupes conflicts, and flags
  reset-required/receipt-expired for recovery.
- Dispatched rows orphaned under a different enrollment are fenced into
  reviewable conflicts (`enrollment-superseded`), never replayed.

### Step 2 — reset/scan semantics across the contract

- Contract: `SyncPushParams.epoch`, `SyncScanBeginResult.resumeCursor`,
  `SyncScanFinishResult.watermarkEnd/epoch/nextCursor`; finish params reduced
  to `{ scanId }`.
- Backend (`cloud/backend/src/account-coordinator.ts`): scan begin returns
  `resumeCursor` and epoch; finish rejects unfinished scans
  (`scan-incomplete`) and returns the server watermark + epoch.
- Engine: staged rebuild per spec §5 — scan pages land in `sync_scan_staging`
  (never visible state), catch-up applies changes in
  `(watermarkStart, watermarkEnd]` from `resumeCursor`, and
  `activateStagedScan` atomically adopts clean entities, preserves dirty local
  work (conflict), reconciles absent entities and remote/local ID collisions,
  clears quarantine state only on understood content, and only then advances
  the pull cursor to `finish.nextCursor`.
- Unknown entity types/schema versions/malformed payloads are quarantined on
  the binding with their revision instead of advancing or corrupting state.

### Step 3 — backend/account isolation

- `sync-auth.service.ts`: persisted sessions carry `backendId`; a
  `sessionEpoch` fence discards enrollment/refresh responses that land after
  sign-out or re-enrollment; refresh is serialized via `refreshInFlight`;
  `refresh-reuse-detected` wipes local session state.
- `sync-backend.service.ts`: re-pinning an existing deployment ID under a
  changed URL or auth issuer sets `identity_review_required` and pauses the
  association; `resolveBackendIdentityReview` clears it after explicit review.
- `sync-runtime.service.ts`: `runtimeGeneration` fence bumped on enroll,
  enable, sign-out, and backend disconnect; every engine cycle takes a guard
  checked before each durable write after an async boundary; `currentScope()`
  refuses sessions bound to a different backend; adoption skips entities bound
  in ANY scope (one hosted association per entity); conflict views/resolution
  are scoped to the active scope; installation id comes from
  `sync_installation`.
- IPC: `sync-backend:resolve-review` handler + preload
  `syncBackend.resolveReview` + `SyncRuntimeStatus.backendIdentityReviewRequired`.

### Failure-injection coverage added

`src/main/services/__tests__/sync-failure-injection.test.ts` (13 tests,
file-backed SQLite close/reopen): lost-acknowledgement replay with identical
changeId/sequence/hash, in-flight successor preservation, orphaned-dispatch
fencing, tampered-content receipt rejection, epoch-rotation reset flag,
interrupted scan leaving no partial state, staging discard on restart, scan
finish failure, catch-up failure before activation, mid-scan epoch rotation,
guard fencing before first write and mid-flight, two-scope isolation.

### Verification this wave

- `npx vitest run` over sync/engine/persistence/auth/runtime/backend-client/
  failure-injection + workflow + `cloud/contract` tests: 178 passed, 16 files.
- `pnpm --dir cloud/backend test`: 15 passed, 6 files (workerd pool).
- `tsc -p cloud/tsconfig.json --noEmit`: clean.
- `pnpm --dir cloud/backend typecheck`: clean.
- `tsc -p tsconfig.node.json --noEmit`: zero sync/cloud diagnostics; remaining
  diagnostics are the pre-existing unrelated set listed above.
- `npx eslint src/`: clean.

### Still open (per the review ordering)

- Step 4: replace spike authentication with real enrollment-code/PKCE flows
  end-to-end (contract + backend issue/consume, desktop OIDC callback
  delivery, refresh scheduling, spike isolated to dev fixtures).
- Step 5: socket invalidation + reconnect, adoption/conflict UX, two-profile
  Electron acceptance gate; run the desktop engine against the actual Worker.
- Steps 6–7: operational controls, remaining G1 entities, then Mesh packets.

## 2026-09-11 — Wave 1 complete, Wave 2 dispatched

Branch: `feature/sync-mesh--foundations` (base `main` @ `3ff60e2`).

### Commits this session / prior Wave 1

- `745c92e` docs: spec v2, integration contract, builder prompt
- `080b2ef` docs: execution handoff
- `420f928` PLAN-01 persistence/identity audit
- `3c42e71` PLAN-02 provider-neutral v1 contract (45 tests)
- `54ba1f4` SYNC-01 local bindings/outbox + transactional workflow template writes (schema 67)
- `6af4c93` align local `PendingChange` hash with `cloud/contract/sync.ts`

### Tests run

- `pnpm exec vitest run cloud` — 45 passed (PLAN-02)
- sync-persistence + schema + workflow — 76 passed (SYNC-01)
- `sync-contract-hash.test.ts` + persistence + contract sync — 33 passed (reconciliation)
- `pnpm exec tsc -p cloud/tsconfig.json --noEmit` — clean
- `tsc -p tsconfig.node.json` still has pre-existing errors on `main` in untouched files

### Wave 2 dispatched (not yet committed)

- BACKEND-01 AccountCoordinator spike → `cloud/backend/`
- AUTH-01 device session contract → `cloud/contract/auth.ts` + `sync-auth.service.ts`
- BYOB-01 generic client + schema 68 + Settings Sync & Mesh panel
- SESSION-01 provider portability audit doc

### Open risks

- Dual-edit on `cloud/contract/index.ts` (AUTH-01 export) vs untouched contract
- Hibernation evidence may be unmeasurable in local tests — must not be faked
- BYOB-01 SettingsView is ~2900 lines; keep the category addition minimal

## 2026-09-12 — Step 5 UX completion + OPS-01 retention/quota slice

Commits: `db20fa3` live channel, `f4192d6` save-copy + actionable states,
this OPS-01 slice.

### Step 5 UX completion

- `save-copy` conflict resolution end-to-end: remote takes the canonical
  entity; the local version is preserved under a fresh id, bound to the same
  scope and queued as a create so it syncs like any local workflow.
- Conflict compare: `SyncConflictView` carries local/remote payload JSON; the
  panel renders name/step/edge summaries plus an explicit-choice hint for
  edit-delete conflicts.
- Actionable status: `rejectedCount` (terminal outbox rejections),
  `recovering` (reset_required), `sessionExpired` (refresh credential
  rejected non-retryably or session wiped server-side; clears on enroll /
  refresh / sign-out) surfaced in `SyncRuntimeStatus` and the panel.

### OPS-01 slice: retention, quota, counters

- Account DO: one self-rescheduling alarm sweeps expired change-journal rows,
  receipts, and completed scans in bounded 500-row passes; deleting journal
  rows advances `retention_floor` to the highest deleted sequence, and
  `sync.pull` now rejects cursors below the floor with `reset-required`
  (previously a stale cursor silently got a partial journal).
- History-byte quota (64 MiB/account, `HISTORY_QUOTA_BYTES`) enforced before
  accepting each change: `rejected`/`quota-exceeded` consumes the sequence
  with a receipt; recovery history is never discarded.
- Aggregate counters (push per-status, bytes_accepted, pulls, scan_begins,
  sweep deletions) in a `counters` table; `/internal/meta` now returns
  `{ epoch, stats }` and `session.describe` merges it as `accountStats`
  (additive, optional — contract unchanged for older backends).
- Session DO: hourly alarm sweeps expired unconsumed enrollment codes,
  clears lapsed refresh-grace rows, and drops revoked sessions past 30d
  audit retention. `/internal/sweep` on both DOs is the ops-drill entrypoint
  (worker-internal only, never routed publicly).
- Desktop: `sweepLocalSyncRetention()` compacts acknowledged/rejected
  outbox rows and resolved conflicts past 90d on runtime init; mutable rows
  are never swept.

### Verification

- Backend: 37/37 (new `test/retention.test.ts`: quota reject+recover, sweep
  floor advance + stale-cursor reset, retention-window preservation,
  describe accountStats, code expiry, lapsed-grace cleanup).
- Desktop sync suite: 109/109 (+ local retention sweep test).
- Two-profile acceptance gate re-passed against live `wrangler dev --env dev`
  with quota/sweep/floor active.
- `tsc -p cloud/tsconfig.json` + backend typecheck: clean; node/web
  typechecks: zero sync diagnostics; eslint clean on touched files.

### Still open

- OPS-01 remainder: metering export/redacted diagnostics bundle, restore
  drill evidence, quota exceeded UX copy.
- ENTITY-01: workspace/agent/settings adapters — blocked on a product
  decision: "editable agents" do not exist as a domain entity today
  (personas are compiled-in constants with bundled prompt files).
- WS-01..03, MESH-01..03, SESSION-02/03, FLOW-01..03, PLACE-01, BYOB-02,
  IAC-01/02, LAUNCH-01.

### OPS-01 diagnostics export

- `exportSyncDiagnostics()` in the runtime produces a redacted bundle:
  generated-at, protocol/profile, schema version, installation id, runtime
  status, and per-scope rollups (bindings by entity type, outbox by state,
  open/resolved conflicts, pull cursor, consumed-sequence high-water,
  retention floor, reset flag, staged scan rows, last push/pull). Remote
  `session.describe` account stats merge best-effort; the bundle is complete
  when the backend is unreachable. Never contains payloads, file paths,
  tokens, or enrollment codes — verified by a redaction test.
- Wired end to end: `sync-runtime:diagnostics` IPC → preload →
  `syncRuntime.diagnostics()` → a "Copy diagnostics" button in the Sync
  panel that copies the JSON bundle to the clipboard.

Verification: 18/18 runtime tests (new diagnostics coverage), 618/618 main
suite, node+web typechecks zero sync diagnostics, eslint clean.

### OPS-01 quota UX + restore drill

- `quotaExceeded` flows from the engine snapshot (rejected outbox rows with
  reason `quota-exceeded`) through `SyncRuntimeStatus` to the panel, which
  now shows quota-specific copy instead of generic rejection text.
- Acceptance gate gains a wipe-and-restore drill: a fresh profile (new
  userDataDir + SQLite, no cursors) redeems a pairing code issued via the
  production `issueEnrollmentCode` path and materializes the full account
  dataset in one cycle — restore evidence against the real worker.

Verification: 3/3 acceptance tests on live worker; 41/41 engine+runtime+
failure-injection tests; typechecks and eslint clean.

### ENTITY-01 + WS-01 + MESH-01 + IAC-01 wave

- Schema 70: `editable_agents`, `workspace_repo_definitions`, and
  `workspaces.definition_state` (`ready`/`needs-setup`) — added in both
  `SCHEMA_SQL` and `MIGRATIONS` without rewriting history.
- New domain codec boundary `sync-entity-domain.ts` generalizes the
  workflow-template path across all `SYNC_ENTITY_TYPES`
  (`workflow-template`, `editable-agent`, `workspace-definition`,
  `settings`): serialize (canonical JSON), validate, remote projection,
  delete, save-copy, local-id listing. Engine + scan/activation route all
  entities through it; malformed/unsupported payloads quarantine on the
  binding instead of corrupting domain state.
- `editable-agent.service.ts` is a real synced domain entity (SQLite CRUD
  via `withSyncedEntityWrite`). `persona-catalog.ts` extracts the built-in
  catalog into a data-only leaf so `persona.service` (built-ins +
  editable agents, inline `renderPromptTemplate` for agents) stays
  cycle-free of the sync codec layer.
- Workspace definitions sync `{ id, name, repos[], preferences }` with
  stable `portable_id` per repo and device-local `mapped_repo_id`.
  `materializeRepoDefinitions` runs on bind and every membership mutation;
  `recomputeWorkspaceDefinitionState` flips `needs-setup` on unresolved
  persona/workflow refs or unmapped repos. Preference serialization uses
  a per-field allowlist — `workItemConnectionId`, provider page refs, and
  launch provenance never leave the device — and remote apply merges
  portable fields over local-only keys instead of replacing sections.
- Settings sync is a singleton (`SYNC_SETTINGS_ENTITY_ID`) with a closed
  column allowlist; `updateSettings` emits intent only when an allowlisted
  key changed.
- `bindLocalEntities`/`previewAdoption` generalize over all entity types;
  an entity bound in any other scope is skipped (never silently re-homed).
- IPC surface: `agents.ipc.ts`, preload bridge, `ipc-api.d.ts`. UI:
  `EditableAgentsPanel` in settings, `· needs setup` marker in the
  workspace menu, conflict summaries that describe all four payload
  shapes.
- WS-01 seam: `mapWorkspaceRepo` IPC maps a portable repo entry to a local
  checkout and recomputes setup state.
- Engine queue fix: a displaced `requestSync` waiter now rides forward
  into the replacement cycle's settle list instead of resolving early —
  previously an awaited requestSync could return while the in-flight pull
  was still running (surfaced as a flaky restore-drill assertion under
  parallel test load). Regression test added.
- MESH-01 backend (parallel workstream): worker lifecycle in
  `cloud/backend` — `device.policy.publish`, `worker.connect/describe/
  capabilities.publish/replica.publish`, policy gating, revocation,
  incarnation + lease management, availability socket fan-out, worker/
  replica persistence, retention sweep, ops counters. Contract types in
  `cloud/contract/workers.ts`.
- IAC-01 (parallel workstream): `anvil-cloud/packages/cloudflare` mesh
  recipe (plan/apply/remove/connection) + `anvil-cloud mesh` CLI commands;
  provider-gated, no live calls in tests.

Verification: 22/22 entity-domain tests, 17/17 engine tests, 152 files /
990 tests full suite, 45/45 backend tests, 46/46 contract tests,
3/3 two-profile acceptance tests against the live `wrangler dev` worker
(all four entity types flowing), eslint clean, node typecheck clean for
all touched files.

### MESH-02 — job/attempt lifecycle + desktop worker runtime

Backend (parallel workstream), contract types in
`cloud/contract/jobs.ts`:

- `jobs`/`attempts` tables: idempotent create on
  `(source_enrollment_id, request_id)` + `payload_hash` (mismatch →
  `conflict`); `next_fence` monotonic claim fence; `retried` bounds the
  one `safe`-retry re-queue; jobs never emit entity changes.
- `job.create` resolves placement eagerly for `device` targets
  (same-account non-revoked worker + allowing policy + live incarnation,
  else the create is rejected — never silently retargeted); `auto` picks
  the least-loaded eligible worker deterministically or stays queued with
  a persisted `placementExplanation`.
- `job.claim` is one transaction: live incarnation, lazy deadline expiry
  (queued past deadline → `failed`), queued/target match,
  `policyAllowsSource`, capacity `min(policy, capabilities, 64)`,
  no duplicate active attempt — then allocates the fence, inserts a
  `claimed` attempt, job → `running`.
- `attempt.renew` batches per-item results (rejections never fail the
  batch); `attempt.report` requires fence+incarnation match, masks
  `completed` → `cancelled` when the job is `cancel-requested`, retains
  stale/terminal reports in `late_result`. `job.cancel` is idempotent:
  queued → `cancelled`, running → `cancel-requested` + attempt `stopping`.
- Sweeps: queued jobs past deadline expire lazily on every job op and on
  the alarm; attempts one lease past expiry age to `unknown-outcome` —
  never reassigned. `job.available` socket frames go only to the resolved
  target enrollment. Ops counters for all of it.

Desktop (`src/`):

- Schema 71: `mesh_worker_state` (opt-in, incarnation, lease, last error)
  + `mesh_attempts` local journal (state, manifest, journal events,
  cancel flag, result).
- `mesh-worker.service.ts`: device-local opt-in publishes an allowing
  `device.policy` (backend stays fail-closed without it), connects a
  leased incarnation, publishes capabilities (`diagnostic` only), emits
  replica metadata (ids/revision/readiness — never paths/config), claims
  `job.available` frames, journals BEFORE work (crash-reconstructable),
  renews attempt leases on the 30s heartbeat, detects cancellation via
  `job.get` on heartbeat (no cancel frame in v1), reports fenced
  outcomes, and sweeps `job.list?state=queued` on connect — the durable
  recovery path for frames missed during socket downtime.
- Fail-closed edges: disable fences in-flight attempts to
  `unknown-outcome`; a fresh incarnation marks surviving active attempts
  stale; boot reconcile does the same for crash survivors;
  `late-result-retained` reports mark local rows `unknown-outcome`.
- The service never imports `sync-runtime` — the runtime injects
  `{apiUrl, token, enrollmentId}` via `configureMeshWorkerContext` and
  drives `meshWorkerOnSyncReady`/`meshWorkerOnSyncGone` on enable/hello/
  sign-out/backend-change.
- Source side: `createDiagnosticJob` (idempotent, sha-256 payload hash),
  `getMeshJob`, `cancelMeshJob` — account ops any enrolled device may
  call; richer kinds land with SESSION-02+.
- IPC/preload/shared: `sync-runtime:mesh-worker-set`,
  `SyncRuntimeStatus.meshWorker`. Settings panel gains the opt-in toggle
  (aria-pressed convention) with fail-closed copy.

Verification: 15/15 new backend job tests (60/60 total), 11/11 mesh-worker
service tests, **4/4 acceptance gate including a live end-to-end
diagnostic run** — A creates the job, C's durable sweep claims/journals/
runs/reports, A reads `completed`. Full app suite green; tsc clean on
`cloud/` and touched files; eslint clean.

## MESH-03 desktop — live observation + artifact client (d9565ee)

- `mesh-worker.service.ts`: `sendFrame` in the injected context; bounded
  per-attempt `activity` frames (`attempt:<id>` stream, monotonic
  sequence, fence as generation) emitted as best-effort status events —
  send failures are swallowed, the durable journal stays authoritative.
- `mesh-observe.service.ts`: `observeAttempt(attemptId, listener)` —
  multiplexed socket subscriptions (shared per scope), 60s interest
  renewal under the 90s server expiry, bounded 200-item replay buffer
  for late listeners, `gap` frames mark explicit holes and trigger
  `event.pull` durable replay; unretained sequences stay marked so the
  UI shows a hole rather than fabricating output. Resubscribes on
  socket hello; tears down on sign-out/backend change. No sync-runtime
  import — same injected-context pattern as the worker.
- `mesh-artifact.service.ts`: `uploadAttemptArtifact` (reserve →
  byte PUT to `uploadPath` with bearer → finalize), `listMeshArtifacts`,
  `getMeshArtifact`, `downloadMeshArtifact` (sha256 verified,
  published-only), `deleteMeshArtifact`.
- Runtime: routes `activity`/`gap` frames to the observer (mesh gaps no
  longer kick `requestSync`), calls `meshObserverOnLive` on hello,
  `meshObserverOnGone` on gone, injects artifact context.

Verification: 26/26 mesh service tests (13 worker, 7 artifact,
6 observe), 22/22 runtime + acceptance tests.
## WS-03 tail — approval IPC, recovery, panel; WS-02 UI; SESSION-01 env fix; MESH-03 backend + E2E (ac9eb63, 07d4086, 2dc2432, 6ee7ca6, 7d6c412, 1b98f2d)

- `bootstrap-policy.service.ts`: `workspaceCheckoutRoot` (first mapped
  repo's local path — per-repo working dirs are a contract extension),
  `resolveWorkspaceCommits` (real HEAD pins via `rev-parse`), and
  `recoverBootstrapRuns` wired into `index.ts` boot alongside WS-02
  materialisation recovery — interrupted runs re-verify postconditions
  only; unproven → `unknown-outcome`, never replayed.
- IPC surface: `workspace:bootstrap-status|approve|run|approvals|
  revoke-approval` + preload + `WorkspaceBootstrapStatus` wire types.
  `bootstrap-approve` pins the digest (recipe+commits+policy) and starts
  the run atomically; parked `awaiting-approval` rows stay as journal
  history.
- `WorkspaceBootstrapPanel` (workspace menu → Bootstrap…): recipe
  explanation, shell-consent checkbox when the recipe uses shell, live
  run/step state polling, run history.
- `WorkspaceSetupPanel` (workspace menu → Set up checkouts… when
  `definitionState === 'needs-setup'`): per-repo link-existing-checkout
  or clone-all-into-root, latest materialisation op stages rendered from
  the journal. The needs-setup marker now has a resolution path.
- SESSION-01: `agent-spawn-env.ts` `providerSpawnEnv()` allowlist applied
  to all provider CLI spawns (codex app-server, cursor-agent acp, codex
  exec) — ambient tokens (GH_TOKEN/AWS_*/ANVIL_*) dropped; provider
  credential vars, proxies, CODEX_HOME/XDG, and git transport kept as
  target-local bindings. Audit doc §9 remediation log added.
- MESH-03 backend (subagent): durable event journal with dual cursors;
  `event.pull` authoritative replay with `hasGap`; activity ingest gated
  by worker ownership + live incarnation + fence + terminal check with
  reserved-stream protection and per-account burst throttling; durable
  approvals bound to attempt+digest+generation with expiry, idempotent
  decide, self-decide prohibition, cancel-on-cancel; artifacts
  reserve→streamed PUT→finalize (sha256+length verified)→private GET
  with account quotas and orphan sweep; subscribe/unsubscribe with
  replay-on-subscribe and 90s expiry.
- Worker evidence: `runAttempt` uploads the diagnostic result as an R2
  artifact while the attempt is active, journaled best-effort.
- Acceptance gate +1: `replays attempt events and round-trips an R2
  artifact` — durable event replay via `event.pull` on the source
  profile + byte-exact artifact round-trip against the live worker.

Verification: backend 85/85 (25 new MESH-03 tests), app suite
161 files / 1078 tests, 5/5 acceptance tests on the live worker,
tsc + eslint clean on touched files.

Remaining for launch: `device.list|rename|revoke`, `account.delete*`,
`data.export|import.*`, `handoff.*` backend ops; SESSION-02 remote
prepare/start (attempt journal before spawn, creation key, timeout
orphan kill, CLI pin per audit §9); FLOW-01/02/03, PLACE-01, BYOB-02,
IAC-02, LAUNCH-01.
## SESSION-02 slice — remote prepare-workspace + remote approval gate (1cf3116, 7eebf7e)

- `prepare-workspace` executor on the worker: converges on the pinned
  `workspaceDefinitionRevision` (stale replicas refuse), verifies each
  mapped checkout's HEAD against the manifest pin per-repo (never mutates
  user checkouts), and journals clone-at-commit for unmapped definitions
  into `<userDataDir>/mesh-checkouts/<workspaceId>` via WS-02
  `startWorkspaceClone` — worker-managed paths only, no arbitrary source
  paths.
- Bootstrap gate: recomputes the WS-03 digest (recipe + manifest commits
  + `buildDevicePolicy()`) and refuses on mismatch. Local exact-digest
  approval short-circuits; shell recipes ALWAYS require the local shell
  pin (`shell-recipe-requires-local-approval`) — remote approval never
  satisfies shell consent per spec §10.
- Remote approval: worker sends `{request:'approval', actionDigest}` on
  the reserved `control` stream, then polls `approval.get` (the approval
  ROW is the decision authority — job state alone can't distinguish
  "request landed + granted" from "request never arrived"). Decided rows
  resolve approved/denied/expired; the job-state read only detects
  cancellation. Fail-closed everywhere: dead socket → throw, dropped
  request → TTL-cap denied, unreachable backend → denied.
- Source side: `createPrepareWorkspaceJob` pins revision + resolved
  HEADs + bootstrap digest (refuses unmapped defs — source can only
  commit to what it proves), `inspect-before-retry` policy, device or
  auto targeting; `listMeshApprovals`/`decideMeshApproval` wrap
  `approval.get`/`approval.decide`.
- Backend tail: `artifact.deleted` events journal under the attempt
  fence instead of generation 0.

Verification: worker suite 20/20 (5 new approval-wait failure-injection
tests: control-frame shape, grant, denial, job-cancelled-while-pending,
dropped-request fail-closed, dead-socket reject; 2 manifest-pin tests
with a real git fixture), app suite 161 files / 1085 tests, backend
85/85, tsc + eslint clean.

Remaining: `start-session` typed job, SESSION-03 handoff,
`device.list|rename|revoke`, `account.delete*`, `data.export|import.*`,
`handoff.*`, FLOW-01/02/03, PLACE-01, BYOB-02, IAC-02, LAUNCH-01.
## SESSION-02 tail — live-channel handshake + remote approval E2E (2e044a4, e626647)

The remote-approval acceptance test exposed a chain of three real
production bugs, each fixed at its root:

- Backend never emitted the contract `hello` frame: `acceptClient`
  accepted the socket and stopped, so the desktop sat in 'connecting'
  and the control channel could never open. `acceptClient` now sends
  hello (enrollment identity, worker incarnation when live, negotiated
  profiles) immediately after attachment serialization. (2e044a4)
- Superseded sockets stranded 'connecting': a runtime generation bump
  while a socket was mid-handshake (e.g. enableSync following
  initSyncRuntime's auto-connect) fenced out its hello, and
  connectLiveChannel's `liveSocket !== null` early-return prevented
  redial — permanently. connectLiveChannel now records the dialing
  generation and retires superseded sockets. (e626647)
- `connectWorker` raced concurrent callers on a boolean guard: the
  awaited caller returned before the in-flight connect finished,
  observing a half-connected state (`worker.connected === false`). The
  guard is now the in-flight promise; callers coalesce. (e626647)

Also fixed a convergence bug the E2E forced to the surface: definition
revision pins used `workspaces.updated_at`, a LOCAL clock re-stamped on
remote apply, so a manifest pinned on one device could never match its
replica on another. The pin is now sha256 over the canonical definition
payload (`workspaceDefinitionRevision`) — identical on every converged
replica — and replica publishing reports the same digest.

The approval wait journals send/poll retries once per distinct failure
reason (bounded observability; this is what surfaced the dead-socket
loop above).

Acceptance gate now 7/7 on the live backend, including both new
SESSION-02 cases: remote `prepare-workspace` on a mapped worker with a
pinned manifest + pre-approved digest (completed), and the remote
approval path — worker request registers durably, source denies via
`approval.decide`, job+attempt fail. Backend 86/86 (hello coverage +
nextFrameOfType helper), app suite 161 files / 1088 tests.

Remaining: `start-session` typed job + attempt journal before provider
spawn, creation key/idempotency, timeout orphan kill, CLI pin per audit
§9; then `device.list|rename|revoke`, `account.delete*`,
`data.export|import.*`, `handoff.*`, FLOW-01/02/03, PLACE-01, BYOB-02,
IAC-02, LAUNCH-01.
## SESSION-02 — remote start-session (b922a57)

`start-session` is now a typed mesh job end to end:

- `mesh-session.service.ts` — the provider-neutral session driver:
  `codex app-server` over line-delimited JSON-RPC (stdin/stdout), with
  CLI probing, minimum-version enforcement, thread start/resume, a
  bounded turn with cancellation polling, timeout that kills the whole
  process group, and codex-internal approval requests auto-declined
  (mesh approvals gate the job, not the provider's prompts). Spawn is
  injectable for tests.
- `executeStartSession` — resolves each pinned repository to a verified
  local checkout (mapped checkouts verified, never mutated; unmapped
  ones resolved from the managed root BY commit, failing
  `workspace-not-prepared` until `prepare-workspace` has run), computes
  cwd via `commonParentDir`, journals `provider-spawn` BEFORE spawning
  (a crash in between is the durable orphan evidence), refuses a second
  spawn when a prior attempt journaled spawn-without-thread
  (`prior-spawn-unresolved` — spec §9 inspect-before-retry), resumes the
  journaled `provider-thread` handle otherwise, and reports
  providerThreadId/turnId/cliVersion in the attempt result.
- `createStartSessionJob` — pins workspaceDefinitionRevision (content
  digest), exact HEAD commits, provider/model/reasoning/sandbox,
  cliMinVersion, and turnTimeoutMs under the job's immutable
  requestId + payloadHash with `inspect-before-retry`.

Coverage: 9 focused driver tests against a fake app-server on
PassThrough streams (thread start/resume, turn, timeout → process-group
kill, cancel, CLI pin rejection) + 6 worker tests (spawn journal
ordering, orphan refusal, thread resume, CLI pin violation,
workspace-not-prepared, manifest pinning). Worker suite 27/27, app
suite 162 files / 1103 tests, acceptance gate 7/7 on the live backend,
backend 86/86, tsc + eslint clean.

Remaining: `device.list|rename|revoke`, `account.delete*`,
`data.export|import.*`, `handoff.*`, FLOW-01/02/03, PLACE-01, BYOB-02,
IAC-02, LAUNCH-01.

## SESSION-03 — exact Git checkpoint + ownership handoff (landed)

Spec §11: single-writer session ownership moves between devices through a
generation-fenced, checkpoint-bearing handoff. No dual activation across
crash cases.

Backend (`handoff.create|get|advance|cancel`, mesh/1):

- `mesh_sessions` tracks the authoritative session row (generation +
  owner enrollment + checkpoint lineage); `handoffs` is the durable
  handoff record with a unique index enforcing ≤1 non-terminal handoff
  per session.
- `handoff.create` is idempotent on handoffId, conflicts on differing
  session/source/target/generation, and binds the session's current
  generation + owner on first write.
- `handoff.advance` walks the strict transition graph; the
  `source-relinquished-and-checkpointed` step requires a schema-valid
  `SessionCheckpoint` with exact repository commit pins;
  `ownership-transferred` performs a generation CAS
  (`stale-generation` on mismatch) and mints targetGeneration = source+1.
  Source enrollment authorizes pre-transfer steps; target authorizes
  post-transfer steps.
- `handoff.cancel` records `cancelledFrom` so post-transfer cancels
  stay distinct from pre-transfer rollbacks. 12/12 focused tests
  (idempotent create, conflicting reuse, authz per side, stale
  generation, checkpoint validation, single-active invariant,
  pre/post-transfer cancel, terminal-state rejection).

Desktop:

- `mesh-ownership.service.ts` — leaf module owning the
  `mesh_session_ownership` mirror (schema 74). `assertSessionTurnAllowed`
  fails closed when the session is locally relinquished;
  `codex-session.service.sendMessage` consults it so a relinquished
  session refuses new turns even while the provider process is alive.
- `mesh-handoff.service.ts` — source orchestrator:
  `evaluateHandoffReadiness` blocks on dirty trees, untracked inputs,
  unpushed commits, and unsupported checkouts (submodules/LFS/shallow
  via `detectUnsupportedCheckout`) with remediation text, all BEFORE
  any backend call. `initiateHandoff` journals each transition to
  `mesh_handoff_journal` durably before the RPC, mirrors the local
  relinquish at `source-relinquished-and-checkpointed`, and on
  pre-transfer failure cancels the backend record AND restores local
  ownership (fresh generation on resume per spec). `captureSessionCheckpoint`
  pins exact HEADs + a bounded message tail + provider/model/summary.
  `reconcileHandoffsOnBoot` resolves interrupted handoffs: a
  pre-transfer cancel restores ownership; post-transfer states keep the
  relinquish (target owns recovery).
- Target side lives in `executeStartSession`: when inputs carry a
  `handoffId` the worker fetches the record, verifies it targets this
  enrollment and sits at `ownership-transferred` (else
  `handoff-not-transferred`), advances to `target-activating`, renders
  a summary-continuation prompt from the checkpoint, runs the provider
  turn, then advances to `completed` (or `failed` — target keeps
  ownership for recovery) and writes the local ownership mirror at
  targetGeneration.

Coverage: 10 handoff-service tests (gate semantics, readiness
blockers with remediation, full create→transfer drive with durable
markers, pre-transfer failure rollback, boot reconciliation both ways,
exact-commit checkpoint capture) + 3 worker tests (activation
happy-path incl. journal ordering + ownership write, not-transferred
refusal without spawn, failed-turn → handoff.failed). App suite
162 files / 1109 tests, backend 98/98, acceptance gate 7/7, tsc +
eslint clean.

Remaining: `device.list|rename|revoke`, `account.delete*`,
`data.export|import.*`, FLOW-01/02/03, PLACE-01, BYOB-02, IAC-02,
LAUNCH-01.

## FLOW-01 — per-attempt local worktrees + result manifests (landed)

Spec §451-455: write-capable execution is attempt-scoped, not run-scoped.

- New `code-task` job kind (contract JobKind + backend JOB_KINDS) — one
  write-capable provider turn inside per-attempt worktrees.
- `mesh-worktree.service.ts`: `allocateAttemptWorktrees` creates
  `mesh/attempt/<attemptId>` branches via `git worktree add -b` at the
  pinned commit, serialized per source checkout (ref-mutation lane —
  spec §451). No `-B` resets, no forced removal; a name collision fails
  the attempt rather than destroying a ref. `finalizeAttemptWorktrees`
  commits residual changes onto the attempt branch (work is never lost)
  and captures base→result pins. `disposeAttemptWorktrees` is the
  explicit-disposal path (non-forced remove + `branch -d`).
- `executeCodeTask`: resolves pinned checkouts (verified, never
  mutated), allocates attempt trees under
  `userDataDir/mesh-worktrees/<attemptId>/`, reuses the prior-spawn
  inspect-before-retry gate + CLI pin, runs the provider turn with cwd
  inside the attempt trees, finalizes commits, runs manifest-declared
  verification commands per worktree under the restricted `meshExecEnv`
  (no provider/git credentials — remote-authored text), and returns an
  `AttemptResultManifest` (base/result commits, verification outcomes,
  provenance). Failed turns journal `worktrees-preserved` with paths —
  the trees stay as inspectable evidence.
- `meshExecEnv` added to agent-spawn-env: ambient+proxy vars only.
- `refPolicy` input: only `local-branches` supported — remote refs
  require explicit policy (§455), anything else fails closed.
- `createCodeTaskJob` pins revision/commits/digest/model/verification
  under `inspect-before-retry`.

Coverage: 9 worktree-service tests (allocation at pinned commit,
attempt isolation, concurrent-allocation ref serialization, branch
collision refusal, residual commit + ref-namespace inspectability,
explicit disposal, verification honesty incl. timeout) + 5 worker tests
(manifest in result_json + journal ordering, verification verbatim,
failure preserves trees + source untouched, ref-policy rejection,
creator pinning). App suite 163 files / 1123 tests, backend 98/98,
gate 7/7, tsc + eslint clean.

Remaining: `device.list|rename|revoke`, `account.delete*`,
`data.export|import.*`, FLOW-02/03, PLACE-01, BYOB-02, IAC-02,
LAUNCH-01.

## FLOW-02 — remote nodes + result transfer (landed)

Spec §449/§455: workflow nodes dispatch to remote workers as durable
jobs; results transfer back through Git refs, not text.

- `workflow-node` executor = code-task flow + `resultTransfer:
  'bundle-artifacts'`. After finalize, each CHANGED repo's attempt
  branch is packed as a thin bundle rooted on the pinned base (the
  parent provably holds it — it pinned it) and published as an
  `application/vnd.git-bundle` R2 artifact listed in the result
  manifest. Unchanged repos transfer nothing (empty ranges don't
  bundle).
- Parent side (`mesh-dispatch.service.ts`, schema 75
  `mesh_node_dispatches`): dispatch persists BEFORE job.create with a
  stable `node-dispatch/<dispatchId>` requestId — backend idempotency
  re-binds restarts instead of duplicating work. `refreshDispatch`
  mirrors job state and, on terminal completion, downloads each
  `bundle:<repo>` artifact and `git fetch`es it into the mapped local
  checkout as `refs/mesh/result/<dispatchId>/<repo>` — the user's
  working tree is never touched. `cancelNodeDispatch` persists intent
  then propagates `job.cancel` (a missing ack is not treated as
  cancelled). `reconcileDispatchesOnBoot` re-adopts persisted jobs.
- `ExecutionAttempt.result` added to the wire (additive) so `job.get`
  carries the attempt's result manifest — no separate fetch for
  metadata.

Coverage: 5 dispatch tests (stable requestId pinning, idempotent
re-dispatch, real thin-bundle fetch into the parent repo producing the
result ref with a clean working tree, cancel intent+propagation, boot
re-adoption with no recreation) + 1 worker test (workflow-node
publishes bundle artifacts). App suite 165 files / 1136 tests, backend
98/98, gate 7/7, tsc + eslint clean.

Remaining: `device.list|rename|revoke`, `account.delete*`,
`data.export|import.*`, FLOW-03, PLACE-01, BYOB-02, IAC-02, LAUNCH-01.

## FLOW-03 — fan-out integration + verification (desktop, complete)

- `mesh-integration.service.ts`: `integrateResults` reads each
  dispatch's adopted result refs and merges them — in declared
  dependency order — into a dedicated `mesh/integrate/<id>` worktree
  per repo, allocated at the manifest's pinned base. Divergent base
  pins across dispatches are a loud `base-diverged` failure, not a
  guessed merge.
- Overlapping edits surface as a visible conflict record (conflicted
  files listed via `diff --diff-filter=U`, merge aborted, dependency
  chain for that repo stops). The integration ref records only clean
  merges; adopted result refs and integration branches are preserved
  for explicit disposal — nothing force-deletes.
- Declared verification commands run against the integrated worktree
  before the result is proposed; a nonzero exit marks the run
  `failed` — the merge survives for inspection but is never applied
  to the user's checkout.
- Durable `mesh_integrations` rows (schema 76) make re-entry
  idempotent: a restart or retry returns the persisted result instead
  of re-allocating `mesh/integrate/<id>` refs.

Coverage: 6 tests (ordered clean merge + verification, visible
conflict with preserved refs, verification-failure → `failed`,
base-diverged refusal, missing-dispatch refusal, restart re-bind).
App suite 166 files / 1142 tests, gate 7/7, tsc + eslint clean.

Remaining: `device.list|rename|revoke`, `account.delete*`,
`data.export|import.*`, PLACE-01, BYOB-02, IAC-02, LAUNCH-01.

## PLACE-01 — workspace-readiness placement constraint (complete)

- `resolvePlacement` (auto) now enforces the §12 hard constraint:
  workspace-consuming kinds (start-session, code-task, workflow-node)
  require a `worker_replicas` row with `readiness='ready'` AND
  `definition_revision` equal to the manifest's pinned revision —
  the content digest that also proves Git inputs materialised.
  `prepare-workspace` produces readiness and `diagnostic` needs
  none, so neither is gated. Explicit `device` targets remain an
  override, consistent with capabilities not being checked there.
- No-eligible explanations now name readiness as the discriminator
  (`N rejected on readiness`).
- Source side: all five job creators accept `requirements`
  (CapabilityRequirements) and forward them into
  `requestedTarget: {kind:'auto', requirements}` —
  `dispatchWorkflowNode` passes them through too.
- `executePrepareWorkspace` republishes replicas on success so a
  freshly materialised workspace becomes placement-visible without
  waiting for the next connect.

Coverage: 5 backend placement tests (unresolved without ready
replica + readiness-named explanation, ready-at-pinned-revision
resolves, stale revision rejected, prepare-workspace/diagnostic
exempt, explicit device overrides) + 1 dispatch test (requirements
reach job.create). Backend 103/103, app 166 files / 1143 tests,
gate 7/7, tsc + eslint clean.

Remaining: `device.list|rename|revoke`, `account.delete*`,
`data.export|import.*`, BYOB-02, IAC-02, LAUNCH-01.
