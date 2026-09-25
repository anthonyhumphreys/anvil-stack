# Anvil backend integration contract

Draft v1 specification, 11 September 2026.

This defines the backend extension boundary for the planned Anvil Sync & Mesh launch. It is not a claim that the current released app or a runnable conformance package already implements it. The launch must ship the machine-readable contract and the generic client described here. After that, a compatible backend connects to the existing signed app without rebuilding it.

## 1. Product contract

The same built Anvil distributable supports:

| Connection | What the user supplies | What runs on the user's devices |
| --- | --- | --- |
| Anvil-hosted | Hosted sign-in | The standard app and its local worker |
| Own Cloudflare | A deployment of the official backend and its connection descriptor | The same standard app and worker |
| Compatible backend | A base URL and a supported sign-in/enrollment method | The same standard app and worker |
| Local only | Nothing | Existing local functionality |

Self-hosted deployments do not require an Anvil-hosted account, licensing heartbeat, hosted discovery directory, or credential relay. The backend operator chooses identity and infrastructure. Git and model-provider access remain configured on the executing device.

The extension is a network protocol. The app does not download backend-supplied JavaScript, load an npm adapter, execute setup instructions, or install a new Electron plugin. Providers translate their own infrastructure and data model to the contract on their server. A gateway in front of an existing backend is acceptable.

Only capabilities already understood by the installed app can be enabled. A backend cannot add a new native feature through metadata. A new wire major version, authentication flow, or UI capability may require an app update; a new implementation of the existing contract does not.

## 2. Discovery and connection

The user enters the backend's HTTPS origin or imports a small JSON connection descriptor. A path-hosted installation must expose discovery at the configured base path. The discovery route is `<base>/.well-known/anvil-backend`, with no authentication and no sensitive data.

Proposed example, to be frozen into JSON Schema before the client ships:

```json
{
  "descriptorVersion": 1,
  "deploymentId": "b98d55a2-8615-46e4-b2bd-182826ee83f1",
  "displayName": "Anth's Anvil",
  "protocols": ["anvil-backend/1"],
  "profiles": ["sync/1", "mesh/1"],
  "apiPath": "v1",
  "socketPath": "v1/connect",
  "authModes": ["oidc-pkce", "enrollment-code"],
  "auth": {
    "issuer": "https://identity.example.org",
    "publicClientId": "anvil-desktop",
    "scopes": ["openid", "profile"]
  },
  "limits": {
    "entityBytes": 65536,
    "pageBytes": 262144,
    "batchChanges": 50,
    "liveFrameBytes": 16384
  }
}
```

All sizes are UTF-8 byte limits, not character counts. The app applies the stricter of its own limits and the negotiated server limits. Normalize the entered base URL to a trailing slash and resolve API/socket paths relative to it, with no parent traversal, scheme, authority, query credentials, or leading slash. They remain within the selected HTTPS origin and base path, using WSS for sockets. Do not accept a descriptor that silently redirects data or credentials to another backend origin. An explicitly displayed OIDC issuer may differ because it is the user's chosen login authority.

The descriptor is untrusted configuration until the user reviews the endpoint, identity issuer, advertised capabilities, and data-sharing categories. TLS authenticates the origin; `displayName`, `deploymentId`, and a claimed compatibility badge do not establish trust. An import file contains endpoint metadata only, never API keys, enrollment codes, shell commands, or an instruction to upload data.

Permit plain HTTP only for explicitly selected loopback development endpoints. Private network backends can use HTTPS with an OS-trusted private CA. Never ship an automatic certificate-verification bypass. Discovery fetches are bounded by timeout/size, do not follow arbitrary redirects, and do not probe addresses suggested by an untrusted remote descriptor.

After authentication, obtain the stable account ID, dataset epoch, current enrollment, supported entity schemas, and effective limits through the session/bootstrap operation. Those are authenticated state, not public discovery data. Pin the origin and deployment ID together; a changed deployment ID or issuer requires reconnection review and a new/reconciled namespace.

## 3. Connection UX in the distributable

