# Sync-mesh implementation review and next steps

Reviewed 12 September 2026.

Baseline: `feature/sync-mesh--foundations`, HEAD `51ff4e1`, against specification baseline `3ff60e2`. This review includes the existing uncommitted changes and four untracked runtime files. Source references describe that working tree.

## Assessment

Keep the existing architecture and implementation. The branch has useful protocol contracts, transactional workflow writes, local persistence, a generic transport client, and a tested Cloudflare account-object spike.

It has not passed G1. Several required failure behaviours are missing or incorrect, and the desktop authentication path remains a spike. Finish the sync foundation before building remote execution on it.

The original specification remains the product scope. Workspaces, editable agents, approved settings, multi-repository setup, remote execution, handoff, placement, verified fan-out, own-Cloudflare deployment, and compatible-backend support remain launch requirements.

## Plan versus implementation

| Packet | Evidence in the branch | Actual status |
| --- | --- | --- |
| PLAN-01 | Persistence, identity and write-path audit | Delivered as a baseline document |
| PLAN-02 | TypeScript contracts, fixtures, hashing and transition tests | Substantial foundation; reset semantics, runtime validation and typechecks need repair before treating the contract as frozen |
| SYNC-01 | Schema 67, bindings, outbox, conflicts, transactional workflow save/delete | Implemented, but dispatch recovery and mutation rebasing fail required invariants |
| AUTH-01 | PKCE helpers, injected enrollment/refresh operations, encrypted session persistence | Partial client implementation; no working end-to-end production enrollment |
| BYOB-01 | Discovery, descriptor review, schema 68 backend association, HTTP/socket helpers, settings | Partial; backend identity isolation, actual session integration, reconnect runtime and published bundle remain |
| BACKEND-01 | Worker, account SQLite, receipts, push/pull, hibernating sockets, eviction tests | Useful spike; authentication, retention, measured residency and load gates remain open |
| SYNC-02 | Account-object push/pull and scan routes | Partial; scan convergence is incorrect and recovery/limits are incomplete |
| SYNC-03 | Serialized workflow engine and fake-backend integration tests | Partial; runtime, adoption and conflict UI include uncommitted work; no two-profile acceptance evidence |
| SESSION-01 | Provider portability audit | Delivered as an audit; proposed continuation modes still require implementation and device evidence |
| Remaining packets | Contract types and planning documents | Launch implementations and acceptance evidence remain outstanding |

`execution-handoff.md` and `execution-log.md` still describe Wave 2 as in flight. Their completion and clean-check claims must be reconciled with the current tree.

## Findings that determine the next work

These findings come from source inspection. The passing suites do not reproduce all of these failures.

### 1. High: uncertain dispatches are not durably replayable

`src/main/services/sync-engine.service.ts:309` resets failed dispatches to pending and clears their enrollment sequence. Local edits can then coalesce into an operation whose original outcome is unknown.

After process death, a dispatched row stays dispatched. `sync-persistence.service.ts:549` excludes those entities from subsequent batches, with no startup replay path.

Consequences include permanently blocked entities, changed-content receipt rejection, and loss of the original retry identity.

Required behaviour: persist the dispatched batch and immutable contents until its outcome is resolved. Retry the same sequence and hash across transport failure and process restart. Keep later edits in a separate successor.

### 2. High: rebasing changes invalidates the stored hash

`sync-persistence.service.ts:690` updates pending successors' `base_revision` after acceptance without recomputing `payload_hash`.

`sync-engine.service.ts:494` similarly changes the base when keeping local conflict content. It also resets existing mutation sequences.

The backend verifies the hash against the complete mutation at `cloud/backend/src/account-coordinator.ts:333`, so these changes fail when sent to the real backend.

Required behaviour: derive a new valid pending mutation from the latest local generation and acknowledged remote base. Recompute all affected immutable content before dispatch. Preserve consumed receipt identities separately.

### 3. High: scan completion can permanently skip concurrent changes

The backend scans current entities by key, then returns the current end watermark from `account-coordinator.ts:623`.

The desktop applies scan pages directly to visible domain tables at `sync-engine.service.ts:374` and resumes pulling after the finish cursor. It never catches up changes between the starting and ending watermarks.

