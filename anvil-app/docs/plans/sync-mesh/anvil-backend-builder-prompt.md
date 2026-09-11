# Build a compatible Anvil backend

Reusable agent prompt for the planned `Copy integration prompt` action.

This prompt accompanies a frozen protocol bundle. The current integration contract is a draft; the machine-readable schemas and runnable conformance suite still need implementation. Do not use this prompt to claim compatibility without that bundle and an actual desktop test.

Copy the following prompt, filling the input fields. The released app should fill its version, protocol range, and bundle digest automatically.

---

Implement a backend that an existing, unmodified Anvil desktop distributable can connect to.

Inputs:

- Anvil app version/build: `<installed app version>`
- Contract bundle path/version/digest: `<bundle supplied by Anvil>`
- Backend repository: `<repository or new project directory>`
- Chosen hosting provider and database: `<operator's choice>`
- Required profile: `<sync/1 or sync/1 plus mesh/1>`
- Public base URL or intended domain: `<HTTPS endpoint>`
- Supported authentication mode: `<oidc-pkce or enrollment-code>`
- Scale, retention, and budget constraints: `<operator's values>`

The app already implements the network contract. All provider-specific integration belongs on the backend or in a server-side gateway. Do not fork, patch, rebuild, or install executable provider plugins into Anvil. Do not require an Anvil-hosted account or service for a self-owned deployment.

## Establish the contract

Read the frozen bundle's OpenAPI, JSON Schemas, protocol semantics, fixtures, conformance runner, and supported app versions. Verify the supplied digest/provenance according to the bundle instructions. If any required artifact is missing, request the actual bundle and identify what is unavailable. Do not infer missing wire fields from examples or invent a replacement protocol.

Inspect the target repository and its instructions. Identify existing auth, transactional persistence, migration, WebSocket, and artifact facilities. Reuse them where they satisfy the contract. If the backend cannot provide required conditional updates or recovery semantics, explain the gap and make a concrete backend-side plan; do not weaken the client contract.

Produce a short mapping of protocol operations to backend modules and storage. State unsupported optional capabilities explicitly. Implement only advertised profiles. For a Mesh implementation, generic CRUD over job rows is insufficient.

## Implement

1. Discovery and compatibility negotiation. Return only supported profiles, versions, limits, and supported auth metadata. Keep credentials out of discovery and connection files.
2. Enrollment and device sessions. Use the frozen supported flow, bind credentials to account/enrollment/generation, secure refresh/revocation, and enforce per-operation authorization. Keep cloud admin credentials separate.
3. Durable sync. Implement conditional revisions, atomic entity/change/receipt writes, sequence-based replay protection, cursor pagination, consistent reconciliation scans, tombstones, retention resets, conflict responses, and account/backend isolation.
4. For `mesh/1`, implement worker incarnation, target/source permissions, job idempotency, capacity reservations, fenced claims/renewals/results, cancellation intent, durable approvals, and source-quiescent handoff. Never claim exactly-once arbitrary external effects or automatically rerun uncertain coding jobs.
5. Live observation. Implement the specified socket handshake and frames, expiry/revocation, bounded queues, invalidations, replay/gap handling, and durable outcome recovery. Keep ephemeral activity separate from authoritative state.
6. Artifact transfer. Enforce account/attempt ownership, reservations, byte limits, digest validation, private streaming, retention, and orphan cleanup. Do not upload repositories or secrets automatically.
7. Operations. Add migrations, backup/restore with epoch reset, quotas, redacted diagnostics, rate limits, and deployment configuration appropriate to the chosen provider.

No unauthenticated production mode, wildcard ownership bypass, TLS bypass, hidden destructive cleanup, or logging of credentials/prompt content. Do not silently send requests to an Anvil-hosted service as a substitute for missing backend functionality.

## Verify behaviour

Run the official standalone conformance suite against disposable test accounts. Test process restart, lost acknowledgements, duplicate delivery, concurrent updates, expired receipts, tombstone expiry, account deletion/recreation, cross-tenant spoofing, enrollment revocation, malformed/oversized payloads, and mixed versions.

For Mesh, also test stale workers, lease loss, duplicate process-start requests, cancellation/completion races, approval expiry, interrupted handoff at each transition, artifact access after revocation, and live reconnect with missing frames. Use explicit test-mode fault injection or equivalent controlled infrastructure tests; do not run destructive tests against an operator's production account.

Connect the supplied unmodified Anvil distributable to the backend URL. Prove sign-in/enrollment, sync between two isolated profiles, offline edit recovery, and every advertised Mesh capability on supported devices. If the binary is unavailable, report this acceptance step as unverified and provide exact reproduction instructions. Do not claim end-to-end compatibility from passing HTTP smoke tests alone.

Measure the workload against the operator's limits. Count fan-out, storage, active connection duration, cleanup, and artifact traffic, not just API request totals. Report observed performance and remaining headroom without claiming an untested free-tier guarantee.

## Deliver

- Backend implementation and deployment configuration.
- Credential-free connection descriptor for import into the built Anvil app.
- A separately delivered enrollment/sign-in procedure, with secrets omitted from normal logs and artifacts.
- Supported protocol/profile versions and contract digest.
- Conformance results and unmodified-app acceptance evidence.
- Backup, restore, upgrade, rollback, revocation, and safe removal instructions.
- Known limitations, measured operating cost, and remaining unverified checks.

Do not deploy to a paid account, publish externally, or destroy existing resources unless the operator has authorized those actions. Prepare the exact deployment plan and report any required decision. Existing explicit authorization remains valid; do not ask for it again.

---

The official app-generated prompt should pin an immutable contract bundle. A link to a changing branch is insufficient for compatibility with an installed binary.