Settings → Sync & Mesh → Backend offers `Anvil-hosted`, `My Cloudflare deployment`, and `Compatible backend`, alongside `Local only`.

For a custom endpoint:

1. Enter URL or import a connection file.
2. Fetch and validate discovery, then show capabilities and identity authority.
3. Sign in through a supported method and enroll this device.
4. Run read-only compatibility checks. Explain that these do not certify server honesty or crash safety.
5. Preview which existing local entities will be associated and uploaded.
6. Enable Sync. Enable Mesh separately with target-local source trust and execution permissions.

Provide `Copy integration prompt` and `Download contract bundle`. Both are pinned to the protocol version understood by this exact app build. Contract documentation must also be accessible offline from the bundle.

Support one active backend association per local profile at launch. Switching pauses the old connection and preserves its outbox, conflicts, credentials, and provenance separately. Never point an existing cursor at a new backend. Export/import is an explicit migration, not a URL edit. Other devices must connect to the same backend/account for Mesh; independent backends do not federate automatically.

If the backend advertises only `sync/1`, show Sync functionality and mark Mesh unavailable. The full official backend implements both profiles and all launch capabilities. If a custom backend drops a required capability during execution, stop new related dispatch and preserve unresolved attempts instead of pretending they finished.

## 4. Fixed authentication methods

The built client implements exactly two initial enrollment methods:

- `oidc-pkce`: system-browser authorization code flow with PKCE S256, issuer/state/nonce/audience validation, and a provisioned public desktop client. The backend validates the resulting proof at enrollment. No client secret is embedded in the app. Freeze supported redirect forms and port rules in the contract bundle; a custom provider configures its identity provider to those forms instead of requesting client code changes.
- `enrollment-code`: a backend-admin-issued, short-lived, single-use code entered into the app. It authorizes enrollment into a specific account and exchanges for renewable device-scoped credentials. The public endpoint cannot mint unrestricted codes. Codes are rate-limited, expire, and are never retained in sync data. This permits personal installations without a third-party OIDC dependency.

After either enrollment method, the backend issues a uniform short-lived access token plus rotating refresh credential bound to account, enrollment, and credential generation. OIDC credentials and enrollment codes are proofs used at the enrollment boundary, not generic cloud admin credentials. API authorization derives identity from the resulting device session; caller-supplied owner/device IDs never override it.

The normal API transport uses `Authorization: Bearer <device-access-token>`. Refresh is a fixed authenticated endpoint with rotation/reuse rules. Use a maintained auth/session implementation where possible. Access/refresh lifetime, lost-response recovery, retry grace, and reuse detection must be specified by AUTH-01 and covered by fixtures before v1 freezes. Do not improvise a new token format or cryptographic algorithm.

Device revocation rejects new requests, closes matching sockets, and invalidates refresh. A new enrollment does not inherit permission to execute on existing devices. All secrets stay in OS-protected main-process storage. Cloudflare API tokens and deployment credentials never enter the Mesh session contract.