A create behind the scan cursor, an update to an already-scanned entity, or a concurrent delete can disappear from reconciliation. Entities absent from the rebuilt dataset also have no complete reconciliation step.

Required behaviour: follow spec section 5 exactly. Stage the scan, apply changes in `(S, E]`, validate epoch and retention, then activate atomically while preserving local edits.

### 4. High: account changes do not fence asynchronous work

`sync-runtime.service.ts:195` stops polling and clears the local session, but in-flight engine calls can still apply results.

`sync-auth.service.ts:425` persists a refresh response after awaiting it without checking whether sign-out or another enrollment happened meanwhile.

Required behaviour: capture a runtime generation and immutable backend/account/epoch identity for each operation. Check both before every durable write after an asynchronous boundary. Abort transport where possible, but use generation checks as the correctness mechanism.

### 5. High: backend credentials are not bound to backend identity

`sync-auth.service.ts` stores one session file without backend identity.

`sync-runtime.service.ts:167` combines that session with whichever backend is selected. `sync-backend.service.ts:132` identifies a backend only by its advertised deployment ID and can replace its URL while preserving active state.

Switching endpoints can reuse the old account credentials and namespace. Matching deployment IDs do not establish that two endpoints have the same authority.

Required behaviour: bind credentials to the reviewed backend and identity authority. Endpoint or issuer changes pause operation and require explicit reconciliation. Never transmit an existing credential to a newly selected backend.

### 6. High: adoption and projection can mix account-owned data

`sync-runtime.service.ts:117` adopts every workflow lacking a binding in the current scope, including workflows already associated with another account.

`sync-persistence.service.ts:393` enumerates all bound scopes, and the domain write hook records edits into each one.

`sync-engine.service.ts:520` also creates a binding and upserts a remote entity when no current-scope binding exists, without checking whether its ID collides with a local-only or differently associated workflow.

Required behaviour: enforce one active hosted association per entity. Preserve account provenance after sign-out. Cross-account copying needs explicit adoption with collision handling, and remote collisions must preserve both versions.

### 7. High before deployment: authentication is still a deliberate bypass

`cloud/backend/src/auth.ts` accepts caller-constructed `spike:<accountId>:<enrollmentId>` credentials.

The uncommitted runtime creates those credentials at `sync-runtime.service.ts:145`, with a ten-year access expiry. The path is exposed through normal IPC/settings wiring.

The OIDC loopback listener at `sync-auth.service.ts:165` returns a success page without delivering the authorization code to the completion flow. The runtime does not wire real enrollment or scheduled refresh.

Required behaviour: isolate spike authentication to explicit development fixtures and implement server-validated enrollment, rotation and revocation before any shared deployment.

### 8. High: malformed or unsupported entities can advance acknowledged state

`sync-engine.service.ts:520` advances the binding before projection. The projection silently ignores unknown entity types and some malformed payloads, while workflow schema versions are not enforced.

The RPC client casts operation results, and the socket client largely validates frame type rather than the complete frame schema.

Required behaviour: validate envelopes and entity schemas before application. Quarantine unsupported content with its recovery metadata, preserve local work, and allow unrelated valid entities to proceed.

### 9. Medium: resource bounds and operational recovery remain incomplete

`sync-persistence.service.ts:589` budgets payload bytes rather than the serialized request and permits the first oversized candidate.

The backend buffers request bodies and materializes unbounded query results before limiting returned pages. The desktop RPC response is also unbounded.

The runtime polls every five seconds instead of using its socket helper for invalidation. No retention cleanup alarm or deployed residency/load evidence closes the operational gate.

Required behaviour: bound input and output before buffering, paginate database reads, enforce negotiated limits, quarantine oversize entities individually, and use event-driven synchronization with bounded fallback polling.

### 10. Medium: verification and compatibility claims exceed the evidence

The contract README calls v1 frozen, but the machine-readable bundle and actual bundle digest remain unfinished. The generated builder prompt uses a documented stand-in digest.

The desktop integration suite uses a separately implemented `FakeAccountCoordinator`. It is useful coverage, but it does not prove the desktop engine interoperates with the actual Worker.

