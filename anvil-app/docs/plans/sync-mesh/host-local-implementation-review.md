# Host-local Sync and Mesh implementation review

Prepared 4 October 2026. Implementation and review fixes are integrated at source checkpoint
`e50e2a9`. Automated local project checks pass. The immutable security review is sealed; its
coverage metadata retains superseded progress records, as explained below. Production acceptance
remains open.

## Source map

| Area | Current source |
| --- | --- |
| Machine-session protocol and cryptographic envelopes | `cloud/contract/machine.ts`; `src/main/services/mesh-host-client.service.ts`; `src/main/services/mesh-host-session.service.ts` |
| Broker discovery, tickets and endpoint allocations | `cloud/backend/src/hosted/machine-endpoints.ts`; `cloud/backend/src/hosted/machine-api.ts` |
| Host lifecycle and advertisement | `src/main/services/mobile-companion.service.ts`; `src/main/services/mesh-host-runtime.service.ts`; `src/main/services/mesh-machine-endpoint.service.ts` |
| Managed tunnel process and loopback ingress | `src/main/services/mesh-managed-connector.service.ts`; `cloud/backend/scripts/hosted-deploy.mjs` |
| Durable Mesh ownership, recovery and activity | `cloud/backend/src/account-coordinator.ts`; `src/main/services/mesh-worker.service.ts`; `src/main/services/mesh-handoff.service.ts`; `src/main/services/remote-chat.service.ts` |
| Sync snapshots and bounded change journal | `src/main/services/sync-engine.service.ts`; `src/main/services/sync-persistence.service.ts`; `cloud/backend/src/hosted/` snapshot handlers |
| Current client surfaces | `src/renderer/`; `cloud/contract/browser-workspace.ts`; `mobile/lib/mesh-session.ts`; `raycast/anvil/src/` |

## Rollout controls

`ANVIL_MESH_MACHINE_ENDPOINTS` is disabled unless the main process receives the exact value `true`.
It is an operator setting for a selected application or daemon process; the app does not enable it
automatically or ask users to guess it. A signed-in host also needs an active Sync scope. This host
lifecycle is independent of the Mesh worker opt-in and the local companion preference.

`ANVIL_MESH_MANAGED_ENDPOINTS` is a separate default-off setting on both the host and backend. When
enabled for a selected target, the backend needs an operator-controlled `MACHINE_ENDPOINT_DOMAIN`
and protected `CLOUDFLARE_TUNNEL_ACCOUNT_ID`, `CLOUDFLARE_TUNNEL_ZONE_ID` and
`CLOUDFLARE_TUNNEL_API_TOKEN` secrets. The hosted deployment wrapper requires all three when the
generated flag is `true` and rejects these values from public Worker variables. Account and zone IDs
may be shared across stages; production needs a distinct API token.

The host resolves `cloudflared` from `ANVIL_CLOUDFLARED_PATH`, the packaged resource, then `PATH`.
It checks that the selected executable can run, launches it without a shell with auto-update
disabled, and does not download or install it. It does not check file ownership or parent-directory
permissions. Operators must supply a trusted binary from a path writable only by the intended
administrator; that ownership condition is not enforced by the runtime.

Managed ingress targets a separate listener bound to `127.0.0.1`; it does not expose the ordinary
companion listener. The source account bearer goes only to HTTPS broker endpoints. The broker issues
opaque admission tickets that expire after 60 seconds and can be consumed once. It seals an
admission proof key to the client's ephemeral X25519 public key. The host consumes the ticket and
checks the client's HMAC over the ticket claims and challenge. The host returns an HMAC over the
complete bootstrap response under that proof key; the client verifies it before accepting the host
session token, which is sealed to the ephemeral client key. Session frames use directional
AES-256-GCM keys. The broker does not relay live session frames.

## Acceptance limits

- Current clients require `anvil-backend/1`, `sync/2` and `mesh/2`. Direct hosts advertise their
  machine-session and stream capabilities separately.
