# Cloud-connected companion surfaces (MOB-01)

Status: proposed. Depends on BILL-04/05 landing (account enrollment + hosted entitlement on the client). Builds on `anvil-sync-mesh-spec-v2.md`; this document only covers the companion surface delta.

## Intent

The companion app (Expo mobile today, Raycast extension, watch/widgets/CarPlay surfaces) becomes a client of two transports chosen per connection:

1. **Pair to device** — the existing point-to-point flow. LAN bearer token via pairing ticket, or a pasted Raycast token. No account required; nothing leaves the local network. Live control of that one desktop.
2. **Sign in to account** — the companion enrolls on the user's sync account, discovers every enrolled host through the account object, and connects to each directly where a route exists, falling back to account-mediated operations where it does not.

The user's choice is real, not cosmetic: point-to-point needs no hosted account and works with zero cloud dependency; account sign-in adds cross-machine visibility and works when a given desktop is asleep.

## Principles

- **No master device.** The account is the coordination boundary. Every enrolled device — desktop, phone, Raycast — is a peer enrollment. Pairing codes bind a new device to the account, never to another device.
- **Account = directory + trust root + durable fallback.** The `AccountCoordinator` already knows which enrollments exist and holds hibernating sockets to online devices. It answers "who can I reach and how" and carries durable operations when no direct route exists.
- **Direct = preferred data plane.** Live steering, history reads, and event streams use a direct transport whenever one is reachable: Tailscale first, then LAN, then account-mediated.
- **Auto-authenticate ≠ auto-authorize.** Account membership grants discovery and the right to *ask* a host for a session. Each host applies its own policy over what an enrollment may do. A compromised account credential must not silently grant live control of every desktop — the same rule the spec already applies to mesh execution sources.
- **Revocation is total.** Revoking an enrollment from the web dashboard or any signed-in device ends every access path that enrolment had: account session, direct host connections, queued operations. A device that was kicked off cannot keep working through a cached direct connection.

## Identity and enrollment

A companion enrolls exactly like a desktop: `enroll` with one of the two contract proofs, yielding the same `DeviceSession` (short-lived access token, rotating refresh, credential generation, bound to account + enrollment).

- **`oidc-pkce`** on mobile uses the system browser (`expo-web-browser` / ASWebAuthenticationSession). The contract redirect allow-list currently accepts only the desktop loopback form `http://127.0.0.1:{ephemeral}/callback`; mobile needs a second frozen redirect form — the `anvil://` custom scheme (universal links can follow later). This is a contract + identity-provider client-config change, versioned like the loopback form.
- **`enrollment-code`** requires no contract change. The website "Connect a device" card and any signed-in device already mint single-use codes bound to the account. This is the recommended v1 path: mint on the web or on a signed-in desktop, type the code on the phone.
- Raycast runs on macOS and can use either; an enrollment code is the simplest first step since the desktop already mints them.
- Credentials live in `expo-secure-store` on mobile and Raycast local storage on desktop. Tokens never appear in logs, analytics, or renderer-visible state.
- Phone enrollments count toward the same per-account device limits as desktops ("pair within limits"); the dashboard shows them alongside machines.

## Discovery and presence

Today `device.list` returns the enrollment roster but not reachability. Add an account-scoped presence surface:

- Each host publishes an endpoint advertisement on connect and on change: companion API port, LAN addresses, Tailscale addresses, companion protocol version, and a capability set (observe, approvals, steering, artifact serving).
- Advertisements are TTL'd presence, not durable entities — they ride the existing socket attachment lifecycle (`hello`/`worker.available` already carry enrollment identity; presence joins that channel or a sibling op). Dead entries age out; presence is never a sync change and never bumps the change sequence.
- `device.presence` (or presence fields on `device.list`) returns for each enrollment: online state, last-seen, advertisements, and authorized capabilities for the *calling* enrollment — a host may hide endpoints from enrollments its policy does not trust.
- Endpoint strings are capability data, not secrets; they must still stay out of logs and analytics.

## Direct connection and attestation

The companion dials a host's advertised endpoints in preference order **Tailscale → LAN → account-mediated**. Tailscale is preferred over LAN not for reachability but for transport security: the current companion channel is cleartext HTTP plus bearer on `:47631`; WireGuard gives encrypted, machine-authenticated transport for free. LAN remains the fallback for tailnet-less networks.

