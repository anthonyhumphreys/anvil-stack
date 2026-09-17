# Anvil Sync & Mesh

Product, architecture, and implementation specification, revision 2

Status: revised proposal, Cloudflare selected; network contract and IaC are explicit launch work.  
Date: 11 September 2026.  
Target: `anthonyhumphreys/anvil-stack`, primarily `anvil-app/`.  
Baseline inspected: `main`, commit `3ff60e23557fb2dcafcde626e8df145d502a7ab2`.  
Supersedes: the original 100-section Sync & Mesh proposal for implementation planning. Incorporates the single-launch scope, Cloudflare decision, and bring-your-own-backend requirements.

## 1. One substantial launch

Anvil gives a user one environment across their trusted machines. Workspace definitions travel between devices. Git reconstructs repository contents. Devices execute work locally. Users select where sessions and workflow tasks run, move supported sessions, and coordinate independent agents whose results converge into verified code.

This is one substantial public release. The milestones below are internal engineering gates, not separate launches or permission to ship a reduced experience. The public launch is gated on the complete supported journey, including visible remote execution, safe handoff, explainable placement, verified fan-out, and connection to a user-owned compatible backend from the same built app.

An account remains optional. Local work stays usable without internet access or Anvil-operated infrastructure. Existing local execution remains the default. Sync does not mirror working directories. Mesh does not migrate process memory, browser state, terminals, or containers.

### The launch demonstration

The product must support this sequence on real machines without database edits, hidden terminal fixes, or demo-only code:

1. Sign into a fresh Anvil profile and see the user's workspaces, workflows, and editable agent definitions.
2. Choose a workspace and set it up from Git, including a supported multi-repository definition and approved bootstrap. Show actual progress and recovery actions.
3. Start a session on another device. Observe live activity, answer permitted approvals, inspect its diff/artifacts, and stop it from the initiating device.
4. Move a supported session to another machine. Show source stopping, target preparation, and continuation with accurate context and Git state.
5. Run three coding agents in separate worktrees, with an explicit example spanning two devices. Show where each runs and why.
6. Integrate their results in an isolated checkout, run verification on the combined result, and present one reviewable change with evidence.
7. Demonstrate an offline edit or disconnected worker without losing work or silently repeating execution.
8. Connect the same unmodified app build to a user-owned Cloudflare deployment. Show that it uses the same features without an Anvil-hosted account. Provide a separate compatibility proof against a non-Cloudflare reference implementation.

The proof is the visible, trustworthy workflow. Animations and status transitions must reflect real state. Record a concise version suitable for Twitter, with readable device names, a clear outcome, and no secrets or private repository content.

### Internal engineering gates

| Gate | Capability to prove | Public launch requirement |
| --- | --- | --- |
| G1: durable sync | Offline-safe metadata, conflicts, account lifecycle, adapters | Workflows, workspace definitions, editable agents, and approved settings |
| G2: workspace mobility | Existing-checkout linking, journalled cloning, bootstrap, safe removal | Supported single and multi-repository setups |
| G3: remote execution | Trusted workers, live observation, approvals, cancellation, artifacts | Explicit target selection and preparation |
| G4: handoff | Exact Git checkpoints and single-owner continuation | At least one fully verified provider mode; clear fallback/unsupported states |
| G5: distribution | Durable remote nodes and per-attempt isolation | Cross-device workflow execution and result transfer |
| G6: placement and convergence | Reserved capacity, explainable selection, fan-out and verified integration | Three-agent demo and combined-result review |

Support common Git, OS, and provider combinations deliberately and publish the matrix. Do not claim universal portability. Unsupported dirty/unpublished Git state must lead to explicit remediation rather than invisible file transfer. Multi-user organisations, secret synchronization, live process migration, a general remote shell, and Kubernetes-style scheduling remain out of scope.

The worker runs while Anvil is open, including a supported background/tray mode where the OS permits it. A separate always-on daemon is optional, not a launch requirement. A remote computer that is asleep is not promised to wake itself.

## 2. Backend architecture and TCO decision

The shipped backend uses Cloudflare Workers plus SQLite-backed Durable Objects, with R2 Standard for bounded artifacts and checkpoint packages. Keep SQLite as the local application database. Hosted login uses a maintained OIDC provider; user-owned backends may also use the standardized one-time enrollment-code flow.

Cloudflare is the chosen implementation, not one of several production adapters to build. AUTH-01 and BACKEND-01 validate how it is implemented. The installed app communicates through the provider-neutral HTTP/WebSocket contract, so a different operator can implement the same contract without app changes.

### Why Cloudflare for this workload

One account's machines naturally share a coordination boundary. Give each account a SQLite-backed `AccountCoordinator` Durable Object. It owns portable entities, change sequence, receipts, enrollments, jobs, attempts, approvals, and artifact manifests. Incoming device WebSockets use the Hibernation API so idle connections do not keep an object resident. Devices always connect outbound; no Tunnel, inbound port, STUN, or TURN is required.

```text
Renderer → preload → validated IPC → main-process services
                                      ├─ SQLite, Git, bootstrap, provider processes
                                      └─ hosted protocol adapter
                                          → Cloudflare Worker
                                              ├─ OIDC/session validation and routing
                                              ├─ AccountCoordinator, one per account
                                              │    ├─ SQLite metadata and durable jobs
                                              │    └─ hibernating device/observer sockets
                                              └─ R2: approved artifacts/checkpoints
```

The entry Worker authenticates and derives account routing. It never accepts an arbitrary client-selected tenant as authority. Account metadata lookup is a low-rate registration concern, not a global coordinator on every request. A small identity-directory object maps issuer/subject to internal account ID and deletion generation; shard it by subject hash, with a persisted provisioning operation for account creation/recovery. There are no cross-account execution transactions.

Inside an account object, commit related SQLite changes in one synchronous storage transaction. Never hold an external network call across that transaction. Serialize ownership transitions explicitly; a Durable Object does not make filesystem or provider effects transactional. Reconstruct all execution state from storage after eviction. WebSocket attachments contain only the minimum authenticated connection metadata, not authoritative jobs or leases.

Route durable commands and pull operations over authenticated HTTP or the socket with the same versioned envelopes. Sync socket messages remain invalidations; `pull` is authoritative. Session progress may be forwarded ephemerally to interested observers; persist lifecycle transitions, approvals, checkpoints, and result references. This avoids paying database-write costs for each token.

Use one earliest-deadline alarm per account for pending durable deadlines and retention, rescheduling from stored state. Alarms are at-least-once and share that deadline queue. They do not automatically retry coding jobs. Dormant accounts need no polling loop; schedule only real expiry, cleanup, or deletion work. Do not allocate an object per heartbeat or per token stream.

R2 uploads happen outside the SQL transaction with an upload reservation and final verified manifest. Abandoned uploads expire. Artifacts are not the primary job state. This launch does not need D1, KV, Queues, Workflows, Containers, or a separate relay service. Add a product only when a measured requirement cannot be handled by this design.

