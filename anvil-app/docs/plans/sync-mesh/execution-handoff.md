# Sync & Mesh execution handoff

Operating plan for the agent continuing this work. Written 11 Sep 2026 09:45 UTC+1 on branch `feature/sync-mesh--foundations` (base `main` @ `3ff60e2`). Read this file, then `anvil-sync-mesh-spec-v2.md`, then `anvil-backend-integration-contract.md`. The spec is authoritative; this file only tells you where execution stands and what to do next.

## 0. Ground rules for the continuing agent

- Work stays on `feature/sync-mesh--foundations`. Do not rebase or force-push. Conventional Commits, one commit per packet, no AI attribution trailers.
- Run `pnpm install` inside `anvil-app/` (never repo root) if `node_modules` is missing.
- Conventions from `anvil-app/AGENTS.md`: semicolons, single quotes, trailing commas, printWidth 100; business logic in `src/main/services/`; IPC files validate+delegate; extend `src/shared/ipc-api.d.ts` → `src/main/ipc/*.ipc.ts` → `src/preload/index.ts` → renderer when exposing anything. Imports at top of file only. Exhaustive `switch` with a `never` default on unions.
- Schema changes: bump `SCHEMA_VERSION`, add a new entry to `MIGRATIONS` in `src/main/db/schema.ts`. Never edit historical migrations.
- Use subagents for disjoint packets, one implementer per packet, each with an explicit allowed-files list. Shared files (`schema.ts`, `vitest.config.ts`, preload, IPC declarations, startup wiring) have exactly one owner per wave. You (the coordinator) integrate, run checks, and commit.
- Scratch files go in `/tmp`, never in the repo.
- Commits are plain `git commit -m` with Conventional Commits and no AI attribution trailers. Never use `git commit -a`; unrelated in-progress files may be in the working tree.
- Verification per packet: focused vitest files → `pnpm exec tsc --noEmit` on the relevant tsconfig → `pnpm exec eslint <changed files>`. Run full `pnpm test` only before a PR.

## 1. State at handoff

Committed on the branch:

- `2108023 docs(sync-mesh): add Sync & Mesh spec v2, backend integration contract, and builder prompt`
- `317272f docs(sync-mesh): add execution handoff plan for continuing agent`
- `bebb146 docs(sync-mesh): PLAN-01 persistence and identity audit` — **PLAN-01 is complete and committed.** Key findings that constrain later packets: workspace and workflow-template IDs are already random UUIDs (keep them); `repos.id` is a SHA-256 prefix of the absolute path (machine-specific — map portable repo IDs onto it, never replace the FK); personas are a hardcoded slug catalog with no table or write path, so ENTITY-01 must introduce an editable-agent store before "editable agent definitions" can sync; `codex_mode` is local execution policy and must be excluded from the settings allowlist; `createWorkspace`/`deleteWorkspace`/membership already use `db.transaction()`, while template save/delete and `startWorkflowRun` do not.
- `3c42e71 feat(sync-mesh): PLAN-02 provider-neutral v1 protocol contract and fixtures` — **PLAN-02 is complete and committed** (45 tests, strict typecheck clean via `cloud/tsconfig.json`). Ambiguity resolutions are logged in `anvil-app/cloud/contract/README.md`: `quota-exceeded`→413, `unsupported-*`→400, `SyncCursor` is a branded string, direct `cancelled` allowed only from non-running states. - `54ba1f4 feat(sync): SYNC-01 local sync bindings, outbox, and transactional workflow template writes` — **SYNC-01 is complete and committed** (schema v67; 25 new tests, 76/76 across sync/schema/workflow suites; eslint clean). Decisions taken: `dataset_epoch` is opaque TEXT; `sync_state.reset_required` INTEGER flag for reset/receipt-expired; dispatch skips entities with a `dispatched` row or an unresolved `sync_conflicts` row; `enrollment_id` is `''` until `nextBatch` assigns the dispatching enrollment; conflict `kind` inferred from op/remote payload; ordering `created_at, rowid`. `sync-persistence.service.ts` is ~880 lines — split an outbox module out in a later packet if it grows further.

**Wave 1 is fully landed.** Known pre-existing `tsc -p tsconfig.node.json` errors exist on `main` in untouched files (`chat.ipc`, `codex-bridge`, `embedded-editor`, `telemetry`, mobile-companion/agent-ui-intent tests); they are not from this branch — judge typecheck by "no errors in touched files" until main is fixed.