## Ordered implementation plan

### Step 0: establish an accurate continuation baseline

Scope: execution documents, TypeScript configuration and the missing shared type import.

- Record committed versus uncommitted packet ownership and the actual dependency SHAs.
- Preserve and inspect the current runtime work instead of restarting it.
- Fix `SyncOperation` being re-exported without a local import.
- Separate portable contract compilation from Node-based contract tests, and correctly include JSON fixtures.
- Replace stale completion claims with explicit acceptance evidence.
- Set one integration owner for schema, startup, preload and IPC declarations.
- Remove obsolete Cursor-specific operational instructions from the continuation plan.

Acceptance: contract typecheck passes; sync-related desktop type errors are eliminated; remaining unrelated errors are listed separately.

### Step 1: repair durable mutation delivery

Packets: SYNC-01 and SYNC-03 repair.

Scope: persistence, engine, schema and focused tests.

- Add a durable enrollment sequence allocator and persisted dispatch/replay state.
- Retry outstanding dispatched mutations before creating new batches.
- Preserve mutation identity after unknown transport outcomes.
- Keep edits made during dispatch as pending successors.
- Recompute hashes when constructing rebased successors or conflict resolutions.
- Preserve rejection reasons and uncertain outcomes for recovery.
- Enforce serialized batch limits and negotiated entity limits.

Acceptance tests:

- Real file-backed SQLite close/reopen at dispatch and acknowledgement boundaries.
- Server commits, response is dropped, process restarts, same receipt is recovered.
- Local edits continue during the lost acknowledgement without mutating the dispatched payload.
- Keep-local resolution and post-ack successors pass the real backend hash verifier.
- One oversized entity cannot block unrelated valid work.

### Step 2: complete reset and scan semantics across the contract

Packets: PLAN-02 reconciliation and SYNC-02/03 repair.

Scope: contract, backend scan/pull, local staging tables and engine.

- Define how clients obtain the starting catch-up position, ending watermark and epoch proof.
- Reconcile the current scan fields explicitly. Do not silently reinterpret a supposedly frozen contract.
- Check epoch and retention before uploading on startup/reconnect.
- Stage scan results and catch up through the end watermark.
- Reconcile missing entities, tombstones, dirty generations and uncertain dispatches.
- Activate the rebuilt base atomically.
- Resume or discard incomplete staging safely after restart.

Acceptance: deterministic concurrent create/update/delete tests across page boundaries; expired scan, changed epoch and retention-floor tests; no partial visible replacement; no resurrection of deleted entities.

### Step 3: enforce backend and account isolation

Packets: AUTH-01, BYOB-01 and SYNC-03 lifecycle work.

Scope: session storage, backend association, binding ownership, runtime and IPC.

- Bind sessions to the reviewed backend identity and issuer.
- Fence enrollment, refresh, push, pull and conflict actions with runtime generation.
- Pause before backend identity changes and clear queued old-generation work.
- Enforce one active entity association.
- Add explicit export/copy adoption and local-ID collision handling.
- Check conflict ownership against the current scope before resolution.
- Persist stable installation identity separately from enrollment identity.

Acceptance: delayed callbacks after sign-out have no effect; backend B never receives A's token or outbox; A-owned workflows are not silently adopted into B; colliding remote IDs preserve local content.

### Step 4: replace spike authentication with the supported flows

Packets: AUTH-01 completion and BACKEND-01 integration.

- Implement one-time enrollment-code issuance and consumption.
- Implement authenticated device sessions, short-lived access credentials, refresh rotation, revocation and generation checks.
- Define safe recovery when a successful rotation response is lost.
- Complete OIDC callback capture, state handling and backend proof verification.
- Serialize refresh operations and persist session replacement atomically.
- Keep secrets in the main process.
- Remove spike enrollment from production UI/IPC and fail closed outside the development fixture.
- Advertise only authentication modes the backend actually supports.

Acceptance: real client/server enrollment and refresh tests, duplicate code consumption, lost rotation response, revoked sessions, concurrent refresh and credential-isolation checks.

### Step 5: close the workflow-sync acceptance gate

Packets: SYNC-03 and BYOB-01 completion.