Cloudflare provides account-scoped coordination and hibernating sockets. Anvil owns offline reconciliation, authorization, protocol evolution, reconnect, and operator tooling. The runtime backend and the deployment tool are separate components with separate contracts. [Durable Objects overview](https://developers.cloudflare.com/durable-objects/), [Hibernating WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

### Architecture constraints

| Decision | TCO benefit | Accepted boundary |
| --- | --- | --- |
| One account object | Co-locate transactions and coordination; no distributed database joins | A hot account is one coordination bottleneck; cap its throughput and inspect telemetry |
| Hibernating sockets | Keep live connections without idle residency | Active handlers/streams still consume duration; hibernation must be measured |
| Ephemeral progress, durable outcomes | Avoid token-by-token database writes | Reconnect uses a durable checkpoint plus device replay; gaps are explicit |
| R2 for bounded artifacts | Keep screenshots/checkpoints out of row storage | Retention, upload integrity, and access revocation need explicit handling |
| One typed job mechanism | Share deduplication, cancellation, and recovery | Session and workflow domains retain their own validation |
| Presence from connections/probes | Avoid global heartbeat history | Socket connection alone is not execution readiness |
| Existing main-process worker | Reuse lifecycle, credentials, and updates | Anvil must remain running |
| Existing IDs and service patterns | Reduce migration regressions | Portable repo IDs still need local mappings |
| One provider implementation | Reduce ongoing test and support burden | Provider migration is a real engineering project |

The server is trusted with plaintext synced metadata, approved artifacts, and coordination decisions. The launch does not claim end-to-end confidentiality or protection against a malicious coordination server. Local execution restrictions still apply. Secret sync and a stronger server threat model require separate cryptographic design.

### Built-app backend portability

Ship three connection choices in the same signed Anvil distributable: Anvil-hosted, own Cloudflare deployment, and compatible backend URL. Local-only remains available. A user-owned backend requires no Anvil-hosted identity, entitlement check, credential relay, or deployment service at runtime.

The extension boundary is a versioned network protocol, not dynamically loaded provider code. The app contains one generic main-process client for discovery, supported authentication, HTTP operations, socket frames, and artifacts. A provider implements those operations directly or through a server-side gateway. Users enter an endpoint and authenticate; they do not recompile Electron or install an npm plugin.

Domain IDs, payload schemas, revisions, errors, and transitions remain provider-neutral. Cursors are opaque and scoped to backend, account, and dataset epoch. A new implementation of an existing protocol works with the installed binary. New native capabilities or wire-major versions may still require an app update.

Publish the network contract, machine-readable schemas, conformance suite, and a version-pinned backend-builder prompt. The prompt is a convenience; schema and behavioural conformance define compatibility. Test the actual unmodified release artifact against the official backend, a fresh user-owned Cloudflare deployment, and a small non-Cloudflare conformance reference. The reference is test infrastructure, not a second hosted production service.

See [Backend integration contract](anvil-backend-integration-contract.md) for discovery, connection UX, fixed auth methods, transport, operation inventory, and bundle requirements. The companion spec is [cloud-connected-companion.md](cloud-connected-companion.md); current implementation status lives in [README.md](README.md). These documents currently specify work to implement; they do not imply the current released binary already has this capability.

### Own Cloudflare through Anvil Cloud

Ship a version-pinned deployment recipe through `anvil-cloud`, backed by the same Worker bundle and schema migrations as the hosted backend. The recipe provisions account coordinators, R2, authentication/configuration, and a credential-free connection descriptor. Keep provider credentials local to the deployment tool. Anvil Cloud orchestrates deployment; the running backend does not call back to the deployer's computer or Anvil-hosted services.

The existing Cloudflare adapter is plan-only at the normal CLI boundary. Its stateless Worker artifact/smoke path is useful, but Durable Object storage and class exports, R2 lifecycle, auth/secrets, upgrades, and production deployment support are explicit missing work. Add a bounded platform-owned backend deployment recipe rather than pretending the current generic D1 Cell database mapping supplies account-coordination semantics.

Use existing plan/review/artifact and conformance machinery. Export inspectable generated Wrangler configuration as the manual/recovery path, so users are not stranded by the CLI. Do not maintain separate Terraform and Pulumi copies of the same infrastructure. Deployment plans must preserve namespace/bucket identity, recover partial applies, retain data on removal by default, and distinguish code rollback from irreversible data migrations.

Cloudflare implementation details stay in backend/provisioning modules. User Cell authoring does not acquire raw provider APIs. Implement only the capabilities needed by the Mesh recipe; completing every Anvil Cloud runtime adapter feature is not a prerequisite. The integration contract records the exact repository gaps and lifecycle requirements.

## 3. Ownership and local-first invariants

1. Local domain state is authoritative for local reads and editing. Every sync-enabled domain write and its sync intent commit in the same SQLite transaction.
2. No cloud acknowledgement is required to save a local edit or start an ordinary local session. Disk failures are reported; local-first is not a promise to save without storage.
3. The hosted service arbitrates accepted shared revisions and remote execution ownership. It never overwrites unacknowledged local edits implicitly.
4. Cross-device starts, new remote turns, and ownership transfers require live authorization. Cloud outages do not block unrelated local work.
5. A remote attempt may finish its current non-interruptible action during loss of connectivity, but must stop admitting further work when its lease becomes unsafe. It must never be automatically reassigned merely because its lease expired.
6. Remote revocation blocks new reads, writes, claims, and renewals. It cannot erase cached data or guarantee immediate termination of a disconnected process.
7. A global workspace deletion removes its shared definition. Local checkouts and active execution are preserved until explicitly resolved locally.
8. Remote state is descriptive unless a typed, authorized command explicitly requests a change. A synced recipe edit never executes itself.

### Account and backend lifecycle

Use a stable internal account ID mapped from the selected backend identity authority, such as OIDC issuer/subject or an administrator-provisioned personal account, never email alone. Scope every sync table, cursor, outbox item, conflict, device enrollment, and callback to `{backendId, accountId, datasetEpoch}` plus the local profile where appropriate.

Sign-in does not enable upload. Show the selected entities and data categories before adoption. Existing entities keep IDs where possible. A collision is a conflict or explicit linking decision, never an overwrite.

Sign-out stops transport and invalidates in-flight callbacks for the old namespace. Local edits continue. Previously account-associated data remains labelled as such. Signing into B must not replay A's outbox or silently adopt A's cached data. In v1, an entity has at most one active hosted association; copying to another account requires explicit export/adoption.

Account deletion disables enrollments first, then deletes active hosted data through a retryable purge. Local data remains. A recreated account receives a new internal identity; stale clients cannot recreate deleted cloud state. Published backup-retention policy must explain delayed expiry from backups.

## 4. Identity and workspace model

Use random UUIDs for new application identities. Preserve compatible existing UUIDs. IDs are not authorization credentials and timestamps are not conflict order.

Distinguish an installation ID from account enrollment and worker incarnation. Re-enrollment issues new credentials. Each worker start obtains a new incarnation ID. A copied profile must re-enroll before executing; concurrent use of one enrollment is rejected by exclusive worker-incarnation ownership. A fully compromised copied credential remains a credential compromise, not something UUIDs solve.

### Portable definition

```ts
interface WorkspaceDefinition {
  id: string;
  schemaVersion: number;
  name: string;
  description?: string;
  repos: Array<{
    id: string;                    // Portable repository identity within the workspace
    remoteUrl?: string;             // Sanitized; absent means link-local-only
    relativeDirectory: string;
    defaultRef?: string;            // Setup preference, never an execution snapshot
  }>;
  workflowIds: string[];
  agentIds: string[];
  preferences: PortableWorkspacePreferences;
  bootstrap?: BootstrapRecipe;
}
```

`PortableWorkspacePreferences` is a closed, versioned allowlist. Do not use arbitrary settings blobs. Connector references require a portable logical reference and local credential binding. Validate unresolved workflow/persona references and mark the definition not yet runnable without losing it.

No authoritative absolute paths, device status, credentials, execution permissions, or current branch belong in this payload. The sync envelope owns revision and audit timestamps.

### Local replica and execution checkouts

V1 has one canonical workspace replica per device, with multiple repository mappings. Execution checkouts are separate children of attempts. Additional independent canonical replicas on one device are deferred.

Local mappings contain:

- Workspace ID, pinned or last-applied definition revision, and device enrollment.
- Portable repo ID to existing local repo ID and canonical path.
- Ownership, either `linked` or `anvil-created`, and references from other workspaces.
- Per-repository materialisation state and operation ID.
- Per-repository Git observations with observation time and upstream identity.
- Bootstrap approval digest, step outcomes, and verification evidence.

`remote-only` is derived from the absence of a mapping. Materialisation states are `preparing`, `cloning`, `awaiting-approval`, `bootstrapping`, `ready`, `failed`, `unknown-outcome`, and `removing`. Git freshness is a separate observation. A changed definition marks configuration as needing review; it never silently reconfigures a checkout.

Cloud replica summaries contain only workspace ID, device ID, verified definition revision, coarse readiness, and observation time. Publish changes when readiness changes. Do not synchronize paths or poll Git on a fixed global interval.

Two independently imported workspaces are not automatically merged because remotes match. Offer explicit linking after showing repositories and configuration. Different SSH/HTTPS URLs and forks need user-assisted resolution.

## 5. Sync protocol

### Local persistence

Extend existing domain tables. Add `sync_bindings`, `sync_outbox`, `sync_state`, `sync_conflicts`, and `device_enrollments`. A binding stores acknowledged base payload/revision separately from the current local entity and its local edit generation. Add local materialisation/attempt journals at their engineering gates.

Do not create an independently editable generic entity cache alongside domain tables. Remote application updates the domain projection and sync base transactionally without generating a new outgoing edit. Domain adapters validate both directions.

Unsynced entities save normally without an outbox. For synced entities, persist a local dirty intent atomically even if the hosted service rejects quota or schema constraints. Such rejection must not lose local work.

### Push

```ts
interface PendingChange {
  changeId: string;
  enrollmentSequence: number;
  entityType: string;
  entityId: string;
  schemaVersion: number;
  baseRevision: number | null;      // null is create-only
  operation: 'create' | 'update' | 'delete';
  payload?: unknown;               // Validated by the entity-specific wire schema
  payloadHash: string;
}
```

Hash a specified canonical serialization of all immutable mutation content, including operation, identity, base, and payload. Authenticate the actor outside the domain payload.

Allow one in-flight batch per enrollment, with at most one dispatched mutation per entity. Batch up to 50 ordered changes within 256 KiB. A batch has sequential per-item results in one backend transaction; network, auth, or transaction failure accepts none unless the entire commit succeeded. Each terminal accepted/conflict/rejected result consumes its sequence and has a receipt. Retryable transport/server failures do not.

Validate batch structure before effects. Inside the transaction: authorize enrollment; validate epoch/cursor freshness; check sequence and existing receipt; reject changed content for an existing receipt; validate entity schema and base revision; write accepted entity, revision, ordered change record, and receipt together. Derive device and account audit fields server-side.

Results are `accepted`, `conflict`, `rejected`, `reset-required`, or `receipt-expired`. An acknowledgement includes the accepted canonical revision and content or a reference sufficient to retrieve them. Backend retries never bypass Anvil's base-revision comparison. Use a synchronous SQLite storage transaction within the account object for related acceptance writes.

Coalesce edits only while undispatched. A dispatched mutation is immutable. After its acknowledgement, generate the successor against the new base while preserving newer local edits. For the same entity, do not place dependent revisions in a batch until their base is known. A conflict blocks that entity, not other entities.

### Pull and conflict application

Use a monotonically increasing account-scoped change sequence for portable metadata only. Presence, leases, logs, and job progress never increment it. Realtime subscribes to the small account watermark and only triggers the engine to pull. One serialized sync loop per profile coalesces triggers and backs off with jitter.

Pull returns ordered changes, next cursor, and `hasMore`, bounded by count and bytes. Apply each page and its cursor in one SQLite transaction. Duplicate or older entity revisions cannot roll back an acknowledged base.

If incoming state differs from the base while local work is pending, preserve base, local, and remote versions in a conflict. The UI offers compare, keep local, use remote, and save a separate copy. Edit/delete conflicts require an explicit choice. A resolution is a new conditional mutation and may conflict again.

An acknowledgement advances the base. It replaces visible local content only if the acknowledged local generation is still current. User timestamps never select a winner.

### Payload sealing (E2E)

Domain `payload` travels as a sealed envelope `{enc, keyVersion, nonce, ct}` — AES-256-GCM under a versioned 256-bit account data key (ADK) with a random 96-bit nonce. Associated data binds the envelope to backend id, account id, entity type, entity id, and key version; operation and schemaVersion are covered by the backend-verified `payloadHash` instead, so quarantined envelopes re-open without reconstructing the mutation. `payloadHash` covers the canonical sealed envelope, preserving dedupe and receipt semantics. Deletes carry no payload and are not sealed.

The backend validates envelope structure (`enc`, positive integer `keyVersion`, 12-byte nonce, ciphertext carrying at least the GCM tag) and stores ciphertext it cannot open. It never sees plaintext and never sees key material.

Sealing happens at dispatch, not at edit time: `sealed_json` on the outbox row persists the exact wire envelope so replays reuse identical ciphertext and payload hash. Local domain state stays plaintext. A missing ADK defers the change — plaintext is never sent for a domain entity on a scoped session.

Crypto-boundary entity types (`device-identity`, `keyring-wrap`, `keyring-pairing`) carry their own payloads and bypass domain sealing. They are consumed by the keyring on pull before any domain/binding handling.

Unseal failure on pull quarantines the raw envelope on the binding with its revision; a later key delivery retries the quarantined envelopes without re-fetch.

Artifact bytes and handoff checkpoints seal under the same ADK. Artifact manifests record `sealed`, `keyVersion`, and `plaintextBytes`; hashes cover stored ciphertext. Checkpoints keep `sessionId` and `sourceGeneration` clear for backend CAS; the remaining body is sealed. Shared-artifact bytes seal under a fresh per-share key carried only in the share URL fragment — the server never receives it.

Key hierarchy and distribution live in §6.

### Retention, reset, and long-offline recovery

Keep incremental changes, full delete tombstones, and receipts for 90 days initially. Enforce an account history-byte quota before accepting new shared changes; never accept a change and then silently discard required recovery history. Local editing remains available while quota is exceeded. Compact asynchronously in bounded batches.

Maintain a small durable consumed-sequence high-water mark per enrollment. Old sequences without a retained receipt return `receipt-expired` and cannot apply again. Do not automatically create a new change ID to retry an uncertain old operation.

Before push on startup/reconnect, check dataset epoch and cursor retention. A stale cursor or changed epoch requires rebuilding acknowledged state while preserving local edits and unresolved operations in a recovery area. Updates to absent entities never become creates. Re-creation after deletion uses explicit user intent and a new entity ID.

A bounded snapshot scan uses immutable entity-key ordering:

1. Capture starting watermark S and epoch.
2. Scan current entities into a staging base, leaving local working state untouched.
3. Capture end watermark E and apply every retained change in `(S, E]` to staging, ignoring older revisions already observed by the scan.
4. Verify the epoch and retention floor still cover S; otherwise restart safely.
5. Atomically activate the rebuilt base, reconcile preserved local changes, and continue pulling after E.

This is a reconciliation scan, not a claim that multiple queries share one database snapshot. Creates behind the scan cursor and concurrent deletes are covered by catch-up. Bound snapshot lifetime to 15 minutes initially. Unsupported or oversized datasets fail with a recoverable explanation; never partially replace the visible database.

Recovery with an expired receipt preserves the intended local version and presents a conflict if its previous acceptance cannot be established. It must not silently replay side effects or resurrect removed content.

Server restore rotates a deployment epoch before clients reconnect. Reject old pushes and all old job leases; require device reauthentication and state reconciliation. Backup restore is not ordinary incremental sync.

### Compatibility and limits

Advertise protocol version, supported entity versions, batch limits, epoch, and retention floor. Retain unknown payloads in quarantine with their revisions; do not let old clients strip fields or block every unrelated entity. Quarantined objects are not runnable or editable until supported.

Initial application limits are 64 KiB per portable entity and 256 KiB per push/pull page. A larger workflow can remain local with an actionable sync error. Enforce these application limits on every transport before parsing large payloads or writing storage. They remain provider-neutral.

## 6. Authentication and device trust

The built client supports two fixed enrollment methods: system-browser OIDC authorization code with PKCE, and an administrator-issued short-lived one-time enrollment code for personal/custom deployments. Neither requires a provider-specific app plugin. The integration contract defines both methods and their versioning.

OIDC uses a provisioned public desktop client, state/nonce/issuer/audience validation, and fixed supported redirect forms. No client secret is embedded in Electron. Enrollment codes authorize a specific account and expire after one use. They are not general cloud API tokens. After either enrollment flow, exchange into the same device-scoped short-lived access token and rotating refresh credential, protected in main-process OS credential storage.

Derive account, enrollment, and credential generation from the authenticated device session for every request. A client-supplied device ID alone grants nothing. AUTH-01 must freeze rotation, lost-response recovery, reuse detection, and expiry semantics with a maintained session/auth implementation. Enrollment retry must recover one enrollment or revoke/replace it safely, never create unlimited trusted devices.

Socket operations check current enrollment generation and session expiry. Revocation closes matching connections and blocks refresh, reconnect, claims, and artifact access. Expired sockets cannot keep operating merely because a timer has not closed them yet. OIDC/enrollment proofs, device credentials, and cloud deployment credentials are distinct and never appear in discovery, connection descriptors, normal logs, or renderer state.

Sync enrollment does not authorize Mesh. On each target, enable remote sessions/workflow tasks locally and approve which source enrollments may request execution. New sources require fresh approval. The backend cannot use synced configuration to enable a target's local execution policy. Account recovery does not silently restore remote authority.

### Account data key distribution

Each enrolled device generates an X25519 identity keypair at enrollment and publishes the public half as a `device-identity` entity. The ADK moves between devices only in forms the backend cannot open: a `keyring-wrap` entity seals the ADK to a recipient's X25519 public key, and a `keyring-pairing` entity seals it under a one-time secret carried in the out-of-band pairing payload (`anvil-pair-…`, scanned or typed) alongside the enrollment code. The server sees the enrollment code; it never sees the pairing secret or any key material. Key material rests in local SQLite wrapped by OS credential storage (`safeStorage`, or the daemon's `0600` AES-256-GCM file).