- `6af4c93 refactor(sync): align local PendingChange and hash with cloud contract` — **§3 reconciliation is complete.** `src/shared/sync-mesh.ts` re-exports `PendingChange`, `SyncOperation`, `canonicalChangeHashInput`, `canonicalizeJson`, and `hashChange` from `cloud/contract/sync.ts`. `computePayloadHash` / `canonicalJson` in `sync-persistence.service.ts` delegate to those. `tsconfig.node.json` includes `cloud/contract/**`. Alignment tests live in `src/main/services/__tests__/sync-contract-hash.test.ts`.

**Wave 2 has landed.** Committed packets:

- `e13085d docs(sync-mesh): SESSION-01 provider portability audit`
- `f506621 feat(sync-mesh): AUTH-01 device enrollment and session contract`
- `c9b1318 docs(sync-mesh): require grok 4.6 for all subagents` — Cursor-era instruction; superseded, no code effect.
- `dfbfc49 feat(sync-mesh): BYOB-01 generic backend discovery and connection`
- `7e6c49b chore(sync-mesh): keep contract typecheck independent of the backend spike`
- `64ae257 feat(sync): SYNC-03 local serialized push/pull engine`
- `27bf010 feat(sync-mesh): BACKEND-01 AccountCoordinator push/pull spike`
- `4a9c590 test(sync): expect SCHEMA_VERSION 68 after backend association table`
- `39cca48 feat(sync-mesh): SYNC-02 account-object scan begin/page/finish`
- `51ff4e1 test(sync): round-trip workflow templates through a BACKEND-01-shaped fake`

**Uncommitted SYNC-03 runtime work** (keep; do not restart): `src/main/services/sync-runtime.service.ts`, `src/main/ipc/sync-runtime.ipc.ts`, `src/shared/sync-runtime.ts`, `src/main/services/__tests__/sync-runtime.service.test.ts`, plus modifications to `sync-auth.service.ts`, `sync-engine.service.ts`, `sync-persistence.service.ts`, `sync-backend.ipc.ts`, `src/main/index.ts`, preload, `ipc-api.d.ts`, and `SyncMeshSettingsPanel.tsx`.

## 1a. Implementation review (12 Sep 2026)

A full review of this branch lives in `docs/plans/sync-mesh/implementation-review-next-steps.md`. Its conclusions, in short:

- **G1 is not passed.** Keep the architecture; repair the foundations before any remote-execution work.
- High findings driving the repair wave: (1) uncertain dispatches are not durably replayable — failed pushes were reverted to `pending` with a cleared sequence, and `dispatched` rows had no startup replay; (2) rebasing changed `base_revision` without recomputing `payload_hash`; (3) scan applied pages directly to domain tables and skipped changes in `(watermarkStart, watermarkEnd]`; (4) async work was not fenced across sign-out/backend switch; (5) credentials were not bound to backend identity; (6) adoption/projection could mix account-owned data; (7) spike auth was reachable from normal IPC; (8) malformed entities could advance acknowledged state.
- Ordered repair plan (Steps 0–3 of the review): contract/typecheck baseline → durable mutation delivery → reset/scan semantics → backend+account isolation. Then AUTH-01 completion (Step 4) and the two-profile gate (Step 5) before any Mesh execution.

**Integration owner for the repair wave:** whoever edits `schema.ts`, `src/main/index.ts` startup, preload, or `src/shared/ipc-api.d.ts` owns those files end-to-end for the wave — one owner, no parallel edits.

**Repair-wave status (12 Sep 2026):** Steps 0–3 landed in `61c3c9b` (docs `2ff764d`); see `execution-log.md` "2026-09-12 — Repair wave" for the per-step detail, the failure-injection suite (`sync-failure-injection.test.ts`, 13 tests), and verification output.

**Step 4 + workflow-gate status (13 Sep 2026):** real authentication is implemented end to end — SessionCoordinator DO (single-use enrollment codes, opaque rotating tokens, reuse detection, lost-rotation grace window, revoke), contract auth routes (`/v1/enroll`, `/v1/session/refresh`, `/v1/session/revoke`, `/v1/enrollment-codes`), OIDC/PKCE verification, desktop loopback-callback delivery + refresh scheduling, IPC/preload/panel wiring, and dev-only spike gating (`ANVIL_DEV_SPIKE` exists only in `env.dev` + the vitest pool; the deployable env fails closed). The two-profile acceptance gate (`sync-two-profile.acceptance.test.ts`) passes against the real `wrangler dev` worker: cross-profile create/update/delete convergence, restart rehydration, code-reuse rejection, remote revoke. See `execution-log.md` "2026-09-13". Remaining Step 5 items: socket invalidation/reconnect wiring and the wider adoption/conflict UX sweep — then Mesh packets may start.

