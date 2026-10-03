# MOB-01: Cloud-connected companion — implementation status

Branch: `feature/sync-mesh--foundations`
Spec: `docs/plans/sync-mesh/cloud-connected-companion.md`

## Work completed

### Phase 0 — contract + backend (`af8607d`)

- `cloud/contract/companion.ts`: new pure-TS contract module — `device.advertise`, `device.presence`, `session.attest` ops, `CompanionEndpoint`/`DevicePresenceEntry`/`SessionAttestResult` shapes, endpoint-kind ordering constants (`tailscale → lan → loopback`), request validators.
- Backend: presence table + TTL'd advertisement storage on `AccountCoordinator`; presence roster returns per-caller filtered reachability; `session.attest` routes through the session coordinator's validate path (verified identity claims, never echoes the token).
- Tests: `cloud/backend/test/presence.test.ts` (7 tests: advertise, presence, cross-enrollment attest, revoked-token attest rejection, malformed/unknown token handling).

### Phase 0c — desktop host (`f124495`)

- Schema v80: `companion_enrollment_policies` (`enrollment_id`, `account_id`, `display_name`, `tier`, timestamps).
- `mobile-companion.service.ts`: dual-credential auth — legacy paired tokens keep full access; account access tokens are attested via `session.attest`, matched against the host's signed-in account, and gated by a per-enrollment policy. First verified contact creates a `pending` row and returns 403 until the host decides. Cached attestations: 60s positive / 15s negative; cache entries re-validate against current sign-in state.
- Tier gates: GET/HEAD → `observe`, `/api/approvals` → `approve`, mutations → `steer`. Paired tokens bypass tiering entirely.
- Endpoint advertisement: while the companion server runs, the host publishes its dialable endpoints to the account object (10-minute refresh, well inside the 30-minute ad TTL).
- Settings UI: "Account-connected devices" section — approve/deny/forget controls, per-tier buttons, live refresh via a new `mobile-companion:event` renderer broadcast.
- IPC/preload/shared types extended end to end (`listEnrollmentPolicies`, `setEnrollmentPolicy`, `removeEnrollmentPolicy`, `onEvent`).

### Phase 1 + 2 — mobile (`19474c2`)

- `lib/anvil-account.ts`: enrollment-code redemption → `DeviceSession` in `expo-secure-store`; envelope-RPC client with refresh-and-retry on `unauthenticated`; `device.list`/`device.presence` reads; session revoke on sign-out.
- `lib/account-dial.ts`: per-host dial in contract endpoint order; 200 = ready, 403 = pending/denied (stops dialing — reachable but unauthorized), network failure = next endpoint; ready and pending hosts are upserted as account-mode connections.
- `lib/anvil-api.ts`: `CompanionConnection` gains `authMode`/`enrollmentId`/`requiresHostApproval`; account connections resolve the bearer live per request (including the SSE events stream) and rotate once on 401.
- Settings: "Anvil account" panel (API URL + enrollment code → connect; presence roster with online/endpoint kinds; sign out). Account hosts appear in the host picker with a cloud badge and pending-approval state.

### Phase 3 (partial) — Raycast (`d057b80`)

- `src/account.ts`: LocalStorage-backed device session, one-time enrollment-code redemption, presence dial with cached host + re-dial on failure, transparent refresh.
- `api.ts`: paired mode wins when configured; otherwise resolves through the account path.
- Preferences: `baseUrl`/`token` now optional; new `accountApiUrl` + `accountEnrollmentCode` fields.
- Deferred: mobile OIDC custom scheme (`anvil://` redirect is a contract-freeze change + IdP client config, sequenced with BILL-06 launch config).

## Verification evidence

- App suite: 174 files / 1228 tests passing — including 8 new auth/policy tests exercising the real HTTP boundary (unknown token 401, signed-out host 401, cross-account 401, pending first-contact 403 + row creation, observe/approve/steer gates, denied, re-pend after forget).
- Backend: 21 files / 258 tests; contract: 52 tests.
- `tsc` clean: main (`tsconfig.node.json`), renderer (`tsconfig.web.json`), mobile, Raycast extension.
- New schema test covers the v80 table; both `SCHEMA_VERSION` pin assertions updated.

## Remaining work — agent-suitable

| Task | Notes |
| --- | --- |
| Phase 4a: companion-roster op | Hosts publish local `mobile_companion_devices` roster as presence metadata; backend op + contract field; dashboard lists them marked `local-pair`. Contract + backend + desktop publisher + website table — all mechanical on existing patterns. |
| Phase 4b: forwarded revocation | Dashboard revoke of a `local-pair` row → durable op to owning host → host deletes token. Needs a queued-op path; host may be offline. |
| Multi-host picker for Raycast commands | `resolveAccountTarget` currently picks the first reachable host; a `host` argument/action per command would make it genuinely multi-machine. |
| Mobile pending-approval retry UX | A "check again" affordance + auto-redial when a pending host approves (presence poll). |
| Tailscale endpoint detection hardening | Current advertisement uses whatever `networkInterfaces` reports; could add ordering heuristics/tests for tsnet/utun interfaces. |
| Contract packaging | `cloud/contract` is still imported by relative path; extracting `@anvil/cloud-contract` is mechanical but touches build tooling. |
| Update `AGENTS.md`/docs | Document the two companion auth modes + policy tiers for future agents. |

## Remaining work — human-required

| Task | Why a human |
| --- | --- |
| Real-device dogfood pass | Two desktops + a physical phone on one account; kill LAN → confirm Tailscale path; kill both → confirm durable ops land on reconnect; revoke phone from `/account/devices` → confirm all paths die within ~60s (attest cache TTL). Emulators won't cover TS-on-LAN-less-network or SecureStore behavior. |
| Decide local pairing's future | Phase 4 effort is only justified if ticket/token pairing stays first-class for zero-account users. Product decision, not engineering. |
| Transcript portability (Phase 5c decision) | Whether finished-chat transcripts become opt-in R2 artifacts or stay host-local is a privacy/retention call. Recommend accepting the gap; evaluate with usage. |
| WorkOS/OIDC client config for mobile | Registering the `anvil://` redirect URI in the identity provider is console work; contract change follows the config. |
| Production backend URL / hosted config | Mobile and Raycast both take an API URL field today; deciding the shipped default (or keeping it BYO-backend) is a launch call tied to BILL-06. |
| Enrollment-code UX copy | The mint-on-web → type-on-phone flow works, but the wording/discovery of "Connect a device" deserves a human pass. |

## Known sharp edges

- Attestation cache means backend revocation takes up to ~60s to reach direct connections. Acceptable per spec (bounded TTL); push-based invalidation is a Phase 5 candidate.
- Account-connected mode still depends on the host being awake and its companion server enabled — the cloud path is directory/fallback, not a hosted proxy.
- `requiresHostApproval` connections are stored optimistically; they start working the moment the host approves, no re-dial needed.
- Mobile OIDC and universal links are spec'd but intentionally unimplemented; enrollment codes are the v1 path.