The first device on an account mints ADK v1 at first seal. A device that knows it has peers but holds no ADK defers sealing until a wrap or pairing blob arrives — it never falls back to plaintext or mints a divergent key.

Revoking a device rotates the ADK: a trusted device mints the next version and queues wraps for every surviving enrolled device, excluding the revoked set and itself. The revoked device keeps content it already decrypted; rotation limits future reads only. A short authentication string derived from both device public keys and the account id is available for manual verification of a pairing.

Before claim and each new remote action, the worker validates local policy, source authorization, enrollment, job kind, workspace scope, and resource limits. Diagnostic handlers are built-in operations, not arbitrary shell strings. The renderer sees safe state only; IPC validates callers and payloads through existing patterns.

API keys, Git/provider credentials, arbitrary environment variables, and local permission settings do not sync. Use closed serializers, sanitize errors, and strip embedded remote credentials. User-authored prompts and selected artifacts may contain sensitive content; preview sharing before upload. Custom-backend selection is explicit trust in that operator for the data and coordination it handles, not automatic permission to run code locally.

## 7. Workspace adoption, materialisation, and removal

G2 starts by proving a single-repository operation, then extends the same journal to multi-repository setups before launch. Persist and recover each repository stage independently; aggregate readiness requires every declared required repository to pass. Preserve successfully cloned repositories after a partial failure, and never roll back user edits made inside them. Local-only/no-remote repositories can be linked and listed but cannot be reconstructed remotely. Unsupported submodule, LFS, shallow-history, filesystem, and authentication cases must be detected before claiming readiness.

