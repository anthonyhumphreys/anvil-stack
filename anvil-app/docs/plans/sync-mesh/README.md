# Sync & Mesh — feature overview and status

Branch: `feature/sync-mesh--foundations` · PR #91
Normative spec: `anvil-sync-mesh-spec-v2.md` · Companion spec: `cloud-connected-companion.md` · Ops: `runbooks/hosted-sync/`

This document is the entry point. It explains what the branch builds, what has landed, and what remains — split into work an agent can execute versus decisions and verification that need a human.

## What the feature is

Anvil's hosted sync layer replaces the "master desktop" model with an **account-scoped peer mesh**:

- The account is the coordination and trust boundary. Desktops, phones, and Raycast enroll as peer devices; no machine is authoritative.
- A Cloudflare Workers + Durable Objects backend (`cloud/backend`) holds per-account coordinators: an append-only change journal, live socket sessions, durable jobs, and presence.
- Devices sync **portable entities only**: workspace definitions, settings, workflow templates, editable agents, session ownership records. Chat transcripts and code are explicitly not synced entities.
- Direct transport is preferred wherever a route exists — Tailscale → LAN → cloud-mediated fallback through the account object's hibernating sockets.
- Hosted features are gated by a billing entitlement (Stripe + WorkOS identity); account-less and self-hosted (BYOB) modes keep working without it.

## What this branch contains

### Mesh execution and workspace replication (landed)

- Workspace adoption/materialisation: portable definitions sync; each device keeps a local replica and execution checkouts with journalled clone/link/removal and bootstrap approvals (WS-02/WS-03).
- Durable jobs and attempts with generation fencing, cancellation intents, and per-attempt isolated worktrees (MESH-*).
- Remote `prepare-workspace` and `start-session` job kinds: pinned manifests by content digest, control-channel approvals, provider sessions on remote hosts (SESSION-02).
- Workflow placement and fan-out: code-task jobs carrying per-repo commit pins, ordered result integration with visible conflicts.
- Durable events, approvals, artifact manifests, and socket observation (MESH-03); live/durable channel split — ephemeral frames never persisted.

### Session ownership and portability (landed)

- Cross-device handoff: `requested → target-prepared → source-quiescing → checkpointed → ownership-transferred → activating → completed`, with a durable ownership mirror in the account object.
- Provider continuity is explicit per adapter (`native-resume` / `checkpoint-import` / `summary-continuation`); a provider thread ID is not portability proof.
- Session ownership chip in the execution view; mesh session-view surface (jobs, approvals, activity, handoffs).

### Account, identity, and billing — hosted tier (landed, launch-pending)

- BILL-01/02/03: WorkOS identity binding, enrollment-code + OIDC device enrollment, D1 persistence, Stripe checkout/webhooks/reconciliation, entitlement enforcement at authoritative handlers.
- BILL-04: `/account` website area — device table (list/rename/revoke), "Connect a device" code minting, billing surface.
- BILL-05: desktop entitlement status + resumable pause.
- IAC-01/02: deploy + rehearsal harness; live rehearsal passed on a clean account (evidence was in `iac-02-rehearsal.md`, since removed as transitive — the runbooks carry the durable procedures).
- `device.list`/`rename`/`revoke`, `data.export`/`import`, `account.delete`/`deletionStatus` ops; hosted device + account-deletion service routes.
- Runbooks: deploy, rollback, reconciliation, webhook failures, entitlement incidents, account deletion, metrics, launch checklist.

### Cloud-connected companions — MOB-01 (landed)

- Contract (`cloud/contract/companion.ts`): `device.advertise`, `device.presence`, `session.attest`; endpoint ordering Tailscale → LAN → loopback.
- Backend: TTL'd endpoint advertisements on the account coordinator; attestation via session-coordinator token validation.
- Desktop: `companion_enrollment_policies` (schema v80) — account tokens attested and gated by per-enrollment `observe`/`approve`/`steer` tiers; first contact is `pending`; paired LAN/Raycast tokens keep legacy full access. Settings UI for account-connected devices.
- Mobile: enrollment-code sign-in (SecureStore session, refresh-on-401), presence discovery, direct dial, account-mode connections, settings panel.
- Raycast: account-connected mode (LocalStorage session, presence dial); manual token config still wins when set.

## Verified state

- App suite: 174 files / 1228 tests. Backend: 21 files / 258 tests. Contract: 52 tests.
- `tsc` clean across main, renderer, mobile, Raycast.
- Not yet exercised: real-device flows (see human tasks). Lint is blocked by a pre-existing ESLint 10 / `eslint-plugin-react` incompatibility.

## Next steps — agent-executable

| Task | Scope |
| --- | --- |
| Legacy companion-token roster (Phase 4a) | Hosts publish `mobile_companion_devices` roster as presence metadata; contract field + backend op + website table marking `local-pair`. |
| Forwarded revocation (Phase 4b) | Dashboard revoke of a `local-pair` row → durable op to owning host → token deleted on receipt. |
| Raycast multi-host picker | Per-command host argument; `resolveAccountTarget` currently takes first reachable. |
| Mobile pending-approval retry UX | Re-dial when a pending host approves; "check again" affordance. |
| Contract packaging | Extract `@anvil/cloud-contract`; mobile/Raycast currently import by relative path. |
| ESLint 10 / `eslint-plugin-react` compat | Upgrade plugin or pin ESLint; blocks lint repo-wide. |
| Tailscale endpoint detection hardening | Order/heuristics for tsnet/utun interfaces in the desktop advertiser. |

## Next steps — human-required

| Task | Why |
| --- | --- |
| Real-device dogfood | Two desktops + phone on one account: LAN kill → Tailscale path; both kill → durable ops land on reconnect; web revoke → all paths die within ~60s (attest TTL). |
| BILL-06 launch gates | Production deploy config, Stripe live-mode keys, persistent secrets — see `runbooks/hosted-sync/launch-checklist.md`. |
| WorkOS/OIDC client config | Register `anvil://` mobile redirect in the IdP console; contract freeze follows config. |
| Local pairing's future | Keep ticket/token pairing first-class for zero-account users, or deprecate? Determines whether Phase 4 is worth doing. |
| Transcript portability decision | Finished-chat transcripts live only on the origin host. Options in the spec's open questions: accept the gap (recommended), opt-in R2 artifacts, or synced entity (avoid). |
| Production backend URL | Shipped default vs BYO-backend for mobile/Raycast — launch call. |

## Known sharp edges

- Backend revocation reaches direct connections within ~60s (attestation cache TTL); push invalidation is a Phase 5 candidate.
- Account-mediated mode needs the host awake with its companion server enabled — the coordinator is directory + durable fallback, not a live proxy (frame relay is Phase 5, optional).
- Account-mode connections store `pending` optimistically; they activate on host approval with no re-dial.
- Mobile OIDC and universal links are spec'd, unimplemented; enrollment codes are the v1 path.
