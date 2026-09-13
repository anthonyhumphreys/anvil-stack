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
