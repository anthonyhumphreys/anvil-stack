# Cloud-connected companion surfaces (MOB-01)

Status: proposed. Depends on BILL-04/05 landing (account enrollment + hosted entitlement on the client). Builds on `anvil-sync-mesh-spec-v2.md`; this document only covers the companion surface delta.

## Intent

The companion app (Expo mobile today, Raycast extension, watch/widgets/CarPlay surfaces) becomes a client of two transports chosen per connection:

1. **Pair to device** — the existing point-to-point flow. LAN bearer token via pairing ticket, or a pasted Raycast token. No account required; nothing leaves the local network. Live control of that one desktop.
2. **Sign in to account** — the companion enrolls on the user's sync account, discovers every enrolled host through the account object, and connects to each directly where a route exists, falling back to account-mediated operations where it does not.

## Principles

- **No master device.** The account is the coordination boundary; every enrolled device is a peer.
- **Account = directory + trust root + durable fallback.** The `AccountCoordinator` knows which enrollments exist and holds hibernating sockets to online devices.
- **Direct = preferred data plane.** Tailscale → LAN → account-mediated, in that order. TS preferred over LAN for transport security (cleartext HTTP bearer today vs. WireGuard).
- **Auto-authenticate ≠ auto-authorize.** Enrollment grants the right to ask; each host applies per-enrollment policy tiers: `observe` / `approve` / `steer`.
- **Revocation is total.** Revoking an enrollment from the web dashboard ends every access path — account session, direct connections, queued ops.

## Key mechanisms

- **Enrollment:** same `DeviceSession` contract as desktop. Mobile v1 uses `enrollment-code` (website "Connect a device" already mints them); OIDC needs a second frozen redirect form (`anvil://` custom scheme).
- **Presence:** hosts publish TTL'd endpoint advertisements (LAN addr, TS addr, companion port, capabilities) over the existing socket lifecycle; `device.presence` returns per-caller filtered reachability.
- **Attestation:** companion presents account-bound proof + challenge; host verifies online against the session coordinator, caches briefly, re-verifies on revocation notification.
- **Policy:** first contact prompts on the host ("iPhone 15 wants to approve and steer"); optional "allow all devices on this account" default tier.

## Revocation gap (flagged)

LAN-paired phones and Raycast bearer tokens live in host-local `mobile_companion_devices`, invisible to `/account/devices`. Two-phase fix: hosts publish their companion roster as presence metadata, then dashboard revoke forwards to the owning host as a durable op. Long-term: migrate paired devices to enrollments and deprecate the token path.

## Phasing

0. Contract packaging (`@anvil/cloud-contract`) + presence/attestation contract + host verification path.
1. Mobile code-only enrollment + account-mediated mode (synced views, durable approvals, job dispatch).
2. Direct transport: endpoint ads, TS→LAN dial order, attestation, policy tiers + first-contact approval.
3. Raycast enrollment + multi-host picker; mobile OIDC custom scheme.
4. Legacy token roster visibility + forwarded revocation; local-pairing deprecation decision.
5. v2 candidates: transient live-frame relay over hibernating sockets, universal links, transcript portability.

## Open questions

- Finished-session transcripts aren't synced (only on origin host) — recommend accepting the gap in v1, evaluating opt-in R2 transcript artifacts later, avoiding a chat-history entity type.
- Offline queued chat turns: durable intent vs fail-fast.
- Whether companion enrollments share the desktop device cap or get their own class.
- Whether manual LAN pairing stays first-class for zero-account users.