For a new setup:

1. Persist operation ID, definition revision, requested repository commits/refs, destination, and ownership intent.
2. Reserve destination using an ID-based suffix and a canonical-path lock. Validate containment, collisions, case sensitivity, symlinks, and available disk space.
3. Clone into an operation-owned staging directory. Validate remote identity and checkout; record filesystem evidence before advancing the journal.
4. Resolve and record exact commit IDs. A floating default ref is allowed only as a setup preference, not as the input identity of a job.
5. Obtain bootstrap approval if required, execute and verify steps, then publish the completed mapping. Keep partial results recoverable.
6. Open only when required repository and bootstrap checks pass, or explicitly offer opening without setup.

Use argument-safe Git invocation and an approved transport policy. Default to authenticated HTTPS or SSH; reject remote helpers, local-path remotes from synced definitions, embedded credentials, and unexpected protocol/host changes. Credentials come from target-local configuration. Linking local paths is a separate locally initiated operation.

On restart, inspect both the journal and operation-owned filesystem state. Resume only proven safe stages. Never infer ownership from a matching directory name. Concurrent requests for the same pinned inputs attach to the same operation; different inputs wait or return conflict.

The materialisation gate defines the boundary between bootstrap, shell environment, and package-manager scripts explicitly. Worktree creation must not inherit unsafe force/reset semantics from existing helpers.

### Bootstrap recipe

A recipe has a schema version, stable step IDs, declared platforms, working directory per step, argv or an explicitly approved shell script, timeout, environment variable names, verification, and retry classification. Pin a digest of recipe content, repository commits, and effective execution policy in the local approval record.

Initial step types are `command` and `verify`. Do not add a general workflow language. The runner strips ambient credentials by default and supplies only locally approved environment bindings. Package installation is executable repository code, including lifecycle scripts. Explain this at approval.

A step transitions through `pending → running → verified`, or `failed/unknown-outcome`. After a crash, verify the postcondition before retrying. Non-idempotent steps with uncertain results require inspection. Capture bounded, sanitized logs locally. Cancellation requests terminate the process group where supported, then inspect child processes and filesystem state before confirming stop.

Automatically setting up a remote workspace is permitted only when the target has already approved the exact effective recipe and source policy. Otherwise the job waits for an approval that the target policy allows to be answered remotely, or requires target-local action.

### Safe removal

Default removal detaches mappings. A linked checkout is never deleted by this operation. Deleting an Anvil-created checkout requires local confirmation against its resolved path after checking active attempts, other workspace references, untracked files, dirty state, and unpublished commits. Prefer recoverable trash/quarantine, with a second explicit irreversible purge if needed.

Global definition deletion never invokes filesystem deletion. Keep orphaned local workspaces visible and offer export or detachment.

## 8. Worker lifecycle and low-cost availability

All signed-in profiles may connect for sync invalidations. Only Mesh-enabled enrollments accept worker commands. Sync-only devices maintain no durable presence timer. They show `last synced` when no recent live evidence exists.

A worker runs while Anvil is open or in its supported background mode. No inbound ports or separate OS service are needed. Closing Anvil attempts graceful interruption and records unresolved execution; crash recovery does not assume every child process died.

Worker availability combines socket connectivity, last transport response, accepting-work policy, active reservations, capability digest, and worker incarnation. Socket presence is a hint. Before placement, send a target readiness probe and obtain a worker response. Idle does not mean available capacity.

Use hibernating incoming sockets and automatic protocol/application keepalive responses where supported. Do not turn each keepalive into a SQLite write or fan out a persistent presence update. Configure client ping timing from observed network behaviour, initially 60 seconds with jitter; store last-seen checkpoints at most every 15 minutes while active, or on meaningful lifecycle changes. Heartbeats never renew execution ownership implicitly.

| Condition | Reporting policy |
| --- | --- |
| Sync-only idle | No durable heartbeat; transport keepalive only if connected |
| Mesh idle | Hibernating socket, target-local policy, on-demand readiness probe |
| User selects device | Probe and acknowledge within 15 seconds or show unavailable/stale |
| Attempt running | Renew a 120-second lease every 30 seconds; one worker message may batch its active attempt renewals |
| Capabilities | Detect on start, settings change, or explicit refresh; publish changed digest only |
| Replica status | Publish coarse transitions; inspect Git when opening/preparing/refreshing |
| Device picker open | Show live connection hints with freshness; revalidate before claiming |

Lease renewal is durable and fenced. Batching transport does not remove per-attempt storage checks or row-write costs. Do not extend a lease merely because the socket is alive. Automatic ping responses keep a connection healthy; they do not prove that the local agent runner is responsive.