Repair-wave verification baseline (all run on the repaired tree): `tsc -p cloud/tsconfig.json --noEmit` clean; `tsc -p tsconfig.node.json --noEmit` clean for sync files — remaining diagnostics are pre-existing on `main` (`chat.ipc` AgentProvider, `agent-ui-intent`/`mobile-companion`/`notification` test typing, `codex-bridge` nullability, `embedded-editor` Dirent generics + settings index, `telemetry` options, `mobile-home-summary` fixture inclusion) and are listed as unrelated, not regressed.

Baseline facts verified against the repo (do not re-audit):

- `anvil-app/src/main/db/schema.ts` has `SCHEMA_VERSION = 66`.
- `anvil-app/cloud/` did not exist at start; PLAN-02 is creating it.
- `anvil-app/vitest.config.ts` includes only `src/**/*.{test,spec}.{ts,tsx}`; PLAN-02 is adding `cloud/**`.
- No `zod`/`ajv` in `anvil-app`; validators are hand-rolled.
- `workflow.service.ts` `saveWorkflowTemplate` (~L197) and `deleteWorkflowTemplate` (~L233) write without a transaction; SYNC-01 wraps them.
- `anvil-cloud/packages/{auth,aws,builder,cli,client,cloudflare,control-plane,deployment,local,runtime}` exist; Cloudflare adapter is plan-only (see integration contract §10 table).

### Wave 1 was dispatched with three parallel subagents (may be finished, partial, or absent when you read this)

| Packet | Model | Allowed files | Expected output |
| --- | --- | --- | --- |
| PLAN-01 audit | grok 4.6 | `docs/plans/sync-mesh/plan-01-persistence-identity-audit.md` only | Audit doc: entity/column classification, write-path inventory, settings allowlist, workspace model gaps, session identity findings, risks |
| PLAN-02 contract | muse-spark | `anvil-app/cloud/**`, `anvil-app/vitest.config.ts`, optional `cloud/tsconfig.json` | `cloud/contract/{version,discovery,envelope,sync,operations,jobs,handoff,socket,artifacts,index}.ts`, `fixtures/*.json`, `__tests__/*.test.ts`, `README.md` |
| SYNC-01 persistence | muse-spark | `src/main/db/schema.ts` (v67), `src/shared/sync-mesh.ts`, `src/main/services/sync-persistence.service.ts`, `workflow.service.ts` (save/delete template only), tests | Tables `device_enrollments`, `sync_bindings`, `sync_outbox`, `sync_state`, `sync_conflicts`; outbox-in-transaction hook; coalescing; `nextBatch`; `applyPushResults` |

**First action for you:** run `git status` and `git diff --stat` in `anvil-app/`. Then, for each packet above:

1. If files exist and are complete, verify with the commands in §3 and commit with the message in §3.
2. If files are partial, finish them to the spec in §2 (the detailed briefs) rather than restarting.
3. If absent, dispatch the packet fresh using the brief in §2.

Do not commit PLAN-02 and SYNC-01 together; they are independent commits.

## 2. Packet briefs (Wave 1, for re-dispatch or completion)

### PLAN-01 — persistence/identity audit (read-only, one doc)

Audit `schema.ts`, `database.ts`, `workflow.service.ts`, `workspace.service.ts` + `workspace_repos`, `git.service.ts` (`repoIdFromPath`), `settings.service.ts`, `persona.service.ts`, `codex-session.service.ts`, `mobile-companion.service.ts`, `auth.service.ts`, `src/shared/ipc-api.d.ts`. Sections: baseline; entity classification table (portable / local-only / secret-never-sync / derived per column, and ID scheme); write-path inventory with file:line and transaction status; settings allowlist proposal; WorkspaceDefinition gaps (spec §4); session/process identity findings; reusable facilities; decisions with recommended defaults. Gate: every portable field and write path classified.

### PLAN-02 — provider-neutral v1 contract as code (`anvil-app/cloud/contract/`)