Native-app browser login and authorization-server metadata follow the relevant standards. [Native-app OAuth](https://www.rfc-editor.org/rfc/rfc8252), [Authorization-server metadata](https://www.rfc-editor.org/rfc/rfc8414).

## 5. Transport and versioning

The frozen v1 contract must include these route families. Operation names below are the proposed wire inventory; complete request/response schemas are a launch deliverable, not left to provider authors to guess.

| Route | Purpose |
| --- | --- |
| `GET <base>/.well-known/anvil-backend` | Bounded public discovery |
| `POST <api>/enroll` | Exchange supported proof into a device enrollment/session |
| `POST <api>/session/refresh` | Rotate device session credentials |
| `POST <api>/session/revoke` | Idempotently revoke this device session |
| `POST <api>/rpc` | Versioned typed operations for durable state |
| `GET <socket>` with WebSocket upgrade | Invalidation, live activity, and observer subscription |
| `PUT/GET <api>/artifacts/{artifactId}/content` | Authorized bounded streaming, backed by an artifact manifest |

Use one request/response envelope for RPC:

```json
{
  "protocol": "anvil-backend/1",
  "requestId": "e672c524-bc21-4b24-8646-0e9ee7bdd79e",
  "operation": "sync.pull",
  "params": {"cursor": null, "maxBytes": 262144}
}
```

Success returns the same `requestId`, `result`, and `serverTime`. Error returns the same ID where available and `{code, retryable, retryAfterMs?, details?}`. Define parameterized error schemas. Messages are sanitized plain text and never scripts or remediation commands to execute automatically.

The HTTP status and error code must agree. Use 401 for expired/invalid session, 403 for policy denial, 409 for a top-level conditional conflict, 413 for oversized requests, 429 for throttling, and 503 for retryable unavailability. Domain push batches retain per-item outcomes in a successful envelope; they are not automatically all retried because one item conflicted. Specify malformed-request and unsupported-version errors in the bundle.

Request IDs correlate calls. Each mutating operation additionally defines its durable idempotency scope and payload digest; transport retry does not mint a new business operation. Unknown outcomes are queryable. An implementation must not infer exactly-once external effects from HTTP idempotency.

Freeze a major version and additive minor policy. Unknown optional response fields are ignored, unknown operations fail explicitly, and unsupported required capabilities fail before execution. Entity schemas have their own versions. Publish a minimum supported protocol window for server upgrades. A backend may support old and new versions concurrently; it cannot demand that a released binary reinterpret existing fields.

## 6. Capability profiles and operation inventory

`sync/1` requires discovery, either supported authentication method, secure enrollment, account/backend namespace isolation, sync, export/import, and version handling. `mesh/1` requires `sync/1` plus all execution, observation, handoff, and artifact operations below. Providers can advertise optional implementation details for diagnostics, but desktop behaviour uses protocol capabilities, not provider names.

| Family | Operations to freeze | Required semantics |
| --- | --- | --- |
| Session/account | `session.describe`, `account.delete`, `account.deletionStatus` | Authenticated identity/epoch; retryable purge; stale enrollment rejection |
| Devices | `device.list`, `device.rename`, `device.revoke`, `device.policy.publish` | Bound enrollment, generation, source trust; local permissions cannot be enabled remotely |
| Sync | `sync.push`, `sync.pull`, `sync.scan.begin`, `sync.scan.page`, `sync.scan.finish` | Conditional revisions, ordered change log, receipts, retained base, reset protocol |
| Data portability | `data.export.begin`, `data.export.page`, `data.import.preview`, `data.import.commit`, `data.operationStatus` | Versioned portable entities and mappings; preserve conflicts; no live lease migration |
| Worker | `worker.connect`, `worker.describe`, `worker.capabilities.publish`, `worker.replica.publish` | Incarnation ownership, bounded metadata, observed freshness |
| Jobs | `job.create`, `job.get`, `job.list`, `job.claim`, `attempt.renew`, `attempt.report`, `job.cancel` | Target resolution, source-scoped idempotency lookup via optional `job.list.requestId`, capacity, fence, immutable input manifest, uncertain effects |
| Events/control | `event.pull`, `approval.get`, `approval.decide` | Durable sequence, gap markers, scoped expiring action approval |
| Handoff | `handoff.create`, `handoff.get`, `handoff.advance`, `handoff.cancel` | Server-validated state transitions; source relinquishment before target activation |
| Artifacts | `artifact.reserve`, `artifact.finalize`, `artifact.get`, `artifact.list`, `artifact.delete` | Account/attempt ownership, byte limits, checksum, retention, deletion recovery |

Different operations require different actor roles. A user controller cannot report another worker's stopped state. A worker cannot self-authorize a bootstrap approval. `handoff.advance` and `attempt.report` validate permitted transitions and expected generations; they are not generic patch endpoints. `device.policy.publish` publishes the current enrollment's local policy only, never arbitrary settings for another target.

Readiness probes are bounded diagnostic jobs. Placement resolves in the coordinator with explicit explanation and capacity reservation. Live frames are not accepted as authoritative lifecycle transitions. Use the main Sync & Mesh spec for reconciliation, crash, Git, lease, and handoff invariants.

## 7. Socket contract

The native main-process client opens WSS using the device bearer in an authorization header and a fixed subprotocol, `anvil.mesh.v1`. No tokens appear in the URL. Browser-only clients are not assumed by this contract. If a deployment proxy cannot support the chosen upgrade/auth scheme, adapt the proxy rather than supplying executable client glue.

Frames have a versioned type, correlation or stream ID, and a schema-bounded payload. Initial frame types are `hello`, `subscribe`, `unsubscribe`, `sync.invalidate`, `worker.available`, `job.available`, `activity`, `gap`, `auth.expiring`, and `error`. Freeze their schemas, subscription scopes, maximum sizes, and ordering in the bundle.

Authentication expires even while connected. Notify the client before expiry, refresh via HTTPS, and reconnect with a fresh bearer. Enforce expiry at the server and reject incoming operations immediately when expired; timely close is additional cleanup, not the only check. Reconstruct authorization after process restart or Durable Object hibernation.

The socket only accelerates delivery. Durable job reads and event cursors recover missed notifications. Activity frames carry attempt ID, execution generation, stream ID, and sequence. A gap is explicit. A provider may coalesce ephemeral frames but cannot discard accepted durable events or approvals to fake compatibility.

## 8. The contract bundle shipped with Anvil

Release a version-pinned, redistributable bundle accessible from the app and the backend release artifact:

- Protocol prose with ownership, conflict, replay, reset, and recovery state machines.
- OpenAPI 3.1 for HTTP routes and JSON Schemas for RPC operations, errors, entities, and socket frames.
- Examples/golden fixtures, including invalid and oversized payloads, expressed in provider-neutral IDs.
- A standalone conformance runner using the same schemas and expectations as the app.
- A fake backend for desktop tests, with deterministic failure injection and connection loss.
- The integration prompt in the companion document, filled with bundle version and selected capabilities.
- A schema/bundle digest plus provenance for official release artifacts.

Only the frozen published bundle is a compatibility promise. Tests must check state-machine behaviour, not just whether example JSON parses. Docs and test fixtures are generated or checked from one source of truth. The draft operation inventory must be expanded and resolved before publishing v1.

The prompt helps an agent implement an integration; the bundle and conformance suite determine whether it is compatible. A generated implementation is never certified merely because an agent says it is complete.

## 9. Backend conformance and binary acceptance

The standalone suite runs against disposable test accounts in an explicit test deployment. It creates and removes fixtures; it must never run destructive tests against a user's production data by default. The in-app connection test is limited to safe negotiation/auth/readiness checks unless the user explicitly starts a disposable test.

Required suites cover tenant/device spoofing, revocation and refresh, cross-backend credential isolation, concurrent edits, edit-in-flight acknowledgement, duplicate requests, expired receipts, retention reset, mixed versions, process restart, stale attempts, cancellation races, quiescent handoff, artifact authorization, and bounded stream reconnect.

Provider implementations supply deterministic fault-injection hooks in test mode only or equivalent controlled infrastructure restart tests. Verify durable effects across restarts using an external observer. A backend claiming `mesh/1` must prove the complete Mesh state machine, not just `job.create`.

Test the actual signed/release-candidate desktop artifact against:

1. The managed official backend.
2. A fresh user-owned Cloudflare deployment from the IaC package.
3. A non-Cloudflare fixture/reference backend using another persistence implementation and the same frozen network contract.

The third is a conformance reference for portability, not a second production service that Anvil must operate. It may be a small local SQLite/HTTP/WebSocket server for isolated testing. The test fails if any endpoint-specific desktop patch or rebuilding is required. All three use the same profile-specific capability negotiation and local execution policy.

Custom backend operators own their uptime, backup, upgrades, quotas, and identity service. Anvil owns the published client contract and its reference implementation. The app shows protocol compatibility and tested versions without implying endorsement of an arbitrary operator.

## 10. Own-Cloudflare deployment through Anvil Cloud

Ship the official backend as a versioned deployment recipe consumable by `anvil-cloud`, plus its generated, inspectable Cloudflare configuration. Hosted and user-owned deployments use the same worker code and schema migration lineage. Only configuration and ownership differ.

Current repository evidence at commit `3ff60e23557fb2dcafcde626e8df145d502a7ab2`:

| Existing component | Current support | Work required for this recipe |
| --- | --- | --- |
| `anvil-cloud/packages/deployment` | Provider-neutral plan/review and conformance metadata | A pinned backend-package deployment input and resource lifecycle contract |
| `anvil-cloud/packages/cloudflare` | Plan-only CLI adapter and experimental stateless Worker verification | Durable Object bindings/classes, R2, secret/auth configuration, stateful upgrades |
| `packages/cloudflare/src/artifacts.ts` | Worker bundle and Wrangler config generation | Preserve coordinator class exports, SQLite migration lineage, and bindings |
| `packages/cloudflare/src/support.ts` | Fails closed for unsupported stateful features | Enable each supported recipe capability only after its conformance gate |
| `packages/cli/src/deployment-adapters.ts` | Cloudflare lifecycle marked `plan-only` | Plan/apply/inspect/upgrade/rollback/remove with real provider evidence |

The current generic Cell database mapping targets D1. Mesh requires account-scoped transactional state and hibernating sockets; do not pretend a D1 table capability provides those semantics. Add a bounded platform-owned deployment recipe for the Mesh backend using the existing deployment/artifact machinery. Keep provider-specific provisioning in the Cloudflare adapter and backend package, not in user Cell source. Do not require implementing every Anvil Cloud runtime capability to ship this recipe.

Anvil Cloud's existing agent-execution control plane has related idempotency, cursor, lease, and cleanup contracts. Audit and reuse proven definitions/tests where they match. Do not conflate its AWS sandbox execution restrictions with execution on a user's enrolled local device, and do not weaken existing AWS policy to support Mesh.

### Package and lifecycle requirements

The package pins backend version, contract digest, Worker bundle digest, compatibility date, required CLI version, coordinator class identities, storage migration lineage, bindings, artifact bucket settings, auth configuration, resource ownership, and default quotas. Cloud credentials remain local to the deployment tool.

The IaC flow must:

1. Authenticate to the user's permanent Cloudflare account and validate required permissions/resources.
2. Produce a stable, reviewable plan with ownership, cost drivers, identity method, migrations, and any destructive changes.
3. Apply idempotently, journalling provider operations and recovering partial completion without replacing existing namespaces or buckets.
4. Configure a chosen identity provider or the supported personal enrollment-code flow. Never leave the API open for convenience.
5. Run health and contract checks against disposable fixtures, then print a credential-free connection descriptor and a deployment receipt.
6. Enroll the user's first device through a locally delivered one-time code or browser sign-in. Do not embed that proof in the reusable descriptor or standard `--json` output.
7. Inspect drift, upgrade compatible schema versions, back up, and restore using documented commands with structured results.
8. Retain stateful resources by default on removal. Destruction requires an explicit resource-specific plan and confirmation. Code rollback is allowed only when compatible with the current data schema; an irreversible data migration does not have a fictional automatic rollback.

User-owned deployments retain stable deployment IDs and resource names across routine upgrades. A new backend namespace is a migration event, not an accidental consequence of renaming a CLI project. Preserve Durable Object class/storage identity through deploys. [Cloudflare configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [Durable Object class/migration guidance](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).

Publish a generated Wrangler route using the same artifacts as a recovery/manual deployment path, rather than maintaining a separate Terraform and Pulumi implementation. Anvil Cloud orchestrates deployment; the running backend must not depend on the deployer's machine or an Anvil-hosted control service remaining online.

Anvil Cloud commands for this recipe must be documented only once implemented. Do not present the existing plan-only CLI as a working deploy command. Add the recipe/lifecycle support as explicit launch work and update the relevant alpha support policy in the same implementation changes, preserving unrelated adapter behaviour.