Avoid periodic `setInterval` in account objects and avoid outgoing sockets, both of which can undermine hibernation. Recover attached connection identity on object reactivation and re-check expiry/revocation before routing work. Never put active attempt ownership only in object memory. [Hibernating socket behaviour](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

Default to one write-capable attempt until the user enables more capacity. The launch supports at least three isolated attempts on a capable worker, with explicit CPU/memory/disk and provider budgets. Reserve capacity during claim and revalidate locally. Unknown-outcome attempts keep their local reservations until inspected. Read-only diagnostics have a separate small bounded allowance.

### Headless daemon mode (DAEMON-01)

A headless build of the Anvil host services — sync runtime, mesh worker, companion server — runs as an OS service on always-on machines (homelab boxes, NAS, VPS, CI runners). It carries no renderer, no IPC surface, and no Electron dependency at runtime; the `electron` module is satisfied by a stub providing data-dir resolution and a file-backed secret store.

- **Enrollment is code-only.** `anvil-daemon enroll --api-url <url> --code <code>` discovers the backend descriptor (`<base>/.well-known/anvil-backend`), pins it, redeems the code, enables sync, and persists the `DeviceSession` under the daemon data dir. OIDC is a desktop flow; a daemon that needs re-enrollment is re-enrolled with a fresh code.
- **State dir.** `ANVIL_DATA_DIR` or `~/.anvil-daemon/`. Holds the SQLite DB, session file (`0600`, file-permission security — same trust level as `~/.ssh`), and config. No Keychain/safeStorage: headless secret storage is a `0600` AES-256-GCM-encrypted file keyed by a locally generated master key, which is itself `0600`-protected — honest equivalent to ssh-agent's trust model, documented as such.
- **Policy grants are CLI-managed.** `anvil-daemon policy list|set <enrollmentId> <tier>|forget`. A `defaultTier` config (`denied` unless set) covers zero-touch personal deployments; `steer` is never auto-granted by default.
- **Same protocol surface.** The daemon is an ordinary enrollment: it advertises companion endpoints, claims mesh jobs within its capability set, renews leases, and dies by revocation identically to a desktop. Provider-dependent job kinds (codex sessions, etc.) claim only if the provider CLI is installed; capability reporting must reflect what the host can actually run.
- **No wake promise.** A daemon on an always-on host converts "queued until the app opens" into "runs now", but a sleeping machine is still asleep — unchanged from §8.
- **Service management is the user's.** Ship reference `launchd`/`systemd` unit templates and a build script; Anvil does not manage the daemon lifecycle from the desktop app.

## 9. Durable jobs, attempts, and cancellation

All remote materialisation, readiness probes, session starts, and later workflow nodes use typed jobs. They share delivery and recovery semantics but retain domain-specific payload schemas. No independently writable placement request queue exists.

```ts
interface MeshJob {
  id: string;
  requestId: string;               // Unique within account and source enrollment
  payloadHash: string;
  kind: 'diagnostic' | 'prepare-workspace' | 'start-session' | 'workflow-node';
  sourceEnrollmentId: string;
  requestedTarget: { kind: 'device'; enrollmentId: string }
                 | { kind: 'auto'; requirements: CapabilityRequirements };
  targetEnrollmentId?: string;    // Resolved before claim; source choice is preserved
  inputManifest: ExecutionManifest;
  state: 'queued' | 'running' | 'awaiting-approval' | 'completed'
       | 'failed' | 'cancel-requested' | 'cancelled' | 'unknown-outcome';
  queueDeadline: string;
  retryPolicy: 'safe' | 'inspect-before-retry' | 'never';
}

interface ExecutionAttempt {
  id: string;
  jobId: string;
  workerIncarnation: string;
  fence: number;
  leaseExpiresAt: string;
  state: 'claimed' | 'preparing' | 'running' | 'stopping'
       | 'completed' | 'failed' | 'cancelled' | 'unknown-outcome';
}
```

`ExecutionManifest` pins workspace definition revision, repository ID/commit pairs, bootstrap digest, provider/model requirements, relevant config versions, and declared inputs. Attachments require a supported transport; an inaccessible local path fails validation.

The server derives account and source identity from authorization. Job creation is idempotent by request ID and hash. For automatic placement, resolve and persist a target plus the matching constraints and explanation before claim. Only an unclaimed automatic request may be retargeted under its declared fallback policy. Claim atomically checks enrollment, source policy, queue deadline, capacity, existing attempts, and then allocates an increasing fence. Renewal and completion require matching attempt, incarnation, and fence. Late completion from a stale attempt is rejected but its recoverable local result is retained.

Before process start, write a local attempt journal. Where the provider supports a stable creation key, use it. Otherwise a crash between spawn and recording the provider ID produces `unknown-outcome`; inspect before starting another process. PID alone is insufficient evidence of process identity after restart.

Backend transactions cannot provide exactly-once external effects. A fence protects accepted ownership and result publication; it cannot stop an old process from pushing to Git or modifying an external service. Remote coding and bootstrap default to `inspect-before-retry`. Expired leases never automatically launch another coding attempt.

Workers compute conservative local renewal deadlines, handle sleep/resume, and stop new dispatch before expiry. If they cannot establish ownership, request interruption and retain uncertain state. Server outage must not create an automatic ownership transfer.

Cancellation is an idempotent durable intent. Terminal completion and cancellation race through conditional server transitions: an already accepted completion remains completed; a prior cancellation request prevents ordinary completion from masking the cancellation outcome. The worker reports any partial result and effects. Confirm `cancelled` only after stopping has been verified. Unreachable workers remain `cancel-requested` or `unknown-outcome`.

Queue defaults are explicit. Readiness probes expire after 15 seconds; user-launched execution requests expire after 10 minutes unless the UI offers a different deadline. Jobs do not unexpectedly start days later. Bounded, indexed recovery sweeps may mark lease expiry, but reads/claims must also enforce expiry without relying on punctual timers.

## 10. Live session observation and artifacts

Separate logical session identity from device-local execution attempts and provider thread IDs. A session records current execution generation, target, and checkpoint lineage. Only the owner of that generation may accept a new remote turn. Ordinary local-only sessions retain their existing path and do not require a cloud lease.

The launch exposes explicit/automatic target selection, preparation progress, waiting-for-approval, live output, diff/artifact inspection, cancellation pending, and terminal results. Never silently change an explicitly selected target. Explain automatic choices using hard constraints and reserved capacity.

### Live and durable channels

Use the account object's sockets to forward coalesced, size-bounded activity frames only to authorized interested observers. Default to 100-250 ms batching for smooth active output, with per-account byte/message ceilings and bounded queues. Persist lifecycle changes, approvals, verified checkpoints, and result manifests. Do not persist each token or UI frame.

Every frame has attempt, generation, and sequence. Devices retain a bounded replay buffer locally. Reconnect reads the durable snapshot and requests replay after the last seen sequence. If the source no longer has it, show a gap and restore from the last available checkpoint; do not fabricate missing output. A durable checkpoint bounds recoverable history, while ephemeral frames provide responsiveness.

Stop forwarding when no observer is subscribed. Observer interest expires after 90 seconds without renewal. Backpressure first coalesces replaceable output; it never drops approval requests or durable outcomes. The client can pause live output without stopping the job.

Retain at most 1 MiB of intermediate durable event metadata per job, with a separate bounded final outcome and approval record. User-requested transcripts and provider checkpoints belong in R2 subject to size/retention policy. Raw terminal control and arbitrary remote shell are not required to show agent activity, diffs, approvals, screenshots, and verification results.

### Artifact contract

Artifacts include explicit screenshots, test reports, diff summaries, attachments, and supported provider checkpoint packages. Git transfers code through approved refs. Artifact upload is deliberate job policy, not automatic workspace file collection.

Reserve an artifact ID and byte allowance in the account object. Upload to a private R2 key scoped by account and artifact ID. Verify checksum, actual byte size, media type, and owning attempt before publishing the manifest. A failed upload is not a successful artifact. Recovery reconciles reserved, uploaded, published, and deleting states; orphan cleanup is idempotent. Never attempt a SQL/R2 atomic transaction.

Authorize every artifact read and write through the Worker and current account/enrollment policy; stream bytes rather than buffering whole files. Avoid long-lived public or signed bearer URLs that outlive revocation. Inline previews use safe content types and sandboxing. No executable HTML from a job is rendered with app privileges. Apply per-artifact and per-account quotas before transfer.

Remote approval is an expiring durable request bound to attempt, action digest, generation, and permitted approver. It cannot loosen the target's local execution policy. Duplicate decisions are idempotent and stale approvals are rejected. Bootstrap policy may require target-local approval even when ordinary run approvals can be answered remotely.

The server sees approved artifacts and checkpoint contents. Show this explicitly. Default retention is seven days for intermediate artifacts and 30 days for user-visible final artifacts, configurable before upload. Keep local unmerged code regardless of cloud expiry. R2 is for recoverable evidence and context, not the only copy of a user's repository.

## 11. Git portability and session handoff

Every execution checkpoint specifies exact commit IDs for every required repository. Resolve and verify target reachability. Never use `checkout branch; pull` as an identity-preserving handoff. Branch labels may accompany immutable commits for display.

G4 requires clean tracked state, explicit treatment of untracked inputs, and commits reachable through an approved remote. Stashing alone does not transfer work. Local-only commits, dirty work, unsupported LFS/submodules, and inaccessible artifacts block handoff with specific remediation. A future bundle/patch transfer is explicit and separately authorized.

Provider adapters declare `native-resume`, `checkpoint-import`, `summary-continuation`, or `unsupported`, with supported versions and verification. A provider thread ID is not proof of portability. Summary continuation creates a new provider thread and the UI states what context is omitted.

A checkpoint contains logical session ID, schema version, source generation, exact repository manifest, provider/model identity, transferable messages or summary, plan/goal state, artifact references, and unresolved approvals. Do not transfer approval authority. Existing approvals are cancelled or reissued against the target action.

Handoff is a durable operation:

```text
requested
→ target-prepared-without-execution
→ source-quiescing
→ source-relinquished-and-checkpointed
→ ownership-transferred
→ target-activating
→ completed
```

The source first durably rejects new messages, interrupts or completes its turn, verifies child-process quiescence, captures the final checkpoint, and relinquishes its generation. Source restart honours that relinquishment. If source execution cannot be proven stopped, do not activate the target.

The server transfers ownership conditionally against the expected generation and handoff ID. Target activation uses the stable attempt ID and process-start recovery rules. A target-start timeout is not permission to restart the source. Rollback requires confirming target inactivity and assigning a fresh generation.

Source and target preparation may overlap only for immutable prerequisites. Revalidate the final source commit manifest after quiescence. Pre-transfer cancellation may resume a proven-stopped source under its valid ownership; post-transfer cancellation follows target stop/recovery. Never infer rollback from a missing acknowledgement.

If users explicitly choose to continue separately while ownership is uncertain, create a new logical session and isolated checkout, explain the duplicate-effect risk, and preserve the original as unresolved. Do not call this a successful move.

## 12. Workflow placement, fan-out, and convergence

G5 extends existing workflow nodes with optional explicit target metadata. Nodes without placement metadata retain local behaviour. The parent persists dispatch IDs, attempt references, input manifests, output references, and cancellation intent. Parent restart never recreates a node job with a new identity merely because its response was lost.

Before fan-out, change execution paths from run-scoped to attempt-scoped. Allocate a unique branch and worktree for each write-capable attempt from pinned input commits. Do not reset an existing branch with `-B` or use forced worktree removal as normal cleanup. Serialize operations that modify shared repository refs.

Worktrees isolate file edits, not credentials, processes, network access, shared services, or Git's common storage. Enforce target-local sandbox policy, separate temporary directories/ports where necessary, and avoid running untrusted work with ambient deployment credentials. Optional containers follow actual workloads, not a universal requirement.

Each successful coding attempt publishes a result manifest: base commits, result commits, verification outcomes, declared artifacts, and provenance. Textual handoffs are context, not proof that code exists or tests passed. Transfer code through approved Git refs. Remote refs and artifact publication require explicit policy.

An integration attempt starts from a pinned base and applies results in declared dependency order. Overlapping edits produce a visible conflict. Verify the integrated result before proposing application to a user checkout. Preserve failed or unmerged branches until explicit disposal or a previously approved retention policy applies.

Automatic scheduling follows explicit placement. Hard constraints include source authorization, worker consent, freshness, required capabilities, available capacity, workspace readiness, and Git input availability. Reserve capacity atomically; scoring never replaces admission. Start with deterministic tie-breaking and explanations. Add GPU/model inventories or scoring only for shipped workloads that need them.

## 13. Persistence, repository integration, and service boundaries

Keep business logic under `src/main/services/`, shared contracts under `src/shared/`, and privileged operations behind existing IPC/preload. Prefer service subdirectories only when file count warrants them. Extend existing workspace, workflow, session, Git, and secret-storage facilities after auditing their semantics.

Hosted foundational tables inside an account object are account metadata, enrollments, sync state, entities, changes, and receipts. Workspace definitions are an entity type, not a second writable store. Add worker, job/attempt, approval, bounded event, handoff, and artifact-manifest tables through their internal gates. Local replica details never enter generic sync by accident.

Use account/entity, account/change-sequence, enrollment/sequence, target/queued-job, and attempt/event-sequence indexes. Avoid account-wide scans on heartbeat, progress, or claim. Do not publish heartbeat/lease updates as entity changes or persist ephemeral stream frames. One account counter is acceptable for low-rate metadata; do not turn it into a deployment-wide counter.

Keep Mesh backend/domain source under `anvil-app/cloud/` with a versioned build manifest, network schemas, account-object migrations, and dedicated backend tests. Put the reusable deployment lifecycle and Cloudflare resource support in `anvil-cloud/`, with a bounded Mesh recipe consuming the backend artifact. Preserve the existing independent workspace boundaries; the desktop does not import deployment tooling at runtime. Provider-neutral contracts may be published as a small package/artifact with no Electron or Cloudflare runtime dependency.

Observed integration constraints at the baseline commit:

| Existing code | Required action |
| --- | --- |
| `src/main/services/git.service.ts`, `repoIdFromPath` | Map portable repo IDs to local IDs; do not replace all foreign keys |
| `src/main/services/workspace.service.ts` and `workspace_repos` | Preserve multi-repo membership and add local mapping/adoption |
| `src/main/services/workflow.service.ts`, template save/delete | Add the outbox inside the original transaction boundary |
| `src/main/services/workflow.service.ts`, execution paths and interrupted-run recovery | Introduce per-attempt paths; preserve inspect-before-retry behaviour |
| `src/main/services/codex-session.service.ts` | Audit provider portability, process identity, environment, and startup recovery |
| `src/main/services/mobile-companion.service.ts` | Reuse suitable session/approval domain operations; reassess transport and auth |
| `src/main/services/settings.service.ts` | Serialize an allowlist; never sync the settings row |
| `src/main/db/schema.ts`, baseline version 66 | Add migrations from the current version at implementation time; never rewrite historical migrations |

Paths in this table are repository-relative to `anvil-app/`. They are integration evidence, not permission to refactor unrelated services.

## 14. Free-tier target, operating budget, and cost evidence

Target a complete, impressive launch experience. Aim for free-tier operation for personal use and a 100-active-account planning case. Also model 1,000 accounts and launch-day bursts. These are explicit modelling assumptions pending audience estimates, not a guarantee of free hosting at any user count.

For the managed service, free allowances are shared by the operator account, not granted anew to each Anvil user. A user deploying into their own Cloudflare account uses that account's allowances and pays its bills; the managed service does not proxy their coordination traffic. This is ownership, not a strategy of multiplying operator-controlled accounts to evade limits. Existing workloads, development deployments, identity provider, backups, monitoring, and artifact usage consume separate or shared budgets. External model/API usage remains on the executing device's configured provider and is excluded from backend-free claims.

### Current published allowances

| Provider/service | Free allowance relevant to Anvil | Main constraint |
| --- | --- | --- |
| Cloudflare Workers | 100,000 requests/day; 10 ms CPU/invocation | HTTP/auth/upload traffic and burst-day limits |
| SQLite Durable Objects | 100,000 request units/day; 13,000 GB-s/day; 5M rows read/day; 100,000 rows written/day; 5 GB total SQL storage | Active duration and indexed row writes, not just socket counts |
| R2 Standard | 10 GB-month storage; 1M Class A and 10M Class B operations/month; no egress charge | Retained artifact bytes and operation count |

Verified 11 September 2026. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

The free plans have hard limits. Exhaustion can fail shared operations, so free-tier eligibility is not production availability. The launch runbook must include operator-approved paid-plan activation before headroom becomes unsafe. Workers Paid starts at $5/month; it is not a promise that every workload costs $5. Do not sacrifice essential recovery, responsiveness, or cancellation to avoid this small base cost. [Workers paid plan](https://developers.cloudflare.com/workers/platform/pricing/).

### Cost boundary for user-owned deployments

The same official backend can serve a personal account or the managed user population. Size limits, recovery, and trust semantics are identical. Operators can tune quotas to their own plan; the desktop negotiates them without rebuilding. Self-hosting adds the operator's time for identity, updates, monitoring, and backup. Publish those obligations alongside the IaC, including the optional enrollment-code path that avoids a mandatory external identity subscription for personal use.

### Cloudflare planning scenarios

Assume three connected devices/account for eight hours/day, 100 portable edits/account/month, ten jobs/account/month, two running account-hours/account/month, and 30 days/month. A running account-hour means at least one job in that account is active; concurrent jobs on one account share object-duration accounting but still renew separate leases and produce separate effects.

For a conservative duration scenario, assume each running account object remains billable for the entire job period. Use 0.128 GB as in Cloudflare's pricing examples. Hibernation between frames may reduce this; external I/O, more observed time, or an implementation that prevents idle hibernation may increase total measured residency.

| Scenario | Personal/beta: 10 accounts | Launch case: 100 accounts | Growth case: 1,000 accounts |
| --- | ---: | ---: | ---: |
| Connected devices at common peak | 30 | 300 | 3,000 |
| Running account-hours/month | 20 | 200 | 2,000 |
| Job-duration scenario, GB-s/day | 307.2 | 3,072 | 30,720 |
| Share of DO free daily duration | 2.4% | 23.6% | 236.3% |
| Sync payload history, 90 days at 4 KiB/edit | 12.3 MB | 122.9 MB | 1,228.8 MB |
| Lease-row updates/day at 30 seconds, one active attempt/account | 80 | 800 | 8,000 |

These are partial resource estimates, not bills or capacity proofs. History excludes indexes, receipts, current entities, and events. Lease updates exclude index changes, audit rows, cleanup, multiple attempts, and alarms. If all connected account objects accidentally stay billable for eight hours/day, even 10 accounts consume 36,864 GB-s/day and exceed free duration. The hibernation test is a launch blocker.

Model actual row writes, not API calls. Count every modified index entry, receipt, change record, lease, cleanup delete, and alarm update. Do not persist live frames. A three-agent fan-out should add three bounded attempts, not three unbounded database streams. [SQLite row accounting](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

Incoming DO WebSocket messages receive a 20:1 request-billing ratio; outgoing messages are not billed as requests. This does not eliminate duration, storage, bandwidth processing, or application limits. For conservative free-tier capacity planning, also test raw event volume and confirm platform enforcement instead of assuming the ratio grants unlimited messages. [DO request metering](https://developers.cloudflare.com/durable-objects/platform/pricing/).

The 100-account scenario is plausibly within the free backend allowances with efficient hibernation and modest artifact retention. It is not proven until a workload replay measures all dimensions. The 1,000-account scenario should budget for paid usage. More signups can remain cheap if inactive; a smaller set of heavy users can cost more.

### Budget and implementation gates

Use a reproducible load harness with personal/100/1,000-account inputs, configurable watched hours, edit volume, concurrent attempts, artifact sizes, reconnect rate, and peak-day multiplier. Report Workers requests/CPU, DO requests/duration/rows/storage, R2 operations/storage, identity costs, and recovery/support incidents separately.

Stay below 50% of each free dimension in the measured target workload before calling it free-tier-safe. Alert at 50%, 70%, and 85%; require an operator decision before projected shared limits endanger accepted work. Per-account quotas and progress backpressure protect fairness but do not override platform hard limits. Keep headroom for cancel, approval, reconnect, and cleanup. If the provider rejects those too, the UI must report uncertainty rather than claim success.

```text
cash_cost = backend_plan + metered_requests + active_duration + row_operations
          + storage + artifact_operations + identity + monitoring + backups

TCO = cash_cost + engineering_hours × loaded_hourly_cost
               + support_hours × loaded_hourly_cost
               + attributable_device_compute_and_storage_cost
```

BACKEND-01 validates account transactions, hibernation, auth, recovery, and measured residency on the chosen Cloudflare architecture. Resolve failures inside this implementation and record any architectural change explicitly. BYOB-01/02 prove that the desktop depends only on the network contract, without adding another production backend to the project.

### Limits and operating policy

Initial configurable application quotas: 10 enrollments/account, 1,000 portable entities/account, 100 MiB retained sync history/account, 100 queued jobs/account, 1 MiB intermediate durable events/job, 10 MiB/artifact by default, 100 MiB cloud artifacts/account, and three parallel write attempts after local capacity opt-in. These are ceilings, not guaranteed free-tier allocations; aggregate storage controls must also apply. Larger checkpoint packages require an explicit quota/policy adjustment.

Keep sync recovery history for 90 days, intermediate events for seven days, and terminal job metadata/approval audit for 90 days. Artifact retention is defined in section 10. Bounded cleanup uses the account deadline alarm; it must not create an always-awake loop. Unmerged local work is excluded from automatic destructive cleanup.

Collect operation IDs and aggregate counters for outbox age, conflict/reset rate, receipt expiry, auth rejection, lease loss, unknown outcomes, setup failures, stream gaps, storage, and cost. Never collect prompts, paths, tokens, or raw output by default. Provide redacted diagnostic export and an operator procedure to inspect one account's metadata safely.

Measure a 24-hour idle fleet, watched/unwatched sessions, three-agent runs, reconnect bursts, and peak-day traffic. Verify idle hibernation, no durable ping writes, no unbounded queues, no persisted token streams, and no lease renewal without fenced ownership.

Under healthy connectivity, target p95 metadata convergence within five seconds, live activity within one second after device emission, readiness within 15 seconds, and cancellation acknowledgement within five seconds for a connected worker. These targets do not promise external-process termination within five seconds.

Before public launch, run a backup/restore drill. Target at most 24 hours lost accepted cloud metadata and at most one working day recovery initially. Verify actual provider recovery/export capabilities and publish limitations. Store deletion/enrollment generations so restore cannot revive revoked authority; rotate dataset epoch, invalidate leases, and reconcile local state. Recovery tooling and artifact retention must be included in the free-tier budget rather than omitted to produce a smaller estimate.

## 15. Implementation packets and dependency order

Packet IDs below replace the old ticket list for planning. They are proposed identifiers, not claims that tracker issues exist.

| Packet | Deliverable | Depends on | Gate |
| --- | --- | --- | --- |
| PLAN-01 | Persistence/identity audit and architecture decisions | Baseline inspection | All portable fields and write paths classified |
| PLAN-02 | Protocol schemas, state transitions, replay and reset fixtures | PLAN-01 | No unresolved foundational sync semantics |
| BACKEND-01 | Worker/account-object spike and hibernation/load proof | PLAN-02 | Auth, transactions, eviction, burst and free-budget evidence |
| SYNC-01 | SQLite bindings, outbox, workflow transaction integration | PLAN-02 | Real SQLite crash/restart tests |
| AUTH-01 | Generic OIDC/code enrollment and device-session contract | PLAN-02 | Auth, revocation, refresh recovery, and credential isolation proven |
| BYOB-01 | Frozen wire bundle, discovery, built-app generic backend connection | PLAN-02, AUTH-01 | Schema/version negotiation and no executable provider code |
| SYNC-02 | Account-object push, pull, scan, receipts, limits, and invalidation | BYOB-01, BACKEND-01 | Tenancy and replay conformance |
| SYNC-03 | Engine, conflict handling, adoption/account lifecycle UI | SYNC-01, SYNC-02, BYOB-01 | G1 two-profile acceptance suite |
| OPS-01 | Metering harness, quotas, retention, restore drill | SYNC-02, BACKEND-01 | Cost and restore evidence before public launch |
| IAC-01 | Anvil Cloud Mesh recipe, stateful Cloudflare lifecycle, connection export | BACKEND-01, BYOB-01 | Plan/apply/retry/upgrade/retain/remove with provider evidence |
| ENTITY-01 | Editable-agent, workspace, and allowlisted settings adapters | SYNC-03 | Privacy, references, versions, and migration tests |
| WS-01 | Definition adapter and existing-checkout mapping | ENTITY-01 | Local IDs and multi-repo membership preserved |
| WS-02 | Journalled single and multi-repo clone, linking, and safe removal | WS-01 | Collision/crash/partial-clone/removal tests |
| WS-03 | Bootstrap policy, approvals, verifier, progress UI | WS-02 | Unknown outcomes never auto-replayed |
| SESSION-01 | Session/provider portability and process-start audit | PLAN-01 | Adapter capability matrix before remote design freeze |
| MESH-01 | Local opt-in, source authorization, worker lifecycle/mailbox | AUTH-01, OPS-01 | Revocation and incarnation tests |
| MESH-02 | Attempts, leases, admission, diagnostic job, cancellation | MESH-01 | Partition and stale-completion tests |
| MESH-03 | Live observation, durable approvals, R2 artifacts/checkpoints | MESH-02, BACKEND-01 | Reconnect, expiry, authorization, and rate-limit tests |
| SESSION-02 | Remote prepare/start using typed jobs | WS-03, SESSION-01, MESH-03 | G3 remote start and control gate |
| SESSION-03 | Exact Git checkpoint and ownership handoff | SESSION-02 | No dual activation across crash cases |
| FLOW-01 | Per-attempt local worktrees and result manifests | SESSION-01, WS-02 | Concurrent writes isolated; recovery preserves work |
| FLOW-02 | Remote nodes and result transfer | FLOW-01, SESSION-02 | Parent restart and cancellation propagation |
| FLOW-03 | Fan-out integration and verification | FLOW-02 | Integrated result independently verified |
| PLACE-01 | Capability matching and automatic placement | MESH-02, FLOW-02 | Reservations and explainable decisions in the launch demo |
| BYOB-02 | Conformance runner, non-Cloudflare fixture, versioned builder prompt | BYOB-01, SESSION-03, FLOW-03, PLACE-01 | Same unmodified desktop artifact connects to compatible implementation |
| IAC-02 | Clean-account self-deployment and upgrade/restore rehearsal | IAC-01, OPS-01, BYOB-02 | No managed Anvil identity or runtime dependency |
| LAUNCH-01 | Integrated UX, device matrix, recovery and demonstration acceptance | All preceding launch packets | Section 1 journey and section 18 acceptance pass |

G1 is the internal sync foundation, not the public deliverable. All launch packets through LAUNCH-01 must pass before the substantial release. Implement single-repository, explicit-placement, and diagnostic paths first as testable foundations, then complete the multi-repo, automatic-placement, live-observation, handoff, and fan-out launch requirements. Own-Cloudflare IaC and compatible-backend support in the unmodified app are also launch requirements. Do not silently move those capabilities out of launch scope to meet a date or free-tier ceiling.

Independent packets may run concurrently after required contracts merge. Do not create an agent per architectural noun. An implementer and an independent reviewer are normally enough for a packet; add parallel implementers only for disjoint work with merged dependencies.

Each packet records objective, dependency commit SHAs, contract versions, acceptance fixtures, allowed areas, shared-file owner, migration owner, prohibited changes, validation commands, and expected output. If a dependency changes, rerun conformance and rebase before integration. Shared schema, preload, IPC declarations, and startup wiring have one integration owner.

Use one worktree/branch per implementation packet. Follow repository branch conventions, such as `feature/<actual-issue-id>--<description>`, with real issue IDs when available, and Conventional Commits. Confirm the base if work begins off main/develop. Do not overwrite unrelated work or reinterpret an ambiguous contract privately.

### Old-plan disposition

- Fold SYNC-010 through SYNC-015 into versioned contracts, but freeze each contract before its dependent packet starts.
- Replace generic `sync_entities` local duplication with domain adapters plus acknowledged-base bindings.
- Fold SYNC-047 workspace writes into the entity protocol. Keep read projections only where useful.
- Move SESSION-010 portability audit to SESSION-01 before remote implementation.
- Move presence, trust, admission, and jobs ahead of remote session placement.
- Replace SESSION-012's start-target-then-mark-origin flow with ownership transfer.
- Replace WS-007 download-style removal with ownership-aware detachment/deletion.
- Move per-attempt worktree isolation ahead of remote fan-out.
- Include capability discovery needed for the launch, simple explainable placement, and live observation. Defer exhaustive model inventories, encrypted secret sync, a separate OS daemon, a general remote shell, and multiple production backend implementations.

## 16. Verification and release acceptance

Use real temporary SQLite for transactions and migrations, backend integration tests for tenancy and sockets, and two isolated Electron profiles for end-to-end reconciliation. Test the built release-candidate app against managed, user-deployed Cloudflare, and non-Cloudflare conformance backends. Documentation, published schema, and executable fixtures must agree. Test supported OS/toolchain combinations before claiming cross-platform materialisation. Do not replace migration testing with mocked repositories.

| Failure/attack | Required observable outcome |
| --- | --- |
| Process dies after local domain write | Domain and dirty intent either both committed or neither did |
| Server accepts push; acknowledgement lost | Same sequence returns original receipt or safe expired-receipt recovery |
| Edit occurs while push is in flight | New local generation remains visible and queued |
| Concurrent edits or edit/delete | Base/local/remote preserved; explicit resolution |
| Device offline beyond retention | Rebuild acknowledged base; preserve edits; no resurrection |
| Snapshot races creates/updates/deletes | Catch-up produces complete state without rollback |
| Unknown schema or oversized payload | Preserved locally/quarantined; unrelated entities proceed |
| Sign-out or account switch during request | Old callbacks cannot modify the new namespace |
| Deleted account or restored backup | Stale uploads and leases rejected; recovery is explicit |
| Spoofed owner/device or revoked subscription | No access without current account and enrollment authorization |
| Synced path traversal/credential URL/recipe change | Rejected or awaiting new local approval before effects |
| Crash after clone or during bootstrap | Reconcile owned files; non-idempotent uncertainty requires inspection |
| Removal of linked/shared/dirty checkout | Detach or refuse deletion; preserve user work |
| Duplicate start or crash around spawn | Reconcile stable attempt; never silently duplicate process |
| Worker sleeps, partitions, or loses lease | Stop new work; reject stale publication; no automatic coding reassignment |
| Cancel races completion | Defined conditional outcome, with partial effects visible |
| Crash at every handoff transition | At most one authorized active generation; unknown process state blocks activation |
| Provider thread unavailable on target | Supported continuation mode or specific refusal |
| Parallel agents and integration conflict | Separate checkouts; preserve branches; verify merged result |
| Idle fleet and observer reconnect storm | Bounded traffic, queues, retention, and jittered retries |
| Backend URL or identity issuer changes | Review identity and reconcile a new namespace; never replay old credentials/outbox |
| Malicious discovery/connection descriptor | No script execution, credential redirection, or automatic upload |
| Interrupted IaC apply or upgrade | Preserve resource identity/data; reconcile receipts without duplicate resources |
| Custom backend through frozen contract | Same binary, no provider plugin, explicit advertised capability limits |

Failure injection should cover every durable boundary surrounding external effects, not literally every `await`. Include process death, SQLite commit boundaries, dropped acknowledgements, subscription loss, server clock/epoch changes, and app sleep/wake.

Every packet reports changed behaviour, acceptance evidence, relevant existing test results, failure cases, and unresolved limitations. Run focused tests, lint, types/build as appropriate to touched areas. Critical/high reliability or trust failures block the public launch. Avoid tests that only mirror implementation or unrelated refactors.

## 17. Decisions requiring evidence before launch

These are bounded validation tasks, not permission for implementers to choose conflicting private designs.

| Decision | Default in this spec | Evidence required |
| --- | --- | --- |
| Identity and device transport | OIDC/code enrollment into uniform device sessions | AUTH-01 desktop security and retry/rotation tests |
| Hosted backend | Cloudflare Worker, account DO SQLite, R2 | BACKEND-01 correctness, hibernation, auth, and TCO evidence |
| User-owned deployment | Anvil Cloud recipe plus generated provider configuration | IAC-01/02 clean deployment, upgrade, restore, safe removal |
| Third-party backend | Frozen protocol and built-app generic client | BYOB-01/02 conformance and signed-artifact acceptance |
| Free-tier claim | Target personal and 100-account workload; model 1,000 | All dimensions and launch-day headroom measured |
| Supported Git/OS cases | Common single/multi-repo clean reachable commits | WS-02 platform matrix and unsupported-case UX |
| Handoff mode | At least one verified provider continuation mode | SESSION-01 matrix and complete ownership-recovery tests |
| Live output | Ephemeral socket frames plus durable checkpoints | MESH-03 latency, privacy, replay, and budget evidence |
| Placement | Simple deterministic matcher and reserved capacity | PLACE-01 explanations and race tests |

## 18. Launch acceptance and demonstration quality

Release only after the full section 1 journey passes on real supported devices from clean profiles. Internal gates organise implementation; they do not reduce launch scope.

- A fresh device can discover and set up a workspace without manual database edits or unexplained terminal commands.
- A user-owned Cloudflare backend deploys through the published IaC and connects to the same signed app. No Anvil-hosted account or service is required for its ongoing operation.
- A third-party backend passes the published profile conformance suite and connects by URL through the installed app. The bundled integration prompt names the exact schema version and digest.
- Setup shows concrete stages, byte/progress information where available, actionable failures, and retry state that survives restart.
- The session view keeps target device, connection freshness, pending approvals, live activity, and stop controls visible. A lost connection never looks like successful cancellation.
- Handoff shows which device owns execution and whether continuation is native or checkpoint-based. It never claims to migrate an unsupported live process.
- A three-agent run shows distinct worktrees, devices, dependencies, and actual results. The final review identifies the tested combined commit and reports failures honestly.
- All advertised Git/provider/platform combinations pass the same acceptance suite. Test at least two physical machines and a supported cross-OS path; publish the tested matrix.
- A recorded short demo uses production feature paths and representative accounts. Cold setup and elapsed time are labelled honestly if edited for length.
- Empty/loading/offline/error/approval states, keyboard access, readable contrast, and reduced-motion behaviour are complete. Avoid rendering an operational graph so dense that the outcome is unreadable in a video.
- Launch-day admission, abuse/rate limits, quota alerts, paid-plan runbook, rollback, and backup recovery are rehearsed. A spike in signups must not silently threaten accepted jobs.

Backend frugality supports the product. It does not justify removing the capabilities that make the launch compelling or weakening their correctness.