- The current coordinator remains responsible for durable acceptance, ownership, approval,
  cancellation, handoff and recovery operations it supports. Live host-only reads still require a
  reachable host. Network retries and cursor recovery must not create duplicate mutations or hide
  data gaps.
- Sync and Mesh remain free for personal accounts; no organization or shared fleet is required.
  Only future Anvil Cloud Agents are planned as paid, and that feature stays disabled by default.
- The post-review application suite passed with 2,025 tests passing and 12 intentionally skipped.
  There were 247 passing files and four skipped files. Full application lint passed with no errors
  or warnings.
- Node and web TypeScript checks, desktop and daemon production builds, backend tests/typecheck,
  Cloud tests/typechecks/lint/build, provisioner checks, contract tests/conformance, mobile checks,
  Raycast build/typecheck/ESLint/cold-load, and website documentation/browser/environment/typecheck/
  Webpack production checks passed. The integration owner's test record has per-project counts.
- Raycast's remote schema lint could not reach its service because of DNS; direct ESLint and CJS
  cold-load passed. The default website Turbopack production build was blocked by `EPERM`; the
  Webpack production build passed.
- The security review covered all 247 changed files in `afbe685..fef0049` and recorded dispositions
  for all 13 candidates. Eight findings survived, two medium and six low. Subsequent commits address
  seven; the mobile native WebSocket buffering limitation below remains. The sealed report keeps
  the original findings and their validation limits rather than presenting the later code as the
  audited revision.
- The workbench reports partial coverage because it retained superseded pending review records
  while merging the final draft. All nine final review groups and candidate dispositions are
  recorded. Scan `a8cb3712-65ad-4b87-bdc3-1a3b96712a4a` is sealed; a separate report reconciliation
  records this metadata discrepancy without rewriting it.
- Physical hosts on separate WANs, sleep/disconnect recovery on real networks, actual managed tunnel
  allocation and cleanup, provider capacity/traffic terms, and an actual provider bill have not been
  verified. Production rollout flags remain off until those gates have owners and evidence.

## Review changes and remaining mobile limit

Deleted-workspace grants now fail closed. File mentions become private snapshots at selection time,
so later repository edits cannot replace their attachment bytes. Host HTTP responses use bounded
stream readers; desktop and Raycast WebSockets reject oversized messages in the transport before
delivery. Current Sync domain payloads must be account-sealed, snapshot expansion has a 256 MiB
ceiling, and expired snapshot staging has durable R2 cleanup with retry. Sync key-version bounds are
consistent across metadata and snapshot validation.

The original tunnel-quota race hypothesis was rejected by the actual Durable Object harness, which
held both account and global limits under concurrent requests. Label hashing now precedes the
synchronous quota checks and reservation anyway. Intentional developer execution and unavailable
future paid-agent billing were not reported as authorization bypasses. PR91's existing bot comments
were rechecked; no newer comments appeared, and the applicable fixes are included.

React Native's current WebSocket API exposes no inbound native message cap. Mobile rejects an
oversized message after native delivery, so its 512 KiB application limit does not bound native
message assembly. Expo's streaming HTTP path also has a native pre-reader buffering window.
Strict native receive limits need a bounded transport and physical-device resource-abuse acceptance
before public rollout. These limits do not require an older-host compatibility path.

The post-review backend suite passed with 436 tests. Mobile's three bounded-stream tests, typecheck,
lint and iOS export passed. Raycast build, typecheck, ESLint and CJS cold-load passed. Desktop and
daemon builds passed, as did the daemon device-authorization integration and a real loopback test
rejecting a 512 KiB-plus-one WebSocket message before delivery.

See the [operator host-connection guide](../../runbooks/hosted-sync/host-connections.md),
[four-surface rehearsal](../../runbooks/hosted-sync/four-device-test-plan.md), and
[launch checklist](../../runbooks/hosted-sync/launch-checklist.md) for the required steps.
