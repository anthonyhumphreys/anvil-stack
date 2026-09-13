# Sync & Mesh execution log

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