- Add complete operation and entity validators with quarantine.
- Finish adoption selection and base/local/remote conflict review, including save-copy.
- Connect socket invalidations, reconnect jitter, sleep/wake and bounded fallback polling.
- Show actionable pending, rejected, recovering, offline and expired-session states.
- Run the desktop engine against the actual Worker in integration tests.
- Exercise two isolated Electron profiles using production feature paths.

Acceptance: create/update/delete convergence, offline edits, edit/delete conflicts, lost acknowledgements, account switches, restart and reset all pass without database manipulation.

This closes the workflow subset. Full G1 also requires the entity adapters below.

### Step 6: complete operational controls and G1 entities

Packets: OPS-01, BACKEND-01 completion, ENTITY-01 and WS-01.

- Add bounded retention cleanup, quotas, request limits and redacted diagnostics.
- Measure hibernation and workload costs. Local eviction tests are insufficient.
- Rehearse restore with epoch rotation and revoked-authority preservation.
- Introduce editable-agent persistence, portable workspace definitions and the closed settings allowlist.
- Preserve local repository IDs through explicit portable-to-local mappings.
- Validate references and privacy classifications in both directions.

Acceptance: full G1 two-profile suite, migration coverage, privacy fixtures and recorded operational evidence.

Cloudflare's [WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) explains the hibernation mechanism. The branch must still supply its own residency measurements. Apply the [Workers request-handling guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) when bounding backend bodies.

### Step 7: proceed through the remaining launch dependencies

| Order | Packets | Required result before advancing |
| --- | --- | --- |
| Workspace mobility | WS-02, then WS-03 | Journalled single/multi-repo setup, containment and ownership checks, approved bootstrap, safe removal and crash recovery |
| Local execution isolation | FLOW-01, using SESSION-01 and WS-02 | Per-attempt worktrees, stable attempt journals and preserved partial results |
| Worker coordination | MESH-01 → MESH-02 → MESH-03 | Opt-in authority, incarnations, fenced leases, diagnostic job, cancellation, approvals, observation and artifacts |
| Remote sessions | SESSION-02 → SESSION-03 | Remote prepare/start, then exact Git checkpoint and single-owner continuation |
| Distributed workflows | FLOW-02 → FLOW-03, then PLACE-01 after its dependencies | Durable remote nodes, result transfer, explainable reserved placement and verified combined result |
| Deployment and compatibility | IAC-01 after backend/BYOB foundations; BYOB-02 and IAC-02 after their spec dependencies | Frozen bundle/digest, conformance runner, same binary against own Cloudflare and non-Cloudflare fixture, upgrade/restore/retain/remove evidence |
| Launch | LAUNCH-01 | Complete section 1 journey and section 18 device, recovery, operational and demo acceptance |

Use the SESSION-01 audit's summary-continuation proposal as an implementation starting point. Do not claim cross-device native resume or verified handoff until the supported provider/device matrix proves it.

## Verification performed

| Check | Result |
| --- | --- |
| Desktop sync, contract, schema and workflow-persistence focused Vitest selection | 142 tests passed across 14 files |
| `cloud/backend` test suite | 15 tests passed across 6 files |
| Backend `pnpm run typecheck` | Passed |
| ESLint for sync services, IPC, shared sync files and SyncMeshSettingsPanel | Passed |
| `tsc -p cloud/tsconfig.json --noEmit` | Failed: Node crypto/Buffer types in auth tests |
| `tsc -p tsconfig.node.json --noEmit` | Failed: 28 diagnostics total, including contract JSON fixture inclusion and missing `SyncOperation` references |

The full application suite, renderer typecheck, packaged build, two-profile Electron journey, real-device matrix, deployed load measurement and restore drill were not run.

For implementation packets, run focused regression tests first, followed by the affected project checks. Before integration, run the full desktop test suite and build. Keep backend commands scoped to `anvil-app/cloud/backend`.

## First delivery to request

Implement Steps 0–3 as focused changes with failure-injection coverage. The reviewable outcome is a workflow-sync foundation that preserves edits and retry identity across failures, completes reset safely, and cannot mix credentials or data across accounts.

Then finish real authentication and the two-profile workflow gate before starting mesh execution.