Pure TS + JSON, no Electron/Node/Cloudflare runtime deps, no new npm packages. Files and content:

- `version.ts`: `PROTOCOL='anvil-backend/1'`, `PROFILES=['sync/1','mesh/1']`, `SOCKET_SUBPROTOCOL='anvil.mesh.v1'`, `DESCRIPTOR_VERSION=1`, `LIMITS` (entityBytes 65536, pageBytes 262144, batchChanges 50, liveFrameBytes 16384), retention/timing constants (90 d changes+receipts, 15 min snapshot, 15 s probe, 10 min user job deadline, 120 s lease / 30 s renew, 90 s observer interest).
- `discovery.ts`: `BackendDescriptor` (integration contract §2 example), `validateDescriptor`, `resolveBackendPaths` (trailing-slash base; relative paths without leading slash/`..`/scheme/authority/query; https only except loopback with explicit flag; wss socket; reject foreign origin).
- `envelope.ts`: request/success/error envelopes, `ErrorCode` union, `httpStatusForErrorCode` exhaustive (401/403/409/413/429/503 per §5).
- `sync.ts`: `PendingChange` exactly as spec §5; push/pull/scan params+results; per-item results `accepted|conflict|rejected|reset-required|receipt-expired`; `canonicalChangeHashInput` (sorted keys) and `hashChange(change, sha256Hex)` with injected hash fn.
- `operations.ts`: `OperationName` union from integration contract §6, `OPERATION_PROFILE`, `requiredActorRole`.
- `jobs.ts`: `MeshJob`, `ExecutionAttempt`, `ExecutionManifest`, transition tables + `canTransitionJob/Attempt` (completion accepted stays completed; prior `cancel-requested` blocks ordinary completion masking; `unknown-outcome` only from claimed/preparing/running/stopping).
- `handoff.ts`: spec §11 state machine + `canAdvanceHandoff`, `SessionCheckpoint`, `ProviderContinuationMode`.
- `socket.ts`: frames `hello|subscribe|unsubscribe|sync.invalidate|worker.available|job.available|activity|gap|auth.expiring|error`.
- `artifacts.ts`: states `reserved|uploaded|published|deleting|deleted|expired`, `ArtifactManifest`, reserve/finalize types.
- `fixtures/*.json` golden cases (valid/invalid descriptor, push batch, mixed push result, pull page, oversized error, handoff sequence, cancel-vs-complete race).
- `__tests__/` vitest coverage for all of the above.

Verify: `pnpm exec vitest run cloud` and `pnpm exec tsc -p cloud/tsconfig.json --noEmit`.

### SYNC-01 — local sync persistence and workflow transaction integration

Migration 67 adds `device_enrollments`, `sync_bindings` (acknowledged base payload/revision separate from live domain row, `local_edit_generation`, `acknowledged_generation`, `quarantine_json`), `sync_outbox` (PendingChange columns + `state pending|dispatched|acknowledged|conflict|rejected`, partial unique index: one `dispatched` row per scope+entity), `sync_state` (per `{backend_id, account_id, dataset_epoch}`: cursor, high-water mark, retention floor, server limits, reset flag), `sync_conflicts` (base/local/remote payloads, kind, resolution).