Authentication on the direct channel changes from "whoever holds a LAN-issued token" to "an enrollment on my account":

- The companion presents an account-bound attestation: its enrollment identity plus a fresh challenge, signed/provable against its device session.
- The host verifies online against the session coordinator it already trusts: enrollment exists, belongs to this account, is not revoked, and passes local policy. Verification results may be cached for a short bounded TTL; revocation signals must invalidate immediately — a host re-verifies on connection setup and on coordinator notification, never trusting a cached yes across a revocation event.
- A host that cannot reach the coordinator cannot attest new companions; already-authorized sessions may continue under cached policy until TTL expiry. Hosts that have never seen the account (account-less mode) keep ticket/token pairing only.

## Per-host authorization policy

Enrollment grants the right to ask; host policy grants authority. Each host keeps a per-enrollment policy with three cumulative tiers:

| Tier | Allows |
| --- | --- |
| `observe` | workspace/session lists, status, live activity frames, artifact reads |
| `approve` | resolving remote approvals within the attempt's permitted-approver rules |
| `steer` | sending turns/messages, interrupting, launching workflows |

- First contact from a previously unseen enrollment surfaces a host-side approval prompt naming the device and requested tier ("iPhone 15 wants to approve and steer on this machine"). Approved policy is durable; denied requests are remembered, not re-prompted aggressively.
- An "allow all devices on this account" toggle sets a default tier for personal accounts that want zero friction. New-device prompts still appear for `steer` unless the user explicitly lowers that bar.
- Policy changes and revocations push to connected companions immediately; a dropped tier interrupts active streams.
- This is deliberately the same shape as the spec's mesh source-authorization ("approve which source enrollments may request execution; new sources require fresh approval"). Sync enrollment authorizes neither companion control nor mesh execution.

## Capability matrix

| Capability | P2P (existing) | Account — direct (TS/LAN) | Account — mediated (host offline) |
| --- | --- | --- | --- |
| Workspace/workflow/agent lists | yes | yes | yes — from synced entities, last-known state |
| Session list + ownership | host-local only | yes, all hosts | yes — ownership mirror |
| Live activity of running attempt | yes | yes | no — resumes when host reconnects |
| Resolve approvals | yes | yes | durable intent — delivered when host is next reachable |
| Send turn / launch workflow | yes | yes | queued as job dispatch; runs when a policy-eligible host claims it |
| Interrupt running turn | yes | yes | durable cancel intent (`cancel-requested`) |
| Full chat history | yes | yes | no — transcripts are not synced |
| Artifacts | yes | yes | published manifests via R2 read path |

Chat history is called out deliberately: transcripts are not portable entities. Over any transport the *content* comes from the owning host; account-mediated mode cannot show a finished session's transcript that was never checkpointed. See open questions.

## Revocation and device management

- The website `/account/devices` table already lists enrollments and revokes them through the signed hosted channel. A companion enrollment is one row; revocation kills its session, blocks refresh, closes sockets.
- For revocation to end *direct* access too, hosts must re-verify attestation rather than cache trust indefinitely, and must drop connections when the coordinator reports revocation.
- **Legacy tokens gap:** LAN-paired phones and Raycast bearer tokens live in the host-local `mobile_companion_devices` table and are invisible to the dashboard. Two-phase fix:
  1. Hosts publish their companion-token roster as presence metadata so the dashboard shows *every* device that can reach a machine, marked `local-pair` vs `account`.
  2. Dashboard revocation of a local-pair entry forwards to the owning host as a durable op (queued while the host is offline); the host deletes the token on receipt.
- Longer term, migrate local-paired devices to enrollments and deprecate the token path; until then both rows are manageable from the same table.

## Client deltas

**Contract packaging.** `anvil-app/cloud/contract` is pure TS by design but is not a consumable package today. Extract or publish it as a versioned artifact (`@anvil/cloud-contract`) consumable by mobile, Raycast, and desktop without Electron/Cloudflare deps. Pin the contract version; companions declare their supported wire version in `hello`.

**Desktop (host).**

- Companion service accepts the attestation credential alongside tickets/tokens; verification call + bounded cache + revocation invalidation.
- Presence/endpoint publisher (advertise on connect, on network change, on policy change).
- Per-enrollment policy store (schema migration), first-contact approval UX in Settings → Sync & Mesh / companion settings.
- Companion-token roster reporting to the account object.
- Tailscale detection for endpoint advertisement (read-only; never manages the tailnet).