Service `sync-persistence.service.ts`: `recordLocalChange` (runs inside caller's transaction; coalesces only undispatched rows; create+delete before dispatch removes the row; dispatched rows are immutable and get a pending successor), `withSyncedEntityWrite` hook (no bindings → domain write only, no outbox), `nextBatch` (≤50 changes, ≤256 KiB, one per entity, skip entities with a dispatched row, increasing `enrollment_sequence`), `applyPushResults` (accepted advances base+acknowledged generation; conflict → `sync_conflicts` row and blocks only that entity), enrollment/state/conflict CRUD. Hash: sha256 of canonical JSON `{operation, entityType, entityId, schemaVersion, baseRevision, payload}`.

`workflow.service.ts`: wrap `saveWorkflowTemplate` and `deleteWorkflowTemplate` in `getDb().transaction(...)()` and call the hook with `entityType 'workflow-template'`, `schemaVersion 1`.

Tests (real temp SQLite): migration 66→67; unsynced save → zero outbox rows; synced save atomic with throw-after-domain-write leaving neither row; coalescing rules; `nextBatch` limits and sequencing; `applyPushResults` accepted/conflict/rejected; hash determinism under key reordering.

Verify: `pnpm exec vitest run src/main/services/__tests__/sync-persistence src/main/db/__tests__ <existing workflow tests>`, `pnpm exec tsc --noEmit -p <tsconfig covering src/main>`, `pnpm exec eslint <changed files>`.

## 3. Integration checklist and commit messages

| Packet | Commit message |
| --- | --- |
| PLAN-01 | `docs(sync-mesh): PLAN-01 persistence and identity audit` |
| PLAN-02 | `feat(sync-mesh): PLAN-02 provider-neutral v1 protocol contract and fixtures` |
| SYNC-01 | `feat(sync): SYNC-01 local sync bindings, outbox, and transactional workflow template writes` |

Before each commit: the packet's focused tests pass; `tsc --noEmit` passes for the touched project; eslint passes on changed files; `git diff --stat` shows only the packet's allowed files. After SYNC-01, also run the existing workflow service tests to confirm unsynced behaviour is unchanged.

Reconciliation task after both PLAN-02 and SYNC-01 land: `src/shared/sync-mesh.ts` (SYNC-01) and `cloud/contract/sync.ts` (PLAN-02) both define `PendingChange`. Make `src/shared/sync-mesh.ts` re-export or structurally match the contract type, and ensure the canonical hash inputs are identical (same field set and key ordering). Add one test that hashes the same change through both paths and asserts equality. Commit as `refactor(sync): align local PendingChange and hash with cloud contract`.

## 4. Wave 2 — next packets (dispatch after Wave 1 is committed)

All three are independent once PLAN-02 is merged. Use one implementer each; disjoint directories.

### BACKEND-01 — Cloudflare Worker + AccountCoordinator spike (`anvil-app/cloud/backend/`)

Objective: prove the account-object design from spec §2 and §13 with real Cloudflare primitives in a local `wrangler dev` / `@cloudflare/vitest-pool-workers` (or miniflare) test setup. Scope:

- New `anvil-app/cloud/backend/` with its own `package.json` (pnpm, workspace-independent to keep Electron free of Cloudflare deps — check `anvil-app/pnpm-workspace.yaml` before adding it as a workspace package; a standalone package with its own lockfile inside `cloud/backend` is acceptable for the spike).
- `wrangler.toml` / `wrangler.jsonc` with a SQLite-backed Durable Object class `AccountCoordinator`, an R2 binding `ARTIFACTS`, `compatibility_date` pinned, and a `new_sqlite_classes` migration.
- Entry Worker: `GET /.well-known/anvil-backend` serving a descriptor that validates with `cloud/contract/discovery.ts`; `POST /v1/rpc` envelope parsing using `cloud/contract/envelope.ts`; auth stub that derives `accountId` from a bearer (spike-only, replaced by AUTH-01) and routes to `env.ACCOUNT.idFromName(accountId)`.
- `AccountCoordinator`: SQLite tables `entities`, `changes`, `receipts`, `enrollments`, `sync_meta`; `sync.push` implementing spec §5 inside one `this.ctx.storage.transactionSync` (authorize enrollment, epoch check, sequence+receipt check, changed-content-for-existing-receipt rejection, base-revision compare, write entity+revision+change+receipt); `sync.pull` ordered by account change sequence with count/byte bounds; WebSocket via Hibernation API (`acceptWebSocket`, `webSocketMessage`, `webSocketClose`), broadcasting `sync.invalidate` frames from `cloud/contract/socket.ts` after commits; one earliest-deadline alarm; no `setInterval`.
- Tests: push idempotency (same sequence returns original receipt), conflict on stale base, batch atomicity, pull pagination, invalidation delivery, and an eviction test that reconstructs state from storage. Record measured DO duration/rows-written per operation in `cloud/backend/EVIDENCE.md` as the first BACKEND-01 cost evidence.

Gate: auth stub clearly marked; transactions, eviction, and invalidation proven by tests.

### AUTH-01 — device enrollment and session contract (`anvil-app/cloud/contract/auth.ts` + `anvil-app/src/main/services/sync-auth.service.ts`)

- Contract: `enroll` request/response for `oidc-pkce` and `enrollment-code` proofs; device session `{accessToken, accessExpiresAt, refreshToken, credentialGeneration, enrollmentId, accountId, datasetEpoch}`; `session.refresh` with rotation and reuse detection semantics; `session.revoke`; `session.describe`. Freeze redirect forms for the desktop OIDC client (loopback `http://127.0.0.1:{port}/callback` with ephemeral port range) and PKCE S256 requirements.
- Desktop: main-process service implementing PKCE code generation, system-browser launch (`shell.openExternal`), loopback listener with state/nonce validation, token exchange via the backend `enroll` route, storage of refresh credential via existing credential storage (find what `auth.service.ts`/codex-auth use: `safeStorage` or keytar), refresh scheduling, and revocation. No renderer access to tokens; expose only `{state: 'signed-out'|'enrolling'|'signed-in', accountId, enrollmentId, expiresAt}` via IPC later (BYOB-01 owns preload/IPC wiring).
- Tests: PKCE verifier/challenge; state mismatch rejection; refresh rotation and reuse-detected → signed-out; expiry math; credential never appears in serialized state.

### BYOB-01 — generic backend client and connection settings (`anvil-app/src/main/services/sync-backend-client.service.ts`, `sync-backend.ipc.ts`, preload, settings UI)

- Main-process HTTP client using the frozen envelope: discovery fetch (bounded 64 KiB, 10 s timeout, no redirects), descriptor validation via `cloud/contract`, limit negotiation (stricter of local/server), RPC call with typed operations, and WebSocket client (`ws` is already a dependency) using `Authorization` header + subprotocol `anvil.mesh.v1`, reconnect with jittered backoff, frame validation.
- Backend association stored per profile (one active) in a new `sync_backends` table (migration 68; coordinate with schema owner) with `{backendId, baseUrl, deploymentId, displayName, profiles, authModes, pinnedDescriptorJson, state}`. Switching pauses old association; never repoints cursors.
- IPC + preload: `syncBackend.discover(url)`, `syncBackend.connect(...)`, `syncBackend.status()`, `syncBackend.disconnect()`; renderer Settings → "Sync & Mesh" section with Local only / Anvil-hosted / My Cloudflare deployment / Compatible backend, showing descriptor review (endpoint, issuer, capabilities, data categories) before enabling. Copy-integration-prompt button reads `anvil-backend-builder-prompt.md` content with version/digest filled from `cloud/contract/version.ts`.
- Tests: URL normalization and rejection cases (reuse contract fixtures); fake HTTP server for discovery; limit negotiation.

### Also start in Wave 2 if capacity allows

- **SESSION-01** (audit only, one doc): provider portability matrix for `codex-session.service.ts` and any other session providers — `native-resume | checkpoint-import | summary-continuation | unsupported` per provider/version, process identity and startup recovery findings. Feeds SESSION-02/03 and must finish before remote design freeze.

## 5. Wave 3 and beyond (dependency order from spec §15)

SYNC-02 (account-object push/pull/scan/receipts on BACKEND-01) → SYNC-03 (engine loop, conflict UI, adoption/account lifecycle; G1 two-profile acceptance) → OPS-01 (metering harness, quotas, restore drill) and IAC-01 (Anvil Cloud Mesh recipe in `anvil-cloud/`, stateful Cloudflare lifecycle) → ENTITY-01 → WS-01/02/03 → MESH-01/02/03 → SESSION-02/03 → FLOW-01/02/03 → PLACE-01 → BYOB-02 → IAC-02 → LAUNCH-01. Do not reorder; do not move launch requirements out of scope.

## 6. Known risks to watch

- Two `PendingChange` definitions until reconciled (see §3).
- `anvil-app/cloud/` must never be imported by Electron runtime code except `cloud/contract/**` (pure types/validators). Backend code (`cloud/backend`) stays out of the app bundle; check `electron.vite.config.*` externals if anything under `cloud/` gets pulled in.
- Migration numbering: SYNC-01 takes 67; BYOB-01 takes 68. If anything else on `main` lands a schema bump before merge, renumber the branch migrations (they are unreleased) rather than conflicting.
- `workflow.service.ts` is ~1.2k lines; keep edits surgical and consider extracting template persistence later, not now.
- Free-tier hibernation is a launch blocker; BACKEND-01 must produce measured evidence, not assumptions.

## 7. Status reporting

At the end of each session append a dated entry to `docs/plans/sync-mesh/execution-log.md` (create it if absent): commits made, packets completed/in-progress, tests run, open risks. Keep this handoff file's §1 current when Wave 1 fully lands.