**Mobile.**

- Enrollment service: code redemption first, OIDC custom-scheme second; sessions in `expo-secure-store`; refresh rotation identical to desktop.
- Connection manager: per-host dial list (TS → LAN → account-mediated), health marking, transport badge in UI (`Tailscale`, `LAN`, `Cloud`, `Offline`).
- Dual transport behind the existing `anvil-api.ts` surface — same screens speak companion-API-over-direct or account-ops-over-coordinator.
- Offline behaviours: approvals become durable intents, dispatches queue, transcripts show the "available on the host" state.

**Raycast.**

- Preferences gain account enrollment (code paste v1); manual token remains as legacy same-machine mode.
- Host picker for commands when enrolled: steer the local machine or any reachable enrolled host — Raycast becomes multi-machine where today it is same-machine-only.
- Same attestation + dial-order logic as mobile; TS preference gives it encrypted remote control without new transport code.

**Backend.**

- Presence/endpoint surface and per-caller capability filtering.
- Attestation verification route (or a documented composition of existing session/device ops) with rate limits.
- Revocation fan-out to connected hosts and companions.
- Companion-roster op for the legacy-token visibility phase.

## Security requirements

- Enrollment is never authority. `observe` is the floor; `steer` is a deliberate per-host grant.
- Attestations are challenge-bound and short-lived; replay across hosts or time is rejected. Hosts re-verify on revocation notification and bounded TTL.
- No endpoint strings, attestations, enrollment IDs, or tokens in analytics, crash reports, or normal logs beyond the existing redaction rules.
- Cloud-mediated mode requires the hosted entitlement; account-less P2P keeps working regardless of entitlement state.
- A copied/cloned mobile profile must re-enroll; one enrollment's concurrent use follows the same exclusive-incarnation rule as desktop workers.
- Device revocation while a companion is mid-approval leaves the approval unresolvable by that device; the durable intent model already covers retry by other authorized approvers.

## Phasing

0. Contract packaging + presence/attestation contract + host verification path (backend + desktop groundwork; conformance suite gains a second-enrollment companion fixture).
1. Mobile **code-only** enrollment + account-mediated mode: device list, synced workspace views, durable approvals, job dispatch. No direct transport yet — works entirely through the coordinator.
2. Direct transport: endpoint advertisement, TS→LAN dial order, attestation, per-host policy tiers and first-contact approval.
3. Raycast enrollment + multi-host picker; OIDC custom-scheme for mobile.
4. Legacy token roster visibility + forwarded revocation; migration/deprecation decision for local pairing.
5. Optional v2: live frame relay over hibernating sockets for offline-host observation (transient relay, never persisted frames), universal-link OIDC, transcript portability decision.

## Open questions

- **Finished-session transcripts.** Account-mediated mode cannot show a never-checkpointed transcript — it only exists on the origin host. Options: (a) accept the gap in v1, P2P/direct covers couch-reading when the host is reachable; (b) opt-in transcript artifacts in R2 under the existing artifact retention policy; (c) promote chat history to a synced entity type — heavy, sensitive, and creates conflict semantics on an append-only stream. Recommendation: (a) now, evaluate (b) with real usage, avoid (c).
- **Offline queued messages.** If a user sends a chat turn while the host is unreachable, does it queue as a durable intent ("deliver when online") or fail fast? Dispatch queuing exists for jobs; a session-turn equivalent needs turn-level semantics decided.
- **Device limits.** Do companion enrollments share the desktop device cap or get their own class? Entitlement tiers could gate `steer` vs `observe`.
- **Local pairing's future.** Once sign-in exists, does manual ticket/token pairing remain first-class (zero-account users) or become legacy? Determines how much phase-4 work is justified.
- **Watch/widgets/CarPlay.** These ride the phone's connection today; whether they ever hold their own enrollment is a later decision — treat as out of scope.

## Verification

- Extend the conformance suite: companion enrollment fixture, presence advertisement, attestation accept/reject/revoked paths, dial-order resolution, policy-tier enforcement per op.
- Failure injection: revocation mid-stream, attestation replay, coordinator-unreachable attestation, expired-TTL reuse.
- Dogfood: two desktops + phone on one account; kill LAN, confirm Tailscale path; kill both, confirm durable ops land on reconnect; revoke phone from the web dashboard and confirm all paths die.
